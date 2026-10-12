#if canImport(SwiftUI)
import SwiftUI
import StoreKit

/// Drop-in paywall driven by the offering configured in the dashboard.
/// Fully restylable: pass your own header, accent colour and legal links.
public struct MoneyMakerPaywall<Header: View>: View {
    @ObservedObject private var mm = MoneyMaker.shared
    @Environment(\.dismiss) private var dismiss
    private let offeringID: String?
    private let accent: Color
    private let header: Header
    private let termsURL: URL?
    private let privacyURL: URL?
    private let onPurchase: (CustomerInfo) -> Void

    @State private var selected: Package?
    @State private var busy = false
    @State private var error: String?

    public init(offering: String? = nil, accent: Color = .green, termsURL: URL? = nil, privacyURL: URL? = nil,
                onPurchase: @escaping (CustomerInfo) -> Void = { _ in }, @ViewBuilder header: () -> Header) {
        self.offeringID = offering
        self.accent = accent
        self.header = header()
        self.termsURL = termsURL
        self.privacyURL = privacyURL
        self.onPurchase = onPurchase
    }

    private var offering: Offering? { offeringID.flatMap { mm.offerings?[$0] } ?? mm.offerings?.current }

    public var body: some View {
        VStack(spacing: 18) {
            header
            if let offering {
                VStack(spacing: 10) {
                    ForEach(offering.packages.filter { $0.product != nil }) { package in
                        PackageRow(package: package, selected: selected?.id == package.id, accent: accent)
                            .onTapGesture { selected = package }
                    }
                }
                Button {
                    Task { await buy() }
                } label: {
                    HStack { if busy { ProgressView().tint(.black) }; Text(ctaTitle).fontWeight(.bold) }
                        .frame(maxWidth: .infinity).padding(.vertical, 16)
                        .background(accent, in: RoundedRectangle(cornerRadius: 16)).foregroundStyle(.black)
                }
                .disabled(busy || selected == nil)
            } else {
                ProgressView().task { _ = try? await mm.loadOfferings() }
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            HStack(spacing: 16) {
                Button(String(localized: "Restore purchases")) { Task { await restore() } }
                if let termsURL { Link(String(localized: "Terms"), destination: termsURL) }
                if let privacyURL { Link(String(localized: "Privacy"), destination: privacyURL) }
            }
            .font(.footnote).foregroundStyle(.secondary)
        }
        .padding(20)
        .onAppear { if selected == nil { selected = offering?.packages.last(where: { $0.product != nil }) } }
        .onChange(of: offering?.id) { _ in selected = offering?.packages.last(where: { $0.product != nil }) }
    }

    private var ctaTitle: String {
        guard let selected else { return String(localized: "Continue") }
        return selected.hasFreeTrial ? String(localized: "Start free trial") : String(localized: "Continue")
    }

    private func buy() async {
        guard let selected else { return }
        busy = true; defer { busy = false }
        do {
            if case .success(let info) = try await mm.purchase(selected) { onPurchase(info); dismiss() }
        } catch { self.error = error.localizedDescription }
    }

    private func restore() async {
        busy = true; defer { busy = false }
        do { let info = try await mm.restorePurchases(); if !info.activeEntitlements.isEmpty { onPurchase(info); dismiss() } }
        catch { self.error = error.localizedDescription }
    }
}

extension MoneyMakerPaywall where Header == EmptyView {
    public init(offering: String? = nil, accent: Color = .green, termsURL: URL? = nil, privacyURL: URL? = nil,
                onPurchase: @escaping (CustomerInfo) -> Void = { _ in }) {
        self.init(offering: offering, accent: accent, termsURL: termsURL, privacyURL: privacyURL, onPurchase: onPurchase) { EmptyView() }
    }
}

struct PackageRow: View {
    let package: Package
    let selected: Bool
    let accent: Color

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(package.product?.displayName ?? package.id).font(.headline)
                if package.hasFreeTrial { Text(String(localized: "Free trial")).font(.caption).foregroundStyle(accent) }
                else if let d = package.product?.description, !d.isEmpty { Text(d).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(package.localizedPrice).font(.headline.monospacedDigit())
                if let badge = package.metadata["badge"] {
                    Text(badge).font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 2)
                        .background(accent.opacity(0.2), in: Capsule()).foregroundStyle(accent)
                }
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.primary.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(selected ? accent : .clear, lineWidth: 2))
        .contentShape(Rectangle())
    }
}

/// Gates any view behind an entitlement and presents a paywall otherwise.
public struct RequiresEntitlement<Paywall: View>: ViewModifier {
    @ObservedObject private var mm = MoneyMaker.shared
    let entitlement: String
    let paywall: () -> Paywall
    @State private var showPaywall = false

    public func body(content: Content) -> some View {
        Group {
            if mm.isEntitled(entitlement) { content }
            else {
                content.redacted(reason: .placeholder).allowsHitTesting(false)
                    .overlay { Button { showPaywall = true } label: { Color.clear.contentShape(Rectangle()) } }
            }
        }
        .sheet(isPresented: $showPaywall) { paywall() }
    }
}

public extension View {
    func requiresEntitlement<P: View>(_ id: String, @ViewBuilder paywall: @escaping () -> P) -> some View {
        modifier(RequiresEntitlement(entitlement: id, paywall: paywall))
    }
    func requiresEntitlement(_ id: String) -> some View {
        modifier(RequiresEntitlement(entitlement: id) { MoneyMakerPaywall() })
    }
}
#endif
