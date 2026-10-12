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
    /** Signature checking of customer-info responses (trusted entitlements). */
    val entitlementVerification: EntitlementVerificationMode = EntitlementVerificationMode.INFORMATIONAL,
) : PurchasesUpdatedListener {

    companion object {
        const val DEFAULT_BASE_URL = "https://moneymaker-io.web.app/v1"
        /** Ed25519 key of the hosted service (GET /v1/signing-key), pinned for DEFAULT_BASE_URL. */
        const val HOSTED_SIGNING_KEY = "9F7dzH51ASV9YKJmckzwJPTmNzoaefMzuOPPz2xXOBA="
        @Volatile private var instance: MoneyMaker? = null

        val shared: MoneyMaker get() = instance ?: error("Call MoneyMaker.configure(context, apiKey) first")
        val isConfigured: Boolean get() = instance != null

        @JvmStatic @JvmOverloads
        fun configure(
            context: Context, apiKey: String, appUserId: String? = null, baseUrl: String = DEFAULT_BASE_URL,
            entitlementVerification: EntitlementVerificationMode = EntitlementVerificationMode.INFORMATIONAL,
        ): MoneyMaker =
            instance ?: synchronized(this) { instance ?: MoneyMaker(context.applicationContext, apiKey, appUserId, baseUrl, entitlementVerification).also { instance = it } }

        /** Ed25519 public key (base64 raw, from GET /v1/signing-key) pinned in the app. Null → fetched once and pinned (TOFU). */
        @JvmStatic var signingPublicKey: String? = null

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
    /** Test Store key (`mm_test_…`): never talks to Google Play; purchases are sandbox grants on the server. */
    val isTestStore: Boolean = apiKey.startsWith("mm_test_")
    private val pending = PendingPurchaseQueue(prefs)
    @Volatile private var flushing = false

    var appUserId: String = appUserId ?: anonymousId(); private set
    val isAnonymous get() = appUserId.startsWith("\$anon:")

    private val _customerInfo = MutableStateFlow(cached(this.appUserId))
    /** Latest known customer state; survives restarts (cached) and works offline. */
    val customerInfo: StateFlow<CustomerInfo?> = _customerInfo
    var onCustomerInfoUpdate: ((CustomerInfo) -> Unit)? = null

    init {
        if (entitlementVerification == EntitlementVerificationMode.ENFORCED && prefs.getString("verification.${this.appUserId}", null) == VerificationResult.FAILED.name)
            _customerInfo.value = _customerInfo.value?.revokingEntitlements()
        scope.launch {
            if (!isTestStore) { flushPendingPurchases(); runCatching { connect(); syncExistingPurchases() } }
            runCatching { refreshCustomerInfo() }
        }
        if (!isTestStore) registerRetryTriggers(context)
    }

    /** Retries queued purchases when connectivity returns and when an activity resumes. */
    private fun registerRetryTriggers(context: Context) {
        if (android.os.Build.VERSION.SDK_INT >= 24) runCatching {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
            cm.registerDefaultNetworkCallback(object : android.net.ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: android.net.Network) { scope.launch { flushPendingPurchases() } }
            })
        }
        (context as? android.app.Application)?.registerActivityLifecycleCallbacks(object : android.app.Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) { scope.launch { flushPendingPurchases() } }
            override fun onActivityCreated(activity: Activity, savedInstanceState: android.os.Bundle?) {}
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: android.os.Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }

    // ── Identity ─────────────────────────────────────────────────────────
    suspend fun logIn(newAppUserId: String): CustomerInfo {
        if (newAppUserId == appUserId) return refreshCustomerInfo()
        val previous = appUserId
        appUserId = newAppUserId
        val info = if (previous.startsWith("\$anon:"))
            fetchCustomerInfo("customers/${enc(previous)}/alias", JSONObject().put("newAppUserId", newAppUserId))
        else fetchCustomerInfo("customers/${enc(newAppUserId)}")
        return publish(info)
    }

    fun logOut() {
        prefs.edit().remove("anon").apply()
        appUserId = anonymousId()
        _customerInfo.value = null
        scope.launch { runCatching { refreshCustomerInfo() } }
    }

    // ── Customer info ────────────────────────────────────────────────────
    fun isEntitled(entitlement: String) = _customerInfo.value?.isEntitled(entitlement) ?: false

    /** Redeems a web purchase made without an account (`…?mm_redeem=TOKEN` from the hosted /pay/success page). Single use. */
    suspend fun redeemWebPurchase(token: String): CustomerInfo =
        publish(CustomerInfo.fromJson(api.post("customers/${enc(appUserId)}/redeem", JSONObject().put("token", token))))

    /** Extracts `mm_redeem` from a deep link (App Links or custom scheme). */
    fun webRedemptionToken(uri: android.net.Uri): String? = uri.getQueryParameter("mm_redeem")

    suspend fun refreshCustomerInfo(): CustomerInfo = try {
        publish(fetchCustomerInfo("customers/${enc(appUserId)}"))
    } catch (e: MoneyMakerException) {
        // Server unreachable: entitlements from owned Play purchases + cached entitlement map.
        if (!isRetryable(e) || isTestStore) throw e
        offlineCustomerInfo()?.let { publish(it, persist = false) } ?: throw e
    }

    /** Entitlements computed on device from Google Play purchases (null before the first loadOfferings()). */
    suspend fun offlineCustomerInfo(): CustomerInfo? {
        val map = cachedEntitlementMap() ?: return null
        val owned = runCatching {
            connect()
            listOf(BillingClient.ProductType.SUBS, BillingClient.ProductType.INAPP).flatMap { type ->
                billing.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(type).build()).purchasesList
                    .filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }
                    .flatMap { p -> p.products.map { it to p.purchaseTime } }
            }
        }.getOrDefault(emptyList())
        return buildOfflineCustomerInfo(appUserId, map, owned, _customerInfo.value)
    }

    /** Fetches customer info with a fresh X-Nonce and verifies the signature per [entitlementVerification]. */
    private suspend fun fetchCustomerInfo(path: String, body: JSONObject? = null): CustomerInfo {
        val nonce = UUID.randomUUID().toString()
        val r = api.raw(path, if (body == null) "GET" else "POST", body, mapOf("X-Nonce" to nonce))
        val info = CustomerInfo.fromJson(JSONObject(r.body))
        if (entitlementVerification == EntitlementVerificationMode.DISABLED || !SignatureVerifier.isSupported) return info
        val key = signingKey() ?: return if (entitlementVerification == EntitlementVerificationMode.ENFORCED) info.revokingEntitlements() else info
        val ok = SignatureVerifier.verify(key, r.headers["x-moneymaker-signature"], nonce, r.headers["x-request-time"], r.body.toByteArray())
        return when {
            ok -> info.copy(verification = VerificationResult.VERIFIED)
            entitlementVerification == EntitlementVerificationMode.ENFORCED -> info.revokingEntitlements()
            else -> info.copy(verification = VerificationResult.FAILED)
        }
    }

    private suspend fun signingKey(): String? {
        signingPublicKey?.let { return it }
        if (baseUrl.startsWith(DEFAULT_BASE_URL)) return HOSTED_SIGNING_KEY
        prefs.getString("signingKey", null)?.let { return it }
        val k = runCatching { api.get("signing-key").getString("publicKey") }.getOrNull() ?: return null
        prefs.edit().putString("signingKey", k).apply()
        return k
    }

    private fun cachedEntitlementMap(): Map<String, List<String>>? = prefs.getString("entitlementMap", null)?.let { s ->
        runCatching { JSONObject(s).let { o -> o.keys().asSequence().associateWith { k -> o.getJSONArray(k).let { a -> (0 until a.length()).map(a::getString) } } } }.getOrNull()
    }

    /** Re-posts purchases queued while offline. */
    suspend fun flushPendingPurchases() {
        if (isTestStore || flushing) return
        flushing = true
        try {
            var last: CustomerInfo? = null
            for (item in pending.items()) {
                try {
                    last = fetchCustomerInfo("customers/${enc(item.appUserId)}/google", item.body)
                    pending.remove(item.purchaseToken)
                } catch (e: Exception) {
                    if (isRetryable(e)) break
                    pending.remove(item.purchaseToken) // rejected (4xx): retrying won't help
                }
            }
            last?.let { publish(it) }
        } finally { flushing = false }
    }

    suspend fun setAttributes(attributes: Map<String, String?>) {
        val obj = JSONObject(); attributes.forEach { (k, v) -> obj.put(k, v ?: JSONObject.NULL) }
        api.post("customers/${enc(appUserId)}/attributes", JSONObject().put("attributes", obj))
    }

    /** Balances of the virtual currencies configured in the dashboard (credited automatically on purchases).
     *  Spending is server-side only (secret key): POST /v1/customers/{id}/wallet/{code}/spend. */
    suspend fun virtualCurrencies(): Map<String, VirtualCurrencyBalance> {
        val obj = JSONObject(api.raw("customers/${enc(appUserId)}/wallet", "GET", null).body).optJSONObject("virtualCurrencies") ?: JSONObject()
        return obj.keys().asSequence().associateWith { k ->
            val c = obj.getJSONObject(k)
            VirtualCurrencyBalance(c.optString("code", k), c.optString("name", k), c.optLong("balance", 0))
        }
    }

    // ── Offerings ────────────────────────────────────────────────────────
    private val appVersion: String? = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull()
    var offerings: Offerings? = null; private set

    suspend fun loadOfferings(): Offerings {
        val q = buildList {
            add("appUserId=${enc(appUserId)}"); add("platform=android")
            appVersion?.let { add("appVersion=${enc(it)}") }
            java.util.Locale.getDefault().country.takeIf { it.length == 2 }?.let { add("country=$it") }
        }.joinToString("&")
        val json = api.get("offerings?$q")
        json.optJSONObject("entitlements")?.let { prefs.edit().putString("entitlementMap", it.toString()).apply() }
        val raw = json.optJSONObject("offerings") ?: JSONObject()
        val ids = mutableSetOf<String>()
        raw.keys().forEach { k -> raw.getJSONObject(k).optJSONArray("packages")?.let { a ->
            for (i in 0 until a.length()) a.getJSONObject(i).optJSONObject("productIds")?.optString("play_store")?.takeIf { it.isNotEmpty() }?.let(ids::add)
        } }
        if (!isTestStore) loadProducts(ids)
        val all = raw.keys().asSequence().associateWith { k ->
            val o = raw.getJSONObject(k)
            val pk = o.optJSONArray("packages")
            Offering(k, o.optString("description").ifEmpty { null }, paywallJson = o.optJSONObject("paywall")?.toString(), packages = (0 until (pk?.length() ?: 0)).map { i ->
                val p = pk!!.getJSONObject(i)
                val pids = p.optJSONObject("productIds") ?: JSONObject()
                val meta = p.optJSONObject("metadata") ?: JSONObject()
                Package(p.getString("id"), pids.keys().asSequence().associateWith { pids.getString(it) },
                    meta.keys().asSequence().associateWith { meta.get(it).toString() }, productDetails[pids.optString("play_store")], isTestStore)
            })
        }
        val pl = json.optJSONObject("placements") ?: JSONObject()
        val ex = json.optJSONArray("experiments")
        return Offerings(
            json.optString("current").ifEmpty { null }?.let { all[it] }, all,
            pl.keys().asSequence().filter { !pl.isNull(it) }.associateWith { pl.getString(it) },
            (0 until (ex?.length() ?: 0)).map { i -> ex!!.getJSONObject(i).let { ExperimentAssignment(it.getString("experimentId"), it.getString("variant"), it.getString("placement"), it.getString("offeringId")) } },
            json.optJSONObject("entitlements")?.let { o -> o.keys().asSequence().associateWith { k -> o.getJSONArray(k).let { a -> (0 until a.length()).map(a::getString) } } } ?: emptyMap(),
        ).also { offerings = it }
    }

    /** Offering resolved for a placement. Call loadOfferings() first. */
    fun offeringForPlacement(placement: String): Offering? = offerings?.offeringForPlacement(placement)

    /** Paywall analytics + experiment results. Call from your paywall UI (impression, close, purchase_start, purchase, cancel). */
    suspend fun trackPaywallEvent(type: PaywallEventType, offering: Offering, placement: String? = null) {
        val body = JSONObject().put("type", type.wire).put("offeringId", offering.id)
        placement?.let { body.put("placement", it) }
        offerings?.experiment(offering.id, placement)?.let { body.put("experimentId", it.experimentId).put("variant", it.variant) }
        runCatching { api.post("customers/${enc(appUserId)}/paywall-events", body) }
    }

    // ── Purchases ────────────────────────────────────────────────────────
    suspend fun purchase(activity: Activity, pkg: Package, offerToken: String? = null): PurchaseResult {
        if (isTestStore) return testPurchase(pkg.productIds["play_store"] ?: pkg.id)
        val details = pkg.product ?: throw MoneyMakerException("product_not_found", "Play product ${pkg.productIds["play_store"]} not found")
        return purchase(activity, details, offerToken)
    }

    /** Test Store purchase (mm_test_ key): sandbox grant on the server, no Google Play. */
    suspend fun testPurchase(productId: String): PurchaseResult {
        check(isTestStore) { "testPurchase requires a Test Store key (mm_test_…)" }
        return PurchaseResult.Success(publish(fetchCustomerInfo("customers/${enc(appUserId)}/test-purchase", JSONObject().put("productId", productId))))
    }

    suspend fun purchase(activity: Activity, details: ProductDetails, offerToken: String? = null): PurchaseResult {
        if (isTestStore) return testPurchase(details.productId)
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

    // ── Customer Center ──

    /** Customer Center configuration from the dashboard (survey, retention offer, support email). */
    suspend fun customerCenterConfig(): JSONObject = api.get("customer-center")

    /**
     * Opens Google Play's subscription management for the active Play subscription
     * (or the generic subscriptions list when there is none).
     */
    fun showCustomerCenter(activity: Activity) {
        val sku = _customerInfo.value?.entitlements?.values
            ?.firstOrNull { it.active && it.store == "play_store" }?.productId
        val url = if (sku != null)
            "https://play.google.com/store/account/subscriptions?sku=${enc(sku)}&package=${enc(activity.packageName)}"
        else "https://play.google.com/store/account/subscriptions"
        activity.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)))
    }

    /** Records a cancellation reason / action. action ∈ cancel, accepted_offer, refund, dismissed, contact_support. */
    suspend fun sendCustomerCenterFeedback(reason: String, action: String, comment: String? = null) {
        val body = JSONObject().put("reason", reason).put("action", action)
        if (!comment.isNullOrBlank()) body.put("comment", comment)
        api.post("customers/${enc(appUserId)}/customer-center/feedback", body)
    }

    /** Re-posts every purchase owned by the Google account. */
    suspend fun restorePurchases(): CustomerInfo {
        if (isTestStore) return refreshCustomerInfo()
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
        // The backend verifies with Google and acknowledges the purchase server-side, only once it accepted it.
        // Offline / 5xx: queue the token (retried later), entitlements computed on device meanwhile.
        return try {
            publish(fetchCustomerInfo("customers/${enc(appUserId)}/google", body)).also { pending.remove(p.purchaseToken) }
        } catch (e: MoneyMakerException) {
            if (!isRetryable(e)) throw e
            pending.enqueue(PendingPurchaseQueue.Item(p.purchaseToken, appUserId, body))
            offlineCustomerInfo()?.let { publish(it, persist = false) } ?: throw e
        }
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

    private fun publish(info: CustomerInfo, persist: Boolean = true): CustomerInfo {
        if (info.appUserId == appUserId) {
            _customerInfo.value = info
            if (persist) prefs.edit().putString("info.${info.appUserId}", info.raw.toString())
                .putString("verification.${info.appUserId}", info.verification.name).apply()
            onCustomerInfoUpdate?.invoke(info)
        }
        return info
    }

    private fun cached(id: String) = prefs.getString("info.$id", null)?.let { runCatching { CustomerInfo.fromJson(JSONObject(it)) }.getOrNull() }

    private fun anonymousId(): String = prefs.getString("anon", null) ?: "\$anon:${UUID.randomUUID()}".also { prefs.edit().putString("anon", it).apply() }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}

