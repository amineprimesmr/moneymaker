import Foundation
import StoreKit
import CryptoKit
import os

/// MoneyMaker — subscriptions for App Store, Google Play and Stripe, on your own backend.
///
/// ```swift
/// MoneyMaker.configure(apiKey: "mm_pub_…", appUserID: user.id)
/// if MoneyMaker.shared.isEntitled("premium") { … }
/// try await MoneyMaker.shared.purchase(package)
/// ```
@MainActor
public final class MoneyMaker: ObservableObject {
    nonisolated public static let defaultBaseURL = URL(string: "https://moneymaker-io.web.app/v1")!

    private static var instance: MoneyMaker?
    public static var shared: MoneyMaker {
        guard let instance else { fatalError(MoneyMakerError.notConfigured.localizedDescription) }
        return instance
    }
    public static var isConfigured: Bool { instance != nil }

    /// Latest customer state. Observe it from SwiftUI (`@ObservedObject var mm = MoneyMaker.shared`).
    @Published public private(set) var customerInfo: CustomerInfo?
    @Published public private(set) var offerings: Offerings?
    public private(set) var appUserID: String

    /// Called whenever entitlements change (purchase, renewal, refund pushed by StoreKit, login…).
    public var onCustomerInfoUpdate: ((CustomerInfo) -> Void)?

    private let api: APIClient
    private let cache: Cache
    private var updatesTask: Task<Void, Never>?
    private let log = Logger(subsystem: "MoneyMaker", category: "sdk")

    @discardableResult
    public static func configure(apiKey: String, appUserID: String? = nil, baseURL: URL = defaultBaseURL) -> MoneyMaker {
        if let instance { return instance }
        let mm = MoneyMaker(apiKey: apiKey, appUserID: appUserID, baseURL: baseURL)
        instance = mm
        return mm
    }

    private init(apiKey: String, appUserID: String?, baseURL: URL) {
        self.api = APIClient(baseURL: baseURL, apiKey: apiKey)
        self.cache = Cache(namespace: String(apiKey.suffix(8)))
        self.appUserID = appUserID ?? cache.anonymousID
        self.customerInfo = cache.customerInfo(for: self.appUserID)
        updatesTask = Task { [weak self] in await self?.listenForTransactions() }
        Task { [weak self] in
            await self?.syncUnfinishedTransactions()
            _ = try? await self?.refreshCustomerInfo()
        }
    }

    deinit { updatesTask?.cancel() }

    // MARK: Identity

    public var isAnonymous: Bool { appUserID.hasPrefix("$anon:") }

    /// Identifies the user. Purchases made while anonymous are moved to this id.
    @discardableResult
    public func logIn(_ newAppUserID: String) async throws -> CustomerInfo {
        guard newAppUserID != appUserID else { return try await refreshCustomerInfo() }
        let previous = appUserID
        appUserID = newAppUserID
        let info: CustomerInfo
        if previous.hasPrefix("$anon:") {
            info = try await api.send("customers/\(previous.urlPath)/alias", body: ["newAppUserId": newAppUserID])
        } else {
            info = try await api.get("customers/\(newAppUserID.urlPath)")
        }
        publish(info)
        return info
    }

    /// Switches back to a fresh anonymous id.
    public func logOut() {
        cache.resetAnonymousID()
        appUserID = cache.anonymousID
        customerInfo = nil
        Task { _ = try? await refreshCustomerInfo() }
    }

    // MARK: Customer info

    /// Cached synchronous check. Works offline with the last known state.
    public func isEntitled(_ entitlement: String) -> Bool { customerInfo?.isEntitled(entitlement) ?? false }

    @discardableResult
    public func refreshCustomerInfo() async throws -> CustomerInfo {
        let info: CustomerInfo = try await api.get("customers/\(appUserID.urlPath)")
        publish(info)
        return info
    }

    /// Returns cached info if fresher than 5 minutes, otherwise fetches it.
    public func getCustomerInfo() async throws -> CustomerInfo {
        if let info = customerInfo, Date().timeIntervalSince(info.requestedAt) < 300 { return info }
        return try await refreshCustomerInfo()
    }

    public func setAttributes(_ attributes: [String: String?]) async throws {
        let body = ["attributes": attributes.mapValues { $0 as Any? ?? NSNull() }]
        let _: [String: Bool] = try await api.send("customers/\(appUserID.urlPath)/attributes", body: body)
    }

    // MARK: Offerings

    /// Loads the paywall configured in the dashboard and resolves real App Store products/prices.
    @discardableResult
    public func loadOfferings() async throws -> Offerings {
        let dto: OfferingsDTO = try await api.get("offerings")
        let ids = Set(dto.offerings.values.flatMap { $0.packages.compactMap { $0.productIds["app_store"] } })
        let products = try await Product.products(for: ids)
        let byId = Dictionary(uniqueKeysWithValues: products.map { ($0.id, $0) })
        var all: [String: Offering] = [:]
        for (id, o) in dto.offerings {
            let packages = o.packages.map { p in
                Package(id: p.id, productIds: p.productIds, metadata: (p.metadata ?? [:]).mapValues(\.stringValue),
                        product: p.productIds["app_store"].flatMap { byId[$0] })
            }
            all[id] = Offering(id: id, description: o.description, packages: packages)
        }
        let result = Offerings(current: dto.current.flatMap { all[$0] }, all: all)
        offerings = result
        return result
    }

    // MARK: Purchases

    @discardableResult
    public func purchase(_ package: Package) async throws -> PurchaseResult {
        guard let product = package.product else { throw MoneyMakerError.productNotFound(package.productIds["app_store"] ?? package.id) }
        return try await purchase(product)
    }

