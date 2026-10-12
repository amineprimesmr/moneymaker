package io.moneymaker.amazon

import android.content.Context
import com.amazon.device.iap.PurchasingListener
import com.amazon.device.iap.PurchasingService
import com.amazon.device.iap.model.FulfillmentResult
import com.amazon.device.iap.model.ProductDataResponse
import com.amazon.device.iap.model.PurchaseResponse
import com.amazon.device.iap.model.PurchaseUpdatesResponse
import com.amazon.device.iap.model.Receipt
import com.amazon.device.iap.model.RequestId
import com.amazon.device.iap.model.UserDataResponse
import io.moneymaker.CustomerInfo
import io.moneymaker.MoneyMaker
import io.moneymaker.MoneyMakerException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Amazon Appstore support (Appstore SDK `PurchasingService`), documented flow:
 * https://developer.amazon.com/docs/in-app-purchasing/iap-implement-iap.html
 *
 *   MoneyMaker.configure(context, "mm_pub_…", appUserId)
 *   MoneyMakerAmazon.configure(context)                 // in Application.onCreate
 *   MoneyMakerAmazon.shared.syncPurchases()             // in Activity.onResume (getUserData + getPurchaseUpdates)
 *   val info = MoneyMakerAmazon.shared.purchase("premium_monthly")
 *
 * Each receipt is sent to MoneyMaker (`POST /v1/customers/{id}/amazon`), verified server-side with RVS, and only then
 * `notifyFulfillment(receiptId, FULFILLED)` is called.
 */
class MoneyMakerAmazon private constructor(context: Context) : PurchasingListener {

    companion object {
        @Volatile private var instance: MoneyMakerAmazon? = null
        val shared: MoneyMakerAmazon get() = instance ?: error("Call MoneyMakerAmazon.configure(context) first")

        @JvmStatic
        fun configure(context: Context): MoneyMakerAmazon = instance ?: synchronized(this) {
            instance ?: MoneyMakerAmazon(context.applicationContext).also {
                instance = it
                PurchasingService.registerListener(context.applicationContext, it)
            }
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val purchases = ConcurrentHashMap<RequestId, CompletableDeferred<CustomerInfo>>()
    private val prices = ConcurrentHashMap<String, String>()
    @Volatile private var amazonUserId: String? = null
    @Volatile private var marketplace: String? = null
    /** LicensingService.getAppstoreSDKMode(): "SANDBOX" when running against App Tester. */
    private val isSandbox: Boolean get() = runCatching { com.amazon.device.drm.LicensingService.getAppstoreSDKMode() == "SANDBOX" }.getOrDefault(false)

    /** Refreshes the Amazon user and re-sends every receipt (restores purchases). */
    fun syncPurchases(reset: Boolean = false) {
        PurchasingService.getUserData()
        PurchasingService.getPurchaseUpdates(reset)
    }

    /** Loads localized prices (`Product.getPrice()`, formatted) for the given SKUs. */
    fun loadProducts(skus: Set<String>) { PurchasingService.getProductData(skus) }

    suspend fun purchase(sku: String): CustomerInfo {
        val deferred = CompletableDeferred<CustomerInfo>()
        purchases[PurchasingService.purchase(sku)] = deferred
        return deferred.await()
    }

    override fun onUserDataResponse(response: UserDataResponse) {
        if (response.requestStatus == UserDataResponse.RequestStatus.SUCCESSFUL) {
            amazonUserId = response.userData.userId
            marketplace = response.userData.marketplace
        }
    }

    override fun onProductDataResponse(response: ProductDataResponse) {
        if (response.requestStatus == ProductDataResponse.RequestStatus.SUCCESSFUL) {
            response.productData.forEach { (sku, product) -> product.price?.let { prices[sku] = it } }
        }
    }

    override fun onPurchaseResponse(response: PurchaseResponse) {
        val deferred = purchases.remove(response.requestId)
        when (response.requestStatus) {
            PurchaseResponse.RequestStatus.SUCCESSFUL -> scope.launch {
                amazonUserId = response.userData.userId
                runCatching { send(response.receipt, response.userData.userId) }
                    .onSuccess { deferred?.complete(it) }.onFailure { deferred?.completeExceptionally(it) }
            }
            PurchaseResponse.RequestStatus.ALREADY_PURCHASED -> { syncPurchases(); deferred?.completeExceptionally(MoneyMakerException("already_purchased", "Already purchased")) }
            else -> deferred?.completeExceptionally(MoneyMakerException("amazon_${response.requestStatus.name.lowercase()}", "Amazon purchase ${response.requestStatus}"))
        }
    }

    override fun onPurchaseUpdatesResponse(response: PurchaseUpdatesResponse) {
        if (response.requestStatus != PurchaseUpdatesResponse.RequestStatus.SUCCESSFUL) return
        val userId = response.userData.userId
        scope.launch { response.receipts.forEach { r -> runCatching { send(r, userId) } } }
        if (response.hasMore()) PurchasingService.getPurchaseUpdates(false)
    }

    private suspend fun send(receipt: Receipt, userId: String): CustomerInfo {
        val body = JSONObject().put("receiptId", receipt.receiptId).put("amazonUserId", userId).put("productId", receipt.sku)
            .put("sandbox", isSandbox)
        marketplace?.let { body.put("marketplace", it) }
        val info = MoneyMaker.shared.syncStorePurchase("amazon", body)
        // Fulfill only once MoneyMaker verified the receipt (Amazon re-delivers unfulfilled receipts).
        if (!receipt.isCanceled) PurchasingService.notifyFulfillment(receipt.receiptId, FulfillmentResult.FULFILLED)
        return info
    }
}
