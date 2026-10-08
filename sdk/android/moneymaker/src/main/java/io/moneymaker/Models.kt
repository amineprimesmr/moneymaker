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
) {
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

data class Package(val id: String, val productIds: Map<String, String>, val metadata: Map<String, String>, val product: ProductDetails?) {
    val formattedPrice: String?
        get() = product?.subscriptionOfferDetails?.firstOrNull()?.pricingPhases?.pricingPhaseList?.lastOrNull()?.formattedPrice
            ?: product?.oneTimePurchaseOfferDetails?.formattedPrice
    val hasFreeTrial: Boolean
        get() = product?.subscriptionOfferDetails?.any { o -> o.pricingPhases.pricingPhaseList.any { it.priceAmountMicros == 0L } } == true
}

data class Offering(val id: String, val description: String?, val packages: List<Package>) {
    fun pkg(id: String) = packages.firstOrNull { it.id == id }
}

data class Offerings(val current: Offering?, val all: Map<String, Offering>) {
    operator fun get(id: String) = all[id]
}

sealed class PurchaseResult {
    data class Success(val customerInfo: CustomerInfo) : PurchaseResult()
    data object UserCancelled : PurchaseResult()
    data object Pending : PurchaseResult()
}