    @discardableResult
    public func purchase(productID: String) async throws -> PurchaseResult {
        guard let product = try await Product.products(for: [productID]).first else { throw MoneyMakerError.productNotFound(productID) }
        return try await purchase(product)
    }

    @discardableResult
    public func purchase(_ product: Product, options: Set<Product.PurchaseOption> = []) async throws -> PurchaseResult {
        var opts = options
        if let token = UUID(uuidString: accountToken) { opts.insert(.appAccountToken(token)) }
        let result = try await product.purchase(options: opts)
        switch result {
        case .success(let verification):
            let info = try await handle(verification)
            return .success(info)
        case .userCancelled: return .userCancelled
        case .pending: return .pending
        @unknown default: return .pending
        }
    }

    /// Re-syncs every purchase the Apple ID owns (call from a "Restore purchases" button).
    @discardableResult
    public func restorePurchases() async throws -> CustomerInfo {
        try? await AppStore.sync()
        var last: CustomerInfo?
        for await verification in Transaction.currentEntitlements {
            last = try? await post(verification)
        }
        if let last { publish(last); return last }
        return try await refreshCustomerInfo()
    }

    /// Opens the system subscription management sheet.
    public func showManageSubscriptions() async {
        #if os(iOS) && !targetEnvironment(macCatalyst)
        guard let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene else { return }
        try? await AppStore.showManageSubscriptions(in: scene)
        #endif
    }

    // MARK: Internals

    /// Deterministic UUID shared with the backend so server notifications map back to this user.
    var accountToken: String {
        let h = SHA256.hash(data: Data("moneymaker:\(appUserID)".utf8)).map { String(format: "%02x", $0) }.joined()
        let a = Array(h)
        let variant = String((Int(String(a[16]), radix: 16)! & 3) | 8, radix: 16)
        return "\(String(a[0..<8]))-\(String(a[8..<12]))-5\(String(a[13..<16]))-\(variant)\(String(a[17..<20]))-\(String(a[20..<32]))"
    }

    private func handle(_ verification: VerificationResult<Transaction>) async throws -> CustomerInfo {
        guard case .verified(let transaction) = verification else { throw MoneyMakerError.unverifiedTransaction }
        let info = try await post(verification)
        await transaction.finish()
        publish(info)
        return info
    }

    private func post(_ verification: VerificationResult<Transaction>) async throws -> CustomerInfo {
        try await api.send("customers/\(appUserID.urlPath)/apple", body: ["signedTransaction": verification.jwsRepresentation])
    }

    private func listenForTransactions() async {
        for await verification in Transaction.updates {
            do { _ = try await handle(verification) }
            catch { log.error("transaction update failed: \(error.localizedDescription, privacy: .public)") }
        }
    }

    private func syncUnfinishedTransactions() async {
        for await verification in Transaction.unfinished {
            _ = try? await handle(verification)
        }
    }

    private func publish(_ info: CustomerInfo) {
        guard info.appUserId == appUserID else { return }
        customerInfo = info
        cache.store(info)
        onCustomerInfoUpdate?(info)
    }
}

#if os(iOS)
import UIKit
#endif

extension String {
    var urlPath: String { addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? self }
}

// MARK: - Networking

struct APIClient: Sendable {
    let baseURL: URL
    let apiKey: String

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .millisecondsSince1970
        return d
    }()

    func get<T: Decodable>(_ path: String) async throws -> T { try await request(path, method: "GET", body: nil) }
    func send<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        try await request(path, method: "POST", body: try JSONSerialization.data(withJSONObject: body))
    }

    private func request<T: Decodable>(_ path: String, method: String, body: Data?) async throws -> T {
        var req = URLRequest(url: URL(string: "\(baseURL.absoluteString)/\(path)")!)
        req.httpMethod = method
        req.httpBody = body
        req.timeoutInterval = 20
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("MoneyMaker-iOS/1.0", forHTTPHeaderField: "User-Agent")
        var lastError: Error = MoneyMakerError.network("unknown")
        for attempt in 0..<3 {
            do {
                let (data, response) = try await URLSession.shared.data(for: req)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (200..<300).contains(status) { return try Self.decoder.decode(T.self, from: data) }
                let err = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                let e = MoneyMakerError.server(status: status, code: err?["error"] as? String ?? "http_\(status)", message: err?["message"] as? String ?? "")
                if status < 500 { throw e }
                lastError = e
            } catch let e as MoneyMakerError {
                if case .server(let s, _, _) = e, s < 500 { throw e }
                lastError = e
            } catch {
                lastError = MoneyMakerError.network(error.localizedDescription)
            }
            try? await Task.sleep(nanoseconds: UInt64(400_000_000 * (attempt + 1)))
        }
        throw lastError
    }
}

// MARK: - Offline cache

struct Cache {
    let defaults = UserDefaults.standard
    let namespace: String

    var anonymousID: String {
        let key = "mm.\(namespace).anon"
        if let id = defaults.string(forKey: key) { return id }
        let id = "$anon:\(UUID().uuidString.lowercased())"
        defaults.set(id, forKey: key)
        return id
    }

    func resetAnonymousID() { defaults.removeObject(forKey: "mm.\(namespace).anon") }

    func customerInfo(for id: String) -> CustomerInfo? {
        guard let data = defaults.data(forKey: "mm.\(namespace).info.\(id)") else { return nil }
        return try? APIClient.decoder.decode(CustomerInfo.self, from: data)
    }

    func store(_ info: CustomerInfo) {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .millisecondsSince1970
        if let data = try? e.encode(info) { defaults.set(data, forKey: "mm.\(namespace).info.\(info.appUserId)") }
    }
}
