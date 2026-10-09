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
    @Published var days = max(7, UserDefaults.standard.object(forKey: "mm.period") as? Int ?? 28)
    @Published var error: String?
    @Published var loading = false
    @Published var today: Today? = MMShared.cachedToday
    @Published var feed: [FeedEvent] = MMShared.cachedFeed
    /// Pulsation déclenchée à chaque nouvel événement reçu en direct.
    @Published var liveTick = 0
    /// Business affichés (sélection multiple, au moins un). Vide = jamais choisi → tous. Mémorisé.
    @Published var selectedIds: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "mm.selectedProjects") ?? []) {
        didSet { UserDefaults.standard.set(Array(selectedIds), forKey: "mm.selectedProjects") }
    }
    /// Période de l'Accueil : 0 = aujourd'hui, sinon nombre de jours (28 par défaut).
    @Published var period: Int = UserDefaults.standard.object(forKey: "mm.period") as? Int ?? 28 {
        didSet { UserDefaults.standard.set(period, forKey: "mm.period") }
    }

    var allProjects: [ProjectSummary] { overview?.projects ?? [] }

    /// Logo touché sur l'Accueil : on ne regarde que ce business, sans changer la sélection.
    @Published var focusId: String?

    /// Périmètre réellement affiché : le business mis en avant, sinon la sélection.
    var viewIds: Set<String> { memo.view }
    var viewProjects: [ProjectSummary] { memo.viewProjects }

    /// Touche un logo : met ce business en avant ; re-toucher revient à toute la sélection.
    func focus(_ projectId: String) {
        lastFocusTap = Date()
        withAnimation(.smooth(duration: 0.55)) { focusId = focusId == projectId ? nil : projectId }
        Task { await refreshLive() }
    }

    private var lastFocusTap = Date.distantPast

    /// Toucher ailleurs sur l'Accueil : retour à toute la sélection.
    /// (Ignore le geste qui accompagne le toucher d'un logo.)
    func clearFocus() {
        guard focusId != nil else { return }
        let asked = Date()
        Task {
            // Laisse passer l'action d'un logo touché en même temps : elle a la priorité.
            try? await Task.sleep(for: .milliseconds(60))
            guard focusId != nil, lastFocusTap < asked.addingTimeInterval(-0.3) else { return }
            withAnimation(.smooth(duration: 0.55)) { focusId = nil }
            await refreshLive()
        }
    }

    /// Sélection effective : ids encore existants ; si rien de valable, tous.
    var activeIds: Set<String> { memo.active }
    var isAll: Bool { memo.view.count == allProjects.count }
    var selectedProjects: [ProjectSummary] { memo.selectedProjects }
    /// Un seul business choisi (bloc dédié sur l'Accueil).
    var selectedProject: ProjectSummary? { viewProjects.count == 1 ? viewProjects.first : nil }
    /// Ids à transmettre au serveur (nil = tous).
    var scopeIds: [String]? { isAll ? nil : Array(viewIds).sorted() }

    /// L'overview agrégé sur les business affichés : les cartes de l'Accueil le lisent sans connaître la sélection.
    var scoped: Overview? { memo.scoped }
    var scopedAlerts: [RankingAlert] { memo.alerts }

    // MARK: Mémo du périmètre
    // Ces valeurs étaient recalculées à chaque accès (des dizaines de fois par image) ; elles ne
    // changent qu'avec l'overview, les alertes, la sélection ou le business mis en avant.

    private struct ScopeMemo {
        var key = ""
        var active: Set<String> = []
        var view: Set<String> = []
        var selectedProjects: [ProjectSummary] = []
        var viewProjects: [ProjectSummary] = []
        var scoped: Overview?
        var alerts: [RankingAlert] = []
    }
    private var memoStore = ScopeMemo()

    private var memo: ScopeMemo {
        let key = "\(overview?.generatedAt ?? 0)|\(overview?.projects.count ?? 0)|\(selectedIds.sorted())|\(focusId ?? "")|\(alerts.count)|\(alerts.first?.id ?? "")"
        if memoStore.key == key { return memoStore }
        var m = ScopeMemo(key: key)
        let all = allProjects, allIds = Set(all.map(\.projectId))
        let valid = selectedIds.intersection(allIds)
        m.active = valid.isEmpty ? allIds : valid
        if let f = focusId, m.active.contains(f) { m.view = [f] } else { m.view = m.active }
        m.selectedProjects = all.filter { m.active.contains($0.projectId) }
        m.viewProjects = all.filter { m.view.contains($0.projectId) }
        if let o = overview {
            if m.view.count == all.count {
                m.scoped = o
            } else {
                let ps = m.viewProjects, dl = ps.compactMap(\.downloads)
                m.scoped = Overview(currency: ps.first?.currency ?? o.currency, periodDays: o.periodDays,
                                    mrrMicros: ps.reduce(0) { $0 + $1.mrrMicros }, revenueMicros: ps.reduce(0) { $0 + $1.netRevenueMicros },
                                    activeSubscriptions: ps.reduce(0) { $0 + $1.activeSubscriptions }, activeTrials: ps.reduce(0) { $0 + $1.activeTrials },
                                    newCustomers: ps.reduce(0) { $0 + $1.newCustomers }, projects: ps, generatedAt: o.generatedAt,
                                    payingCustomers: ps.reduce(0) { $0 + ($1.payingCustomers ?? 0) },
                                    downloads: dl.isEmpty ? nil : dl.reduce(0, +), hasTrials: ps.contains { $0.hasTrials ?? ($0.activeTrials > 0) })
            }
        }
        if m.view.count == all.count { m.alerts = alerts } else {
            let names = Set(m.viewProjects.map(\.name))
            m.alerts = alerts.filter { a in a.projectId.map(m.view.contains) ?? names.contains(a.projectName ?? "") }
        }
        memoStore = m
        return m
    }

    /// Progression vers l'objectif de MRR (réglé dans Réglages → Widgets), nil s'il n'y en a pas.
    func mrrGoalProgress(_ o: Overview) -> Double? {
        guard let g = MMShared.mrrGoal, g > 0 else { return nil }
        return Double(o.mrrMicros) / Double(g * 1_000_000)
    }

    /// « Tous les business », « V2 », « V2 + 10K Design », « 3 business ».
    var scopeLabel: String {
        if isAll { return allProjects.count > 1 ? "Tous les business" : (allProjects.first?.name ?? "MoneyMaker") }
        let ps = viewProjects
        if ps.count == 1 { return ps[0].name }
        if ps.count == 2 { return "\(ps[0].name) + \(ps[1].name)" }
        return "\(ps.count) business"
    }

    /// Coche / décoche un business. Refuse de retirer le dernier (retourne false).
    @discardableResult
    func toggle(_ projectId: String) -> Bool {
        var next = activeIds
        if next.contains(projectId) {
            guard next.count > 1 else { return false }
            next.remove(projectId)
        } else {
            next.insert(projectId)
        }
        withAnimation(.smooth(duration: 0.55)) { selectedIds = next; focusId = nil }
        Task { await refreshLive() }
        return true
    }

    /// Un seul business (raccourcis : liste de l'Accueil, notifications).
    func only(_ projectId: String) {
        withAnimation(.smooth(duration: 0.55)) { selectedIds = [projectId]; focusId = nil }
        Task { await refreshLive() }
    }

    func setPeriod(_ p: Int) {
        guard p != period else { return }
        withAnimation(.smooth(duration: 0.5)) { period = p }
        if p > 0 && p != days { days = p; Task { await refresh() } }
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
        let ids = scopeIds
        async let t = try? c.today(projectIds: ids)
        async let f = try? c.feed(projectIds: ids)
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
        let ids = scopeIds
        async let t = try? c.today(projectIds: ids)
        async let f = try? c.feed(projectIds: ids)
        let before = feed.first?.id
        await applyLive(today: t, feed: f)
        if let id = feed.first?.id, id != before { liveTick += 1 }
    }

    private func applyLive(today t: Today?, feed f: [FeedEvent]?) async {
        withAnimation(.smooth(duration: 0.55)) {
            if let t { today = t }
            if let f { feed = f }
        }
        if let t, isAll { await LiveActivityManager.shared.refresh(with: t) }
    }
}


extension Result where Failure == Error {
    static func capture(_ body: () async throws -> Success) async -> Result {
        do { return .success(try await body()) } catch { return .failure(error) }
    }
}
