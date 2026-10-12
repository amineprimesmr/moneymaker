import ExpoModulesCore
import StoreKit

public final class MoneyMakerModule: Module {
  /// Synchronous JS functions run on the JS thread: hop to the main actor (the SDK is @MainActor).
  static func onMain<T>(_ body: @MainActor () throws -> T) rethrows -> T {
    if Thread.isMainThread { return try MainActor.assumeIsolated(body) }
    return try DispatchQueue.main.sync { try MainActor.assumeIsolated(body) }
  }

  public func definition() -> ModuleDefinition {
    Name("MoneyMaker")

    Events("onCustomerInfoUpdated")

    Constant("defaultBaseUrl") { MoneyMaker.defaultBaseURL.absoluteString }

    Function("configure") { (apiKey: String, appUserId: String?, baseUrl: String?) throws in try Self.onMain {
      var url = MoneyMaker.defaultBaseURL
      if let baseUrl, !baseUrl.isEmpty {
        guard let parsed = URL(string: baseUrl) else { throw Self.error("invalid_base_url", "Invalid baseUrl: \(baseUrl)") }
        url = parsed
      }
      let mm = MoneyMaker.configure(apiKey: apiKey, appUserID: appUserId, baseURL: url)
      mm.onCustomerInfoUpdate = { [weak self] info in
        self?.sendEvent("onCustomerInfoUpdated", Self.encode(info))
      }
    } }

    Function("isConfigured") { Self.onMain { MoneyMaker.isConfigured } }

    Function("getAppUserId") { () throws -> String in try Self.onMain { try Self.mm().appUserID } }

    Function("isAnonymous") { () throws -> Bool in try Self.onMain { try Self.mm().isAnonymous } }

    Function("isEntitled") { (entitlement: String) -> Bool in
      Self.onMain { MoneyMaker.isConfigured ? MoneyMaker.shared.isEntitled(entitlement) : false }
    }

    Function("getCachedCustomerInfo") { () -> [String: Any]? in
      Self.onMain {
        guard MoneyMaker.isConfigured, let info = MoneyMaker.shared.customerInfo else { return nil }
        return Self.encode(info)
      }
    }

    AsyncFunction("logIn") { (appUserId: String) async throws -> [String: Any] in
      try await Self.wrap { Self.encode(try await Self.mm().logIn(appUserId)) }
    }

    AsyncFunction("logOut") { () async throws in
      try await Self.mm().logOut()
    }

    AsyncFunction("getCustomerInfo") { () async throws -> [String: Any] in
      try await Self.wrap { Self.encode(try await Self.mm().getCustomerInfo()) }
    }

    AsyncFunction("refreshCustomerInfo") { () async throws -> [String: Any] in
      try await Self.wrap { Self.encode(try await Self.mm().refreshCustomerInfo()) }
    }

    AsyncFunction("setAttributes") { (attributes: [String: String?]) async throws in
      try await Self.wrap { try await Self.mm().setAttributes(attributes) }
    }

    AsyncFunction("getOfferings") { () async throws -> [String: Any] in
      try await Self.wrap { Self.encode(try await Self.mm().loadOfferings()) }
    }

    AsyncFunction("purchasePackage") { (offeringId: String, packageId: String, _: String?) async throws -> [String: Any] in
      try await Self.wrap {
        let mm = try await Self.mm()
        var offerings = await mm.offerings
        if offerings?[offeringId]?.package(packageId) == nil { offerings = try await mm.loadOfferings() }
        guard let pkg = offerings?[offeringId]?.package(packageId) else {
          throw Self.error("product_not_found", "Package \(packageId) not found in offering \(offeringId).")
        }
        return Self.encode(try await mm.purchase(pkg))
      }
    }

    AsyncFunction("purchaseProduct") { (productId: String, _: String?) async throws -> [String: Any] in
      try await Self.wrap { Self.encode(try await Self.mm().purchase(productID: productId)) }
    }

    AsyncFunction("restorePurchases") { () async throws -> [String: Any] in
      try await Self.wrap { Self.encode(try await Self.mm().restorePurchases()) }
    }

    AsyncFunction("syncPurchases") { () async throws in
      try await Self.mm().syncPurchases()
    }

    AsyncFunction("showManageSubscriptions") { () async throws in
      try await Self.mm().showManageSubscriptions()
    }
  }

  // MARK: - Helpers

