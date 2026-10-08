package io.moneymaker

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import com.android.billingclient.api.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.UUID

/**
 * MoneyMaker — subscriptions for Google Play, App Store and Stripe on your own backend.
 *
 * ```kotlin
 * MoneyMaker.configure(context, apiKey = "mm_pub_…", appUserId = user.id)
 * MoneyMaker.shared.customerInfo.collect { if (it?.isEntitled("premium") == true) … }
 * MoneyMaker.shared.purchase(activity, offerings.current!!.packages.first())
 * ```
 */
class MoneyMaker private constructor(
    context: Context,
    private val apiKey: String,
    appUserId: String?,
    private val baseUrl: String,
) : PurchasesUpdatedListener {

    companion object {
        const val DEFAULT_BASE_URL = "https://moneymaker-io.web.app/v1"
        @Volatile private var instance: MoneyMaker? = null

        val shared: MoneyMaker get() = instance ?: error("Call MoneyMaker.configure(context, apiKey) first")
        val isConfigured: Boolean get() = instance != null

        @JvmStatic @JvmOverloads
        fun configure(context: Context, apiKey: String, appUserId: String? = null, baseUrl: String = DEFAULT_BASE_URL): MoneyMaker =
            instance ?: synchronized(this) { instance ?: MoneyMaker(context.applicationContext, apiKey, appUserId, baseUrl).also { instance = it } }

        internal fun sha256Hex(s: String): String =
            MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val prefs: SharedPreferences = context.getSharedPreferences("moneymaker.${apiKey.takeLast(8)}", Context.MODE_PRIVATE)
    private val api = Api(baseUrl, apiKey)
    private val billing = BillingClient.newBuilder(context).setListener(this)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build()).build()
    private var pendingPurchase: CompletableDeferred<PurchaseResult>? = null
    private val productDetails = mutableMapOf<String, ProductDetails>()

    var appUserId: String = appUserId ?: anonymousId(); private set
    val isAnonymous get() = appUserId.startsWith("\$anon:")

    private val _customerInfo = MutableStateFlow(cached(this.appUserId))
    /** Latest known customer state; survives restarts (cached) and works offline. */
    val customerInfo: StateFlow<CustomerInfo?> = _customerInfo
    var onCustomerInfoUpdate: ((CustomerInfo) -> Unit)? = null

    init {
        scope.launch {
            runCatching { connect(); syncExistingPurchases() }
            runCatching { refreshCustomerInfo() }
        }
    }

    // ── Identity ─────────────────────────────────────────────────────────
    suspend fun logIn(newAppUserId: String): CustomerInfo {
        if (newAppUserId == appUserId) return refreshCustomerInfo()
        val previous = appUserId
        appUserId = newAppUserId
        val info = if (previous.startsWith("\$anon:"))
            api.post("customers/${enc(previous)}/alias", JSONObject().put("newAppUserId", newAppUserId))
        else api.get("customers/${enc(newAppUserId)}")
        return publish(CustomerInfo.fromJson(info))
    }

    fun logOut() {
        prefs.edit().remove("anon").apply()
        appUserId = anonymousId()
        _customerInfo.value = null
        scope.launch { runCatching { refreshCustomerInfo() } }
    }

    // ── Customer info ────────────────────────────────────────────────────
    fun isEntitled(entitlement: String) = _customerInfo.value?.isEntitled(entitlement) ?: false

    suspend fun refreshCustomerInfo(): CustomerInfo = publish(CustomerInfo.fromJson(api.get("customers/${enc(appUserId)}")))

    suspend fun setAttributes(attributes: Map<String, String?>) {
        val obj = JSONObject(); attributes.forEach { (k, v) -> obj.put(k, v ?: JSONObject.NULL) }
        api.post("customers/${enc(appUserId)}/attributes", JSONObject().put("attributes", obj))
    }

    // ── Offerings ────────────────────────────────────────────────────────
    suspend fun loadOfferings(): Offerings {
        val json = api.get("offerings")
        val raw = json.optJSONObject("offerings") ?: JSONObject()
        val ids = mutableSetOf<String>()
        raw.keys().forEach { k -> raw.getJSONObject(k).optJSONArray("packages")?.let { a ->
            for (i in 0 until a.length()) a.getJSONObject(i).optJSONObject("productIds")?.optString("play_store")?.takeIf { it.isNotEmpty() }?.let(ids::add)
        } }
        loadProducts(ids)
        val all = raw.keys().asSequence().associateWith { k ->
            val o = raw.getJSONObject(k)
            val pk = o.optJSONArray("packages")
            Offering(k, o.optString("description").ifEmpty { null }, (0 until (pk?.length() ?: 0)).map { i ->
                val p = pk!!.getJSONObject(i)
                val pids = p.optJSONObject("productIds") ?: JSONObject()
                val meta = p.optJSONObject("metadata") ?: JSONObject()
                Package(p.getString("id"), pids.keys().asSequence().associateWith { pids.getString(it) },
                    meta.keys().asSequence().associateWith { meta.get(it).toString() }, productDetails[pids.optString("play_store")])
            })
        }
        return Offerings(json.optString("current").ifEmpty { null }?.let { all[it] }, all)
    }

    // ── Purchases ────────────────────────────────────────────────────────
    suspend fun purchase(activity: Activity, pkg: Package, offerToken: String? = null): PurchaseResult {
        val details = pkg.product ?: throw MoneyMakerException("product_not_found", "Play product ${pkg.productIds["play_store"]} not found")
        return purchase(activity, details, offerToken)
    }

    suspend fun purchase(activity: Activity, details: ProductDetails, offerToken: String? = null): PurchaseResult {
        connect()
        val params = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(details).apply {
            val token = offerToken ?: details.subscriptionOfferDetails?.firstOrNull()?.offerToken
            if (token != null) setOfferToken(token)
        }.build()
        val flow = BillingFlowParams.newBuilder().setProductDetailsParamsList(listOf(params))
            .setObfuscatedAccountId(sha256Hex(appUserId)).build()
        val deferred = CompletableDeferred<PurchaseResult>()
        pendingPurchase = deferred
        val launch = billing.launchBillingFlow(activity, flow)
        if (launch.responseCode != BillingClient.BillingResponseCode.OK) {
            pendingPurchase = null
            throw MoneyMakerException("billing_${launch.responseCode}", launch.debugMessage)
        }
        return deferred.await()
    }

    /** Re-posts every purchase owned by the Google account. */
    suspend fun restorePurchases(): CustomerInfo {
        connect()
        syncExistingPurchases()
        return refreshCustomerInfo()
    }

    override fun onPurchasesUpdated(result: BillingResult, purchases: MutableList<Purchase>?) {
        val deferred = pendingPurchase.also { pendingPurchase = null }
        when (result.responseCode) {
            BillingClient.BillingResponseCode.OK -> scope.launch {
                try {
                    var info: CustomerInfo? = null
                    purchases.orEmpty().forEach { p ->
                        if (p.purchaseState == Purchase.PurchaseState.PENDING) { deferred?.complete(PurchaseResult.Pending); return@launch }
                        info = post(p)
                    }
                    deferred?.complete(info?.let { PurchaseResult.Success(it) } ?: PurchaseResult.Pending)
                } catch (e: Exception) { deferred?.completeExceptionally(e) }
            }
            BillingClient.BillingResponseCode.USER_CANCELED -> deferred?.complete(PurchaseResult.UserCancelled)
            else -> deferred?.completeExceptionally(MoneyMakerException("billing_${result.responseCode}", result.debugMessage))
        }
    }

    // ── Internals ────────────────────────────────────────────────────────
    private suspend fun post(p: Purchase): CustomerInfo {
        val productId = p.products.first()
        val details = productDetails[productId] ?: loadProducts(setOf(productId)).let { productDetails[productId] }
        val isSub = details?.productType == BillingClient.ProductType.SUBS
        val phase = details?.subscriptionOfferDetails?.firstOrNull()?.pricingPhases?.pricingPhaseList?.lastOrNull()
        val body = JSONObject().put("purchaseToken", p.purchaseToken).put("productId", productId)
            .put("type", if (isSub) "subscription" else "non_consumable")
        if (phase != null) body.put("priceMicros", phase.priceAmountMicros).put("currency", phase.priceCurrencyCode).put("period", phase.billingPeriod)
        details?.oneTimePurchaseOfferDetails?.let { body.put("priceMicros", it.priceAmountMicros).put("currency", it.priceCurrencyCode) }
        // The backend verifies with Google and acknowledges the purchase server-side.
        return publish(CustomerInfo.fromJson(api.post("customers/${enc(appUserId)}/google", body)))
    }

    private suspend fun syncExistingPurchases() {
        for (type in listOf(BillingClient.ProductType.SUBS, BillingClient.ProductType.INAPP)) {
            val res = billing.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(type).build())
            res.purchasesList.filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }.forEach { runCatching { post(it) } }
        }
    }

    private suspend fun loadProducts(ids: Set<String>) {
        if (ids.isEmpty()) return
        connect()
        for (type in listOf(BillingClient.ProductType.SUBS, BillingClient.ProductType.INAPP)) {
            val params = QueryProductDetailsParams.newBuilder().setProductList(ids.map {
                QueryProductDetailsParams.Product.newBuilder().setProductId(it).setProductType(type).build()
            }).build()
            billing.queryProductDetails(params).productDetailsList?.forEach { productDetails[it.productId] = it }
        }
    }

    private suspend fun connect() {
        if (billing.isReady) return
        suspendCancellableCoroutine { cont ->
            billing.startConnection(object : BillingClientStateListener {
                override fun onBillingSetupFinished(r: BillingResult) { if (cont.isActive) cont.resumeWith(Result.success(Unit)) }
                override fun onBillingServiceDisconnected() {}
            })
        }
    }

    private fun publish(info: CustomerInfo): CustomerInfo {
        if (info.appUserId == appUserId) {
            _customerInfo.value = info
            prefs.edit().putString("info.${info.appUserId}", info.raw.toString()).apply()
            onCustomerInfoUpdate?.invoke(info)
        }
        return info
    }

    private fun cached(id: String) = prefs.getString("info.$id", null)?.let { runCatching { CustomerInfo.fromJson(JSONObject(it)) }.getOrNull() }

    private fun anonymousId(): String = prefs.getString("anon", null) ?: "\$anon:${UUID.randomUUID()}".also { prefs.edit().putString("anon", it).apply() }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}

