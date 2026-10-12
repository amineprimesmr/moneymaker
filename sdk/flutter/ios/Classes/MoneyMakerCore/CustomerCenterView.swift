#if canImport(SwiftUI)
import SwiftUI
import StoreKit
#if os(iOS)
import UIKit
#endif

/// Signature for an App Store promotional offer (MoneyMaker signs it by default, see `signPromotionalOffer`).
public struct PromotionalOfferSignature: Sendable {
    public let keyID: String
    public let nonce: UUID
    public let signature: Data
    public let timestamp: Int
    public init(keyID: String, nonce: UUID, signature: Data, timestamp: Int) {
        self.keyID = keyID; self.nonce = nonce; self.signature = signature; self.timestamp = timestamp
    }
}

/// Self-service subscription screen (RevenueCat-style Customer Center):
/// active subscriptions, manage / cancel, restore, refund, contact support,
/// and a cancellation survey with an optional retention offer configured in the dashboard.
public struct MoneyMakerCustomerCenter: View {
    @ObservedObject private var mm = MoneyMaker.shared
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    private let accent: Color
    private let signOffer: ((_ productID: String, _ offerID: String) async throws -> PromotionalOfferSignature)?

    @State private var config: CustomerCenterConfig?
    @State private var busy = false
    @State private var message: String?
    @State private var showSurvey = false
    @State private var retention: (reason: String, comment: String)?

    /// - Parameter signOffer: custom signer for promotional offers. Defaults to MoneyMaker's server
    ///   signing (needs the In-App Purchase key in the dashboard).
    public init(accent: Color = .green,
                signOffer: ((_ productID: String, _ offerID: String) async throws -> PromotionalOfferSignature)? = nil) {
        self.accent = accent
        self.signOffer = signOffer
    }

    private var active: [PurchaseRecord] {
        (mm.customerInfo?.purchases ?? []).filter { $0.active && $0.type == "subscription" }
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "Subscriptions")) {
                    if active.isEmpty {
                        Text(String(localized: "No active subscription")).foregroundStyle(.secondary)
                    }
                    ForEach(active, id: \.id) { SubscriptionRow(purchase: $0, accent: accent) }
                }
                Section {
                    if active.contains(where: { $0.store == "app_store" }) {
                        Button(String(localized: "Manage subscription")) { Task { await mm.showManageSubscriptions() } }
                        Button(String(localized: "Cancel subscription"), role: .destructive) { showSurvey = true }
                        #if os(iOS)
                        Button(String(localized: "Request a refund")) { Task { await requestRefund() } }
                        #endif
                    }
                    Button(String(localized: "Restore purchases")) { Task { await restore() } }
                    if let email = config?.supportEmail, let url = URL(string: "mailto:\(email)?subject=\(supportSubject)") {
                        Button(String(localized: "Contact support")) {
                            Task { try? await mm.sendCustomerCenterFeedback(reason: "support", action: .contactSupport) }
                            openURL(url)
                        }
                    }
                }
                .disabled(busy)
                if let message { Section { Text(message).font(.footnote).foregroundStyle(.secondary) } }
            }
            .navigationTitle(String(localized: "Account"))
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(String(localized: "Close")) { dismiss() } } }
            .tint(accent)
            .task {
                config = try? await mm.loadCustomerCenterConfig()
                _ = try? await mm.refreshCustomerInfo()
            }
            .sheet(isPresented: $showSurvey) {
                CancellationSurvey(survey: config?.survey) { reason, comment in
                    showSurvey = false
                    Task { await afterSurvey(reason: reason, comment: comment) }
                }
            }
            .alert(String(localized: "Before you go"), isPresented: Binding(get: { retention != nil }, set: { if !$0 { retention = nil } })) {
                Button(String(localized: "Accept offer")) { if let r = retention { Task { await acceptOffer(r) } } }
                Button(String(localized: "Continue cancelling"), role: .destructive) { if let r = retention { Task { await cancel(r) } } }
            } message: {
                Text(config?.retentionOffer?.message ?? "")
            }
        }
    }

    private var supportSubject: String {
        "Support \(mm.appUserID)".addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "Support"
    }

    // MARK: Actions

    private func afterSurvey(reason: String, comment: String) async {
        if config?.retentionOffer != nil { retention = (reason, comment) }
        else { await cancel((reason, comment)) }
    }

    private func cancel(_ r: (reason: String, comment: String)) async {
        retention = nil
        try? await mm.sendCustomerCenterFeedback(reason: r.reason, comment: r.comment, action: .cancel)
        await mm.showManageSubscriptions()
        _ = try? await mm.refreshCustomerInfo()
    }

    private func acceptOffer(_ r: (reason: String, comment: String)) async {
        retention = nil
        try? await mm.sendCustomerCenterFeedback(reason: r.reason, comment: r.comment, action: .acceptedOffer)
        let signOffer = signOffer ?? { try await MoneyMaker.shared.signPromotionalOffer(productID: $0, offerID: $1) }
        guard let offer = config?.retentionOffer, let offerID = offer.offerIdApple,
              let productID = offer.productIdApple ?? active.first(where: { $0.store == "app_store" })?.productId else {
            message = config?.retentionOffer?.message
            return
        }
        busy = true; defer { busy = false }
        do {
            guard let product = try await Product.products(for: [productID]).first else { throw MoneyMakerError.productNotFound(productID) }
            let s = try await signOffer(productID, offerID)
            let option = Product.PurchaseOption.promotionalOffer(offerID: offerID, keyID: s.keyID, nonce: s.nonce, signature: s.signature, timestamp: s.timestamp)
            _ = try await mm.purchase(product, options: [option])
            message = String(localized: "Offer applied. Thank you for staying!")
        } catch {
            message = error.localizedDescription
        }
    }

    private func restore() async {
        busy = true; defer { busy = false }
        do {
            let info = try await mm.restorePurchases()
            message = info.activeEntitlements.isEmpty ? String(localized: "No purchases to restore.") : String(localized: "Purchases restored.")
        } catch { message = error.localizedDescription }
    }

    #if os(iOS)
    private func requestRefund() async {
        guard let productID = active.first(where: { $0.store == "app_store" })?.productId,
              case .verified(let transaction)? = await Transaction.latest(for: productID),
              let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene
        else { message = String(localized: "No App Store purchase to refund."); return }
        do {
            let status = try await transaction.beginRefundRequest(in: scene)
            if status == .success {
                try? await mm.sendCustomerCenterFeedback(reason: "refund_requested", action: .refund)
                message = String(localized: "Refund requested. Apple will email you its decision.")
            }
        } catch { message = error.localizedDescription }
    }
    #endif
}

