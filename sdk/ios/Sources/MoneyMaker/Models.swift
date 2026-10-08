import Foundation
import StoreKit

public struct Entitlement: Codable, Hashable, Sendable {
    public let id: String
    public let active: Bool
    public let productId: String
    public let store: String
    public let expiresAt: Date?
    public let willRenew: Bool
    public let isTrial: Bool
    public let billingIssue: Bool
    public let purchasedAt: Date?
}

public struct PurchaseRecord: Codable, Hashable, Sendable {
    public let id: String
    public let store: String
    public let productId: String
    public let type: String
    public let status: String
    public let active: Bool
    public let purchasedAt: Date?
    public let expiresAt: Date?
    public let willRenew: Bool
    public let isTrial: Bool
    public let isSandbox: Bool
    public let billingIssue: Bool
}

public struct CustomerInfo: Codable, Hashable, Sendable {
    public let appUserId: String
    public let accountToken: String
    public let entitlements: [String: Entitlement]
    public let activeEntitlements: [String]
    public let purchases: [PurchaseRecord]
    public let attributes: [String: String]
    public let requestedAt: Date

    public func isEntitled(_ id: String) -> Bool {
        guard let e = entitlements[id], e.active else { return false }
        if let exp = e.expiresAt { return exp > Date() }
        return true
    }

    /// Products the user owns right now — useful to hide already-purchased items on a paywall.
    public var activeProductIds: Set<String> { Set(purchases.filter(\.active).map(\.productId)) }
}

public struct Package: Identifiable, Hashable, Sendable {
    public let id: String
    public let productIds: [String: String]
    public let metadata: [String: String]
    public let product: Product?

    public var localizedPrice: String { product?.displayPrice ?? "" }
    public var period: Product.SubscriptionPeriod? { product?.subscription?.subscriptionPeriod }
    public var hasFreeTrial: Bool { product?.subscription?.introductoryOffer?.paymentMode == .freeTrial }
}

public struct Offering: Identifiable, Hashable, Sendable {
    public let id: String
    public let description: String?
    public let packages: [Package]
    public func package(_ id: String) -> Package? { packages.first { $0.id == id } }
}

public struct Offerings: Sendable {
    public let current: Offering?
    public let all: [String: Offering]
    public subscript(id: String) -> Offering? { all[id] }
}

public enum PurchaseResult: Sendable {
    case success(CustomerInfo)
    case userCancelled
    case pending
}

public enum MoneyMakerError: LocalizedError, Sendable {
    case notConfigured
    case productNotFound(String)
    case unverifiedTransaction
    case server(status: Int, code: String, message: String)
    case network(String)

    public var errorDescription: String? {
        switch self {
        case .notConfigured: return "MoneyMaker.configure(apiKey:) must be called first."
        case .productNotFound(let id): return "Product \(id) not found in the App Store."
        case .unverifiedTransaction: return "The App Store transaction could not be verified."
        case let .server(status, code, message): return "MoneyMaker \(status) \(code): \(message)"
        case .network(let m): return m
        }
    }
}

// MARK: - Wire format

struct OfferingsDTO: Decodable {
    struct PackageDTO: Decodable { let id: String; let productIds: [String: String]; let metadata: [String: JSONValue]? }
    struct OfferingDTO: Decodable { let description: String?; let packages: [PackageDTO] }
    let current: String?
    let offerings: [String: OfferingDTO]
}

enum JSONValue: Decodable, Hashable {
    case string(String), number(Double), bool(Bool), null, other
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { self = .string(s) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if c.decodeNil() { self = .null }
        else { self = .other }
    }
    var stringValue: String {
        switch self {
        case .string(let s): return s
        case .number(let n): return n.rounded() == n ? String(Int(n)) : String(n)
        case .bool(let b): return String(b)
        default: return ""
        }
    }
}
