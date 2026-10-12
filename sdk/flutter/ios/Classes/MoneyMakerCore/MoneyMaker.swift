import Foundation
import StoreKit
import CryptoKit
import os
import Network

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

    /// Ed25519 public key (base64 raw, from `GET /v1/signing-key`) pinned in the app. Set before `configure`.
    /// When nil, the key is fetched once and pinned on first launch (trust on first use).
    public static var signingPublicKey: String?
    /// Key of the hosted MoneyMaker service (moneymaker-io.web.app), pinned by default for that host.
    static let hostedSigningPublicKey = "9F7dzH51ASV9YKJmckzwJPTmNzoaefMzuOPPz2xXOBA="

    /// Signature checking of customer-info responses (trusted entitlements).
    public let entitlementVerification: EntitlementVerificationMode
    /// Configured with a Test Store key (`mm_test_…`): never talks to StoreKit, purchases are sandbox grants.
    public let isTestStore: Bool

    private let api: APIClient
    private let cache: Cache
    private let verifier: SignatureVerifier
    private let pending: PendingTransactionQueue
    private var flushing = false
    private var updatesTask: Task<Void, Never>?
    private var foregroundObserver: NSObjectProtocol?
    private let pathMonitor = NWPathMonitor()
    private let log = Logger(subsystem: "MoneyMaker", category: "sdk")

    @discardableResult
    public static func configure(apiKey: String, appUserID: String? = nil, baseURL: URL = defaultBaseURL,
                                 entitlementVerification: EntitlementVerificationMode = .informational) -> MoneyMaker {
        if let instance { return instance }
        let mm = MoneyMaker(apiKey: apiKey, appUserID: appUserID, baseURL: baseURL, verification: entitlementVerification)
        instance = mm
        return mm
    }

    private init(apiKey: String, appUserID: String?, baseURL: URL, verification: EntitlementVerificationMode) {
        self.api = APIClient(baseURL: baseURL, apiKey: apiKey)
        self.cache = Cache(namespace: String(apiKey.suffix(8)))
        self.entitlementVerification = verification
        self.isTestStore = apiKey.hasPrefix("mm_test_")
        self.verifier = SignatureVerifier(api: api, hardcodedKey: Self.signingPublicKey ?? (baseURL.host == "moneymaker-io.web.app" ? Self.hostedSigningPublicKey : nil), namespace: String(apiKey.suffix(8)))
        self.pending = PendingTransactionQueue(namespace: String(apiKey.suffix(8)))
        self.appUserID = appUserID ?? cache.anonymousID
        self.customerInfo = cache.customerInfo(for: self.appUserID)
        if verification == .enforced, let info = customerInfo, cache.verification(for: info.appUserId) == .failed {
            self.customerInfo = info.revokingEntitlements()
        }
        if isTestStore {
            Task { [weak self] in _ = try? await self?.refreshCustomerInfo() }
            return
        }
        updatesTask = Task { [weak self] in await self?.listenForTransactions() }
        Task { [weak self] in
            await self?.flushPendingTransactions()
            await self?.syncUnfinishedTransactions()
            await self?.syncPurchases()
            _ = try? await self?.refreshCustomerInfo()
        }
        #if os(iOS)
        foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.flushPendingTransactions() }
        }
        #endif
        pathMonitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in await self?.flushPendingTransactions() }
        }
        pathMonitor.start(queue: DispatchQueue(label: "MoneyMaker.network"))
    }

    deinit {
        updatesTask?.cancel()
        pathMonitor.cancel()
        if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
    }

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
            info = try await fetchCustomerInfo("customers/\(previous.urlPath)/alias", body: ["newAppUserId": newAppUserID])
        } else {
            info = try await fetchCustomerInfo("customers/\(newAppUserID.urlPath)")
        }
        publish(info)
        await syncPurchases()
        return customerInfo ?? info
    }

    // MARK: Web purchases

    /// Redeems a web purchase made without an account (link `…?mm_redeem=TOKEN` from the hosted
    /// `/pay/success` page): the purchase is moved to the current app user. Single use.
    @discardableResult
    public func redeemWebPurchase(token: String) async throws -> CustomerInfo {
        let info = try await fetchCustomerInfo("customers/\(appUserID.urlPath)/redeem", body: ["token": token])
        publish(info)
        return info
    }

    /// Extracts `mm_redeem` from an opened URL (universal link or custom scheme), if any.
    public static func webRedemptionToken(from url: URL) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "mm_redeem" }?.value
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
        do {
            let info = try await fetchCustomerInfo("customers/\(appUserID.urlPath)")
            publish(info)
            return info
        } catch let e as MoneyMakerError where e.isRetryable && !isTestStore {
            // Server unreachable: entitlements from StoreKit, mapped with the cached entitlement map.
            guard let info = await offlineCustomerInfo() else { throw e }
            publish(info, persist: false)
            return info
        }
    }

    /// Entitlements computed on device from `Transaction.currentEntitlements` (nil before the first `loadOfferings()`).
    public func offlineCustomerInfo() async -> CustomerInfo? {
        guard let map = cache.entitlementMap else { return nil }
        var txs: [Transaction] = []
        for await v in Transaction.currentEntitlements { if case .verified(let t) = v { txs.append(t) } }
        return CustomerInfo.offline(appUserID: appUserID, accountToken: accountToken, entitlementMap: map, transactions: txs, previous: customerInfo)
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

    // MARK: Virtual currencies

    /// Balances of the virtual currencies configured in the dashboard (credited automatically on purchases).
    /// Spending is server-side only (secret key): `POST /v1/customers/{id}/wallet/{code}/spend`.
    public func virtualCurrencies() async throws -> [String: VirtualCurrencyBalance] {
        let dto: WalletDTO = try await api.get("customers/\(appUserID.urlPath)/wallet")
        return dto.virtualCurrencies
    }

    // MARK: Offerings

    /// Loads the paywall configured in the dashboard and resolves real App Store products/prices.
    @discardableResult
    public func loadOfferings() async throws -> Offerings {
        var q = URLComponents()
        q.queryItems = [
            URLQueryItem(name: "appUserId", value: appUserID),
            URLQueryItem(name: "platform", value: "ios"),
            Bundle.main.infoDictionary?["CFBundleShortVersionString"].flatMap { $0 as? String }.map { URLQueryItem(name: "appVersion", value: $0) },
            Locale.current.region.map { URLQueryItem(name: "country", value: $0.identifier) },
        ].compactMap { $0 }
        let dto: OfferingsDTO = try await api.get("offerings?\(q.percentEncodedQuery ?? "")")
        if let map = dto.entitlements { cache.entitlementMap = map }
        let ids = Set(dto.offerings.values.flatMap { $0.packages.compactMap { $0.productIds["app_store"] } })
        let products = isTestStore ? [] : try await Product.products(for: ids)
        let byId = Dictionary(uniqueKeysWithValues: products.map { ($0.id, $0) })
        var all: [String: Offering] = [:]
        for (id, o) in dto.offerings {
            let packages = o.packages.map { p in
                var pkg = Package(id: p.id, productIds: p.productIds, metadata: (p.metadata ?? [:]).mapValues(\.stringValue),
                                  product: p.productIds["app_store"].flatMap { byId[$0] })
                pkg.isTestStore = isTestStore
                return pkg
            }
            all[id] = Offering(id: id, description: o.description, packages: packages, paywall: o.paywall)
        }
        let result = Offerings(current: dto.current.flatMap { all[$0] }, all: all,
                               placements: (dto.placements ?? [:]).compactMapValues { $0 },
                               experiments: dto.experiments ?? [], entitlements: dto.entitlements ?? [:])
        offerings = result
        return result
    }

    /// Offering resolved for a placement (targeting rules + A/B tests). Call `loadOfferings()` first.
    public func offering(forPlacement placement: String) -> Offering? { offerings?.offering(forPlacement: placement) }

    /// Records a paywall event (impressions, closes, purchases) for paywall analytics and experiment results.
    /// `MoneyMakerPaywall` calls this automatically; use it if you build your own paywall UI.
    public func trackPaywallEvent(_ type: PaywallEventType, offering: Offering, placement: String? = nil) {
        var body: [String: Any] = ["type": type.rawValue, "offeringId": offering.id]
        if let placement { body["placement"] = placement }
        if let exp = offerings?.experiment(offeringId: offering.id, placement: placement) {
            body["experimentId"] = exp.experimentId
            body["variant"] = exp.variant
        }
        let path = "customers/\(appUserID.urlPath)/paywall-events"
        let api = self.api
        Task { let _: FeedbackAck? = try? await api.send(path, body: body) }
    }

    // MARK: Ad revenue (AdMob, AppLovin…)

    /// Logs impression-level ad revenue. Values map 1:1 to Google Mobile Ads' paid event handler:
    /// `ad.paidEventHandler = { value in MoneyMaker.shared.trackAdRevenue(valueMicros: value.value.multiplying(byPowerOf10: 6).int64Value, currencyCode: value.currencyCode, precision: value.precision.rawValue, adUnitID: ad.adUnitID) }`.
    /// `precision`: 0 unknown, 1 estimated, 2 publisher provided, 3 precise. `type`: "impression" (default), "click" or "rewarded".
    public func trackAdRevenue(valueMicros: Int64, currencyCode: String, precision: Int = 0, adUnitID: String,
                               network: String = "admob", placement: String? = nil, type: String = "impression") {
        var body: [String: Any] = ["type": type, "network": network, "adUnitId": adUnitID, "revenueMicros": valueMicros,
                                   "currency": currencyCode, "precision": precision]
        if let placement { body["placement"] = placement }
        let path = "customers/\(appUserID.urlPath)/ad-events"
        let api = self.api
        Task { let _: FeedbackAck? = try? await api.send(path, body: body) }
    }

    /// Same as `trackAdRevenue` for an impression (revenue may be 0 when the network reports it separately).
    public func trackAdImpression(adUnitID: String, network: String = "admob", placement: String? = nil,
                                  valueMicros: Int64 = 0, currencyCode: String = "USD", precision: Int = 0) {
        trackAdRevenue(valueMicros: valueMicros, currencyCode: currencyCode, precision: precision, adUnitID: adUnitID,
                       network: network, placement: placement, type: "impression")
    }

    // MARK: Purchases

    @discardableResult
    public func purchase(_ package: Package) async throws -> PurchaseResult {
        if isTestStore { return try await testPurchase(productID: package.productIds["app_store"] ?? package.id) }
        guard let product = package.product else { throw MoneyMakerError.productNotFound(package.productIds["app_store"] ?? package.id) }
        return try await purchase(product)
    }

    @discardableResult
    public func purchase(productID: String) async throws -> PurchaseResult {
        if isTestStore { return try await testPurchase(productID: productID) }
        guard let product = try await Product.products(for: [productID]).first else { throw MoneyMakerError.productNotFound(productID) }
        return try await purchase(product)
    }

    @discardableResult
    public func purchase(_ product: Product, options: Set<Product.PurchaseOption> = []) async throws -> PurchaseResult {
        if isTestStore { return try await testPurchase(productID: product.id) }
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
        if isTestStore { return try await refreshCustomerInfo() }
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

    // MARK: Customer Center

    /// Customer Center configuration set in the dashboard (survey, retention offer, support email).
    public func loadCustomerCenterConfig() async throws -> CustomerCenterConfig {
        try await api.get("customer-center")
    }

    /// Records a Customer Center answer (cancellation reason, accepted offer, refund…).
    public func sendCustomerCenterFeedback(reason: String, comment: String? = nil, action: CustomerCenterAction) async throws {
        var body: [String: Any] = ["reason": reason, "action": action.rawValue]
        if let comment, !comment.isEmpty { body["comment"] = comment }
        let _: FeedbackAck = try await api.send("customers/\(appUserID.urlPath)/customer-center/feedback", body: body)
    }

    /// Signs an App Store promotional offer (retention, win-back) on the MoneyMaker server
    /// with the project's In-App Purchase key. Pass the result to `Product.PurchaseOption.promotionalOffer`.
    public func signPromotionalOffer(productID: String, offerID: String) async throws -> PromotionalOfferSignature {
        struct DTO: Decodable { let keyIdentifier: String; let nonce: String; let timestamp: Int; let signature: String }
        let r: DTO = try await api.send("customers/\(appUserID.urlPath)/offers/apple/sign", body: ["productId": productID, "offerId": offerID])
        guard let nonce = UUID(uuidString: r.nonce), let sig = Data(base64Encoded: r.signature) else { throw MoneyMakerError.productNotFound(productID) }
        return PromotionalOfferSignature(keyID: r.keyIdentifier, nonce: nonce, signature: sig, timestamp: r.timestamp)
    }

    // MARK: Internals

    /// Deterministic UUID shared with the backend so server notifications map back to this user.
    var accountToken: String {
        let h = SHA256.hash(data: Data("moneymaker:\(appUserID)".utf8)).map { String(format: "%02x", $0) }.joined()
        let a = Array(h)
        let variant = String((Int(String(a[16]), radix: 16)! & 3) | 8, radix: 16)
        return "\(String(a[0..<8]))-\(String(a[8..<12]))-5\(String(a[13..<16]))-\(variant)\(String(a[17..<20]))-\(String(a[20..<32]))"
    }

    /// Posts the transaction; `finish()` only once the server accepted it. On a network / 5xx failure the JWS
    /// is queued (retried on launch, foreground, network back) and entitlements are computed on device meanwhile.
    private func handle(_ verification: VerificationResult<Transaction>) async throws -> CustomerInfo {
        guard case .verified(let transaction) = verification else { throw MoneyMakerError.unverifiedTransaction }
        do {
            let info = try await post(verification)
            pending.remove(transaction.id)
            await transaction.finish()
            publish(info)
            return info
        } catch let e as MoneyMakerError where e.isRetryable {
            pending.enqueue(.init(transactionID: transaction.id, appUserID: appUserID, jws: verification.jwsRepresentation, queuedAt: Date()))
            log.info("transaction \(transaction.id) queued for retry: \(e.localizedDescription, privacy: .public)")
            guard let info = await offlineCustomerInfo() else { throw e }
            publish(info, persist: false)
            return info
        }
    }

    private func post(_ verification: VerificationResult<Transaction>) async throws -> CustomerInfo {
        try await fetchCustomerInfo("customers/\(appUserID.urlPath)/apple", body: ["signedTransaction": verification.jwsRepresentation])
    }

    /// Re-posts queued transactions, then finishes the StoreKit transactions the server accepted.
    public func flushPendingTransactions() async {
        guard !isTestStore, !flushing else { return }
        let items = pending.items
        guard !items.isEmpty else { return }
        flushing = true
        defer { flushing = false }
        var accepted = Set<UInt64>()
        var last: CustomerInfo?
        for item in items {
            do {
                let info = try await fetchCustomerInfo("customers/\(item.appUserID.urlPath)/apple", body: ["signedTransaction": item.jws])
                accepted.insert(item.transactionID)
                pending.remove(item.transactionID)
                last = info
            } catch let e as MoneyMakerError where e.isRetryable {
                break // still offline
            } catch {
                pending.remove(item.transactionID) // rejected by the server (4xx): retrying won't help
            }
        }
        if !accepted.isEmpty {
            for await v in Transaction.unfinished {
                if case .verified(let t) = v, accepted.contains(t.id) { await t.finish() }
            }
        }
        if let last { publish(last) }
    }

    /// Test Store purchase: sandbox grant on the server, no StoreKit.
    private func testPurchase(productID: String) async throws -> PurchaseResult {
        let info = try await fetchCustomerInfo("customers/\(appUserID.urlPath)/test-purchase", body: ["productId": productID])
        publish(info)
        return .success(info)
    }

    /// Fetches customer info with a fresh nonce and checks the response signature per `entitlementVerification`.
    private func fetchCustomerInfo(_ path: String, body: [String: Any]? = nil) async throws -> CustomerInfo {
        let nonce = UUID().uuidString.lowercased()
        let (data, response) = try await api.raw(path, method: body == nil ? "GET" : "POST",
                                                 body: try body.map { try JSONSerialization.data(withJSONObject: $0) },
                                                 headers: ["X-Nonce": nonce])
        var info = try APIClient.decoder.decode(CustomerInfo.self, from: data)
        guard entitlementVerification != .disabled else { return info }
        guard let key = await verifier.publicKey() else {
            if entitlementVerification == .enforced { return info.revokingEntitlements() }
            return info
        }
        let ok = SignatureVerifier.verify(key: key, header: response.value(forHTTPHeaderField: "X-MoneyMaker-Signature"), nonce: nonce,
                                          requestTime: response.value(forHTTPHeaderField: "X-Request-Time"), body: data)
        if ok { info.verification = .verified; return info }
        log.error("customer info signature verification failed for \(path, privacy: .public)")
        if entitlementVerification == .enforced { return info.revokingEntitlements() }
        info.verification = .failed
        return info
    }

    private func listenForTransactions() async {
        for await verification in Transaction.updates {
            do { _ = try await handle(verification) }
            catch { log.error("transaction update failed: \(error.localizedDescription, privacy: .public)") }
        }
    }

    /// Silently posts every purchase the Apple ID currently owns (no password prompt).
    /// Migrates subscribers who bought before MoneyMaker was integrated; cheap and idempotent.
    public func syncPurchases() async {
        guard !isTestStore else { return }
        var last: CustomerInfo?
        for await verification in Transaction.currentEntitlements {
            if let info = try? await post(verification) { last = info }
        }
        if let last { publish(last) }
    }

    private func syncUnfinishedTransactions() async {
        for await verification in Transaction.unfinished {
            _ = try? await handle(verification)
        }
    }

    private func publish(_ info: CustomerInfo, persist: Bool = true) {
        guard info.appUserId == appUserID else { return }
        customerInfo = info
        if persist { cache.store(info) }
        onCustomerInfoUpdate?(info)
    }
}

#if os(iOS)
import UIKit
#endif

extension String {
    var urlPath: String { addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? self }
}

public struct VirtualCurrencyBalance: Codable, Hashable, Sendable {
    public let code: String
    public let name: String
    public let balance: Int
}

struct WalletDTO: Decodable { let virtualCurrencies: [String: VirtualCurrencyBalance] }

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
        let (data, _) = try await raw(path, method: method, body: body)
        return try Self.decoder.decode(T.self, from: data)
    }

    /// Raw 2xx response (body bytes are needed to verify signatures). Retries network errors / 5xx.
    func raw(_ path: String, method: String, body: Data?, headers: [String: String] = [:]) async throws -> (Data, HTTPURLResponse) {
        var req = URLRequest(url: URL(string: "\(baseURL.absoluteString)/\(path)")!)
        req.httpMethod = method
        req.httpBody = body
        req.timeoutInterval = 20
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("MoneyMaker-iOS/1.0", forHTTPHeaderField: "User-Agent")
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        var lastError: Error = MoneyMakerError.network("unknown")
        for attempt in 0..<3 {
            do {
                let (data, response) = try await URLSession.shared.data(for: req)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (200..<300).contains(status), let http = response as? HTTPURLResponse { return (data, http) }
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
        defaults.set(info.verification.rawValue, forKey: "mm.\(namespace).verification.\(info.appUserId)")
    }

    func verification(for id: String) -> EntitlementVerificationResult? {
        defaults.string(forKey: "mm.\(namespace).verification.\(id)").flatMap(EntitlementVerificationResult.init(rawValue:))
    }

    /// Entitlement → product ids, from the last `GET /v1/offerings` (offline entitlements).
    var entitlementMap: [String: [String]]? {
        get { defaults.data(forKey: "mm.\(namespace).entitlementMap").flatMap { try? JSONDecoder().decode([String: [String]].self, from: $0) } }
        nonmutating set { defaults.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "mm.\(namespace).entitlementMap") }
    }
}
