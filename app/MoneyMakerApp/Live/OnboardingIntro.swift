//
//  OnboardingIntro.swift
//  MoneyMaker — ouverture de l'onboarding : le logo sur écran noir sous une pluie de ventes, puis l'iPhone
//  dézoome et le dashboard apparaît élément par élément. Chiffres illustratifs, rien ne vient du compte.
//

import AVFoundation
import SwiftUI

@MainActor
final class IntroModel: ObservableObject {
    /// Partagé avec la couche posée au-dessus de l'animation de lancement.
    static let shared = IntroModel()

    struct Sale: Identifiable { let id: Int; let amount: String }

    @Published private(set) var progress = 0.0
    @Published private(set) var banners: [Sale] = []
    /// Vrai tant que l'écran noir du lancement doit rester affiché, le temps de la pluie de ventes.
    @Published private(set) var holdsSplash = false
    /// Apparition du dashboard : 0 logo seul au centre, 1 logo en haut et en-tête, 2 tuiles, 3 barre d'onglets.
    @Published private(set) var revealStep = 0
    /// Largeur réelle de la fenêtre : le dézoom part d'un téléphone qui la remplit.
    @Published var viewportWidth: CGFloat = 402

    private let dezoomAtSale = 4
    private let totalSales = 12
    private let amounts = [29.0, 59.0, 9.99, 34.99, 99.0, 19.99].map { $0.formatted(.currency(code: "EUR")) }
    private var sold = 0
    private var players: [AVAudioPlayer] = []
    private var nextPlayer = 0
    private let haptic = UIImpactFeedbackGenerator(style: .light)

    /// Joue toute la séquence ; `onDezoom` part avec le logo encore au centre. S'arrête si la tâche est annulée.
    func play(onDezoom: () -> Void) async {
        // Onboarding retiré en pleine intro (connexion par lien) : le noir du lancement ne doit pas rester.
        defer { if Task.isCancelled { finishNow() } }
        prepareSound()
        haptic.prepare()
        // Pas d'attente de la fin du lancement : la première notification apparaît par-dessus le logo.
        sold = 0; progress = 0; banners = []; revealStep = 0; holdsSplash = true
        guard await wait(0.8) else { return }
        sell()
        guard await wait(1.1) else { return }
        sell()
        guard await wait(0.8) else { return }
        sell()
        var interval = 0.7
        while sold < dezoomAtSale {
            guard await wait(interval) else { return }
            sell()
            interval = max(0.42, interval * 0.92)
        }
        // Le téléphone prend le relais du lancement : son écran montre le même logo, au même endroit.
        holdsSplash = false
        guard await wait(0.06) else { return }
        onDezoom()
        // La page se construit dès le début du dézoom, pendant que les ventes continuent.
        withAnimation(.spring(response: 1.2, dampingFraction: 0.9)) { revealStep = 1 }
        guard await wait(0.3) else { return }
        revealStep = 2
        while sold < totalSales {
            guard await wait(0.45) else { return }
            sell()
            if sold == dezoomAtSale + 5 { withAnimation(.spring(response: 0.9, dampingFraction: 0.88)) { revealStep = 3 } }
        }
        guard await wait(0.6) else { return }
        withAnimation(.easeOut(duration: 0.35)) { banners = [] }
        fadeOutSound()
    }

    func finishNow() {
        holdsSplash = false
        withAnimation(.easeOut(duration: 0.3)) { banners = []; progress = 1; revealStep = 3 }
        fadeOutSound()
    }

    /// Mêmes modèles que le vrai Accueil : les tuiles sont celles de l'app. Les jours et heures se remplissent avec la progression.
    var overview: Overview {
        let days = DayKeys.last(30)
        let filled = Int((Double(days.count) * progress).rounded(.up))
        let shape = [3, 9, 2, 6, 14, 4, 1, 11, 5, 19, 7, 3, 16, 8, 24, 6, 13, 28, 9, 17, 5, 31, 12, 22, 8, 35, 15, 27, 11, 40]
        var byDay: [String: Int] = [:]
        for (i, day) in days.enumerated() where i < filled { byDay[day.0] = shape[i % shape.count] * 12_000_000 }
        let mrr = Int(6_634_000_000 * progress), revenue = Int(7_925_000_000 * progress), paying = Int(464 * progress)
        let project = ProjectSummary(projectId: "intro", name: "MoneyMaker", currency: "EUR", mrrMicros: mrr, netRevenueMicros: revenue,
                                     activeSubscriptions: paying, activeTrials: 0, newCustomers: paying, trialConversionRate: nil, churnRate: nil,
                                     billingIssues: 0, revenueByDay: byDay, payingCustomers: paying, hasTrials: true)
        return Overview(currency: "EUR", periodDays: 28, mrrMicros: mrr, revenueMicros: revenue, activeSubscriptions: paying, activeTrials: 0,
                        newCustomers: paying, projects: [project], generatedAt: 0, payingCustomers: paying, hasTrials: true)
    }

