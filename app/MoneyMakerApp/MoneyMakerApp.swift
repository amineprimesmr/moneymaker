import SwiftUI
import Charts

@main
struct MoneyMakerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var showsSplash = true
    var body: some Scene {
        WindowGroup {
            RootView()
                .overlay { if showsSplash { LaunchSplashView { showsSplash = false } } }
                .onOpenURL { Router.shared.open($0) }
                // fixed-scheme: the whole product (dashboard, widgets) is dark-only.
                .preferredColorScheme(.dark)
                .tint(MMColor.accent)
        }
    }
}

extension Color {
    static let mmGreen = MMColor.accent
    static let mmBlue = MMColor.blue
}

@MainActor
final class Store: ObservableObject {
    @Published var token: String? = MoneyMakerClient.stored.token
    @Published var overview: Overview? = MoneyMakerClient.cachedOverview
    @Published var alerts: [RankingAlert] = MoneyMakerClient.cachedAlerts
    @Published var days = 30
    @Published var error: String?
    @Published var loading = false
    @Published var today: Today? = MMShared.cachedToday
    @Published var feed: [FeedEvent] = MMShared.cachedFeed
    /// Pulsation déclenchée à chaque nouvel événement reçu en direct.
    @Published var liveTick = 0
    /// Business affiché sur l'Accueil (nil = tous). Mémorisé entre les lancements.
    @Published var selectedProjectId: String? = UserDefaults.standard.string(forKey: "mm.selectedProject") {
        didSet { UserDefaults.standard.set(selectedProjectId, forKey: "mm.selectedProject") }
    }

    var selectedProject: ProjectSummary? {
        guard let id = selectedProjectId else { return nil }
        return overview?.projects.first { $0.projectId == id }
    }

    /// L'overview ramené au business sélectionné : les cartes de l'Accueil le lisent sans rien savoir de la sélection.
    var scoped: Overview? {
        guard let o = overview else { return nil }
        guard let p = selectedProject else { return o }
        return Overview(currency: p.currency, periodDays: o.periodDays, mrrMicros: p.mrrMicros, revenueMicros: p.netRevenueMicros,
                        activeSubscriptions: p.activeSubscriptions, activeTrials: p.activeTrials, newCustomers: p.newCustomers,
                        projects: [p], generatedAt: o.generatedAt, payingCustomers: p.payingCustomers, downloads: p.downloads, hasTrials: p.hasTrials)
    }

    var scopedAlerts: [RankingAlert] {
        guard let p = selectedProject else { return alerts }
        return alerts.filter { $0.projectId == p.projectId || ($0.projectId == nil && $0.projectName == p.name) }
    }

    /// Change de business : l'Accueil se transforme, le jour est rechargé pour ce périmètre.
    func select(_ projectId: String?) {
        guard projectId != selectedProjectId else { return }
        withAnimation(.smooth(duration: 0.45)) { selectedProjectId = projectId; today = nil }
        Task { await refreshLive() }
    }

    var client: MoneyMakerClient { MoneyMakerClient(token: token) }

    func signIn(_ raw: String) async {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("mm_pat_") else { error = "Le jeton doit commencer par mm_pat_"; return }
        token = t
        await refresh()
        if error == nil { MoneyMakerClient.save(token: t) } else { token = nil }
    }

    func signOut() {
        let old = token
        Task { await LiveActivityManager.shared.stop(); await PushManager.shared.forgetDevice(token: old) }
        MoneyMakerClient.save(token: nil); token = nil; overview = nil; today = nil; feed = []
    }

    func refresh() async {
        loading = true; defer { loading = false }
        let c = client
        async let o = Result.capture { try await c.overview(days: days) }
        async let a = try? c.alerts()
        let pid = selectedProjectId
        async let t = try? c.today(projectId: pid)
        async let f = try? c.feed(projectId: pid)
        switch await o {
        case .success(let v): overview = v; error = nil
        case .failure(let e): self.error = e.localizedDescription
        }
        if let v = await a { alerts = v }
        await applyLive(today: t, feed: f)
    }

    /// Rafraîchissement léger (jour + flux) après un push ou un retour au premier plan.
    func refreshLive() async {
        let c = client
        let pid = selectedProjectId
        async let t = try? c.today(projectId: pid)
        async let f = try? c.feed(projectId: pid)
        let before = feed.first?.id
        await applyLive(today: t, feed: f)
        if let id = feed.first?.id, id != before { liveTick += 1 }
    }

    private func applyLive(today t: Today?, feed f: [FeedEvent]?) async {
        withAnimation(.snappy) {
            if let t { today = t }
            if let f { feed = f }
        }
        if let t, selectedProjectId == nil { await LiveActivityManager.shared.refresh(with: t) }
    }
}


extension Result where Failure == Error {
    static func capture(_ body: () async throws -> Success) async -> Result {
        do { return .success(try await body()) } catch { return .failure(error) }
    }
}