  @MainActor
  private static func mm() throws -> MoneyMaker {
    guard MoneyMaker.isConfigured else { throw error("not_configured", MoneyMakerError.notConfigured.localizedDescription) }
    return MoneyMaker.shared
  }

  private static func error(_ code: String, _ message: String) -> Exception {
    Exception(name: "MoneyMakerError", description: message, code: code)
  }

  /// Maps native `MoneyMakerError` to coded JS errors (`error.code`).
  private static func wrap<T>(_ body: () async throws -> T) async throws -> T {
    do { return try await body() }
    catch let e as Exception { throw e }
    catch let e as MoneyMakerError {
      switch e {
      case .notConfigured: throw error("not_configured", e.localizedDescription)
      case .productNotFound: throw error("product_not_found", e.localizedDescription)
      case .unverifiedTransaction: throw error("unverified_transaction", e.localizedDescription)
      case let .server(_, code, message): throw error(code, message.isEmpty ? e.localizedDescription : message)
      case .network(let m): throw error("network", m)
      }
    }
    catch let e as StoreKitError { throw error("store_error", e.localizedDescription) }
    catch { throw Self.error("unknown", error.localizedDescription) }
  }

  // MARK: - Serialization (dates as epoch milliseconds, matching the wire format)

  static func encode(_ info: CustomerInfo) -> [String: Any] {
    let e = JSONEncoder()
    e.dateEncodingStrategy = .millisecondsSince1970
    guard let data = try? e.encode(info),
          var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }
    // Optional dates are omitted by JSONEncoder: expose them as null like Android does.
    if var ents = obj["entitlements"] as? [String: [String: Any]] {
      for (k, var v) in ents {
        for key in ["expiresAt", "purchasedAt"] where v[key] == nil { v[key] = NSNull() }
        ents[k] = v
      }
      obj["entitlements"] = ents
    }
    if let purchases = obj["purchases"] as? [[String: Any]] {
      obj["purchases"] = purchases.map { p -> [String: Any] in
        var p = p
        for key in ["expiresAt", "purchasedAt"] where p[key] == nil { p[key] = NSNull() }
        return p
      }
    }
    return obj
  }

  static func encode(_ result: PurchaseResult) -> [String: Any] {
    switch result {
    case .success(let info): return ["status": "success", "customerInfo": encode(info)]
    case .userCancelled: return ["status": "userCancelled"]
    case .pending: return ["status": "pending"]
    }
  }

  static func encode(_ offerings: Offerings) -> [String: Any] {
    let all = offerings.all.mapValues { encode($0) }
    return ["current": offerings.current.map { encode($0) } ?? NSNull(), "all": all]
  }

  static func encode(_ offering: Offering) -> [String: Any] {
    [
      "id": offering.id,
      "description": offering.description ?? NSNull(),
      "packages": offering.packages.map { encode($0, offeringId: offering.id) },
    ]
  }

  static func encode(_ pkg: Package, offeringId: String) -> [String: Any] {
    [
      "id": pkg.id,
      "offeringId": offeringId,
      "productIds": pkg.productIds,
      "metadata": pkg.metadata,
      "product": pkg.product.map { encode($0) } ?? NSNull(),
      "localizedPrice": pkg.localizedPrice,
      "hasFreeTrial": pkg.hasFreeTrial,
    ]
  }

  static func encode(_ product: Product) -> [String: Any] {
    let type: String
    switch product.type {
    case .autoRenewable: type = "subscription"
    case .nonConsumable: type = "non_consumable"
    case .consumable: type = "consumable"
    case .nonRenewable: type = "non_renewing"
    default: type = "unknown"
    }
    var period: Any = NSNull()
    if let p = product.subscription?.subscriptionPeriod {
      let unit: String
      switch p.unit {
      case .day: unit = "D"
      case .week: unit = "W"
      case .month: unit = "M"
      case .year: unit = "Y"
      @unknown default: unit = "M"
      }
      period = "P\(p.value)\(unit)"
    }
    return [
      "identifier": product.id,
      "title": product.displayName,
      "description": product.description,
      "price": NSDecimalNumber(decimal: product.price).doubleValue,
      "priceString": product.displayPrice,
      "currencyCode": product.priceFormatStyle.currencyCode,
      "type": type,
      "subscriptionPeriod": period,
      "hasFreeTrial": product.subscription?.introductoryOffer?.paymentMode == .freeTrial,
    ]
  }
}