class MoneyMakerException(val code: String, message: String) : Exception(message)

data class VirtualCurrencyBalance(val code: String, val name: String, val balance: Long)

internal class Api(private val baseUrl: String, private val apiKey: String) {
    suspend fun get(path: String) = request(path, "GET", null)
    suspend fun post(path: String, body: JSONObject) = request(path, "POST", body)

    class RawResponse(val body: String, val headers: Map<String, String>)

    private suspend fun request(path: String, method: String, body: JSONObject?): JSONObject =
        runCatching { JSONObject(raw(path, method, body).body) }.getOrDefault(JSONObject())

    /** Raw 2xx body + lower-cased headers (body bytes are needed to verify signatures). Retries network / 5xx. */
    suspend fun raw(path: String, method: String, body: JSONObject?, headers: Map<String, String> = emptyMap()): RawResponse = withContext(Dispatchers.IO) {
        var last: Exception = MoneyMakerException("network", "unknown")
        repeat(3) { attempt ->
            try {
                val c = (URL("$baseUrl/$path").openConnection() as HttpURLConnection).apply {
                    requestMethod = method; connectTimeout = 15000; readTimeout = 20000
                    setRequestProperty("Authorization", "Bearer $apiKey")
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("User-Agent", "MoneyMaker-Android/1.0")
                    headers.forEach { (k, v) -> setRequestProperty(k, v) }
                    if (body != null) { doOutput = true; outputStream.use { it.write(body.toString().toByteArray()) } }
                }
                val code = c.responseCode
                val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: "{}"
                val json = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
                if (code in 200..299) return@withContext RawResponse(text, c.headerFields.filterKeys { it != null }.mapKeys { it.key.lowercase() }.mapValues { it.value.firstOrNull() ?: "" })
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
