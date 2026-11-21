import SwiftUI
import Charts
import WidgetKit

@main
struct MoneyMakerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var showsSplash = true
    init() { Analytics.start() }
    var body: some Scene {
        WindowGroup {
            RootView()
                // La synchro descend de la Dynamic Island par-dessus toute l'app (comme V2).
                .overlay(alignment: .top) { IslandRefreshBanner(state: .home).ignoresSafeArea() }
                .overlay { if showsSplash { splash } }
                .onOpenURL { Router.shared.open($0) }
                // Apparence choisie dans les Réglages (mm.theme) : Système, Clair ou Sombre.
                .mmAppTheme()
                .tint(MMColor.accent)
                .onAppear { PerfProbe.start() }
        }
    }
}

extension MoneyMakerApp {
    /// Visite filmée (DEBUG) : écran noir jusqu'au début de l'enregistrement, puis l'ouverture se joue.
    @ViewBuilder
    private var splash: some View {
        #if DEBUG
        TourGate { LaunchSplashView { showsSplash = false } }
        #else
        LaunchSplashView { showsSplash = false }
        #endif
    }
}

#if DEBUG
private struct TourGate<C: View>: View {
    @ViewBuilder var content: () -> C
    @ObservedObject private var tour = AutoTour.shared
    var body: some View {
        if tour.ready { content() } else { Color.black.ignoresSafeArea().onAppear { tour.startIfNeeded() } }
    }
}
#endif

extension Color {
    static let mmGreen = MMColor.accent
    static let mmBlue = MMColor.blue
}

@MainActor
final class Store: ObservableObject {
    @Published var token: String? = MoneyMakerClient.stored.token == "mm_demo" ? nil : MoneyMakerClient.stored.token
    @Published var overview: Overview? { didSet { memoValid = false } }
    @Published var alerts: [RankingAlert] = [] { didSet { memoValid = false } }
    @Published var days = max(7, UserDefaults.standard.object(forKey: "mm.period") as? Int ?? 28)
    @Published var error: String?
    @Published var loading = false
    @Published var today: Today?
    @Published var feed: [FeedEvent] = []

    init() {
        // La démo n'est jamais gardée d'un lancement à l'autre : son jeton et ses chiffres ne doivent
        // pas rester dans le trousseau partagé avec les widgets.
        if MoneyMakerClient.stored.token == "mm_demo" { Store.wipeSharedAccountData() }
        observePrefs()
        // Cache disque (trousseau + JSON) lu et décodé hors du fil principal. Le splash de lancement
        // dure plus d'une seconde : les données sont posées bien avant que le contenu n'apparaisse.
        // On n'écrase jamais une valeur déjà arrivée du réseau entre-temps.
        guard token != nil else { return }
        Task { [weak self] in
            let c = await Task.detached(priority: .userInitiated) {
                (MoneyMakerClient.cachedOverview, MoneyMakerClient.cachedAlerts, MMShared.cachedToday, MMShared.cachedFeed)
            }.value
            guard let self, self.token != nil else { return }
            if self.overview == nil { self.overview = c.0 }
            if self.alerts.isEmpty { self.alerts = c.1 }
            if self.today == nil { self.today = c.2 }
            if self.feed.isEmpty { self.feed = c.3 }
        }
    }
    /// Pulsation déclenchée à chaque nouvel événement reçu en direct.
    @Published var liveTick = 0
    /// Change à chaque réglage d'affichage (UTC, détail par business, ouverture…) : les vues qui lisent
    /// AppPrefs se redessinent, avec animation, sans attendre le prochain rafraîchissement.
    @Published var prefsRevision = 0
    /// Vrai pendant un recalcul déclenché par un réglage (devise) : les chiffres se floutent puis reviennent.
    @Published var reformatting = false
    private var prefsObserver: NSObjectProtocol?
    private var prefsSnapshot = Store.displayPrefs()

    private static func displayPrefs() -> [String] {
        let d = UserDefaults.standard
        return [AppPrefs.utcKey, AppPrefs.perBusinessKey, AppPrefs.openAsKey, AppTheme.storageKey].map { "\(d.object(forKey: $0) ?? "")" }
    }

