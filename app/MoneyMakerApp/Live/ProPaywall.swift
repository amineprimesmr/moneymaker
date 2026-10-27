import PassKit
import SafariServices
import StoreKit
import SwiftUI
import UIKit

// MARK: - MoneyMaker Pro : paywall (porté du paywall de V2, adapté à la licence à vie)
//
// Même construction que V2 (PaywallView + PaywallBevelDesign) : fond noir à lueur respirante,
// barre ⋯ / ✕, héros, titre « … Pro » en dégradé, liste de fonctions, carte de prix en verre,
// bouton plein, mentions et liens légaux toujours visibles. Différence : un seul achat (29 €,
// une fois, Stripe), donc une seule carte de prix au lieu du sélecteur annuel / mensuel.

/// État Pro partagé : statut gardé en cache (affiché tout de suite, rafraîchi en arrière-plan),
/// route d'achat et session Stripe préparée d'avance pour que « Débloquer Pro » ouvre le paiement
/// sans attente.
@MainActor
final class ProPaywall: ObservableObject {
    static let shared = ProPaywall()
    @Published var isPresented = false
    @Published private(set) var status: BillingStatus?
    @Published private(set) var route: ProPurchaseRoute?
    private var prepared: (checkout: MoneyMakerClient.ProCheckout, at: Date)?
    private var preparing: Task<MoneyMakerClient.ProCheckout, Error>?
    private var prewarm: SFSafariViewController.PrewarmingToken?
    private static let cacheKey = "mm.billingStatus"

    private init() {
        if let d = UserDefaults.standard.data(forKey: Self.cacheKey) { status = try? JSONDecoder().decode(BillingStatus.self, from: d) }
    }

    func refresh(client: MoneyMakerClient) async {
        async let s = try? client.billing()
        async let r = ProPurchaseRoute.current()
        let (fresh, rt) = await (s, r)
        route = rt
        if let fresh { store(fresh) }
    }

    private func store(_ s: BillingStatus) {
        status = s
        if let d = try? JSONEncoder().encode(s) { UserDefaults.standard.set(d, forKey: Self.cacheKey) }
    }

    /// « Nouveau business » : au-delà du quota gratuit, le paywall (tout de suite, depuis le cache) ;
    /// sinon le dashboard web.
    func newBusiness(client: MoneyMakerClient) async {
        if status == nil { await refresh(client: client) }
        if let s = status, !s.pro, s.available, s.ownedProjects >= s.freeProjects {
            isPresented = true
            Task { await refresh(client: client) }
        } else {
            await UIApplication.shared.open(URL(string: "https://usemoneymaker.com")!)
        }
    }

    /// Bascule testeur, affichée tout de suite puis confirmée par le serveur.
    func setTesterPro(_ pro: Bool, client: MoneyMakerClient) {
        guard let s = status else { return }
        let previous = s
        store(BillingStatus(pro: pro, ownedProjects: s.ownedProjects, freeProjects: s.freeProjects, available: s.available, tester: s.tester))
        Task {
            if let fresh = try? await client.setTesterPro(pro) { store(fresh) } else { store(previous) }
        }
    }

    /// Prépare la session Stripe dès l'ouverture du paywall (valable 24 h, gardée 20 min ici).
    func prepareCheckout(client: MoneyMakerClient) {
        if let p = prepared, Date().timeIntervalSince(p.at) < 1200 { return }
        guard preparing == nil, status?.pro != true else { return }
        preparing = Task { try await client.proCheckout() }
        Task {
            defer { preparing = nil }
            if let c = try? await preparing?.value {
                prepared = (c, Date())
                // Connexions TLS et DNS ouvertes d'avance : la page Stripe s'affiche aussitôt.
                prewarm = SFSafariViewController.prewarmConnections(to: [c.url])
            }
        }
    }

    /// La session préparée (ou une nouvelle si elle n'est pas prête), consommée par l'achat.
    func takeCheckout(client: MoneyMakerClient) async throws -> MoneyMakerClient.ProCheckout {
        if let p = prepared, Date().timeIntervalSince(p.at) < 1200 { prepared = nil; return p.checkout }
        if let t = preparing { prepared = nil; return try await t.value }
        return try await client.proCheckout()
    }

