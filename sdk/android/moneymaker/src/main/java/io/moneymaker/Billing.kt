package io.moneymaker

import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ProductDetails
import org.json.JSONObject

/**
 * Play Billing helpers kept free of Android framework calls so they can be unit tested on the JVM.
 */

/** A subscription offer of a Play product (one entry of `ProductDetails.subscriptionOfferDetails`). */
internal data class OfferCandidate(
    val basePlanId: String,
    /** Null for the base plan itself (no offer). */
    val offerId: String?,
    val offerToken: String,
    /** ISO 8601 period of the recurring (last) pricing phase, e.g. `P1M`, `P1Y`. */
    val billingPeriod: String? = null,
    val priceMicros: Long? = null,
    val currency: String? = null,
    val formattedPrice: String? = null,
    /** At least one pricing phase is free (free trial). */
    val hasFreePhase: Boolean = false,
)

internal fun ProductDetails.offerCandidates(): List<OfferCandidate> = subscriptionOfferDetails.orEmpty().map { o ->
    val phase = o.pricingPhases.pricingPhaseList.lastOrNull()
    OfferCandidate(o.basePlanId, o.offerId, o.offerToken, phase?.billingPeriod, phase?.priceAmountMicros, phase?.priceCurrencyCode,
        phase?.formattedPrice, o.pricingPhases.pricingPhaseList.any { it.priceAmountMicros == 0L })
}

/**
 * Picks the subscription offer to buy, explicitly:
 * 1. `offerToken` when given (must exist),
 * 2. `offerId` when given (optionally restricted to `basePlanId`),
 * 3. otherwise the base plan **without offer** (`basePlanId` when given, else the first base plan).
 * Returns null when the requested token / offer / base plan does not exist.
 */
internal fun selectOffer(candidates: List<OfferCandidate>, offerToken: String? = null, basePlanId: String? = null, offerId: String? = null): OfferCandidate? {
    if (candidates.isEmpty()) return null
    if (!offerToken.isNullOrEmpty()) return candidates.firstOrNull { it.offerToken == offerToken }
    val plans = if (basePlanId.isNullOrEmpty()) candidates else candidates.filter { it.basePlanId == basePlanId }
    if (!offerId.isNullOrEmpty()) return plans.firstOrNull { it.offerId == offerId }
    return plans.firstOrNull { it.offerId == null }
        // A base plan always has its own offer entry; fall back to the plan's first entry if Play omitted it.
        ?: if (basePlanId.isNullOrEmpty()) null else plans.firstOrNull()
}

/**
 * Play product id from a package's `play_store` id. Accepts the RevenueCat-style `productId:basePlanId` form.
 */
internal fun playProductId(storeId: String): String = storeId.substringBefore(':')

/** Base plan id from a `productId:basePlanId` store id, or null. */
internal fun playBasePlanId(storeId: String): String? = storeId.substringAfter(':', "").ifEmpty { null }

/** Purchase type sent to `POST /v1/customers/{id}/google` (the server skips the acknowledgement for consumables). */
internal fun purchaseType(isSubscription: Boolean, productId: String, consumableProductIds: Set<String>): String = when {
    isSubscription -> "subscription"
    productId in consumableProductIds -> "consumable"
    else -> "non_consumable"
}

/**
 * Body of `POST /v1/customers/{id}/google`: token, product, type and price hints (`period` is the ISO 8601 billing
 * period the server turns into periodMonths; `basePlanId` / `offerId` are informational).
 */
internal fun googlePurchaseBody(
    purchaseToken: String, productId: String, type: String,
    offer: OfferCandidate? = null, oneTimePriceMicros: Long? = null, oneTimeCurrency: String? = null,
): JSONObject {
    val body = JSONObject().put("purchaseToken", purchaseToken).put("productId", productId).put("type", type)
    if (offer != null) {
        body.put("basePlanId", offer.basePlanId)
        offer.offerId?.let { body.put("offerId", it) }
        offer.billingPeriod?.let { body.put("period", it) }
        offer.priceMicros?.let { body.put("priceMicros", it) }
        offer.currency?.let { body.put("currency", it) }
    } else if (oneTimePriceMicros != null) {
        body.put("priceMicros", oneTimePriceMicros)
        oneTimeCurrency?.let { body.put("currency", it) }
    }
    return body
}

/** Error for a failed Play Billing call (`billing_<responseCode>`, as in 1.x). */
internal fun billingError(r: BillingResult, what: String = "Play Billing"): MoneyMakerException =
    billingError(r.responseCode, r.debugMessage, what)

internal fun billingError(responseCode: Int, debugMessage: String?, what: String = "Play Billing"): MoneyMakerException {
    val reason = when (responseCode) {
        BillingClient.BillingResponseCode.BILLING_UNAVAILABLE -> "billing unavailable (Play Store missing, outdated or not signed in)"
        BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE -> "Play Store service unavailable"
        BillingClient.BillingResponseCode.SERVICE_DISCONNECTED -> "Play Store service disconnected"
        BillingClient.BillingResponseCode.FEATURE_NOT_SUPPORTED -> "feature not supported"
        BillingClient.BillingResponseCode.ITEM_UNAVAILABLE -> "item unavailable"
        BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> "item already owned"
        BillingClient.BillingResponseCode.NETWORK_ERROR -> "network error"
        BillingClient.BillingResponseCode.DEVELOPER_ERROR -> "developer error"
        else -> "error"
    }
    val msg = "$what: $reason ($responseCode)" + (debugMessage?.takeIf { it.isNotBlank() }?.let { ": $it" } ?: "")
    return MoneyMakerException("billing_$responseCode", msg, billingResponseCode = responseCode)
}
