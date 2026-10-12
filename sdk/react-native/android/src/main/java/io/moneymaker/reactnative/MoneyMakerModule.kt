package io.moneymaker.reactnative

import android.content.Intent
import android.net.Uri
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.ProductDetails
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import io.moneymaker.CustomerInfo
import io.moneymaker.MoneyMaker
import io.moneymaker.MoneyMakerException
import io.moneymaker.Offering
import io.moneymaker.Offerings
import io.moneymaker.Package
import io.moneymaker.PurchaseResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class MoneyMakerModule : Module() {
  @Volatile private var offerings: Offerings? = null

  override fun definition() = ModuleDefinition {
    Name("MoneyMaker")

    Events("onCustomerInfoUpdated")

    Constants("defaultBaseUrl" to MoneyMaker.DEFAULT_BASE_URL)

    Function("configure") { apiKey: String, appUserId: String?, baseUrl: String? ->
      val context = appContext.reactContext ?: throw CodedException("no_context", "React context unavailable", null)
      val mm = MoneyMaker.configure(context, apiKey, appUserId, baseUrl?.takeIf { it.isNotEmpty() } ?: MoneyMaker.DEFAULT_BASE_URL)
      mm.onCustomerInfoUpdate = { info -> sendEvent("onCustomerInfoUpdated", encode(info)) }
    }

    Function("isConfigured") { MoneyMaker.isConfigured }

    Function("getAppUserId") { mm().appUserId }

    Function("isAnonymous") { mm().isAnonymous }

    Function("isEntitled") { entitlement: String ->
      MoneyMaker.isConfigured && MoneyMaker.shared.isEntitled(entitlement)
    }

    Function("getCachedCustomerInfo") {
      if (!MoneyMaker.isConfigured) null else MoneyMaker.shared.customerInfo.value?.let { encode(it) }
    }

    AsyncFunction("logIn") Coroutine { appUserId: String ->
      wrap { encode(mm().logIn(appUserId)) }
    }

    AsyncFunction("logOut") Coroutine { ->
      wrap { withContext(Dispatchers.Main) { mm().logOut() } }
    }

    AsyncFunction("getCustomerInfo") Coroutine { ->
      wrap {
        val mm = mm()
        val cached = mm.customerInfo.value
        val requestedAt = cached?.raw?.optLong("requestedAt", 0L) ?: 0L
        val info = if (cached != null && System.currentTimeMillis() - requestedAt < 300_000) cached else mm.refreshCustomerInfo()
        encode(info)
      }
    }

    AsyncFunction("refreshCustomerInfo") Coroutine { ->
      wrap { encode(mm().refreshCustomerInfo()) }
    }

    AsyncFunction("setAttributes") Coroutine { attributes: Map<String, String?> ->
      wrap { mm().setAttributes(attributes) }
    }

    AsyncFunction("getOfferings") Coroutine { ->
      wrap { encode(loadOfferings()) }
    }

    AsyncFunction("purchasePackage") Coroutine { offeringId: String, packageId: String, offerToken: String? ->
      wrap {
        val pkg = offerings?.get(offeringId)?.pkg(packageId) ?: loadOfferings()[offeringId]?.pkg(packageId)
          ?: throw CodedException("product_not_found", "Package $packageId not found in offering $offeringId", null)
        purchase(pkg, offerToken)
      }
    }

    AsyncFunction("purchaseProduct") Coroutine { productId: String, offerToken: String? ->
      wrap {
        fun find(o: Offerings?) = o?.all?.values?.flatMap { it.packages }?.firstOrNull { it.productIds["play_store"] == productId && it.product != null }
        val pkg = find(offerings) ?: find(loadOfferings())
          ?: throw CodedException("product_not_found", "Play product $productId is not part of any offering", null)
        purchase(pkg, offerToken)
      }
    }

    AsyncFunction("restorePurchases") Coroutine { ->
      wrap { encode(mm().restorePurchases()) }
    }

    // StoreKit-only on iOS. On Android re-posting owned purchases is already silent.
    AsyncFunction("syncPurchases") Coroutine { ->
      wrap { mm().restorePurchases(); Unit }
    }

    AsyncFunction("showManageSubscriptions") Coroutine { ->
      val context = appContext.currentActivity ?: appContext.reactContext
        ?: throw CodedException("no_activity", "No activity available", null)
      val uri = Uri.parse("https://play.google.com/store/account/subscriptions?package=${context.packageName}")
      val intent = Intent(Intent.ACTION_VIEW, uri)
      if (appContext.currentActivity == null) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      withContext(Dispatchers.Main) { context.startActivity(intent) }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private fun mm(): MoneyMaker {
    if (!MoneyMaker.isConfigured) throw CodedException("not_configured", "Call MoneyMaker.configure({ apiKey }) first", null)
    return MoneyMaker.shared
  }

  private suspend fun loadOfferings(): Offerings = mm().loadOfferings().also { offerings = it }

  private suspend fun purchase(pkg: Package, offerToken: String?): Map<String, Any?> {
    val activity = appContext.currentActivity ?: throw CodedException("no_activity", "No foreground activity to launch the billing flow", null)
    val result = withContext(Dispatchers.Main) { mm().purchase(activity, pkg, offerToken) }
    return when (result) {
      is PurchaseResult.Success -> mapOf("status" to "success", "customerInfo" to encode(result.customerInfo))
      PurchaseResult.UserCancelled -> mapOf("status" to "userCancelled")
      PurchaseResult.Pending -> mapOf("status" to "pending")
    }
  }

  private suspend fun <T> wrap(block: suspend () -> T): T = try {
    block()
  } catch (e: CodedException) {
    throw e
  } catch (e: MoneyMakerException) {
    throw CodedException(e.code, e.message ?: e.code, e)
  } catch (e: Exception) {
    throw CodedException("unknown", e.message ?: e.toString(), e)
  }

  // ── Serialization (same shape as iOS) ─────────────────────────────────

  private fun encode(info: CustomerInfo): Map<String, Any?> {
    val map = toMap(info.raw).toMutableMap()
    map.putIfAbsent("accountToken", "")
    map.putIfAbsent("purchases", emptyList<Any?>())
    map.putIfAbsent("attributes", emptyMap<String, Any?>())
    map.putIfAbsent("requestedAt", System.currentTimeMillis())
    return map
  }

  private fun encode(o: Offerings): Map<String, Any?> = mapOf(
    "current" to o.current?.let { encode(it) },
    "all" to o.all.mapValues { encode(it.value) },
  )

  private fun encode(o: Offering): Map<String, Any?> = mapOf(
    "id" to o.id,
    "description" to o.description,
    "packages" to o.packages.map { encode(it, o.id) },
  )

  private fun encode(p: Package, offeringId: String): Map<String, Any?> = mapOf(
    "id" to p.id,
    "offeringId" to offeringId,
    "productIds" to p.productIds,
    "metadata" to p.metadata,
    "product" to p.product?.let { encode(it) },
    "localizedPrice" to (p.formattedPrice ?: ""),
    "hasFreeTrial" to p.hasFreeTrial,
  )

  private fun encode(d: ProductDetails): Map<String, Any?> {
    val isSub = d.productType == BillingClient.ProductType.SUBS
    val phase = d.subscriptionOfferDetails?.firstOrNull()?.pricingPhases?.pricingPhaseList?.lastOrNull()
    val oneTime = d.oneTimePurchaseOfferDetails
    val micros = phase?.priceAmountMicros ?: oneTime?.priceAmountMicros ?: 0L
    return mapOf(
      "identifier" to d.productId,
      "title" to d.name,
      "description" to d.description,
      "price" to micros / 1_000_000.0,
      "priceString" to (phase?.formattedPrice ?: oneTime?.formattedPrice ?: ""),
      "currencyCode" to (phase?.priceCurrencyCode ?: oneTime?.priceCurrencyCode ?: ""),
      "type" to if (isSub) "subscription" else "non_consumable",
      "subscriptionPeriod" to if (isSub) phase?.billingPeriod else null,
      "hasFreeTrial" to (d.subscriptionOfferDetails?.any { o -> o.pricingPhases.pricingPhaseList.any { it.priceAmountMicros == 0L } } == true),
    )
  }

  private fun toMap(o: JSONObject): Map<String, Any?> = o.keys().asSequence().associateWith { fromJson(o.opt(it)) }

  private fun fromJson(v: Any?): Any? = when (v) {
    null, JSONObject.NULL -> null
    is JSONObject -> toMap(v)
    is JSONArray -> (0 until v.length()).map { fromJson(v.opt(it)) }
    else -> v
  }
}