    /// Après le paiement : Pro passe à vrai (le webhook peut prendre une ou deux secondes).
    func didPay(_ s: BillingStatus) { store(s); prepared = nil }
}

struct ProPaywallView: View {
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var phase

    @ObservedObject private var paywall = ProPaywall.shared
    @State private var checkout: IdentifiableURL?
    @State private var legalURL: IdentifiableURL?
    @State private var isPurchasing = false
    @State private var isRestoring = false
    @State private var purchaseError: String?
    @State private var showsLegalMenu = false

    private let termsURL = URL(string: "https://usemoneymaker.com/terms")!
    private let privacyURL = URL(string: "https://usemoneymaker.com/privacy")!

    var body: some View {
        GeometryReader { geo in
            ZStack {
                ProPaywallBackdrop()
                ScrollView {
                    VStack(spacing: 0) {
                        topChrome
                        titleBlock.padding(.horizontal, 24).padding(.top, 12)
                        ProPaywallFeatures(items: ProPaywallFeatureCatalog.primary).padding(.top, 32)
                        Spacer(minLength: 24)
                        bottomSection
                    }
                    .padding(.top, geo.safeAreaInsets.top + 4)
                    .padding(.bottom, max(geo.safeAreaInsets.bottom, 16) + 6)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: geo.size.height + geo.safeAreaInsets.top + geo.safeAreaInsets.bottom, alignment: .top)
                }
                .scrollIndicators(.hidden)
                .scrollBounceBehavior(.basedOnSize)
                .ignoresSafeArea()
            }
        }
        .environment(\.colorScheme, .dark)
        .alert("Achat", isPresented: Binding(get: { purchaseError != nil }, set: { if !$0 { purchaseError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { if let purchaseError { Text(purchaseError) } }
        .sheet(item: $checkout, onDismiss: { Task { await refreshAfterCheckout() } }) { c in
            SafariView(url: c.url).ignoresSafeArea()
                // Pendant le paiement : dès que le webhook a activé Pro, la feuille se ferme toute seule.
                .task { await waitForPro() }
        }
        .sheet(item: $legalURL) { SafariView(url: $0.url).ignoresSafeArea() }
        .task {
            paywall.prepareCheckout(client: store.client)
            await paywall.refresh(client: store.client)
        }
        .onChange(of: phase) { _, p in if p == .active { Task { await refreshAfterCheckout() } } }
    }

    // MARK: Haut

    private var topChrome: some View {
        HStack {
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                showsLegalMenu = true
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Color.primary.opacity(0.7))
                    .frame(width: 32, height: 32).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Options et informations légales")
            .popover(isPresented: $showsLegalMenu, attachmentAnchor: .rect(.bounds), arrowEdge: .top) {
                legalMenu.presentationCompactAdaptation(.popover)
            }
            Spacer(minLength: 0)
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 48, height: 48)
                    .background { closeGlass }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Fermer")
        }
        .padding(.horizontal, 18)
    }

    @ViewBuilder private var closeGlass: some View {
        if #available(iOS 26.0, *) {
            Circle().fill(.clear).glassEffect(.regular.interactive(), in: Circle())
        } else {
            Circle().fill(.ultraThinMaterial)
        }
    }

    // MARK: Titre

