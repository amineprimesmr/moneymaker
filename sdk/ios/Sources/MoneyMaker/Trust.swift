import Foundation
import CryptoKit
import StoreKit

// MARK: - Trusted entitlements (signed responses)

/// How the SDK checks the Ed25519 signature (`X-MoneyMaker-Signature`) on customer-info responses.
public enum EntitlementVerificationMode: String, Sendable {
    /// No signature check (`customerInfo.verification == .notRequested`).
    case disabled
    /// Checks and reports `customerInfo.verification`, never changes entitlements. Default.
    case informational
    /// A response that fails verification is treated as having no active entitlement.
    case enforced
}

/// Result of the signature check for a `CustomerInfo`.
public enum EntitlementVerificationResult: String, Codable, Sendable {
    /// Signed by the MoneyMaker server for this request (nonce + time + body hash).
    case verified
    /// Signature missing or invalid: the response may have been tampered with.
    case failed
    /// Verification disabled, no key available, or info loaded from the local cache.
    case notRequested
    /// Computed offline from StoreKit transactions verified on device (server unreachable).
    case verifiedOnDevice
}

/// Public key used to verify signatures. Set `MoneyMaker.signingPublicKey` (base64, raw 32-byte Ed25519,
/// value of `GET /v1/signing-key` → `publicKey`) at release time to pin it in the binary; otherwise the SDK fetches
/// it once on first launch and pins it in UserDefaults (trust on first use).
struct SignatureVerifier: Sendable {
    let api: APIClient
    let hardcodedKey: String?
    let namespace: String
    private var pinKey: String { "mm.\(namespace).signingKey" }

    func publicKey() async -> Curve25519.Signing.PublicKey? {
        if let k = hardcodedKey ?? UserDefaults.standard.string(forKey: pinKey), let key = Self.decode(k) { return key }
        struct DTO: Decodable { let publicKey: String }
        guard let dto: DTO = try? await api.get("signing-key"), let key = Self.decode(dto.publicKey) else { return nil }
        UserDefaults.standard.set(dto.publicKey, forKey: pinKey)
        return key
    }

    static func decode(_ b64: String) -> Curve25519.Signing.PublicKey? {
        guard let raw = Data(base64Encoded: b64) else { return nil }
        return try? Curve25519.Signing.PublicKey(rawRepresentation: raw)
    }

    static func message(nonce: String, requestTime: String, body: Data) -> Data {
        let hash = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        return Data("\(nonce).\(requestTime).\(hash)".utf8)
    }

    static func verify(key: Curve25519.Signing.PublicKey, header: String?, nonce: String, requestTime: String?, body: Data) -> Bool {
        guard let header, header.hasPrefix("v1="), let requestTime,
              let sig = Data(base64Encoded: String(header.dropFirst(3))) else { return false }
        return key.isValidSignature(sig, for: message(nonce: nonce, requestTime: requestTime, body: body))
    }
}

extension CustomerInfo {
    /// Same info with every entitlement inactive (enforced mode after a failed verification).
    func revokingEntitlements() -> CustomerInfo {
        var copy = CustomerInfo(
            appUserId: appUserId, accountToken: accountToken,
            entitlements: entitlements.mapValues {
                Entitlement(id: $0.id, active: false, productId: $0.productId, store: $0.store, expiresAt: $0.expiresAt,
                            willRenew: $0.willRenew, isTrial: $0.isTrial, billingIssue: $0.billingIssue, purchasedAt: $0.purchasedAt)
            },
            activeEntitlements: [], purchases: purchases, attributes: attributes, requestedAt: requestedAt)
        copy.verification = .failed
        return copy
    }

    /// Entitlements computed locally from StoreKit `Transaction.currentEntitlements` and the cached
    /// entitlement → products map (from `GET /v1/offerings`). Used when the server is unreachable.
    static func offline(appUserID: String, accountToken: String, entitlementMap: [String: [String]],
                        transactions: [Transaction], previous: CustomerInfo?) -> CustomerInfo {
        let now = Date()
        let live = transactions.filter { $0.revocationDate == nil && ($0.expirationDate.map { $0 > now } ?? true) }
        var ents: [String: Entitlement] = [:]
        for (id, products) in entitlementMap {
            guard let t = live.filter({ products.contains("*") || products.contains($0.productID) })
                .max(by: { ($0.expirationDate ?? .distantFuture) < ($1.expirationDate ?? .distantFuture) }) else { continue }
            ents[id] = Entitlement(id: id, active: true, productId: t.productID, store: "app_store", expiresAt: t.expirationDate,
                                   willRenew: false, isTrial: false, billingIssue: false, purchasedAt: t.originalPurchaseDate)
        }
        let purchases = live.map { t in
            PurchaseRecord(id: String(t.originalID), store: "app_store", productId: t.productID,
                           type: t.productType == .autoRenewable ? "subscription" : t.productType == .consumable ? "consumable" : "non_consumable",
                           status: "active", active: true, purchasedAt: t.originalPurchaseDate, expiresAt: t.expirationDate,
                           willRenew: false, isTrial: false, isSandbox: t.environment != .production, billingIssue: false)
        }
        var info = CustomerInfo(appUserId: appUserID, accountToken: accountToken, entitlements: ents,
                                activeEntitlements: ents.keys.sorted(), purchases: purchases,
                                attributes: previous?.attributes ?? [:], requestedAt: now)
        info.verification = .verifiedOnDevice
        return info
    }
}

// MARK: - Offline retry queue

/// StoreKit transactions whose JWS could not reach the server (network). Persisted in UserDefaults and
/// re-posted on launch, when the app returns to the foreground and when the network comes back.
/// The transaction is only `finish()`ed once the server accepted it.
struct PendingTransactionQueue {
    struct Item: Codable, Hashable { let transactionID: UInt64; let appUserID: String; let jws: String; let queuedAt: Date }
    let namespace: String
    private var key: String { "mm.\(namespace).pendingTransactions" }

    var items: [Item] {
        guard let d = UserDefaults.standard.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([Item].self, from: d)) ?? []
    }

    private func save(_ items: [Item]) {
        if let d = try? JSONEncoder().encode(items) { UserDefaults.standard.set(d, forKey: key) }
    }

    func enqueue(_ item: Item) {
        var all = items.filter { $0.transactionID != item.transactionID }
        all.append(item)
        save(Array(all.suffix(100)))
    }

    func remove(_ transactionID: UInt64) { save(items.filter { $0.transactionID != transactionID }) }
}

extension MoneyMakerError {
    /// Network failure or 5xx: the purchase must be retried later rather than dropped.
    var isRetryable: Bool {
        switch self {
        case .network: return true
        case .server(let status, _, _): return status >= 500 || status == 429
        default: return false
        }
    }
}
