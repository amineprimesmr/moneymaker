#if canImport(SwiftUI)
import SwiftUI
import StoreKit

/// Drop-in paywall driven by the offering configured in the dashboard.
/// When the offering has a remote `paywall` config (dashboard → Paywalls & tests), it is rendered
/// (template, texts, colours, localizations); otherwise the built-in layout below is used.
/// Fully restylable: pass your own header, accent colour and legal links.
public struct MoneyMakerPaywall<Header: View>: View {
    @ObservedObject private var mm = MoneyMaker.shared
    @Environment(\.dismiss) private var dismiss
    private let offeringID: String?
    private let placement: String?
    private let accent: Color
    private let header: Header
    private let termsURL: URL?
    private let privacyURL: URL?
    private let onPurchase: (CustomerInfo) -> Void

    @State private var selected: Package?
    @State private var busy = false
    @State private var error: String?
    @State private var purchased = false
    @State private var trackedOffering: String?
    @State private var closeVisible = false

    public init(offering: String? = nil, placement: String? = nil, accent: Color = .green, termsURL: URL? = nil, privacyURL: URL? = nil,
                onPurchase: @escaping (CustomerInfo) -> Void = { _ in }, @ViewBuilder header: () -> Header) {
        self.offeringID = offering
        self.placement = placement
        self.accent = accent
        self.header = header()
        self.termsURL = termsURL
        self.privacyURL = privacyURL
        self.onPurchase = onPurchase
    }

    private var offering: Offering? {
        offeringID.flatMap { mm.offerings?[$0] } ?? placement.flatMap { mm.offerings?.offering(forPlacement: $0) } ?? mm.offerings?.current
    }

    public var body: some View {
        Group {
            if let offering, let config = offering.paywall { remoteBody(offering, config) } else { staticBody }
        }
        .onAppear { trackImpression() }
        .onChange(of: offering?.id) { _ in trackImpression() }
        .onDisappear { if let offering, !purchased { mm.trackPaywallEvent(.close, offering: offering, placement: placement) } }
    }

    private func trackImpression() {
        guard let offering, trackedOffering != offering.id else { return }
        trackedOffering = offering.id
        mm.trackPaywallEvent(.impression, offering: offering, placement: placement)
    }

    // MARK: Remote layout

