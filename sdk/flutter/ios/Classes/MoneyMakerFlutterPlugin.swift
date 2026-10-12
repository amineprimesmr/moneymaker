import Flutter
import UIKit
import StoreKit
import Combine
// With CocoaPods the SDK sources are compiled into this module (Classes/MoneyMakerCore).
#if canImport(MoneyMaker)
import MoneyMaker
#endif

private struct PluginError: Error { let code: String; let message: String }

public final class MoneyMakerFlutterPlugin: NSObject, FlutterPlugin, FlutterStreamHandler {
    private var sink: FlutterEventSink?
    private var subscription: AnyCancellable?

    public static func register(with registrar: FlutterPluginRegistrar) {
        let instance = MoneyMakerFlutterPlugin()
        let methods = FlutterMethodChannel(name: "io.moneymaker/methods", binaryMessenger: registrar.messenger())
        registrar.addMethodCallDelegate(instance, channel: methods)
        FlutterEventChannel(name: "io.moneymaker/customer_info", binaryMessenger: registrar.messenger())
            .setStreamHandler(instance)
    }

    // MARK: Methods

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        let args = call.arguments as? [String: Any] ?? [:]
        Task { @MainActor in
            do {
                result(try await self.dispatch(call.method, args))
            } catch let e as PluginError {
                result(FlutterError(code: e.code, message: e.message, details: nil))
            } catch {
                result(Self.flutterError(error))
            }
        }
    }

    @MainActor
    private func dispatch(_ method: String, _ args: [String: Any]) async throws -> Any? {
        switch method {
        case "configure":
            guard let apiKey = args["apiKey"] as? String else { throw PluginError(code: "invalid_arguments", message: "apiKey is required") }
            let base = (args["baseUrl"] as? String).flatMap(URL.init(string:)) ?? MoneyMaker.defaultBaseURL
            MoneyMaker.configure(apiKey: apiKey, appUserID: args["appUserId"] as? String, baseURL: base)
            subscribeIfNeeded()
            return nil
        case "isConfigured":
            return MoneyMaker.isConfigured
        default:
            break
        }
        guard MoneyMaker.isConfigured else { throw MoneyMakerError.notConfigured }
        let mm = MoneyMaker.shared
        switch method {
        case "appUserId":
            return mm.appUserID
        case "logIn":
            guard let id = args["appUserId"] as? String else { throw PluginError(code: "invalid_arguments", message: "appUserId is required") }
            return try Self.encode(try await mm.logIn(id))
        case "logOut":
            mm.logOut(); return nil
        case "getCustomerInfo":
            return try Self.encode(try await mm.getCustomerInfo())
        case "refreshCustomerInfo":
            return try Self.encode(try await mm.refreshCustomerInfo())
        case "isEntitled":
            return mm.isEntitled(args["entitlement"] as? String ?? "")
        case "setAttributes":
            let raw = args["attributes"] as? [String: Any] ?? [:]
            var attrs: [String: String?] = [:]
            for (k, v) in raw { attrs[k] = v as? String }
            try await mm.setAttributes(attrs)
            return nil
        case "getOfferings":
            return Self.encode(try await mm.loadOfferings())
        case "purchasePackage":
            let packageId = args["packageId"] as? String ?? ""
            let productIds = args["productIds"] as? [String: String] ?? [:]
            var offerings = mm.offerings
            if offerings == nil { offerings = try await mm.loadOfferings() }
            let pkg = offerings?.all.values.lazy.flatMap(\.packages).first {
                $0.id == packageId && $0.productIds["app_store"] == productIds["app_store"]
            }
            if let pkg { return try Self.encode(try await mm.purchase(pkg)) }
            guard let pid = productIds["app_store"] else { throw MoneyMakerError.productNotFound(packageId) }
            return try Self.encode(try await mm.purchase(productID: pid))
        case "purchaseProduct":
            guard let pid = args["productId"] as? String else { throw PluginError(code: "invalid_arguments", message: "productId is required") }
            return try Self.encode(try await mm.purchase(productID: pid))
        case "restorePurchases":
            return try Self.encode(try await mm.restorePurchases())
        case "syncPurchases":
            await mm.syncPurchases(); return nil
        case "showManageSubscriptions":
            await mm.showManageSubscriptions(); return nil
        default:
            throw PluginError(code: "not_implemented", message: "Unknown method \(method)")
        }
    }

    // MARK: Stream

    public func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
        sink = events
        Task { @MainActor in self.subscribeIfNeeded() }
        return nil
    }

    public func onCancel(withArguments arguments: Any?) -> FlutterError? {
        sink = nil
        subscription = nil
        return nil
    }

    /// Observes the published customerInfo (does not take over `onCustomerInfoUpdate`,
    /// which stays available to native code). Emits the current value first.
    @MainActor
    private func subscribeIfNeeded() {
        guard sink != nil, subscription == nil, MoneyMaker.isConfigured else { return }
        subscription = MoneyMaker.shared.$customerInfo
            .compactMap { $0 }
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] info in
                if let map = try? Self.encode(info) { self?.sink?(map) }
            }
    }

    // MARK: Encoding

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .millisecondsSince1970
        return e
    }()

    static func encode(_ info: CustomerInfo) throws -> [String: Any] {
        let data = try encoder.encode(info)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    static func encode(_ result: PurchaseResult) throws -> [String: Any] {
        switch result {
        case .success(let info): return ["result": "success", "customerInfo": try encode(info)]
        case .userCancelled: return ["result": "userCancelled"]
        case .pending: return ["result": "pending"]
        }
    }

    static func encode(_ offerings: Offerings) -> [String: Any] {
        var all: [String: Any] = [:]
        for (id, o) in offerings.all {
            all[id] = [
                "id": o.id,
                "description": o.description as Any,
                "packages": o.packages.map(encode),
            ]
        }
        return ["current": offerings.current?.id as Any, "all": all]
    }

    static func encode(_ p: Package) -> [String: Any] {
        var m: [String: Any] = ["id": p.id, "productIds": p.productIds, "metadata": p.metadata, "hasFreeTrial": p.hasFreeTrial]
        if let product = p.product {
            var pm: [String: Any] = [
                "identifier": product.id,
                "title": product.displayName,
                "description": product.description,
                "priceString": product.displayPrice,
                "price": NSDecimalNumber(decimal: product.price).doubleValue,
                "currencyCode": product.priceFormatStyle.currencyCode,
            ]
            if let period = p.period { pm["subscriptionPeriod"] = iso8601(period) }
            m["product"] = pm
        }
        return m
    }

    static func iso8601(_ period: Product.SubscriptionPeriod) -> String {
        switch period.unit {
        case .day: return "P\(period.value)D"
        case .week: return "P\(period.value)W"
        case .month: return "P\(period.value)M"
        case .year: return "P\(period.value)Y"
        @unknown default: return "P\(period.value)D"
        }
    }

    static func flutterError(_ error: Error) -> FlutterError {
        guard let mm = error as? MoneyMakerError else {
            return FlutterError(code: "unknown", message: error.localizedDescription, details: nil)
        }
        switch mm {
        case .notConfigured:
            return FlutterError(code: "not_configured", message: mm.localizedDescription, details: nil)
        case .productNotFound:
            return FlutterError(code: "product_not_found", message: mm.localizedDescription, details: nil)
        case .unverifiedTransaction:
            return FlutterError(code: "unverified_transaction", message: mm.localizedDescription, details: nil)
        case let .server(status, code, message):
            return FlutterError(code: code, message: message, details: ["status": status])
        case .network(let m):
            return FlutterError(code: "network", message: m, details: nil)
        }
    }
}