    private var titleBlock: some View {
        VStack(spacing: 6) {
            ProPaywallBusinessHero(projects: store.overview?.projects ?? [])
            VStack(spacing: 10) {
                (Text("Fais grandir tous tes business avec ").foregroundStyle(ProPaywallTheme.title)
                 + Text("Pro").foregroundStyle(ProPaywallTheme.proGradient))
                    .font(MMFont.system(31, .bold))
                    .tracking(-0.45)
                    .multilineTextAlignment(.center)
                    .lineSpacing(1)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity)
                Text(subtitle)
                    .font(MMFont.system(15))
                    .foregroundStyle(Color(.secondaryLabel))
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)
            }
        }
    }

    private var status: BillingStatus? { paywall.status }
    private var route: ProPurchaseRoute { paywall.route ?? .none }

    private var subtitle: String {
        let free = status?.freeProjects ?? 1
        return String(localized: "Le plan gratuit suit \(free) business. Pro les débloque tous, pour toujours.")
    }

    // MARK: Bas

    private var bottomSection: some View {
        VStack(spacing: 12) {
            if status?.pro == true {
                ProPaywallPriceCard(title: "Pro à vie", price: "Actif", detail: "Tous tes business sont débloqués.")
                ProPaywallContinueButton(title: "Continuer", isLoading: false, isEnabled: true) { dismiss() }
            } else {
                ProPaywallPriceCard(title: "À vie", price: "29 €", detail: "Paiement unique · sans abonnement")
                ProPaywallContinueButton(title: ProApplePay.isAvailable ? "Débloquer avec Apple Pay" : "Débloquer Pro", isLoading: isPurchasing, isEnabled: canPurchase) {
                    Task { await purchase() }
                }
                Text("Paiement sécurisé par Stripe. Un seul paiement de 29 € TTC, aucun renouvellement. Les business en plus s'ajoutent depuis le dashboard web.")
                    .font(MMFont.system(11, .medium))
                    .foregroundStyle(Color(.secondaryLabel))
                    .multilineTextAlignment(.center)
            }
            HStack(spacing: 14) {
                Button("Conditions") { legalURL = IdentifiableURL(url: termsURL) }
                Text("·")
                Button("Confidentialité") { legalURL = IdentifiableURL(url: privacyURL) }
                Text("·")
                Button(isRestoring ? "…" : "Restaurer") { Task { await restore() } }.disabled(isRestoring || isPurchasing)
            }
            .font(MMFont.system(11, .semibold))
            .foregroundStyle(Color(.secondaryLabel))
            .buttonStyle(.plain)

            if status != nil, status?.pro != true, !canPurchase, !isPurchasing {
                Text("L'achat de Pro n'est pas disponible dans l'app dans ton pays.")
                    .font(MMFont.system(12, .medium))
                    .foregroundStyle(MMColor.red.opacity(0.85))
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, 20)
    }

    private var canPurchase: Bool {
        guard let status else { return false }
        return status.available && !status.pro && route != .none && !isRestoring && checkout == nil
    }

    private var legalMenu: some View {
        VStack(alignment: .leading, spacing: 0) {
            menuRow("hand.raised", "Confidentialité") { showsLegalMenu = false; legalURL = IdentifiableURL(url: privacyURL) }
            menuRow("doc.text", "Conditions") { showsLegalMenu = false; legalURL = IdentifiableURL(url: termsURL) }
            Divider().padding(.horizontal, 12).padding(.vertical, 4)
            menuRow("safari", "Dashboard web") { showsLegalMenu = false; openURL(URL(string: "https://usemoneymaker.com")!) }
            menuRow("arrow.clockwise", "Restaurer") { showsLegalMenu = false; Task { await restore() } }
        }
        .padding(.vertical, 6)
        .frame(minWidth: 248, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func menuRow(_ symbol: String, _ title: LocalizedStringKey, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: symbol).font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.primary.opacity(0.72)).frame(width: 22)
                Text(title).font(MMFont.system(15, .medium)).foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 14).padding(.vertical, 11).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Achat

    private func refreshAfterCheckout() async {
        let wasPro = status?.pro == true
        await paywall.refresh(client: store.client)
        if !wasPro, status?.pro == true {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            checkout = nil
        }
    }

    private func waitForPro() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(2))
            if let s = try? await store.client.billing(), s.pro {
                paywall.didPay(s)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                checkout = nil
                return
            }
        }
    }

    private func purchase() async {
        guard !isPurchasing, !isRestoring else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        isPurchasing = true; purchaseError = nil
        defer { isPurchasing = false }
        do {
            var token: String?
            switch route {
            case .eu:
                guard #available(iOS 18.1, *) else { return }
                // Feuille d'information d'Apple, exigée avant chaque paiement hors In-App Purchase dans l'UE.
                guard case .continued = try await ExternalPurchaseCustomLink.showNotice(type: .browser) else { return }
                token = try await ExternalPurchaseCustomLink.token(for: "ACQUISITION")?.value
            case .us:
                break
            case .none:
                return
            }
            // Apple Pay natif : la feuille s'ouvre sur le paywall, sans changer de page.
            if ProApplePay.isAvailable {
                if let s = try await ProApplePay.pay(client: store.client, externalPurchaseToken: token) {
                    paywall.didPay(s)
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                }
                return
            }
            // Sans Apple Pay (aucune carte dans Wallet) : la page Stripe préparée.
            let c = try await paywall.takeCheckout(client: store.client)
            checkout = IdentifiableURL(url: c.url)
            let client = store.client
            if let token { Task.detached { try? await client.attachExternalPurchaseToken(token, session: c.id) } }
        } catch {
            purchaseError = error.localizedDescription
        }
    }

    /// Pro est attaché au compte MoneyMaker : « Restaurer » relit simplement le statut.
    private func restore() async {
        isRestoring = true; defer { isRestoring = false }
        await paywall.refresh(client: store.client)
        if status?.pro != true { purchaseError = String(localized: "Aucun achat Pro trouvé sur ce compte MoneyMaker.") }
    }
}

