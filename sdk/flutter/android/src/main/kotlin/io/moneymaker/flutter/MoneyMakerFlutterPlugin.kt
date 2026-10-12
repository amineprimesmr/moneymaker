package io.moneymaker.flutter

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.android.billingclient.api.ProductDetails
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.moneymaker.CustomerInfo
import io.moneymaker.MoneyMaker
import io.moneymaker.MoneyMakerException
import io.moneymaker.Offerings
import io.moneymaker.Package
import io.moneymaker.PurchaseResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch

class MoneyMakerFlutterPlugin : FlutterPlugin, MethodChannel.MethodCallHandler, EventChannel.StreamHandler, ActivityAware {
    private lateinit var context: Context
    private lateinit var methods: MethodChannel
    private lateinit var events: EventChannel
    private var activity: Activity? = null
    private var sink: EventChannel.EventSink? = null
    private var streamJob: Job? = null
    private var offerings: Offerings? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    // ── Lifecycle ───────────────────────────────────────────────────────

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        methods = MethodChannel(binding.binaryMessenger, "io.moneymaker/methods").also { it.setMethodCallHandler(this) }
        events = EventChannel(binding.binaryMessenger, "io.moneymaker/customer_info").also { it.setStreamHandler(this) }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methods.setMethodCallHandler(null)
        events.setStreamHandler(null)
        scope.cancel()
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) { activity = binding.activity }
    override fun onDetachedFromActivityForConfigChanges() { activity = null }
    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) { activity = binding.activity }
    override fun onDetachedFromActivity() { activity = null }

    // ── Methods ─────────────────────────────────────────────────────────

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        scope.launch {
            try {
                result.success(dispatch(call))
            } catch (e: MoneyMakerException) {
                result.error(e.code, e.message ?: e.code, null)
            } catch (e: PluginException) {
                result.error(e.code, e.message, null)
            } catch (e: Exception) {
                result.error("unknown", e.message ?: e.toString(), null)
            }
        }
    }

    private suspend fun dispatch(call: MethodCall): Any? {
        when (call.method) {
            "configure" -> {
                val apiKey = call.argument<String>("apiKey") ?: throw PluginException("invalid_arguments", "apiKey is required")
                MoneyMaker.configure(context, apiKey, call.argument("appUserId"),
                    call.argument<String>("baseUrl") ?: MoneyMaker.DEFAULT_BASE_URL)
                subscribeIfNeeded()
                return null
            }
            "isConfigured" -> return MoneyMaker.isConfigured
        }
        if (!MoneyMaker.isConfigured) throw PluginException("not_configured", "MoneyMaker.configure(apiKey) must be called first.")
        val mm = MoneyMaker.shared
        return when (call.method) {
            "appUserId" -> mm.appUserId
            "logIn" -> encode(mm.logIn(call.argument<String>("appUserId") ?: throw PluginException("invalid_arguments", "appUserId is required")))
            "logOut" -> { mm.logOut(); offerings = null; null }
            "getCustomerInfo" -> encode(mm.customerInfo.value ?: mm.refreshCustomerInfo())
            "refreshCustomerInfo" -> encode(mm.refreshCustomerInfo())
            "isEntitled" -> mm.isEntitled(call.argument<String>("entitlement") ?: "")
            "setAttributes" -> { mm.setAttributes(call.argument<Map<String, String?>>("attributes") ?: emptyMap()); null }
            "getOfferings" -> encode(mm.loadOfferings().also { offerings = it })
            "purchasePackage" -> {
                val id = call.argument<String>("packageId") ?: ""
                val playId = call.argument<Map<String, String>>("productIds")?.get("play_store")
                val pkg = findPackage { it.id == id && it.productIds["play_store"] == playId }
                    ?: throw MoneyMakerException("product_not_found", "Package $id not found")
                encode(mm.purchase(requireActivity(), pkg, call.argument("offerToken")))
            }
            "purchaseProduct" -> {
                val pid = call.argument<String>("productId") ?: throw PluginException("invalid_arguments", "productId is required")
                val details = findPackage { it.product?.productId == pid }?.product
                    ?: throw MoneyMakerException("product_not_found", "Play product $pid not found in any offering")
                encode(mm.purchase(requireActivity(), details, call.argument("offerToken")))
            }
            "restorePurchases" -> encode(mm.restorePurchases())
            "syncPurchases" -> null // The Android SDK syncs existing purchases at configure time.
            "showManageSubscriptions" -> {
                val uri = Uri.parse("https://play.google.com/store/account/subscriptions?package=${context.packageName}")
                val intent = Intent(Intent.ACTION_VIEW, uri)
                val a = activity
                if (a != null) a.startActivity(intent) else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                null
            }
            else -> throw PluginException("not_implemented", "Unknown method ${call.method}")
        }
    }

    private suspend fun findPackage(predicate: (Package) -> Boolean): Package? {
        offerings?.all?.values?.flatMap { it.packages }?.firstOrNull(predicate)?.let { return it }
        val fresh = MoneyMaker.shared.loadOfferings().also { offerings = it }
        return fresh.all.values.flatMap { it.packages }.firstOrNull(predicate)
    }

    private fun requireActivity(): Activity =
        activity ?: throw PluginException("no_activity", "A foreground Activity is required to purchase.")

    // ── Stream ──────────────────────────────────────────────────────────

    override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
        sink = events
        subscribeIfNeeded()
    }

    override fun onCancel(arguments: Any?) {
        sink = null
        streamJob?.cancel(); streamJob = null
    }

    /** Collects the StateFlow (emits the cached value first) without taking over onCustomerInfoUpdate. */
    private fun subscribeIfNeeded() {
        if (sink == null || streamJob != null || !MoneyMaker.isConfigured) return
        streamJob = scope.launch {
            MoneyMaker.shared.customerInfo.filterNotNull().distinctUntilChanged().collect { sink?.success(encode(it)) }
        }
    }

    // ── Encoding (dates as epoch ms, same as the API) ───────────────────

    private fun encode(info: CustomerInfo): Map<String, Any?> = mapOf(
        "appUserId" to info.appUserId,
        "entitlements" to info.entitlements.mapValues { (_, e) ->
            mapOf(
                "id" to e.id, "active" to e.active, "productId" to e.productId, "store" to e.store,
                "expiresAt" to e.expiresAt, "willRenew" to e.willRenew, "isTrial" to e.isTrial,
                "billingIssue" to e.billingIssue,
            )
        },
        "activeEntitlements" to info.activeEntitlements,
        "attributes" to info.attributes,
    )

    private fun encode(r: PurchaseResult): Map<String, Any?> = when (r) {
        is PurchaseResult.Success -> mapOf("result" to "success", "customerInfo" to encode(r.customerInfo))
        PurchaseResult.UserCancelled -> mapOf("result" to "userCancelled")
        PurchaseResult.Pending -> mapOf("result" to "pending")
    }

    private fun encode(o: Offerings): Map<String, Any?> = mapOf(
        "current" to o.current?.id,
        "all" to o.all.mapValues { (_, off) ->
            mapOf("id" to off.id, "description" to off.description, "packages" to off.packages.map(::encode))
        },
    )

    private fun encode(p: Package): Map<String, Any?> = mapOf(
        "id" to p.id,
        "productIds" to p.productIds,
        "metadata" to p.metadata,
        "hasFreeTrial" to p.hasFreeTrial,
        "product" to p.product?.let { encode(it, p.formattedPrice) },
    )

    private fun encode(d: ProductDetails, formattedPrice: String?): Map<String, Any?> {
        val phase = d.subscriptionOfferDetails?.firstOrNull()?.pricingPhases?.pricingPhaseList?.lastOrNull()
        val oneTime = d.oneTimePurchaseOfferDetails
        val micros = phase?.priceAmountMicros ?: oneTime?.priceAmountMicros
        return mapOf(
            "identifier" to d.productId,
            "title" to d.name,
            "description" to d.description,
            "priceString" to (formattedPrice ?: ""),
            "price" to micros?.let { it / 1_000_000.0 },
            "currencyCode" to (phase?.priceCurrencyCode ?: oneTime?.priceCurrencyCode),
            "subscriptionPeriod" to phase?.billingPeriod,
        )
    }

    private class PluginException(val code: String, override val message: String) : Exception(message)
}