struct SubscriptionRow: View {
    let purchase: PurchaseRecord
    let accent: Color

    private var storeName: String {
        switch purchase.store {
        case "app_store": return "App Store"
        case "play_store": return "Google Play"
        case "stripe": return "Web"
        default: return purchase.store
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(purchase.productId).font(.headline)
                Spacer()
                Text(storeName).font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 2)
                    .background(accent.opacity(0.2), in: Capsule()).foregroundStyle(accent)
            }
            if let date = purchase.expiresAt {
                Text(purchase.willRenew
                     ? String(localized: "Renews on \(date.formatted(date: .abbreviated, time: .omitted))")
                     : String(localized: "Expires on \(date.formatted(date: .abbreviated, time: .omitted))"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if purchase.isTrial { Text(String(localized: "Free trial")).font(.caption).foregroundStyle(accent) }
            if purchase.billingIssue { Text(String(localized: "Billing issue: update your payment method")).font(.caption).foregroundStyle(.red) }
        }
    }
}

struct CancellationSurvey: View {
    let survey: CustomerCenterConfig.Survey?
    let onDone: (_ reason: String, _ comment: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var reason: String?
    @State private var comment = ""

    var body: some View {
        NavigationStack {
            Form {
                Section(survey?.question ?? String(localized: "Why are you cancelling?")) {
                    ForEach(survey?.options ?? [String(localized: "Other")], id: \.self) { option in
                        Button { reason = option } label: {
                            HStack {
                                Text(option).foregroundStyle(.primary)
                                Spacer()
                                if reason == option { Image(systemName: "checkmark") }
                            }
                        }
                    }
                }
                Section { TextField(String(localized: "Comment (optional)"), text: $comment, axis: .vertical).lineLimit(3...6) }
            }
            .navigationTitle(String(localized: "Cancel subscription"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Back")) {
                        Task { try? await MoneyMaker.shared.sendCustomerCenterFeedback(reason: reason ?? "none", action: .dismissed) }
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Continue")) { onDone(reason ?? "", comment) }.disabled(reason == nil)
                }
            }
        }
    }
}

public extension View {
    /// Presents the MoneyMaker Customer Center as a sheet.
    func moneyMakerCustomerCenter(isPresented: Binding<Bool>, accent: Color = .green,
                                  signOffer: ((_ productID: String, _ offerID: String) async throws -> PromotionalOfferSignature)? = nil) -> some View {
        sheet(isPresented: isPresented) { MoneyMakerCustomerCenter(accent: accent, signOffer: signOffer) }
    }
}
#endif