// MARK: - Design (PaywallBevelDesign de V2)

enum ProPaywallTheme {
    static let title = Color(.label)
    /// Dégradé du mot « Pro » : l'accent vert de MoneyMaker vers le bleu de ses courbes.
    /// Violets de la DA (jauge et courbes de l'Accueil, RecoveryTileTheme).
    static let violet = MMColor.hex(0x9A4DE8)
    static let violetDeep = MMColor.hex(0x5638C7)
    static let violetBright = MMColor.hex(0x8D6CF2)
    static let proGradient = LinearGradient(
        colors: [MMColor.hex(0xC4B2FF), violetBright, violet],
        startPoint: .topLeading, endPoint: .bottomTrailing)
    static let featureTitle = Color.white.opacity(0.92)
    static let featureIcon = Color.white.opacity(0.88)
}

struct ProPaywallBackdrop: View {
    @State private var drift = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Color.black
            // Lueur violette en bas d'écran, rastérisée une fois : seule sa texture respire.
            EllipticalGradient(stops: [
                .init(color: ProPaywallTheme.violet.opacity(0.34), location: 0),
                .init(color: ProPaywallTheme.violetDeep.opacity(0.18), location: 0.45),
                .init(color: .clear, location: 1),
            ], center: .bottom, startRadiusFraction: 0, endRadiusFraction: 0.75)
            .scaleEffect(x: 1.4, y: 0.7, anchor: .bottom)
            .drawingGroup()
            .opacity(drift ? 1 : 0.7)
            // Petits carrés de l'Accueil et du menu, en violet, qui dérivent doucement (une texture par nappe).
            ZStack {
                RecoveryDotMatrix(anchor: .topTrailing, reach: 0.7, maxOpacity: 0.42, animated: false, ink: ProPaywallTheme.violetBright)
                    .environment(\.recoveryDotSeed, 51)
                    .frame(height: 360).drawingGroup()
                    .frame(maxHeight: .infinity, alignment: .top)
                    .offset(y: drift ? 6 : -6)
                RecoveryDotMatrix(anchor: .topLeading, reach: 0.45, maxOpacity: 0.26, animated: false, ink: ProPaywallTheme.violet)
                    .environment(\.recoveryDotSeed, 63)
                    .frame(height: 240).drawingGroup()
                    .frame(maxHeight: .infinity, alignment: .top)
                    .offset(y: drift ? -5 : 5)
                RecoveryDotMatrix(anchor: .bottomLeading, reach: 0.6, maxOpacity: 0.36, animated: false, ink: ProPaywallTheme.violetBright)
                    .environment(\.recoveryDotSeed, 77)
                    .frame(height: 380).drawingGroup()
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .offset(y: drift ? -6 : 6)
                RecoveryDotMatrix(anchor: .bottomTrailing, reach: 0.45, maxOpacity: 0.24, animated: false, ink: ProPaywallTheme.violet)
                    .environment(\.recoveryDotSeed, 89)
                    .frame(height: 260).drawingGroup()
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .offset(y: drift ? 5 : -5)
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .onAppear {
            guard !reduceMotion else { drift = true; return }
            withAnimation(.easeInOut(duration: 4).repeatForever(autoreverses: true)) { drift = true }
        }
    }
}

