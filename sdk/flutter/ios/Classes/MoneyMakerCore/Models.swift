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
    /// Signature check of this response (trusted entitlements). Not part of the wire format.
    public internal(set) var verification: EntitlementVerificationResult = .notRequested

    enum CodingKeys: String, CodingKey { case appUserId, accountToken, entitlements, activeEntitlements, purchases, attributes, requestedAt }

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
    /// True when the SDK is configured with a Test Store key (`mm_test_…`): purchasable without StoreKit.
    public internal(set) var isTestStore: Bool = false
    /// Can be shown on a paywall / purchased (real StoreKit product, or Test Store).
    public var isAvailable: Bool { product != nil || isTestStore }

    public var localizedPrice: String { product?.displayPrice ?? "" }
    public var period: Product.SubscriptionPeriod? { product?.subscription?.subscriptionPeriod }
    public var hasFreeTrial: Bool { product?.subscription?.introductoryOffer?.paymentMode == .freeTrial }
}

public struct Offering: Identifiable, Hashable, Sendable {
    public let id: String
    public let description: String?
    public let packages: [Package]
    /// Remote paywall layout edited in the dashboard (nil → `MoneyMakerPaywall` uses its built-in layout).
    public var paywall: PaywallConfig? = nil
    public func package(_ id: String) -> Package? { packages.first { $0.id == id } }
}

public struct Offerings: Sendable {
    public let current: Offering?
    public let all: [String: Offering]
    /// placementId → resolved offering id (targeting rules + experiments applied server-side).
    public var placements: [String: String] = [:]
    /// A/B tests this user is enrolled in for this response.
    public var experiments: [ExperimentAssignment] = []
    /// Entitlement → product ids (used to compute entitlements offline).
    public var entitlements: [String: [String]] = [:]
    public subscript(id: String) -> Offering? { all[id] }
    /// Offering to show at a placement (e.g. "onboarding", "settings"). Falls back to `current`.
    public func offering(forPlacement placement: String) -> Offering? { placements[placement].flatMap { all[$0] } ?? current }
    /// Experiment that served `offeringId` at `placement` ("default" = current), if any.
    public func experiment(offeringId: String, placement: String?) -> ExperimentAssignment? {
        experiments.first { $0.offeringId == offeringId && $0.placement == (placement ?? "default") }
            ?? experiments.first { $0.offeringId == offeringId }
    }
}

public struct ExperimentAssignment: Codable, Hashable, Sendable {
    public let experimentId: String
    public let variant: String
    public let placement: String
    public let offeringId: String
}

/// Remote paywall configuration (`offerings.<id>.paywall`).
public struct PaywallConfig: Codable, Hashable, Sendable {
    public enum Template: String, Codable, Sendable { case stack, cards, minimal }
    public struct Feature: Codable, Hashable, Sendable { public let icon: String?; public let text: String }
    public struct Colors: Codable, Hashable, Sendable { public let background: String?; public let accent: String?; public let text: String? }
    public struct FooterLink: Codable, Hashable, Sendable { public let title: String; public let url: String }
    public struct Texts: Codable, Hashable, Sendable {
        public let title: String?; public let subtitle: String?; public let cta: String?
        public let features: [Feature]?; public let footerLinks: [FooterLink]?
    }
    public let template: Template?
    public let title: String?
    public let subtitle: String?
    public let cta: String?
    public let features: [Feature]?
    public let footerLinks: [FooterLink]?
    public let heroImage: String?
    public let colors: Colors?
    public let showCloseButton: Bool?
    public let closeDelay: Double?
    public let localizations: [String: Texts]?

    /// Texts for a language ("fr", "en", "pt-BR"…), falling back to the base texts field by field.
    public func texts(for languageCode: String?) -> Texts {
        let code = languageCode ?? ""
        let l = localizations?[code] ?? localizations?[String(code.prefix(2))]
        return Texts(title: l?.title ?? title, subtitle: l?.subtitle ?? subtitle, cta: l?.cta ?? cta,
                     features: l?.features ?? features, footerLinks: l?.footerLinks ?? footerLinks)
    }
}

public enum PaywallEventType: String, Sendable { case impression, close, purchaseStart = "purchase_start", purchase, cancel }

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
    struct OfferingDTO: Decodable { let description: String?; let packages: [PackageDTO]; let paywall: PaywallConfig? }
    let current: String?
    let offerings: [String: OfferingDTO]
    let placements: [String: String?]?
    let experiments: [ExperimentAssignment]?
    let entitlements: [String: [String]]?
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

// MARK: - Customer Center

public struct CustomerCenterConfig: Codable, Hashable, Sendable {
    public struct RetentionOffer: Codable, Hashable, Sendable {
        public let productIdApple: String?
        public let offerIdApple: String?
        public let googleOfferId: String?
        public let message: String
    }
    public struct Survey: Codable, Hashable, Sendable {
        public let question: String
        public let options: [String]
    }
    public let enabled: Bool
    public let supportEmail: String?
    public let retentionOffer: RetentionOffer?
    public let survey: Survey
}

public enum CustomerCenterAction: String, Sendable {
    case cancel, acceptedOffer = "accepted_offer", refund, dismissed, contactSupport = "contact_support"
}

struct FeedbackAck: Decodable { let ok: Bool }