    var today: Today {
        let total = Int(1_284_000_000 * progress)
        let reached = progress * 23
        // Cumul en marches inégales : des heures creuses, puis de gros paiements.
        let steps: [Double] = [0, 3, 0, 1, 7, 0, 2, 12, 1, 0, 5, 18, 2, 1, 9, 0, 24, 3, 6, 0, 15, 2, 31, 8]
        let upTo = Int(reached)
        let sum = max(steps[0...upTo].reduce(0, +), 1)
        var run = 0.0
        let hourly = (0..<24).map { h -> Int in
            if h <= upTo { run += steps[h] }
            return Int(Double(total) * run / sum)
        }
        return Today(currency: "EUR", tz: "Europe/Paris", dayStart: 0, revenueMicros: total, refundsMicros: 0, sales: sold, renewals: 0,
                     trials: 0, newSubscribers: sold, hourly: hourly, last: nil, generatedAt: nil)
    }

    private func wait(_ seconds: Double) async -> Bool {
        try? await Task.sleep(for: .seconds(seconds))
        return !Task.isCancelled
    }

    private func sell() {
        sold += 1
        // Le début de la courbe reste modeste : les deux premières ventes se lisent une par une.
        // Les chiffres arrivent au bout quand le dézoom commence : ensuite seules les notifications bougent, l'écran reste fluide.
        let target = min(1, pow(Double(sold) / Double(dezoomAtSale), 1.6))
        withAnimation(.spring(response: 0.5, dampingFraction: 0.88)) {
            if target != progress { progress = target }
            banners.insert(.init(id: sold, amount: amounts[sold % amounts.count]), at: 0)
            if banners.count > 4 { banners.removeLast() }
        }
        if AppPrefs.haptics { haptic.impactOccurred() }
        ring()
    }

    private func prepareSound() {
        guard players.isEmpty, let url = Bundle.main.url(forResource: "cash", withExtension: "caf") else { return }
        try? AVAudioSession.sharedInstance().setCategory(.ambient)
        players = (0..<6).compactMap { _ in try? AVAudioPlayer(contentsOf: url) }
        players.forEach { $0.prepareToPlay() }
    }

    private func ring() {
        guard !players.isEmpty else { return }
        let p = players[nextPlayer % players.count]
        nextPlayer += 1
        p.currentTime = 0
        p.volume = sold <= 3 ? 1 : 0.55
        p.play()
    }

    private func fadeOutSound() { players.forEach { $0.setVolume(0, fadeDuration: 0.8) } }
}

/// L'écran du téléphone, dessiné pour 402 pt de large : plein écran pendant l'intro, puis première page du mockup.
struct IntroDashboard: View {
    @ObservedObject var model: IntroModel
    @ObservedObject private var launch = LaunchCoordinator.shared

    private var overview: Overview { model.overview }
    private let tabItems: [MMTabBar.Item] = [
        .init(tag: 0, title: String(localized: "Accueil"), icon: "square.grid.2x2.fill"),
        .init(tag: 1, title: String(localized: "Ventes"), icon: "bolt.fill"),
        .init(tag: 3, title: String(localized: "Classement"), icon: "trophy.fill"),
    ]

    /// Même en-tête que `OverviewView`.
    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Le logo lui-même est dessiné à part : il part du centre de l'écran (`flyingLogo`).
            Color.clear.frame(height: 40)
                .frame(maxWidth: .infinity)
                .overlay(alignment: .leading) {
                    Image(systemName: "line.3.horizontal").font(.system(size: 15, weight: .semibold)).foregroundStyle(MMColor.ink)
                        .frame(width: 42, height: 42).mmGlass(in: Circle())
                }
                .overlay(alignment: .trailing) {
                    Image(systemName: "gearshape").font(.system(size: 16, weight: .semibold)).foregroundStyle(MMColor.ink)
                        .frame(width: 34, height: 34)
                }
                .padding(.bottom, 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
    }

