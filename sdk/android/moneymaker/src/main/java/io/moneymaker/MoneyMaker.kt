package io.moneymaker

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import com.android.billingclient.api.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * MoneyMaker — subscriptions for Google Play, App Store and Stripe on your own backend.
 *
 * ```kotlin
 * MoneyMaker.configure(context, apiKey = "mm_pub_…", appUserId = user.id)
 * MoneyMaker.shared.customerInfo.collect { if (it?.isEntitled("premium") == true) … }
 * MoneyMaker.shared.purchase(activity, offerings.current!!.packages.first())
 * ```
 *
 * Consumable one-time products (coins, credits…) must be declared with `consumableProductIds`: they are sent as
 * `consumable` and consumed after the server validated them, so they can be bought again.
 */
class MoneyMaker private constructor(
    context: Context,
    private val apiKey: String,
    appUserId: String?,
    private val baseUrl: String,
    /** Signature checking of customer-info responses (trusted entitlements). */
    val entitlementVerification: EntitlementVerificationMode = EntitlementVerificationMode.INFORMATIONAL,
    consumableProductIds: Set<String> = emptySet(),
) : PurchasesUpdatedListener {

    companion object {
        const val SDK_VERSION = "1.2.0"
        const val DEFAULT_BASE_URL = "https://usemoneymaker.com/v1"
        /** Ed25519 key of the hosted service (GET /v1/signing-key), pinned for the hosted API hosts below. */
        const val HOSTED_SIGNING_KEY = "9F7dzH51ASV9YKJmckzwJPTmNzoaefMzuOPPz2xXOBA="
        /** Hosts serving the hosted API (same signing key): usemoneymaker.com and the former Firebase Hosting domain. */
        internal val HOSTED_HOSTS = setOf("usemoneymaker.com", "moneymaker-io.web.app")
        private const val CONNECT_TIMEOUT_MS = 30_000L
        @Volatile private var instance: MoneyMaker? = null

        val shared: MoneyMaker get() = instance ?: error("Call MoneyMaker.configure(context, apiKey) first")
        val isConfigured: Boolean get() = instance != null

        /**
         * @param consumableProductIds Play one-time products that are consumable (coins, credits…): consumed after
         * server validation so they can be bought again. Other one-time products are non-consumable.
         */
        @JvmStatic @JvmOverloads
        fun configure(
            context: Context, apiKey: String, appUserId: String? = null, baseUrl: String = DEFAULT_BASE_URL,
            entitlementVerification: EntitlementVerificationMode = EntitlementVerificationMode.INFORMATIONAL,
            consumableProductIds: Set<String> = emptySet(),
        ): MoneyMaker =
            instance ?: synchronized(this) { instance ?: MoneyMaker(context.applicationContext, apiKey, appUserId, baseUrl, entitlementVerification, consumableProductIds).also { instance = it } }

        /** True when [baseUrl] is the hosted API (its signing key is pinned in the SDK). */
        internal fun isHostedBaseUrl(baseUrl: String): Boolean =
            runCatching { java.net.URI(baseUrl).host.lowercase() in HOSTED_HOSTS }.getOrDefault(false)

        /** Ed25519 public key (base64 raw, from GET /v1/signing-key) pinned in the app. Null → fetched once and pinned (TOFU). */
        @JvmStatic var signingPublicKey: String? = null

        internal fun sha256Hex(s: String): String =
            MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val prefs: SharedPreferences = context.getSharedPreferences("moneymaker.${apiKey.takeLast(8)}", Context.MODE_PRIVATE)
    private val api = Api(baseUrl, apiKey)
    private val billing = BillingClient.newBuilder(context).setListener(this)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .enableAutoServiceReconnection()
        .build()
    private val connectMutex = Mutex()
    private var pendingPurchase: CompletableDeferred<PurchaseResult>? = null
    private val productDetails = java.util.concurrent.ConcurrentHashMap<String, ProductDetails>()
    /** Offer chosen at purchase time, per product (price / period hints sent with the purchase token). */
    private val chosenOffers = java.util.concurrent.ConcurrentHashMap<String, OfferCandidate>()

    /** One-time products to consume after server validation (see [configure]). Can be changed at runtime. */
    @Volatile var consumableProductIds: Set<String> = consumableProductIds.toSet()
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
    /**
     * Identifies the user. Purchases made while anonymous are moved to this id, then the purchases owned by the
     * Google account are re-synced (same as iOS). The current id only changes once the server answered:
     * on failure the SDK stays on the previous id.
     */
    suspend fun logIn(newAppUserId: String): CustomerInfo {
        require(newAppUserId.isNotBlank()) { "appUserId must not be blank" }
        if (newAppUserId == appUserId) return refreshCustomerInfo()
        val previous = appUserId
        val info = if (previous.startsWith("\$anon:"))
            fetchCustomerInfo("customers/${enc(previous)}/alias", JSONObject().put("newAppUserId", newAppUserId))
        else fetchCustomerInfo("customers/${enc(newAppUserId)}")
        appUserId = newAppUserId
        publish(info)
        if (!isTestStore) runCatching { connect(); syncExistingPurchases() }
        return _customerInfo.value?.takeIf { it.appUserId == newAppUserId } ?: info
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
                queryPurchases(type)
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
        val info = try { CustomerInfo.fromJson(JSONObject(r.body)) } catch (e: JSONException) {
            throw MoneyMakerException("invalid_response", "Invalid customer info from /$path", r.status, cause = e)
        }
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
        if (isHostedBaseUrl(baseUrl)) return HOSTED_SIGNING_KEY
        prefs.getString("signingKey", null)?.let { return it }
        val k = runCatching { api.get("signing-key").getString("publicKey") }.getOrNull() ?: return null
        prefs.edit().putString("signingKey", k).apply()
        return k
    }

    private fun cachedEntitlementMap(): Map<String, List<String>>? = prefs.getString("entitlementMap", null)?.let { s ->
        runCatching { JSONObject(s).let { o -> o.keys().asSequence().associateWith { k -> o.getJSONArray(k).let { a -> (0 until a.length()).map(a::getString) } } } }.getOrNull()
    }

    /** Re-posts purchases queued while offline (and consumes the consumables the server accepted). */
    suspend fun flushPendingPurchases() {
        if (isTestStore || flushing) return
        flushing = true
        try {
            var last: CustomerInfo? = null
            for (item in pending.items()) {
                try {
                    last = fetchCustomerInfo("customers/${enc(item.appUserId)}/google", item.body)
                    pending.remove(item.purchaseToken)
                    if (item.body.optString("type") == "consumable") consume(item.purchaseToken)
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
        val obj = api.get("customers/${enc(appUserId)}/wallet").optJSONObject("virtualCurrencies") ?: JSONObject()
        return obj.keys().asSequence().associateWith { k ->
            val c = obj.getJSONObject(k)
            VirtualCurrencyBalance(c.optString("code", k), c.optString("name", k), c.optLong("balance", 0))
        }
    }

    // ── Offerings ────────────────────────────────────────────────────────
    private val appVersion: String? = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull()
    var offerings: Offerings? = null; private set

    /**
     * Loads the offerings configured in the dashboard and the Play product details.
     * Throws [MoneyMakerException] when the API is unreachable or rejects the request (never returns empty offerings
     * silently). On a device without Google Play (`BILLING_UNAVAILABLE`) offerings are returned with `product == null`.
     */
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
            for (i in 0 until a.length()) a.getJSONObject(i).optJSONObject("productIds")?.optString("play_store")?.takeIf { it.isNotEmpty() }?.let { ids.add(playProductId(it)) }
        } }
        if (!isTestStore) try { loadProducts(ids) } catch (e: MoneyMakerException) {
            if (e.billingResponseCode != BillingClient.BillingResponseCode.BILLING_UNAVAILABLE) throw e
            android.util.Log.w("MoneyMaker", "Google Play Billing unavailable on this device: offerings without Play products")
        }
        val all = raw.keys().asSequence().associateWith { k ->
            val o = raw.getJSONObject(k)
            val pk = o.optJSONArray("packages")
            Offering(k, o.optString("description").ifEmpty { null }, paywallJson = o.optJSONObject("paywall")?.toString(), packages = (0 until (pk?.length() ?: 0)).map { i ->
                val p = pk!!.getJSONObject(i)
                val pids = p.optJSONObject("productIds") ?: JSONObject()
                val meta = p.optJSONObject("metadata") ?: JSONObject()
                Package(p.getString("id"), pids.keys().asSequence().associateWith { pids.getString(it) },
                    meta.keys().asSequence().associateWith { meta.get(it).toString() }, productDetails[playProductId(pids.optString("play_store"))], isTestStore)
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

    // ── Ad revenue (AdMob, AppLovin…) ────────────────────────────────────
    /**
     * Impression-level ad revenue. Values map 1:1 to Google Mobile Ads' OnPaidEventListener:
     * `ad.onPaidEventListener = OnPaidEventListener { v -> scope.launch { MoneyMaker.shared.trackAdRevenue(v.valueMicros, v.currencyCode, v.precisionType, ad.adUnitId) } }`.
     * precision: 0 unknown, 1 estimated, 2 publisher provided, 3 precise. type: "impression" (default), "click", "rewarded".
     */
    suspend fun trackAdRevenue(valueMicros: Long, currencyCode: String, precision: Int = 0, adUnitId: String,
                               network: String = "admob", placement: String? = null, type: String = "impression") {
        val body = JSONObject().put("type", type).put("network", network).put("adUnitId", adUnitId)
            .put("revenueMicros", valueMicros).put("currency", currencyCode).put("precision", precision)
        placement?.let { body.put("placement", it) }
        runCatching { api.post("customers/${enc(appUserId)}/ad-events", body) }
    }

    /** Impression without (or before) a paid value. */
    suspend fun trackAdImpression(adUnitId: String, network: String = "admob", placement: String? = null,
                                  valueMicros: Long = 0, currencyCode: String = "USD", precision: Int = 0) =
        trackAdRevenue(valueMicros, currencyCode, precision, adUnitId, network, placement, "impression")

    // ── Purchases ────────────────────────────────────────────────────────
    /**
     * Buys a package. Subscriptions: the base plan without offer is bought unless [offerToken] or [offerId] is given
     * (a `play_store` id of the form `productId:basePlanId` selects that base plan).
     */
    suspend fun purchase(activity: Activity, pkg: Package, offerToken: String? = null, offerId: String? = null): PurchaseResult {
        if (isTestStore) return testPurchase(pkg.productIds["play_store"]?.let(::playProductId) ?: pkg.id)
        val details = pkg.product ?: throw MoneyMakerException("product_not_found", "Play product ${pkg.productIds["play_store"]} not found")
        return purchase(activity, details, offerToken, basePlanId = pkg.productIds["play_store"]?.let(::playBasePlanId), offerId = offerId)
    }

    /** Test Store purchase (mm_test_ key): sandbox grant on the server, no Google Play. */
    suspend fun testPurchase(productId: String): PurchaseResult {
        check(isTestStore) { "testPurchase requires a Test Store key (mm_test_…)" }
        return PurchaseResult.Success(publish(fetchCustomerInfo("customers/${enc(appUserId)}/test-purchase", JSONObject().put("productId", productId))))
    }

    /**
     * Buys a Play product. Subscriptions: [offerToken] wins, then [offerId] (within [basePlanId] when given),
     * otherwise the base plan **without offer** ([basePlanId], or the first base plan).
     */
    suspend fun purchase(activity: Activity, details: ProductDetails, offerToken: String? = null,
                         basePlanId: String? = null, offerId: String? = null): PurchaseResult {
        if (isTestStore) return testPurchase(details.productId)
        connect()
        val offer = if (details.productType == BillingClient.ProductType.SUBS) {
            selectOffer(details.offerCandidates(), offerToken, basePlanId, offerId)
                ?: throw MoneyMakerException("offer_not_found", "No subscription offer for ${details.productId}" +
                    listOfNotNull(offerToken?.let { "offerToken" }, basePlanId?.let { "basePlanId=$it" }, offerId?.let { "offerId=$it" })
                        .takeIf { it.isNotEmpty() }?.joinToString(prefix = " (", postfix = ")").orEmpty())
        } else null
        offer?.let { chosenOffers[details.productId] = it }
        val params = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(details).apply {
            if (offer != null) setOfferToken(offer.offerToken)
        }.build()
        val flow = BillingFlowParams.newBuilder().setProductDetailsParamsList(listOf(params))
            .setObfuscatedAccountId(sha256Hex(appUserId)).build()
        val deferred = CompletableDeferred<PurchaseResult>()
        pendingPurchase = deferred
        val launch = billing.launchBillingFlow(activity, flow)
        if (launch.responseCode != BillingClient.BillingResponseCode.OK) {
            pendingPurchase = null
            throw billingError(launch, "launchBillingFlow")
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
            else -> deferred?.completeExceptionally(billingError(result, "purchase"))
        }
    }

    // ── Internals ────────────────────────────────────────────────────────
    private suspend fun post(p: Purchase): CustomerInfo {
        val productId = p.products.first()
        val details = productDetails[productId] ?: runCatching { loadProducts(setOf(productId)) }.let { productDetails[productId] }
        val isSub = details?.productType == BillingClient.ProductType.SUBS
        val type = purchaseType(isSub, productId, consumableProductIds)
        // Hints: the offer bought in this session, else the purchase's own base plan when unambiguous.
        val offer = if (isSub) chosenOffers[productId] ?: details.offerCandidates().let { c ->
            c.map { it.basePlanId }.distinct().singleOrNull()?.let { selectOffer(c, basePlanId = it) }
        } else null
        val oneTime = details?.oneTimePurchaseOfferDetails
        val body = googlePurchaseBody(p.purchaseToken, productId, type, offer, oneTime?.priceAmountMicros, oneTime?.priceCurrencyCode)
        // The backend verifies with Google and acknowledges the purchase server-side, only once it accepted it
        // (consumables are not acknowledged by the server: they are consumed here, after validation).
        // Offline / 5xx: queue the token (retried later), entitlements computed on device meanwhile.
        return try {
            val info = fetchCustomerInfo("customers/${enc(appUserId)}/google", body)
            pending.remove(p.purchaseToken)
            if (type == "consumable") consume(p.purchaseToken)
            publish(info)
        } catch (e: MoneyMakerException) {
            if (!isRetryable(e)) throw e
            pending.enqueue(PendingPurchaseQueue.Item(p.purchaseToken, appUserId, body))
            offlineCustomerInfo()?.let { publish(it, persist = false) } ?: throw e
        }
    }

    /**
     * Posts a purchase from another store to `POST /v1/customers/{id}/{store}` (store = "amazon", "galaxy", "roku")
     * and publishes the verified customer info. Used by optional modules such as `moneymaker-amazon`.
     */
    suspend fun syncStorePurchase(store: String, body: JSONObject): CustomerInfo {
        require(store in setOf("amazon", "galaxy", "roku")) { "Unsupported store: $store" }
        return publish(fetchCustomerInfo("customers/${enc(appUserId)}/$store", body))
    }

    /** Re-posts every owned purchase (idempotent server-side); unconsumed consumables are consumed once accepted. */
    private suspend fun syncExistingPurchases() {
        for (type in listOf(BillingClient.ProductType.SUBS, BillingClient.ProductType.INAPP)) {
            queryPurchases(type).filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }.forEach { runCatching { post(it) } }
        }
    }

    private suspend fun queryPurchases(type: String): List<Purchase> = suspendCancellableCoroutine { cont ->
        billing.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(type).build()) { r, list ->
            if (!cont.isActive) return@queryPurchasesAsync
            if (r.responseCode == BillingClient.BillingResponseCode.OK) cont.resume(list) else cont.resumeWithException(billingError(r, "queryPurchases"))
        }
    }

    /** Consumes a consumable once the server accepted it (consuming also acknowledges it), so it can be bought again. */
    private suspend fun consume(purchaseToken: String) {
        try {
            connect()
            val r = suspendCancellableCoroutine<BillingResult> { cont ->
                billing.consumeAsync(ConsumeParams.newBuilder().setPurchaseToken(purchaseToken).build()) { result, _ -> if (cont.isActive) cont.resume(result) }
            }
            if (r.responseCode != BillingClient.BillingResponseCode.OK && r.responseCode != BillingClient.BillingResponseCode.ITEM_NOT_OWNED)
                android.util.Log.w("MoneyMaker", "consume failed (${r.responseCode}): ${r.debugMessage}; retried at the next purchase sync")
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            android.util.Log.w("MoneyMaker", "consume failed: ${e.message}; retried at the next purchase sync")
        }
    }

    private suspend fun loadProducts(ids: Set<String>) {
        if (ids.isEmpty()) return
        connect()
        val fetched = mutableSetOf<String>()
        for (type in listOf(BillingClient.ProductType.SUBS, BillingClient.ProductType.INAPP)) {
            val params = QueryProductDetailsParams.newBuilder().setProductList(ids.map {
                QueryProductDetailsParams.Product.newBuilder().setProductId(it).setProductType(type).build()
            }).build()
            // PBL 8: QueryProductDetailsResult = fetched productDetailsList + unfetchedProductList (with a status code).
            val result = suspendCancellableCoroutine<QueryProductDetailsResult> { cont ->
                billing.queryProductDetailsAsync(params) { r, res ->
                    if (!cont.isActive) return@queryProductDetailsAsync
                    if (r.responseCode == BillingClient.BillingResponseCode.OK) cont.resume(res) else cont.resumeWithException(billingError(r, "queryProductDetails"))
                }
            }
            result.productDetailsList.forEach { productDetails[it.productId] = it; fetched += it.productId }
        }
        // Each id is queried as SUBS and INAPP, so it is "unfetched" for one of them: only report ids missing from both.
        (ids - fetched).takeIf { it.isNotEmpty() }?.let { android.util.Log.w("MoneyMaker", "Play products not found or unavailable: ${it.joinToString()}") }
    }

    /**
     * Connects to Play Billing. Throws [MoneyMakerException] (`billing_<code>`) when setup fails
     * (e.g. `BILLING_UNAVAILABLE`), when the service disconnects before setup finished, or after 30 s.
     */
    private suspend fun connect() {
        if (billing.isReady) return
        connectMutex.withLock {
            if (billing.isReady) return
            val r = try {
                withTimeout(CONNECT_TIMEOUT_MS) {
                    suspendCancellableCoroutine<BillingResult> { cont ->
                        billing.startConnection(object : BillingClientStateListener {
                            override fun onBillingSetupFinished(r: BillingResult) { if (cont.isActive) cont.resume(r) }
                            override fun onBillingServiceDisconnected() {
                                if (cont.isActive) cont.resumeWithException(billingError(BillingClient.BillingResponseCode.SERVICE_DISCONNECTED, "disconnected before setup finished", "connect"))
                            }
                        })
                    }
                }
            } catch (e: TimeoutCancellationException) {
                throw billingError(BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE, "setup timed out after 30 s", "connect")
            }
            if (r.responseCode != BillingClient.BillingResponseCode.OK) throw billingError(r, "connect")
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

/**
 * Error thrown by the SDK. [code] is the server error code (`invalid_api_key`…), `http_<status>`, `network`,
 * `invalid_response`, `product_not_found`, `offer_not_found` or `billing_<responseCode>` (Play Billing).
 */
class MoneyMakerException @JvmOverloads constructor(
    val code: String,
    message: String,
    /** HTTP status for API errors, 0 otherwise. */
    val status: Int = 0,
    /** Play Billing response code for `billing_<n>` errors. */
    val billingResponseCode: Int? = null,
    cause: Throwable? = null,
) : Exception(message, cause) {
    /** Network failure, 5xx or 429: worth retrying later (purchases are queued). */
    val isRetryable: Boolean get() = code == "network" || status >= 500 || status == 429
}

data class VirtualCurrencyBalance(val code: String, val name: String, val balance: Long)

internal class Api(
    private val baseUrl: String,
    private val apiKey: String,
    private val retryDelayMs: Long = 400,
    private val maxAttempts: Int = 3,
) {
    suspend fun get(path: String) = request(path, "GET", null)
    suspend fun post(path: String, body: JSONObject) = request(path, "POST", body)

    class RawResponse(val body: String, val headers: Map<String, String>, val status: Int = 200)

    /** JSON body of a 2xx response. Throws [MoneyMakerException] on any failure (never an empty object). */
    suspend fun request(path: String, method: String, body: JSONObject?): JSONObject {
        val r = raw(path, method, body)
        return try { JSONObject(r.body) } catch (e: JSONException) {
            throw MoneyMakerException("invalid_response", "Invalid JSON from $method /$path", r.status, cause = e)
        }
    }

    /** Raw 2xx body + lower-cased headers (body bytes are needed to verify signatures). Retries network errors and every 5xx. */
    suspend fun raw(path: String, method: String, body: JSONObject?, headers: Map<String, String> = emptyMap()): RawResponse = withContext(Dispatchers.IO) {
        var last = MoneyMakerException("network", "unknown network error")
        for (attempt in 0 until maxAttempts) {
            if (attempt > 0) delay(retryDelayMs * attempt)
            val r = try { exchange(path, method, body, headers) } catch (e: IOException) {
                last = MoneyMakerException("network", e.message ?: "network error", cause = e); continue
            }
            if (r.status in 200..299) return@withContext r
            val json = runCatching { JSONObject(r.body) }.getOrNull()
            val err = MoneyMakerException(json?.optString("error")?.takeIf { it.isNotEmpty() } ?: "http_${r.status}",
                json?.optString("message")?.takeIf { it.isNotEmpty() } ?: "HTTP ${r.status} on $method /$path", r.status)
            if (r.status < 500) throw err // 4xx: retrying won't help (429 is retryable at the queue level)
            last = err
        }
        throw last
    }

    private fun exchange(path: String, method: String, body: JSONObject?, headers: Map<String, String>): RawResponse {
        val c = (URL("$baseUrl/$path").openConnection() as HttpURLConnection)
        try {
            c.requestMethod = method; c.connectTimeout = 15000; c.readTimeout = 20000
            c.setRequestProperty("Authorization", "Bearer $apiKey")
            c.setRequestProperty("Content-Type", "application/json")
            c.setRequestProperty("User-Agent", "MoneyMaker-Android/${MoneyMaker.SDK_VERSION}")
            headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
            if (body != null) { c.doOutput = true; c.outputStream.use { it.write(body.toString().toByteArray()) } }
            val code = c.responseCode
            val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            val h = c.headerFields.filterKeys { it != null }.mapKeys { it.key.lowercase() }.mapValues { it.value.firstOrNull() ?: "" }
            return RawResponse(text, h, code)
        } finally { c.disconnect() }
    }
}