    @ViewBuilder
    private func remoteBody(_ offering: Offering, _ config: PaywallConfig) -> some View {
        let texts = config.texts(for: Locale.current.language.languageCode?.identifier)
        let tint = config.colors?.accent.flatMap(Color.init(hex:)) ?? accent
        let fg = config.colors?.text.flatMap(Color.init(hex:)) ?? .primary
        let template = config.template ?? .stack
        let packages = offering.packages.filter { $0.isAvailable }
        ZStack(alignment: .topTrailing) {
            (config.colors?.background.flatMap(Color.init(hex:)) ?? Color.clear).ignoresSafeArea()
            ScrollView {
                VStack(spacing: 18) {
                    header
                    if template != .minimal, let hero = config.heroImage.flatMap(URL.init(string:)) {
                        AsyncImage(url: hero) { $0.resizable().scaledToFit() } placeholder: { Color.clear.frame(height: 160) }
                            .frame(maxHeight: 220).clipShape(RoundedRectangle(cornerRadius: 20))
                    }
                    if let title = texts.title { Text(title).font(.largeTitle.bold()).multilineTextAlignment(.center) }
                    if let subtitle = texts.subtitle { Text(subtitle).font(.body).opacity(0.75).multilineTextAlignment(.center) }
                    if template != .minimal, let features = texts.features, !features.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(features, id: \.self) { f in
                                HStack(spacing: 12) {
                                    Image(systemName: f.icon ?? "checkmark.circle.fill").foregroundStyle(tint).frame(width: 24)
                                    Text(f.text)
                                    Spacer(minLength: 0)
                                }
                            }
                        }
                    }
                    if template == .cards {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(packages) { package in
                                    PackageCard(package: package, selected: selected?.id == package.id, accent: tint)
                                        .onTapGesture { selected = package }
                                }
                            }
                        }
                    } else {
                        VStack(spacing: 10) {
                            ForEach(packages) { package in
                                PackageRow(package: package, selected: selected?.id == package.id, accent: tint)
                                    .onTapGesture { selected = package }
                            }
                        }
                    }
                    Button { Task { await buy() } } label: {
                        HStack { if busy { ProgressView().tint(.black) }; Text(texts.cta ?? ctaTitle).fontWeight(.bold) }
                            .frame(maxWidth: .infinity).padding(.vertical, 16)
                            .background(tint, in: RoundedRectangle(cornerRadius: 16)).foregroundStyle(.black)
                    }
                    .disabled(busy || selected == nil)
                    if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                    footer(links: texts.footerLinks ?? [])
                }
                .padding(20)
                .padding(.top, config.showCloseButton == false ? 0 : 24)
            }
            .foregroundStyle(fg)
            if config.showCloseButton != false && closeVisible {
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.body.bold()).padding(10).background(.ultraThinMaterial, in: Circle())
                }
                .foregroundStyle(fg).padding(16).accessibilityLabel(String(localized: "Close"))
            }
        }
        .onAppear { if selected == nil { selected = packages.last } }
        .task(id: offering.id) {
            let delay = max(0, config.closeDelay ?? 0)
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            withAnimation { closeVisible = true }
        }
    }

    private func footer(links: [PaywallConfig.FooterLink]) -> some View {
        HStack(spacing: 16) {
            Button(String(localized: "Restore purchases")) { Task { await restore() } }
            ForEach(links, id: \.self) { l in if let u = URL(string: l.url) { Link(l.title, destination: u) } }
            if links.isEmpty {
                if let termsURL { Link(String(localized: "Terms"), destination: termsURL) }
                if let privacyURL { Link(String(localized: "Privacy"), destination: privacyURL) }
            }
        }
        .font(.footnote).opacity(0.7)
    }

    // MARK: Built-in layout

    private var staticBody: some View {
        VStack(spacing: 18) {
            header
            if let offering {
                VStack(spacing: 10) {
                    ForEach(offering.packages.filter { $0.isAvailable }) { package in
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
        .onAppear { if selected == nil { selected = offering?.packages.last(where: { $0.isAvailable }) } }
        .onChange(of: offering?.id) { _ in selected = offering?.packages.last(where: { $0.isAvailable }) }
    }

    private var ctaTitle: String {
        guard let selected else { return String(localized: "Continue") }
        return selected.hasFreeTrial ? String(localized: "Start free trial") : String(localized: "Continue")
    }

    private func buy() async {
        guard let selected else { return }
        busy = true; defer { busy = false }
        if let offering { mm.trackPaywallEvent(.purchaseStart, offering: offering, placement: placement) }
        do {
            switch try await mm.purchase(selected) {
            case .success(let info):
                purchased = true
                if let offering { mm.trackPaywallEvent(.purchase, offering: offering, placement: placement) }
                onPurchase(info); dismiss()
            case .userCancelled:
                if let offering { mm.trackPaywallEvent(.cancel, offering: offering, placement: placement) }
            case .pending: break
            }
        } catch { self.error = error.localizedDescription }
    }

    private func restore() async {
        busy = true; defer { busy = false }
        do { let info = try await mm.restorePurchases(); if !info.activeEntitlements.isEmpty { onPurchase(info); dismiss() } }
        catch { self.error = error.localizedDescription }
    }
}

extension MoneyMakerPaywall where Header == EmptyView {
    public init(offering: String? = nil, placement: String? = nil, accent: Color = .green, termsURL: URL? = nil, privacyURL: URL? = nil,
                onPurchase: @escaping (CustomerInfo) -> Void = { _ in }) {
        self.init(offering: offering, placement: placement, accent: accent, termsURL: termsURL, privacyURL: privacyURL, onPurchase: onPurchase) { EmptyView() }
    }
}

struct PackageCard: View {
    let package: Package
    let selected: Bool
    let accent: Color

    var body: some View {
        VStack(spacing: 6) {
            if let badge = package.metadata["badge"] {
                Text(badge).font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 2)
                    .background(accent.opacity(0.2), in: Capsule()).foregroundStyle(accent)
            }
            Text(package.product?.displayName ?? package.id).font(.headline).multilineTextAlignment(.center)
            Text(package.localizedPrice).font(.title3.bold().monospacedDigit())
            if package.hasFreeTrial { Text(String(localized: "Free trial")).font(.caption).foregroundStyle(accent) }
        }
        .frame(width: 140, height: 130)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.primary.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(selected ? accent : .clear, lineWidth: 2))
        .contentShape(Rectangle())
    }
}

extension Color {
    /// "#RGB", "#RRGGBB" or "#RRGGBBAA".
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6 || s.count == 8, let v = UInt64(s, radix: 16) else { return nil }
        let a = s.count == 8 ? Double(v & 0xff) / 255 : 1
        let rgb = s.count == 8 ? v >> 8 : v
        self.init(.sRGB, red: Double((rgb >> 16) & 0xff) / 255, green: Double((rgb >> 8) & 0xff) / 255, blue: Double(rgb & 0xff) / 255, opacity: a)
    }
}

/// Presents the paywall automatically when the user lacks an entitlement (checked on appear).
public struct PresentPaywallIfNeeded<Paywall: View>: ViewModifier {
    @ObservedObject private var mm = MoneyMaker.shared
    let entitlement: String
    let paywall: () -> Paywall
    @State private var isPresented = false

    public func body(content: Content) -> some View {
        content
            .task {
                _ = try? await mm.getCustomerInfo()
                if mm.offerings == nil { _ = try? await mm.loadOfferings() }
                isPresented = !mm.isEntitled(entitlement)
            }
            .onChange(of: mm.customerInfo?.activeEntitlements) { _ in if mm.isEntitled(entitlement) { isPresented = false } }
            .sheet(isPresented: $isPresented) { paywall() }
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
    /// Shows `MoneyMakerPaywall` (remote config, placement-aware) if the user is not entitled to `requiredEntitlement`.
    func presentPaywallIfNeeded(requiredEntitlement: String, offering: String? = nil, placement: String? = nil,
                                onPurchase: @escaping (CustomerInfo) -> Void = { _ in }) -> some View {
        modifier(PresentPaywallIfNeeded(entitlement: requiredEntitlement) {
            MoneyMakerPaywall(offering: offering, placement: placement, onPurchase: onPurchase)
        })
    }
    func presentPaywallIfNeeded<P: View>(requiredEntitlement: String, @ViewBuilder paywall: @escaping () -> P) -> some View {
        modifier(PresentPaywallIfNeeded(entitlement: requiredEntitlement, paywall: paywall))
    }
}
#endif