/// Héros : les icônes des business de la personne en pile (à la place des photos de la communauté
/// V2), avec une pastille embossée « business illimités ».
private struct ProPaywallBusinessHero: View {
    let projects: [ProjectSummary]
    private let avatar: CGFloat = 82
    private let overlap: CGFloat = 25

    var body: some View {
        ZStack(alignment: .bottom) {
            HStack(spacing: -overlap) {
                ForEach(Array(tiles.enumerated()), id: \.offset) { index, tile in
                    tile
                        .frame(width: avatar, height: avatar)
                        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 22, style: .continuous)
                                .strokeBorder(LinearGradient(colors: [.white.opacity(0.42), .white.opacity(0.06), .black.opacity(0.30)],
                                                             startPoint: .top, endPoint: .bottom), lineWidth: 1)
                        }
                        .overlay {
                            RoundedRectangle(cornerRadius: 22, style: .continuous)
                                .fill(LinearGradient(colors: [.white.opacity(0.14), .clear], startPoint: .top, endPoint: .center))
                                .allowsHitTesting(false)
                        }
                        .shadow(color: .black.opacity(0.32), radius: 7, y: 4)
                        .rotationEffect(.degrees(Double(index - 1) * 4))
                        .zIndex(Double(index))
                }
            }
            pill.offset(y: 8)
        }
        .frame(height: 150)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Business illimités")
    }

    /// Jusqu'à trois vrais business, complétés par des tuiles « + » : quatre en tout.
    private var tiles: [AnyView] {
        var t: [AnyView] = projects.prefix(3).map { AnyView(ProjectIcon(project: $0, size: avatar)) }
        while t.count < 4 {
            t.append(AnyView(ZStack {
                LinearGradient(colors: [Color(white: 0.20), Color(white: 0.09)], startPoint: .top, endPoint: .bottom)
                Image(systemName: "plus").font(.system(size: 28, weight: .semibold)).foregroundStyle(ProPaywallTheme.violetBright)
            }))
        }
        return t
    }

    private var pill: some View {
        Text("business illimités")
            .font(MMFont.system(12.5, .bold))
            .foregroundStyle(LinearGradient(colors: [Color(white: 0.10), Color(white: 0.30)], startPoint: .top, endPoint: .bottom))
            .shadow(color: .white.opacity(0.85), radius: 0, y: 0.8)
            .shadow(color: .black.opacity(0.25), radius: 0.6, y: -0.5)
            .padding(.horizontal, 15).padding(.vertical, 8)
            .background {
                ZStack {
                    Capsule(style: .continuous).fill(LinearGradient(stops: [
                        .init(color: Color(white: 1.0), location: 0),
                        .init(color: Color(white: 0.97), location: 0.35),
                        .init(color: Color(white: 0.86), location: 0.75),
                        .init(color: Color(white: 0.74), location: 1),
                    ], startPoint: .top, endPoint: .bottom))
                    Capsule(style: .continuous)
                        .strokeBorder(LinearGradient(colors: [.clear, .black.opacity(0.42)], startPoint: .center, endPoint: .bottom), lineWidth: 3)
                        .blur(radius: 1.4).mask(Capsule(style: .continuous))
                    Capsule(style: .continuous)
                        .strokeBorder(LinearGradient(colors: [.white, .white.opacity(0)], startPoint: .top, endPoint: .center), lineWidth: 1.6)
                }
                .compositingGroup()
                .shadow(color: .black.opacity(0.42), radius: 1.5, y: 2)
                .shadow(color: .black.opacity(0.30), radius: 14, y: 9)
            }
    }
}

struct ProPaywallFeatureItem: Identifiable {
    let id: String
    let title: LocalizedStringKey
    let symbol: String
}