    func observePrefs() {
        guard prefsObserver == nil else { return }
        prefsObserver = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let now = Store.displayPrefs()
                guard now != self.prefsSnapshot else { return }
                self.prefsSnapshot = now
                withAnimation(MMMotion.data) { self.prefsRevision += 1 }
            }
        }
    }

    /// Recalcul après un changement de devise : flou bref, puis les montants roulent vers leurs nouvelles valeurs.
    func reformat() async {
        withAnimation(MMMotion.settle) { reformatting = true }
        await refresh()
        withAnimation(MMMotion.data) { reformatting = false }
    }
    /// Business affichés (sélection multiple, au moins un). Vide = jamais choisi → tous. Mémorisé.
    @Published var selectedIds: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "mm.selectedProjects") ?? []) {
        didSet { memoValid = false; UserDefaults.standard.set(Array(selectedIds), forKey: "mm.selectedProjects") }
    }
    /// Période de l'Accueil : 0 = aujourd'hui, sinon nombre de jours (28 par défaut).
    @Published var period: Int = UserDefaults.standard.object(forKey: "mm.period") as? Int ?? 28 {
        didSet { UserDefaults.standard.set(period, forKey: "mm.period") }
    }

    var allProjects: [ProjectSummary] { overview?.projects ?? [] }

    /// Logo touché sur l'Accueil : on ne regarde que ce business, sans changer la sélection.
    @Published var focusId: String? { didSet { memoValid = false } }

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
        var active: Set<String> = []
        var view: Set<String> = []
        var selectedProjects: [ProjectSummary] = []
        var viewProjects: [ProjectSummary] = []
        var scoped: Overview?
        var alerts: [RankingAlert] = []
    }
    private var memoStore = ScopeMemo()
    /// Invalidé par les `didSet` des entrées : l'ancienne clé (chaîne + tri de la sélection)
    /// était reconstruite à chaque accès, des dizaines de fois par image.
    private var memoValid = false

    private var memo: ScopeMemo {
        if memoValid { return memoStore }
        var m = ScopeMemo()
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
                                    mrrMicros: ps.reduce(0) { $0 + $1.mrrMicros }, revenueMicros: ps.reduce(0) { $0 + $1.shownRevenueMicros },
                                    activeSubscriptions: ps.reduce(0) { $0 + $1.activeSubscriptions }, activeTrials: ps.reduce(0) { $0 + $1.activeTrials },
                                    newCustomers: ps.reduce(0) { $0 + $1.newCustomers }, projects: ps, generatedAt: o.generatedAt,
                                    payingCustomers: ps.reduce(0) { $0 + ($1.payingCustomers ?? 0) },
                                    downloads: dl.isEmpty ? nil : dl.reduce(0, +), hasTrials: ps.contains { $0.hasTrials ?? ($0.activeTrials > 0) }, periodStart: o.periodStart,
                                    refundsMicros: ps.reduce(0) { $0 + ($1.refundsMicros ?? 0) }, netRevenueMicros: ps.reduce(0) { $0 + $1.netRevenueMicros },
                                    downloadsSource: ps.contains { $0.downloadsSource == "live" || $0.downloadsSource == "mixed" } ? "live" : ps.compactMap(\.downloadsSource).first)
            }
        }
        // Seulement nos apps : les concurrents suivis (ex. Whoop) n'apparaissent jamais dans l'Accueil.
        let alerts = alerts.filter { $0.own != false }
        if m.view.count == all.count { m.alerts = alerts } else {
            let names = Set(m.viewProjects.map(\.name))
            m.alerts = alerts.filter { a in a.projectId.map(m.view.contains) ?? names.contains(a.projectName ?? "") }
        }
        memoStore = m
        memoValid = true
        return m
    }

    /// Progression vers l'objectif de MRR (réglé dans Réglages → Widgets), nil s'il n'y en a pas.
    func mrrGoalProgress(_ o: Overview) -> Double? {
        guard let g = MMShared.mrrGoal, g > 0 else { return nil }
        return Double(o.mrrMicros) / Double(g * 1_000_000)
    }

    /// « Tous les business », « V2 », « V2 + 10K Design », « 3 business ».
    var scopeLabel: String {
        if isAll { return allProjects.count > 1 ? String(localized: "Tous les business") : (allProjects.first?.name ?? "MoneyMaker") }
        let ps = viewProjects
        if ps.count == 1 { return ps[0].name }
        if ps.count == 2 { return "\(ps[0].name) + \(ps[1].name)" }
        return String(localized: "\(ps.count) business")
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

    /// Réglage : « 28 J » = mois calendaire (depuis le 1er) au lieu de 28 jours glissants.
    @Published var calendarMonth = CalendarMonth.enabled {
        didSet { CalendarMonth.enabled = calendarMonth; memoValid = false; Task { await refresh() } }
    }
    /// La période affichée est le mois en cours.
    var monthMode: Bool { calendarMonth && period == 28 }
    /// Jours réellement couverts par la période affichée.
    var periodDays: Int { monthMode ? CalendarMonth.days : period }

    func setPeriod(_ p: Int) {
        guard p != period else { return }
        withAnimation(.smooth(duration: 0.5)) { period = p }
        if p > 0 && p != days { days = p; Task { await refresh() } }
    }

    var client: MoneyMakerClient { MoneyMakerClient(token: token) }
    /// Session de démo (lecture seule, sans compte).
    var isDemo: Bool { token == "mm_demo" }

    func signIn(_ raw: String) async {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Store.isTokenShaped(t) else { error = String(localized: "Le jeton doit commencer par mm_pat_"); return }
        token = t
        authRejected = false
        signingIn = true
        // Enregistré tout de suite : les caches partagés avec les widgets ne s'écrivent que pour le
        // compte enregistré (une réponse d'un ancien compte ne peut plus les remplir).
        MoneyMakerClient.save(token: t)
        await refresh()
        signingIn = false
        // Seul un refus du serveur (jeton invalide) annule la connexion : hors ligne, on garde le jeton
        // et l'app réessaiera au prochain rafraîchissement au lieu de renvoyer vers la connexion web.
        if authRejected {
            token = nil
            Store.wipeSharedAccountData()
        } else {
            Analytics.capture("signed_in")
            // Notifications : l'appareil est rattaché au nouveau compte.
            await PushManager.shared.registerAfterSignIn()
        }
    }

    static func isTokenShaped(_ t: String) -> Bool { t.hasPrefix("mm_pat_") || t == "mm_demo" }

    /// Lien moneymaker://auth reçu alors qu'un compte est déjà connecté (après confirmation) :
    /// le nouveau jeton est vérifié AVANT de fermer la session en cours. Renvoie le motif d'un refus.
    func switchAccount(to raw: String) async -> String? {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Store.isTokenShaped(t) else { return String(localized: "Ce lien de connexion n'est pas valide. Tu restes connecté à ton compte actuel.") }
        guard t != token else { return nil }
        do {
            // Lecture légère qui n'écrit aucun cache : rien n'est touché tant que le jeton n'est pas validé.
            let _: BillingStatus = try await MoneyMakerClient(token: t).get("billing")
        } catch let e as APIError where e.status == 401 || e.status == 403 {
            return String(localized: "Ce lien de connexion n'est plus valide. Tu restes connecté à ton compte actuel.")
        } catch {
            return error.localizedDescription
        }
        signOut()
        await signIn(t)
        return nil
    }

    /// Le dernier rafraîchissement a été refusé par le serveur (jeton révoqué ou invalide).
    private var authRejected = false
    /// Vrai pendant `signIn` : un refus y annule la connexion au lieu de déconnecter.
    private var signingIn = false
    /// Numéro du dernier rafraîchissement lancé : la réponse d'un rafraîchissement dépassé
    /// (changement de période rapide, déconnexion) est ignorée.
    private var refreshGeneration = 0

    /// Déconnexion : plus rien de l'ancien compte ne reste, ni à l'écran, ni dans les caches, ni dans les widgets.
    func signOut() {
        let old = token
        Task { await LiveActivityManager.shared.stop(); await PushManager.shared.forgetDevice(token: old) }
        refreshGeneration += 1
        Store.wipeSharedAccountData()
        token = nil; overview = nil; today = nil; feed = []; alerts = []; error = nil
        selectedIds = []; focusId = nil
        LongHistory.shared.reset()
        SetupCache.shared.reset()
        FinanceModel.shared.reset()
        PosthogStore.shared.reset()
        ProPaywall.shared.reset()
        Analytics.reset()
        loading = false
    }

    /// Jeton, chiffres, flux, alertes, historique et objectifs effacés du trousseau partagé, widgets rechargés.
    private static func wipeSharedAccountData() {
        MoneyMakerClient.save(token: nil)
        MMShared.clearAccountData()
    }

    func refresh() async {
        refreshGeneration += 1
        let generation = refreshGeneration
        loading = true
        defer { if generation == refreshGeneration { loading = false } }
        let c = client
        let d = days
        let since: Date? = calendarMonth && d == 28 ? CalendarMonth.start : nil
        let qd = since == nil ? d : CalendarMonth.days
        // Une nouvelle tentative sur les erreurs passagères (réseau, annulation) avant d'afficher un échec.
        async let o = Result.capture {
            do { return try await c.overview(days: qd, since: since) } catch { try await Task.sleep(for: .milliseconds(600)); return try await c.overview(days: qd, since: since) }
        }
        async let a = try? c.alerts()
        let ids = scopeIds
        async let t = try? c.today(projectIds: ids)
        async let f = try? c.feed(projectIds: ids)
        let result = await o
        let fetchedAlerts = await a
        let fetchedToday = await t
        let fetchedFeed = await f
        // Une réponse dépassée (période changée entre-temps, déconnexion) n'écrase pas la plus récente.
        guard generation == refreshGeneration, c.token == token else { return }
        switch result {
        case .success(let v): withAnimation(MMMotion.data) { overview = v; error = nil }
        case .failure(let e):
            // Une annulation n'est pas une panne : on garde les données affichées.
            if e is CancellationError || (e as? URLError)?.code == .cancelled { break }
            let status = (e as? APIError)?.status
            if status == 401 || status == 403 { authRejected = true }
            // Jeton révoqué pendant l'usage : déconnexion propre, avec le motif sur l'écran de connexion.
            if status == 401, !signingIn, token != nil {
                signOut()
                error = String(localized: "Ta session a expiré ou a été révoquée. Reconnecte-toi.")
                return
            }
            self.error = e.localizedDescription
        }
        if let v = fetchedAlerts { withAnimation(MMMotion.data) { alerts = v } }
        await applyLive(today: fetchedToday, feed: fetchedFeed)
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
        // Historique 365 j (record, série, projection, objectif auto) : rechargé au plus toutes les 3 h.
        if isAll { Task.detached(priority: .utility) { _ = await MoneyMakerClient.stored.history() } }
    }
}


extension Result where Failure == Error {
    static func capture(_ body: () async throws -> Success) async -> Result {
        do { return .success(try await body()) } catch { return .failure(error) }
    }
}