    /// Même taille et même place que le logo du lancement, puis il rejoint l'en-tête.
    private var flyingLogo: some View {
        GeometryReader { g in
            let centered = model.revealStep == 0
            Image("Logo").resizable().scaledToFit()
                .frame(width: centered ? 250 * 402 / model.viewportWidth : 40 * 720 / 249)
                .shadow(color: .white.opacity(centered ? 0.28 : 0.18), radius: centered ? 16 : 10)
                .position(x: g.size.width / 2, y: centered ? g.size.height / 2 : 82)
        }
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black
            NavigationStack {
                // Hauteur fixe de la barre d'état : la zone sûre de l'appareil ne doit pas décaler la page.
                VStack(alignment: .leading, spacing: 14) {
                    header.opacity(model.revealStep >= 1 ? 1 : 0)
                    // Montées à ce moment-là : leur apparition en cascade se joue devant l'utilisateur.
                    if model.revealStep >= 2 {
                        IntroTiles(o: overview, today: model.today).equatable()
                            .environment(\.recoveryEntranceStagger, 0.28)
                    }
                }
                .padding(.horizontal, 16).padding(.top, 54)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .ignoresSafeArea()
                .toolbar(.hidden, for: .navigationBar)
                .background(Color.black)
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)

            statusBar.opacity(model.revealStep >= 1 ? 1 : 0)

            MMTabBar(selection: .constant(0), items: tabItems)
                .allowsHitTesting(false)
                .frame(maxHeight: .infinity, alignment: .bottom)
                .padding(.bottom, 28)
                .opacity(model.revealStep >= 3 ? 1 : 0)
                .offset(y: model.revealStep >= 3 ? 0 : 40)

            flyingLogo

            // Tant que le logo de lancement est là, la même pile est dessinée au-dessus de lui.
            IntroBannerStack(banners: model.banners).opacity(launch.logoLanded ? 1 : 0)
        }
        .environment(\.colorScheme, .dark)
    }

    private var statusBar: some View {
        HStack {
            Text(verbatim: "09:41").font(.system(size: 16, weight: .semibold))
            Spacer()
            HStack(spacing: 5) {
                Image(systemName: "cellularbars")
                Image(systemName: "wifi")
                Image(systemName: "battery.100")
            }
            .font(.system(size: 14, weight: .semibold))
        }
        .foregroundStyle(.white).padding(.horizontal, 30).padding(.top, 20)
    }
}

/// Notifications empilées, en coordonnées de l'écran de 402 pt.
private struct IntroBannerStack: View {
    let banners: [IntroModel.Sale]

    var body: some View {
        ZStack(alignment: .top) {
            ForEach(Array(banners.enumerated()), id: \.element.id) { index, sale in
                IntroBanner(amount: sale.amount)
                    .scaleEffect(1 - CGFloat(index) * 0.05, anchor: .bottom)
                    .offset(y: CGFloat(index) * 10)
                    .opacity(1 - Double(index) * 0.25)
                    .zIndex(Double(-index))
                    .transition(.asymmetric(insertion: .offset(y: -120).combined(with: .opacity), removal: .opacity))
            }
        }
        .padding(.horizontal, 12).padding(.top, 58)
    }
}

/// Au-dessus de l'animation de lancement, à la position exacte de la pile du dashboard.
struct IntroLaunchBanners: View {
    @ObservedObject private var model = IntroModel.shared

    var body: some View {
        GeometryReader { geo in
            IntroBannerStack(banners: model.banners)
                .environment(\.colorScheme, .dark)
                .frame(width: 402)
                .scaleEffect(geo.size.width / 402, anchor: .topLeading)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

/// Ne se redessine que si les chiffres changent, pas à chaque notification.
private struct IntroTiles: View, Equatable {
    let o: Overview
    let today: Today
    var body: some View { HomeTiles(o: o, today: today) }
}

/// Notification iOS en thème sombre : icône, nom de l'app, « maintenant », texte sur une ligne.
private struct IntroBanner: View {
    let amount: String

    var body: some View {
        HStack(spacing: 11) {
            Image("AppMark").resizable().scaledToFit().frame(width: 40, height: 40)
                .clipShape(RoundedRectangle(cornerRadius: 9.5, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                HStack {
                    Text(verbatim: "MoneyMaker").font(.system(size: 15, weight: .semibold))
                    Spacer()
                    Text("maintenant").font(.system(size: 13)).foregroundStyle(.white.opacity(0.55))
                }
                Text("Nouvelle vente de \(amount)").font(.system(size: 15)).lineLimit(1)
            }
            .foregroundStyle(.white)
        }
        .padding(.horizontal, 14).padding(.vertical, 13)
        .mmGlass(in: RoundedRectangle(cornerRadius: 26, style: .continuous))
    }
}