enum ProPaywallFeatureCatalog {
    static let primary: [ProPaywallFeatureItem] = [
        .init(id: "unlimited", title: "Business illimités · Toutes tes apps", symbol: "square.stack.3d.up"),
        .init(id: "revenue", title: "Revenus en direct · App Store, Play, Stripe", symbol: "chart.line.uptrend.xyaxis"),
        .init(id: "alerts", title: "Alertes · Chaque vente sur ton iPhone", symbol: "bell.badge"),
        .init(id: "widgets", title: "Widgets · Ton MRR d'un coup d'œil", symbol: "square.grid.2x2"),
        .init(id: "lifetime", title: "À vie · Payé une fois, à toi pour toujours", symbol: "infinity"),
    ]
}

private struct ProPaywallFeatures: View {
    let items: [ProPaywallFeatureItem]
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(items) { item in
                HStack(spacing: 14) {
                    Image(systemName: item.symbol)
                        .font(.system(size: 19))
                        .foregroundStyle(ProPaywallTheme.featureIcon)
                        .frame(width: 30, height: 30)
                    Text(item.title)
                        .font(MMFont.system(15, .medium))
                        .foregroundStyle(ProPaywallTheme.featureTitle)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 26)
    }
}

/// Carte de prix en verre (le segment sélectionné du sélecteur de V2), seule offre : à vie.
private struct ProPaywallPriceCard: View {
    let title: LocalizedStringKey
    let price: LocalizedStringKey
    let detail: LocalizedStringKey

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(MMFont.system(16, .bold)).foregroundStyle(Color(.label))
                Text(detail).font(MMFont.system(13, .medium)).foregroundStyle(Color(.secondaryLabel))
            }
            Spacer()
            Text(price).font(MMFont.system(24, .bold)).foregroundStyle(Color(.label))
        }
        .padding(.horizontal, 18)
        .frame(height: 82)
        .background { glass }
        .padding(4)
        .overlay { RoundedRectangle(cornerRadius: 26, style: .continuous).strokeBorder(Color.white.opacity(0.26), lineWidth: 1) }
        .overlay(alignment: .top) {
            Text("SANS ABONNEMENT")
                .font(MMFont.system(12, .bold)).foregroundStyle(.white)
                .padding(.horizontal, 11).padding(.vertical, 5)
                .background(Capsule().fill(LinearGradient(colors: [ProPaywallTheme.violetBright, ProPaywallTheme.violetDeep], startPoint: .top, endPoint: .bottom)))
                .offset(y: -9)
        }
        .padding(.top, 8)
    }

    @ViewBuilder private var glass: some View {
        let shape = RoundedRectangle(cornerRadius: 21, style: .continuous)
        if #available(iOS 26.0, *) {
            shape.fill(.clear).glassEffect(.regular, in: shape).shadow(color: .black.opacity(0.22), radius: 6, y: 2)
        } else {
            shape.fill(.ultraThinMaterial).shadow(color: .black.opacity(0.08), radius: 6, y: 2)
        }
    }
}

private struct ProPaywallContinueButton: View {
    let title: LocalizedStringKey
    let isLoading: Bool
    let isEnabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                if isLoading {
                    ProgressView().tint(.black)
                } else {
                    Text(title)
                        .font(MMFont.system(21, .bold)).tracking(-0.4).foregroundStyle(.black)
                        .overlay { Text(title).font(MMFont.system(21, .bold)).tracking(-0.4).foregroundStyle(.black).offset(x: 0.35) }
                        .padding(.horizontal, 16)
                }
            }
            .frame(maxWidth: .infinity).frame(height: 54)
            .background { capsule }
            .overlay { Capsule(style: .continuous).strokeBorder(Color.black.opacity(0.08), lineWidth: 0.5) }
            .opacity(isEnabled ? 1 : 0.55)
        }
        .buttonStyle(ProPaywallPressStyle())
        .disabled(!isEnabled || isLoading)
    }

    @ViewBuilder private var capsule: some View {
        if #available(iOS 26.0, *) {
            Capsule(style: .continuous).fill(Color.white.opacity(0.92))
                .glassEffect(.regular.tint(Color.white.opacity(0.96)).interactive(), in: Capsule())
        } else {
            Capsule(style: .continuous).fill(Color.white)
        }
    }
}

