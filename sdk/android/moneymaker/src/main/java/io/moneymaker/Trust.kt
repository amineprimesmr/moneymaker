package io.moneymaker

import android.content.SharedPreferences
import android.os.Build
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/** Signature checking of customer-info responses (`X-MoneyMaker-Signature`, Ed25519). */
enum class EntitlementVerificationMode { DISABLED, INFORMATIONAL, ENFORCED }

enum class VerificationResult {
    /** Signed by the MoneyMaker server for this request. */
    VERIFIED,
    /** Signature missing or invalid. */
    FAILED,
    /** Verification disabled, unsupported (Android < 13), no key, or loaded from cache. */
    NOT_REQUESTED,
    /** Computed offline from Google Play purchases (server unreachable). */
    VERIFIED_ON_DEVICE,
}

/**
 * Ed25519 verification. Uses the platform provider (`Signature.getInstance("Ed25519")`, Android 13+ / API 33);
 * on older devices verification is reported as NOT_REQUESTED (never blocks entitlements).
 * Public key: `MoneyMaker.signingPublicKey` (hard-coded at release) or fetched once from GET /v1/signing-key and pinned (TOFU).
 */
internal object SignatureVerifier {
    private val SPKI_PREFIX = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)

    val isSupported: Boolean get() = Build.VERSION.SDK_INT >= 33

    fun message(nonce: String, requestTime: String, body: ByteArray): ByteArray {
        val hash = MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) }
        return "$nonce.$requestTime.$hash".toByteArray()
    }

    fun verify(publicKeyB64: String, header: String?, nonce: String, requestTime: String?, body: ByteArray): Boolean = runCatching {
        if (header == null || !header.startsWith("v1=") || requestTime == null) return false
        val raw = Base64.decode(publicKeyB64, Base64.DEFAULT)
        require(raw.size == 32)
        val key = KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(SPKI_PREFIX + raw))
        Signature.getInstance("Ed25519").run {
            initVerify(key)
            update(message(nonce, requestTime, body))
            verify(Base64.decode(header.removePrefix("v1="), Base64.DEFAULT))
        }
    }.getOrDefault(false)
}

/**
 * Google Play purchases whose token could not reach the server (network / 5xx). Persisted in SharedPreferences,
 * retried on launch, on resume and when connectivity returns. The backend acknowledges the purchase only once it
 * accepted it, so an unsent purchase stays unacknowledged (Play refunds after 3 days → retry matters).
 */
internal class PendingPurchaseQueue(private val prefs: SharedPreferences) {
    data class Item(val purchaseToken: String, val appUserId: String, val body: JSONObject)

    @Synchronized fun items(): List<Item> = runCatching {
        val a = JSONArray(prefs.getString("pendingPurchases", "[]"))
        (0 until a.length()).map { a.getJSONObject(it).let { o -> Item(o.getString("token"), o.getString("appUserId"), o.getJSONObject("body")) } }
    }.getOrDefault(emptyList())

    @Synchronized fun enqueue(item: Item) = save(items().filter { it.purchaseToken != item.purchaseToken } + item)
    @Synchronized fun remove(token: String) = save(items().filter { it.purchaseToken != token })

    private fun save(items: List<Item>) {
        val a = JSONArray()
        items.takeLast(100).forEach { a.put(JSONObject().put("token", it.purchaseToken).put("appUserId", it.appUserId).put("body", it.body)) }
        prefs.edit().putString("pendingPurchases", a.toString()).apply()
    }
}

/** Builds customer info locally from owned Play products + cached entitlement → products map. */
internal fun buildOfflineCustomerInfo(appUserId: String, entitlementMap: Map<String, List<String>>, owned: List<Pair<String, Long>>, previous: CustomerInfo?): CustomerInfo {
    val ents = JSONObject()
    for ((id, products) in entitlementMap) {
        val match = owned.firstOrNull { (pid, _) -> "*" in products || pid in products } ?: continue
        ents.put(id, JSONObject().put("id", id).put("active", true).put("productId", match.first).put("store", "play_store")
            .put("expiresAt", JSONObject.NULL).put("willRenew", false).put("isTrial", false).put("billingIssue", false).put("purchasedAt", match.second))
    }
    val active = JSONArray(); ents.keys().forEach { active.put(it) }
    val attrs = JSONObject(); previous?.attributes?.forEach { (k, v) -> attrs.put(k, v) }
    val j = JSONObject().put("appUserId", appUserId).put("entitlements", ents).put("activeEntitlements", active)
        .put("purchases", JSONArray()).put("attributes", attrs).put("requestedAt", System.currentTimeMillis())
    return CustomerInfo.fromJson(j).copy(verification = VerificationResult.VERIFIED_ON_DEVICE)
}

internal fun isRetryable(e: Throwable) = e is MoneyMakerException && (e.code == "network" || e.code.startsWith("http_5") || e.code == "internal_error")