class MoneyMakerException(val code: String, message: String) : Exception(message)

internal class Api(private val baseUrl: String, private val apiKey: String) {
    suspend fun get(path: String) = request(path, "GET", null)
    suspend fun post(path: String, body: JSONObject) = request(path, "POST", body)

    private suspend fun request(path: String, method: String, body: JSONObject?): JSONObject = withContext(Dispatchers.IO) {
        var last: Exception = MoneyMakerException("network", "unknown")
        repeat(3) { attempt ->
            try {
                val c = (URL("$baseUrl/$path").openConnection() as HttpURLConnection).apply {
                    requestMethod = method; connectTimeout = 15000; readTimeout = 20000
                    setRequestProperty("Authorization", "Bearer $apiKey")
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("User-Agent", "MoneyMaker-Android/1.0")
                    if (body != null) { doOutput = true; outputStream.use { it.write(body.toString().toByteArray()) } }
                }
                val code = c.responseCode
                val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: "{}"
                val json = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
                if (code in 200..299) return@withContext json
                val err = MoneyMakerException(json.optString("error", "http_$code"), json.optString("message"))
                if (code < 500) throw err
                last = err
            } catch (e: MoneyMakerException) {
                if (!e.code.startsWith("http_5") && e.code != "internal_error") throw e
                last = e
            } catch (e: Exception) { last = MoneyMakerException("network", e.message ?: "network error") }
            delay(400L * (attempt + 1))
        }
        throw last
    }
}