private struct ProPaywallPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .opacity(configuration.isPressed ? 0.94 : 1)
            .animation(.spring(response: 0.22, dampingFraction: 0.82), value: configuration.isPressed)
    }
}

// MARK: - Apple Pay natif (Stripe en coulisse)

extension MoneyMakerClient {
    /// Débite le jeton Apple Pay via Stripe et renvoie le statut, Pro déjà actif.
    func payProWithApplePay(_ payment: PKPayment, externalPurchaseToken: String?) async throws -> BillingStatus {
        var body: [String: Any] = [
            "paymentData": payment.token.paymentData.base64EncodedString(),
            "transactionId": payment.token.transactionIdentifier,
            "network": payment.token.paymentMethod.network?.rawValue ?? "",
            "displayName": payment.token.paymentMethod.displayName ?? "",
        ]
        if let externalPurchaseToken { body["externalPurchaseToken"] = externalPurchaseToken }
        return try await send("POST", "billing/applepay", body: body)
    }
}

/// Feuille Apple Pay de MoneyMaker Pro : 29 €, payé une fois. Renvoie le statut si le paiement passe,
/// nil si la personne annule.
@MainActor
final class ProApplePay: NSObject, PKPaymentAuthorizationControllerDelegate {
    static let merchantId = "merchant.io.moneymaker.app"
    static let networks: [PKPaymentNetwork] = [.visa, .masterCard, .amex, .cartesBancaires, .maestro]

    static var isAvailable: Bool { PKPaymentAuthorizationController.canMakePayments(usingNetworks: networks) }

    private let client: MoneyMakerClient
    private let externalPurchaseToken: String?
    private var result: BillingStatus?
    private var failure: Error?
    private var continuation: CheckedContinuation<BillingStatus?, Error>?
    private static var current: ProApplePay?

    private init(client: MoneyMakerClient, externalPurchaseToken: String?) {
        self.client = client
        self.externalPurchaseToken = externalPurchaseToken
    }

    static func pay(client: MoneyMakerClient, externalPurchaseToken: String?) async throws -> BillingStatus? {
        let request = PKPaymentRequest()
        request.merchantIdentifier = merchantId
        request.supportedNetworks = networks
        request.merchantCapabilities = [.threeDSecure]
        request.countryCode = "FR"
        request.currencyCode = "EUR"
        request.paymentSummaryItems = [
            PKPaymentSummaryItem(label: String(localized: "MoneyMaker Pro · à vie"), amount: 29),
            PKPaymentSummaryItem(label: "MoneyMaker", amount: 29),
        ]
        let session = ProApplePay(client: client, externalPurchaseToken: externalPurchaseToken)
        let controller = PKPaymentAuthorizationController(paymentRequest: request)
        controller.delegate = session
        current = session
        defer { current = nil }
        return try await withCheckedThrowingContinuation { c in
            session.continuation = c
            controller.present { shown in
                if !shown { session.finish() }
            }
        }
    }

    private func finish() {
        guard let c = continuation else { return }
        continuation = nil
        if let failure { c.resume(throwing: failure) } else { c.resume(returning: result) }
    }

    nonisolated func paymentAuthorizationController(_ controller: PKPaymentAuthorizationController, didAuthorizePayment payment: PKPayment,
                                                    handler completion: @escaping (PKPaymentAuthorizationResult) -> Void) {
        Task { @MainActor in
            do {
                result = try await client.payProWithApplePay(payment, externalPurchaseToken: externalPurchaseToken)
                completion(PKPaymentAuthorizationResult(status: .success, errors: nil))
            } catch {
                failure = error
                completion(PKPaymentAuthorizationResult(status: .failure, errors: [error]))
            }
        }
    }

    nonisolated func paymentAuthorizationControllerDidFinish(_ controller: PKPaymentAuthorizationController) {
        Task { @MainActor in
            controller.dismiss { Task { @MainActor in self.finish() } }
        }
    }
}
