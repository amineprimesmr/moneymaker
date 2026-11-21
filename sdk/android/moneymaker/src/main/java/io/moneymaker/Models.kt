package io.moneymaker

import com.android.billingclient.api.ProductDetails
import org.json.JSONObject

data class Entitlement(
    val id: String, val active: Boolean, val productId: String, val store: String, val expiresAt: Long?,
    val willRenew: Boolean, val isTrial: Boolean, val billingIssue: Boolean,
)

data class CustomerInfo(
    val appUserId: String,
    val entitlements: Map<String, Entitlement>,
    val activeEntitlements: List<String>,
    val attributes: Map<String, String>,
    internal val raw: JSONObject,
    /** Signature check of this response (trusted entitlements). */
    val verification: VerificationResult = VerificationResult.NOT_REQUESTED,
) {
    /** Same info with every entitlement inactive (enforced mode after failed verification). */
    internal fun revokingEntitlements() = copy(
        entitlements = entitlements.mapValues { it.value.copy(active = false) }, activeEntitlements = emptyList(),
        verification = VerificationResult.FAILED,
    )

    fun isEntitled(id: String, now: Long = System.currentTimeMillis()): Boolean {
        val e = entitlements[id] ?: return false
        return e.active && (e.expiresAt == null || e.expiresAt > now)
    }

    companion object {
        fun fromJson(j: JSONObject): CustomerInfo {
            val ents = j.optJSONObject("entitlements") ?: JSONObject()
            val active = j.optJSONArray("activeEntitlements")
            val attrs = j.optJSONObject("attributes") ?: JSONObject()
            return CustomerInfo(
                appUserId = j.getString("appUserId"),
                entitlements = ents.keys().asSequence().associateWith { k ->
                    val e = ents.getJSONObject(k)
                    Entitlement(k, e.optBoolean("active"), e.optString("productId"), e.optString("store"),
                        if (e.isNull("expiresAt")) null else e.optLong("expiresAt"),
                        e.optBoolean("willRenew"), e.optBoolean("isTrial"), e.optBoolean("billingIssue"))
                },
                activeEntitlements = (0 until (active?.length() ?: 0)).map { active!!.getString(it) },
                attributes = attrs.keys().asSequence().associateWith { attrs.optString(it) },
                raw = j,
            )
        }
    }
}

data class Package(
    val id: String, val productIds: Map<String, String>, val metadata: Map<String, String>, val product: ProductDetails?,
    /** Configured with a Test Store key (`mm_test_…`): purchasable without Google Play. */
    val isTestStore: Boolean = false,
) {
    val isAvailable: Boolean get() = product != null || isTestStore
    /** Base plan bought by default (`play_store` id `productId:basePlanId`, else the first base plan), without offer. */
    internal val defaultOffer: OfferCandidate?
        get() = product?.offerCandidates()?.let { selectOffer(it, basePlanId = productIds["play_store"]?.let(::playBasePlanId)) }
    /** Recurring price of the default base plan (subscriptions) or the one-time price. */
    val formattedPrice: String?
        get() = defaultOffer?.formattedPrice ?: product?.oneTimePurchaseOfferDetails?.formattedPrice
    val priceAmountMicros: Long?
        get() = defaultOffer?.priceMicros ?: product?.oneTimePurchaseOfferDetails?.priceAmountMicros
    val priceCurrencyCode: String?
        get() = defaultOffer?.currency ?: product?.oneTimePurchaseOfferDetails?.priceCurrencyCode
    /** ISO 8601 billing period of the default base plan (`P1M`, `P1Y`…), null for one-time products. */
    val subscriptionPeriod: String? get() = defaultOffer?.billingPeriod
    /** A free-trial offer exists on the default base plan (the trial is bought by passing its offerId / offerToken). */
    val hasFreeTrial: Boolean
        get() = product?.offerCandidates()?.let { c ->
            val plan = defaultOffer?.basePlanId
            c.any { (plan == null || it.basePlanId == plan) && it.hasFreePhase }
        } == true
}

data class Offering(
    val id: String, val description: String?, val packages: List<Package>,
    /** Remote paywall config (raw JSON, see llms.txt) — null when the offering has none. */
    val paywallJson: String? = null,
) {
    fun pkg(id: String) = packages.firstOrNull { it.id == id }
}

data class ExperimentAssignment(val experimentId: String, val variant: String, val placement: String, val offeringId: String)

data class Offerings(
    val current: Offering?, val all: Map<String, Offering>,
    /** placementId → resolved offering id (targeting + experiments applied server-side). */
    val placements: Map<String, String> = emptyMap(),
    val experiments: List<ExperimentAssignment> = emptyList(),
    /** Entitlement → product ids (offline entitlements). */
    val entitlements: Map<String, List<String>> = emptyMap(),
) {
    operator fun get(id: String) = all[id]
    fun offeringForPlacement(placement: String): Offering? = placements[placement]?.let { all[it] } ?: current
    fun experiment(offeringId: String, placement: String?) =
        experiments.firstOrNull { it.offeringId == offeringId && it.placement == (placement ?: "default") } ?: experiments.firstOrNull { it.offeringId == offeringId }
}

enum class PaywallEventType(val wire: String) { IMPRESSION("impression"), CLOSE("close"), PURCHASE_START("purchase_start"), PURCHASE("purchase"), CANCEL("cancel") }

sealed class PurchaseResult {
    data class Success(val customerInfo: CustomerInfo) : PurchaseResult()
    data object UserCancelled : PurchaseResult()
    data object Pending : PurchaseResult()
}
