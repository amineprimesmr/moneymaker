import SwiftUI
import Charts


struct RootView: View {
    @StateObject private var store = Store()
    var body: some View {
        ZStack {
            if store.token == nil {
                SignInView().transition(.opacity.combined(with: .scale(scale: 1.04)))
            } else {
                RootTabView()
                    .mmUpdating(store.reformatting)
                    .transition(.opacity.combined(with: .scale(scale: 0.98)))
            }
        }
        .animation(MMMotion.reveal, value: store.token == nil)
        .environmentObject(store)
        .onReceive(Router.shared.$pendingToken.compactMap { $0 }) { t in
            Router.shared.pendingToken = nil
            Task { await store.signIn(t) }
        }
        .task {
            #if DEBUG
            // Tests UI (captures App Store) : jeton fourni par l'environnement de lancement.
            // Jeton gardé en mémoire seulement : la session enregistrée sur l'iPhone n'est pas touchée.
            if let t = ProcessInfo.processInfo.environment["MM_UI_TEST_TOKEN"], t.hasPrefix("mm_pat_") || t == "mm_demo" {
                store.token = t; await store.refresh()
            }
            #endif
        }
    }
}

// MARK: - Connexion

struct SignInView: View {
    @EnvironmentObject var store: Store
    @State private var token = ""
    @State private var showToken = false
    @State private var authError: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Image("Logo").resizable().scaledToFit().frame(width: 250)
                .mmAppear(0)
            Text("Tous les revenus de tes apps et de Stripe, en direct.")
                .font(MMFont.system(15)).foregroundStyle(MMColor.ink2).multilineTextAlignment(.center)
                .padding(.top, 22).padding(.horizontal, 12).mmAppear(1)
            Spacer()

            VStack(spacing: 14) {
                MMPrimaryButton(title: String(localized: "Se connecter ou créer un compte"), loading: store.loading) { WebSignIn.shared.start { result in
                    switch result {
                    case .success(let t): Task { await store.signIn(t) }
                    case .failure(let e): authError = e.localizedDescription
                    case .none: break
                    }
                } }
                .disabled(store.loading)

                Button { Task { await store.signIn("mm_demo") } } label: {
                    Label("Découvrir avec un exemple", systemImage: "sparkles")
                        .font(MMFont.system(15, .semibold)).foregroundStyle(MMColor.ink)
                        .frame(maxWidth: .infinity).padding(.vertical, 15)
                        .mmGlass(in: Capsule())
                }
                .buttonStyle(MMPressStyle()).disabled(store.loading)

                if showToken {
                    HStack(spacing: 12) {
                        Image(systemName: "key.horizontal").foregroundStyle(focused ? MMColor.accent : MMColor.ink3)
                        SecureField("", text: $token, prompt: Text("Jeton mm_pat_…").foregroundStyle(MMColor.ink3))
                            .font(MMFont.system(16)).focused($focused)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .submitLabel(.go)
                            .onSubmit { Task { await store.signIn(token) } }
                    }
                    .padding(.horizontal, 20).padding(.vertical, 15)
                    .mmGlass(in: Capsule())
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                } else {
                    Button("J'ai un jeton personnel") { withAnimation(.smooth) { showToken = true } }
                        .font(MMFont.system(13, .medium)).foregroundStyle(MMColor.ink3)
                }

                if let e = store.error ?? authError {
                    Text(e).font(MMFont.system(13)).foregroundStyle(MMColor.red).multilineTextAlignment(.center).transition(.opacity)
                }
                HStack(spacing: 14) {
                    Link("Confidentialité", destination: URL(string: "https://usemoneymaker.com/privacy")!)
                    Link("Conditions", destination: URL(string: "https://usemoneymaker.com/terms")!)
                    Link("Aide", destination: URL(string: "https://usemoneymaker.com/support")!)
                }
                .font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                .padding(.top, 4)
            }
            .mmAppear(2)
        }
        .padding(.horizontal, 24).padding(.bottom, 20)
        .mmPage()
        .sensoryFeedback(.error, trigger: store.error ?? authError)
    }
}

// MARK: - Vue d'ensemble

struct RootTabView: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var router = Router.shared
    @Environment(\.scenePhase) private var phase
    @State private var tab = 0
    @State private var homePath = NavigationPath()
    @ObservedObject private var prompt = NotificationPrompt.shared
    @State private var menuOpen = false

    private let items: [MMTabBar.Item] = [
        .init(tag: 0, title: String(localized: "Accueil"), icon: "square.grid.2x2.fill"),
        .init(tag: 1, title: String(localized: "Ventes"), icon: "bolt.fill"),
        .init(tag: 3, title: String(localized: "Classement"), icon: "trophy.fill"),
    ]
    @State private var showSettings = false

    var body: some View {
        shell
        .task { LaunchSync.runOnce(store) }
        .fullScreenCover(isPresented: $showSettings) { LiveSettingsView() }
        .task { await prompt.presentIfNeeded() }
        .sheet(isPresented: $prompt.isPresented) {
            NotificationPermissionView { prompt.enable() } secondaryAction: { prompt.later() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .mmLiveEvent)) { _ in Task { await store.refreshLive() } }
        .onChange(of: phase) { _, p in if p == .active { Task { await store.refreshLive() } } }
        .onChange(of: router.pending) { _, d in route(d) }
        .onAppear {
            route(router.pending)
            #if DEBUG
            if ProcessInfo.processInfo.environment["MM_OPEN_SETTINGS"] != nil { router.pending = .settings }
            // Captures App Store : écran d'arrivée (moneymaker://feed…), sans la confirmation d'openurl.
            if let r = ProcessInfo.processInfo.environment["MM_ROUTE"], let u = URL(string: r) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { router.open(u) }
            }
            #endif
        }
        .onChange(of: store.overview?.projects.count) { _, _ in route(router.pending) }
    }

    @ViewBuilder
    private var shell: some View {
        let key: AnyHashable = "\(tab)|\(homePath.count)"
        if #available(iOS 26.0, *) {
            // Menu façon Instagram : page entière cachée à gauche, l'app glisse vers la droite.
            IGAccessoryView(isEnabled: tab == 0 && homePath.isEmpty, isVisible: $menuOpen, contentKey: key, accessoryKey: sideBarKey,
                            backdrop: AnyView(SideBarBackdrop())) {
                sideBar
            } content: { tabs }
        } else {
            SideMenu(isEnabled: tab == 0 && homePath.isEmpty, isExpanded: $menuOpen, contentKey: key) { _ in sideBar } content: { _ in tabs }
        }
    }

    /// Ce que le menu affiche : il n'est reconstruit que si l'un de ces éléments change.
    private var sideBarKey: AnyHashable {
        AnyHashable([AnyHashable(store.overview?.projects ?? []), AnyHashable(store.activeIds), AnyHashable(store.client.token)])
    }

    private var sideBar: some View {
        BusinessSideBar(projects: store.overview?.projects ?? [], activeIds: store.activeIds, client: store.client,
                        isExpanded: $menuOpen, toggleProject: { store.toggle($0) }) { p in
            homePath = NavigationPath(); homePath.append(p)
        } openSettings: {
            menuOpen = false
            showSettings = true
        }
        .equatable()
    }

    @ViewBuilder
    private var tabBar: some View {
        let reselect: (Int) -> Void = { t in if t == 0 { withAnimation { homePath = NavigationPath() } } }
        // Tab bar d'origine, qui rétrécit au défilement (effet Instagram).
        ShrinkingTabBar { MMTabBar(selection: $tab, items: items, onReselect: reselect) }
    }

    private var tabs: some View {
        ZStack(alignment: .bottom) {
            MMColor.bg.ignoresSafeArea()
            // L'Accueil reste monté (scroll et état conservés) ;
            // la planète n'est rendue que visible : elle anime 60 i/s.
            OverviewView(path: $homePath, menuOpen: $menuOpen).tabLayer(tab == 0)
            // Onglets secondaires : rendus seulement quand ils sont visibles (rien ne tourne en arrière-plan).
            if tab == 1 { NavigationStack { FeedScreen().toolbar(.hidden, for: .navigationBar) }.transition(.opacity) }
            if tab == 3 { NavigationStack { LeaderboardScreen().toolbar(.hidden, for: .navigationBar) }.transition(.opacity) }
            tabBar
                .padding(.bottom, 4)
                .ignoresSafeArea(.keyboard)
        }
    }

    private func route(_ d: Router.Destination?) {
        guard let d else { return }
        // Lancement à froid : les écrans d'un business attendent la première vue d'ensemble.
        switch d { case .project, .charts: if store.overview == nil { return }; default: break }
        router.pending = nil
        withAnimation(.snappy) {
            switch d {
            case .today: tab = 0; homePath = NavigationPath()
            case .feed: tab = 1
            case .globe: tab = 0; homePath = NavigationPath(); homePath.append(d)
            case .leaderboard: tab = 3
            case .settings:
                // Après l'ouverture : une feuille présentée pendant le splash est ignorée.
                Task {
                    while !LaunchCoordinator.shared.revealed { try? await Task.sleep(for: .milliseconds(80)) }
                    try? await Task.sleep(for: .milliseconds(300))
                    showSettings = true
                }
            case .project, .charts: tab = 0; homePath = NavigationPath(); homePath.append(d)
            }
        }
    }
}

private extension View {
    func tabLayer(_ visible: Bool) -> some View {
        opacity(visible ? 1 : 0).allowsHitTesting(visible).accessibilityHidden(!visible).environment(\.mmTabVisible, visible)
    }
}

struct OverviewView: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var launch = LaunchCoordinator.shared
    @Binding var path: NavigationPath
    @Binding var menuOpen: Bool
    @State private var showSettings = false
    @State private var selected: Date?
    @Namespace private var zoomNS

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    header
                        .fullScreenCover(isPresented: $showSettings) { LiveSettingsView() }
                    if !TourFlags.isOn { EnableAlertsCard().mmAppear(1) }
                    // Tout ce qui suit dépend du business choisi : changer d'identité rejoue la cascade
                    // avec les nouvelles données — l'Accueil se transforme au lieu d'ouvrir une page.
                    if let o = store.scoped {
                        let scope = store.viewIds
                        // Grille de tuiles reprise de la page Effort de V2 ; toucher ouvre le détail.
                        Group { if !PerfProbe.isOff("tiles") { HomeTiles(o: o, today: store.today).mmDataSwap(scope) } }
                            .task(id: scope) { await PosthogStore.shared.load(o.projects.map(\.projectId), client: store.client) }
                        if !PerfProbe.isOff("globe") { GlobeSection() }
                        Text("Mis à jour \(Date(timeIntervalSince1970: o.generatedAt / 1000).formatted(.relative(presentation: .named)))")
                            .font(MMFont.system(11)).foregroundStyle(MMColor.ink3).frame(maxWidth: .infinity).padding(.top, 6)
                    } else {
                        skeleton
                    }
                    if let e = store.error {
                        Label(e, systemImage: "exclamationmark.triangle").font(MMFont.system(13)).foregroundStyle(MMColor.red)
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
            .environment(\.homeZoom, zoomNS)
            .igShrinksTabBar()
            .simultaneousGesture(TapGesture().onEnded { store.clearFocus() })
            .islandRefreshable(.home) { await store.refresh(); return store.error == nil }
            .navigationDestination(for: ProjectSummary.self) { ProjectView(p: $0) }
            .navigationDestination(for: HomeMetric.self) { HomeMetricDetail(metric: $0).modifier(ZoomDestination(id: $0, ns: zoomNS)) }
            .navigationDestination(for: PosthogRoute.self) { _ in PosthogFunnelDetail() }
            .navigationDestination(for: Router.Destination.self) { d in
                if case .project(let id) = d, let p = store.overview?.projects.first(where: { $0.projectId == id }) { ProjectView(p: p) }
                else if case .charts(let id) = d, let pid = id ?? store.selectedProject?.projectId ?? store.overview?.projects.first?.projectId {
                    ChartsScreen(projectId: pid)
                }
                else if case .globe = d { GlobeExplorer().modifier(GlobeZoomDestination(ns: zoomNS)) }
            }
            .toolbar(.hidden, for: .navigationBar)
            .mmPage()
        }
        #if DEBUG
        .onReceive(AutoTour.shared.$metric) { m in if let m { path.append(m) } }
        #endif
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image("Logo")
                .resizable().scaledToFit()
                .frame(height: 40)
                .shadow(color: .white.opacity(0.18), radius: 10)
                .background {
                    // Utile seulement pour l'atterrissage du logo au lancement : retiré ensuite,
                    // sinon le cadre global serait relu et comparé à chaque image du défilement.
                    if !launch.logoLanded {
                        GeometryReader { g in
                            Color.clear
                                .onAppear { LaunchCoordinator.shared.headerLogoFrame = g.frame(in: .global) }
                                .onChange(of: g.frame(in: .global)) { _, f in
                                    if !LaunchCoordinator.shared.logoLanded { LaunchCoordinator.shared.headerLogoFrame = f }
                                }
                        }
                    }
                }
                .opacity(launch.logoLanded ? 1 : 0)
                .frame(maxWidth: .infinity)
                .overlay(alignment: .leading) {
                    menuButton.mmAppear(0)
                }
                .overlay(alignment: .trailing) {
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape")
                            .font(.system(size: 16, weight: .semibold)).foregroundStyle(MMColor.ink)
                            .frame(width: 34, height: 34)
                    }
                    .buttonStyle(MMPressStyle(scale: 0.92))
                    .accessibilityLabel("Réglages")
                    .mmAppear(0)
                }
                .accessibilityLabel("MoneyMaker")
                .padding(.bottom, 14)
            scopeTitle.mmAppear(0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
    }

    @ViewBuilder
    private var menuButton: some View {
        if #available(iOS 26.0, *) {
            IGMenuButton { menuOpen = true }
        } else {
            Button { menuOpen = true } label: {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(MMColor.ink)
                    .frame(width: 42, height: 42).mmGlass(in: Circle(), interactive: true)
            }
            .buttonStyle(MMPressStyle(scale: 0.92))
            .accessibilityLabel("Business connectés")
        }
    }

    /// Titre = périmètre affiché. Toucher ouvre le sélecteur.
    /// Le périmètre affiché, sans texte : l'éventail 3D des logos choisis. Toucher ouvre le sélecteur.
    private var scopeTitle: some View {
        HStack(spacing: 12) {
            LogoFan(projects: store.selectedProjects, focusId: store.focusId) { store.focus($0) }
            // Business mis en avant : son nom et sa plateforme (Apple pour une app, Stripe sinon).
            if let id = store.focusId, let p = store.selectedProjects.first(where: { $0.projectId == id }) {
                HStack(spacing: 8) {
                    PlatformMark(stores: p.stores ?? [], size: 26)
                    Text(p.name).font(MMFont.system(15, .semibold)).lineLimit(1)
                }
                .padding(.leading, 5).padding(.trailing, 14).padding(.vertical, 5)
                .mmGlass(in: Capsule())
                .transition(.asymmetric(insertion: .opacity.combined(with: .offset(x: -10)).combined(with: .scale(scale: 0.9, anchor: .leading)),
                                        removal: .opacity))
                .id(id)
            }
            Spacer(minLength: 0)
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.86), value: store.focusId)
            .padding(.top, 6)
            .padding(.bottom, 4)
    }

    /// MRR : la valeur récurrente, sans période — chiffre qui roule quand la sélection change.
    private func mrrCard(_ o: Overview) -> some View {
        MMCard(padding: 20) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 6) {
                    MMLabel(text: "MRR")
                    Text(o.mrrMicros.money(o.currency))
                        .font(MMFont.number(40, .light)).tracking(-1.2)
                        .lineLimit(1).minimumScaleFactor(0.5)
                        .contentTransition(.numericText(value: Double(o.mrrMicros)))
                    Text("ARR \((o.mrrMicros * 12).money(o.currency, compact: true)) · \(o.activeSubscriptions) abonnés actifs")
                        .font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                        .contentTransition(.numericText())
                }
                Spacer(minLength: 0)
                MMRing(value: store.mrrGoalProgress(o) ?? 0, color: MMColor.accent, lineWidth: 5)
                    .frame(width: 54, height: 54)
                    .overlay {
                        Text(store.mrrGoalProgress(o).map { "\(Int(min(1, $0) * 100))%" } ?? "—")
                            .font(MMFont.number(12, .regular)).foregroundStyle(MMColor.ink2)
                    }
                    .opacity(store.mrrGoalProgress(o) == nil ? 0 : 1)
            }
        }
    }

    private func stats(_ o: Overview) -> some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible())], spacing: 12) {
            StatTile(icon: "eurosign", title: String(localized: "Revenu \(o.periodDays) j"), value: o.revenueMicros.money(o.currency, compact: true))
            StatTile(icon: "creditcard", title: String(localized: "Users payants"), value: (o.payingCustomers ?? o.activeSubscriptions).formatted())
            if let dl = o.downloads { StatTile(icon: "arrow.down.app", title: String(localized: "Téléchargements"), value: dl.formatted()) }
            if o.hasTrials ?? (o.activeTrials > 0) { StatTile(icon: "hourglass", title: String(localized: "Essais"), value: o.activeTrials.formatted()) }
            StatTile(icon: "arrow.triangle.2.circlepath", title: String(localized: "Abonnés actifs"), value: o.activeSubscriptions.formatted())
            if o.downloads == nil && !(o.hasTrials ?? (o.activeTrials > 0)) { StatTile(icon: "sparkle", title: String(localized: "Nouveaux"), value: o.newCustomers.formatted()) }
        }
    }

    private var alerts: some View {
        VStack(alignment: .leading, spacing: 10) {
            MMLabel(text: String(localized: "Classements App Store")).padding(.horizontal, 4).padding(.top, 8)
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    ForEach(store.scopedAlerts.prefix(8)) { AlertCard(a: $0) }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollIndicators(.hidden)
            .scrollClipDisabled()
        }
    }

    private func businesses(_ o: Overview) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            MMLabel(text: String(localized: "Business"), trailing: "\(o.projects.count)").padding(.horizontal, 4).padding(.top, 8)
            if o.projects.isEmpty {
                MMCard { Text("Aucun business. Crée-en un sur le dashboard.").font(MMFont.system(14)).foregroundStyle(MMColor.ink2) }
            } else {
                MMCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(Array(o.projects.enumerated()), id: \.element.id) { i, p in
                            if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 18) }
                            Button { store.only(p.projectId) } label: { ProjectRow(p: p) }
                                .buttonStyle(MMPressStyle(scale: 0.98))
                                .contextMenu { NavigationLink(value: p) { Label("Voir le détail", systemImage: "chart.bar.doc.horizontal") } }
                        }
                    }
                }
            }
        }
    }

    private var skeleton: some View {
        VStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 28, style: .continuous).fill(MMColor.cardFill).frame(height: 340)
            HStack(spacing: 12) {
                ForEach(0..<2, id: \.self) { _ in RoundedRectangle(cornerRadius: 22, style: .continuous).fill(MMColor.cardFill).frame(height: 96) }
            }
        }
        .modifier(MMShimmer())
    }
}

struct StatTile: View {
    let icon: String, title: String, value: String
    var body: some View {
        MMCard(padding: 16, radius: 22) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(title.uppercased()).font(MMFont.system(10, .medium)).tracking(1.6).foregroundStyle(MMColor.ink3).lineLimit(1)
                    Spacer()
                    Image(systemName: icon).font(.system(size: 11, weight: .semibold)).foregroundStyle(MMColor.ink3)
                }
                Text(value).font(MMFont.number(26)).tracking(-0.6).lineLimit(1).minimumScaleFactor(0.6)
                    .contentTransition(.numericText())
            }
        }
    }
}

struct ProjectRow: View {
    let p: ProjectSummary
    var body: some View {
        HStack(spacing: 14) {
            ProjectIcon(project: p, size: 38)
            VStack(alignment: .leading, spacing: 3) {
                Text(p.name).font(MMFont.system(15, .medium)).foregroundStyle(MMColor.ink).lineLimit(1)
                Text("\(p.activeSubscriptions) abonnés · \(p.activeTrials) essais").font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
            }
            Spacer(minLength: 8)
            MMSparkline(values: dailySeries(p.revenueByDay, days: 30).map(\.value)).frame(width: 54, height: 24)
            Text(p.mrrMicros.money(p.currency, compact: true)).font(MMFont.number(15, .regular)).foregroundStyle(MMColor.ink).mmNumeric()
                .frame(minWidth: 64, alignment: .trailing)
        }
        .padding(.horizontal, 18).padding(.vertical, 14)
        .contentShape(Rectangle())
    }
}

struct AlertCard: View {
    let a: RankingAlert
    var body: some View {
        let down = a.type == "DROP" || a.type == "LEFT_CHART"
        MMCard(padding: 16, radius: 22) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Image(systemName: a.symbol).font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(down ? MMColor.red : MMColor.accent)
                        .frame(width: 28, height: 28)
                        .background((down ? MMColor.red : MMColor.accent).opacity(0.12), in: Circle())
                    Spacer()
                    Text(flagEmoji(a.cc)).font(.system(size: 18))
                }
                Text(a.rank.map { "#\($0)" } ?? "—").font(MMFont.number(32)).tracking(-0.8)
                VStack(alignment: .leading, spacing: 2) {
                    Text(a.title).font(MMFont.system(13, .medium)).lineLimit(1)
                    Text("\(a.appName ?? "") · \(a.chartLabel)").font(MMFont.system(11)).foregroundStyle(MMColor.ink3).lineLimit(1)
                }
            }
        }
        .frame(width: 168)
    }
}

// MARK: - Business

struct ProjectView: View {
    @EnvironmentObject var store: Store
    let p: ProjectSummary
    @State private var events: [EventItem] = []
    @State private var apps: [TrackedAppSummary] = []
    @State private var selected: Date?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 14) {
                    ProjectIcon(project: p, size: 56)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(p.name).font(MMFont.system(30, .bold)).tracking(-0.8).lineLimit(2)
                        StoreBadges(stores: p.stores ?? [], size: 13)
                    }
                }
                .mmAppear(0)
                hero.mmAppear(1)
                rates.mmAppear(2)
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible())], spacing: 12) {
                    StatTile(icon: "eurosign", title: String(localized: "Revenu"), value: p.netRevenueMicros.money(p.currency, compact: true))
                    StatTile(icon: "person.2", title: String(localized: "Abonnés"), value: "\(p.activeSubscriptions)")
                    StatTile(icon: "hourglass", title: String(localized: "Essais"), value: "\(p.activeTrials)")
                    StatTile(icon: "sparkle", title: String(localized: "Nouveaux"), value: "\(p.newCustomers)")
                }
                .mmAppear(3)
                GrowthSections(p: p).mmAppear(4)
                if p.billingIssues > 0 {
                    MMCard(padding: 16, radius: 22, glow: MMColor.orange) {
                        Label("\(p.billingIssues) problèmes de paiement en cours", systemImage: "exclamationmark.triangle.fill")
                            .font(MMFont.system(14, .medium)).foregroundStyle(MMColor.orange)
                    }
                }
                if !apps.isEmpty {
                    MMLabel(text: "App Store").padding(.horizontal, 4).padding(.top, 8)
                    ForEach(apps) { TrackedAppCard(app: $0).mmScrollReveal() }
                }
                countries
                MMLabel(text: String(localized: "Activité"), trailing: events.isEmpty ? nil : "\(events.count)").padding(.horizontal, 4).padding(.top, 8)
                if events.isEmpty {
                    MMCard { Text("Aucun événement pour l'instant.").font(MMFont.system(14)).foregroundStyle(MMColor.ink2) }
                } else {
                    MMCard(padding: 0) {
                        VStack(spacing: 0) {
                            ForEach(Array(events.enumerated()), id: \.element.id) { i, e in
                                EventRow(e: e, isLast: i == events.count - 1)
                            }
                        }
                        .padding(.vertical, 8)
                    }
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        .islandRefreshable(.home) { await load(); return true }
        .navigationBarTitleDisplayMode(.inline)
        .mmPage()
        .task { await load() }
    }

    /// Revenu par pays du projet.
    @ViewBuilder private var countries: some View {
        let rows = (p.revenueByCountry ?? [:]).filter { $0.key != "??" && $0.value > 0 }.sorted { $0.value > $1.value }
        if !rows.isEmpty {
            MMLabel(text: String(localized: "Pays"), trailing: "\(rows.count)").padding(.horizontal, 4).padding(.top, 8)
            MMCard(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(rows.prefix(15).enumerated()), id: \.element.key) { i, r in
                        if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 52) }
                        HStack(spacing: 12) {
                            Text(flagEmoji(r.key)).font(.system(size: 20)).frame(width: 26)
                            Text(GlobeData.name(r.key)).font(MMFont.system(14, .medium)).lineLimit(1)
                            Spacer()
                            Text(r.value.money(p.currency, compact: true)).font(MMFont.number(14, .regular)).mmNumeric()
                        }
                        .padding(.horizontal, 16).padding(.vertical, 11)
                    }
                }
            }
        }
    }

    private var hero: some View {
        let pts = dailySeries(p.revenueByDay, days: 30)
        let point = selected.flatMap { d in pts.min { abs($0.date.timeIntervalSince(d)) < abs($1.date.timeIntervalSince(d)) } }
        return MMCard(padding: 20, glow: MMColor.accent) {
            VStack(alignment: .leading, spacing: 16) {
                MMLabel(text: point == nil ? "MRR" : String(localized: "Revenu du jour"),
                        trailing: point.map { $0.date.formatted(.dateTime.day().month(.abbreviated)) } ?? String(localized: "30 jours"))
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(point.map { Int($0.value * 1e6).money(p.currency) } ?? p.mrrMicros.money(p.currency))
                        .font(MMFont.number(48)).tracking(-1.4).lineLimit(1).minimumScaleFactor(0.5)
                        .contentTransition(.numericText(value: point?.value ?? Double(p.mrrMicros)))
                        .animation(.snappy(duration: 0.25), value: point?.value)
                    if point == nil { MMDelta(value: halfOverHalf(pts)) }
                }
                MMGlowChart(points: pts, selection: $selected, showsAxis: true).frame(height: 150)
                    .sensoryFeedback(.selection, trigger: point?.date)
            }
        }
    }

    private var rates: some View {
        HStack(spacing: 12) {
            RateTile(title: String(localized: "Conversion essai"), value: p.trialConversionRate, color: MMColor.accent)
            RateTile(title: String(localized: "Churn"), value: p.churnRate, color: MMColor.red)
        }
    }

    func load() async {
        async let e = try? store.client.events(projectId: p.projectId)
        async let a = try? store.client.trackedApps(projectId: p.projectId)
        let (ne, na) = await (e, a)
        withAnimation(.easeOut(duration: 0.35)) {
            events = ne ?? events
            apps = na ?? apps
        }
    }
}

struct RateTile: View {
    let title: String, value: Double?, color: Color
    var body: some View {
        MMCard(padding: 16, radius: 22) {
            HStack(spacing: 14) {
                ZStack {
                    MMRing(value: value ?? 0, color: color, lineWidth: 5)
                }
                .frame(width: 42, height: 42)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title.uppercased()).font(MMFont.system(10, .medium)).tracking(1.4).foregroundStyle(MMColor.ink3).lineLimit(1)
                    Text(value.map { $0.formatted(.percent.precision(.fractionLength(1))) } ?? "—").font(MMFont.number(22))
                }
            }
        }
    }
}

struct EventRow: View {
    let e: EventItem
    let isLast: Bool
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(spacing: 0) {
                Circle().fill(color).frame(width: 8, height: 8).shadow(color: color.opacity(0.7), radius: 4).padding(.top, 6)
                if !isLast { Rectangle().fill(MMColor.hairline).frame(width: 1).frame(maxHeight: .infinity) }
            }
            .frame(width: 10)
            VStack(alignment: .leading, spacing: 3) {
                Text(label).font(MMFont.system(14, .medium))
                Text([e.productId, e.appUserId].compactMap { $0 }.joined(separator: " · "))
                    .font(MMFont.system(11)).foregroundStyle(MMColor.ink3).lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                if let m = e.priceMicros, m > 0, let c = e.currency {
                    Text(m.money(c)).font(MMFont.number(14, .regular)).foregroundStyle(MMColor.ink).mmNumeric()
                }
                Text(Date(timeIntervalSince1970: e.at / 1000).formatted(.relative(presentation: .numeric)))
                    .font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
            }
        }
        .padding(.horizontal, 18).padding(.vertical, 8)
    }

    private var label: String {
        ["INITIAL_PURCHASE": String(localized: "Nouvel abonné"), "RENEWAL": String(localized: "Renouvellement"), "TRIAL_STARTED": String(localized: "Essai démarré"), "TRIAL_CONVERTED": String(localized: "Essai converti"),
         "CANCELLATION": String(localized: "Annulation"), "UNCANCELLATION": String(localized: "Réactivation"), "EXPIRATION": String(localized: "Expiration"), "BILLING_ISSUE": String(localized: "Problème de paiement"),
         "BILLING_RECOVERED": String(localized: "Paiement récupéré"), "REFUND": String(localized: "Remboursement"), "PRODUCT_CHANGE": String(localized: "Changement d'offre"),
         "NON_RENEWING_PURCHASE": String(localized: "Achat"), "GRANT": String(localized: "Accès offert"), "REVOKED": String(localized: "Révoqué"), "PAUSED": String(localized: "En pause"), "TEST": String(localized: "Test")][e.type] ?? e.type
    }
    private var color: Color {
        switch e.type {
        case "INITIAL_PURCHASE", "TRIAL_CONVERTED", "RENEWAL", "NON_RENEWING_PURCHASE", "BILLING_RECOVERED": return MMColor.accent
        case "TRIAL_STARTED", "UNCANCELLATION", "GRANT": return MMColor.blue
        case "BILLING_ISSUE", "CANCELLATION": return MMColor.orange
        default: return MMColor.red
        }
    }
}

/// Classement App Store d'une app, façon Toplify : en-tête (icône, notes, nombre de pays),
/// puis les dernières positions par pays avec la progression depuis le relevé précédent.
struct TrackedAppCard: View {
    let app: TrackedAppSummary
    var body: some View {
        MMCard(padding: 0, radius: 22) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 12) {
                    CachedImage(url: app.icon.flatMap(URL.init(string:))) { MMColor.cardFill }
                        .frame(width: 46, height: 46).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                        .overlay { RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(MMColor.hairline) }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(app.name ?? app.appId).font(MMFont.system(15, .semibold)).lineLimit(1)
                        if let r = app.rating {
                            HStack(spacing: 4) {
                                Stars(value: r)
                                Text("\(r.formatted(.number.precision(.fractionLength(1)))) · \((app.ratingCount ?? 0).formatted()) notes")
                                    .font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                            }
                        } else {
                            Text("Pas encore de notes").font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                        }
                    }
                    Spacer(minLength: 8)
                    Rectangle().fill(MMColor.hairline).frame(width: 1, height: 44)
                    VStack(spacing: 3) {
                        Text("\(app.countriesRanked ?? 0)").font(MMFont.number(18, .semibold))
                            .frame(width: 40, height: 40).background(MMColor.fg(0.10), in: Circle())
                        Text("Pays").font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                    }
                    .padding(.leading, 4)
                }
                .padding(14)
                if let top = app.topRankings, !top.isEmpty {
                    Rectangle().fill(MMColor.hairline).frame(height: 1)
                    HStack(alignment: .firstTextBaseline) {
                        Text("TOP CLASSEMENT iOS").font(MMFont.system(12, .semibold)).tracking(0.6)
                        Spacer()
                        if let best = app.bestRank { Text("Meilleur #\(best)").font(MMFont.system(12, .medium)).foregroundStyle(MMColor.accent) }
                    }
                    .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 6)
                    Text("DERNIÈRES POSITIONS").font(MMFont.system(10.5, .semibold)).tracking(1.2).foregroundStyle(MMColor.ink3)
                        .padding(.horizontal, 16).padding(.bottom, 4)
                    ForEach(Array(top.sorted { $0.rank < $1.rank }.prefix(10).enumerated()), id: \.element) { i, r in
                        if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 56) }
                        HStack(spacing: 12) {
                            Text(flagEmoji(r.cc)).font(.system(size: 22)).frame(width: 28)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(GlobeData.name(r.cc)).font(MMFont.system(14, .medium)).lineLimit(1)
                                if r.scope == "genre" { Text("Catégorie").font(MMFont.system(11)).foregroundStyle(MMColor.ink3) }
                            }
                            Spacer()
                            if let prev = r.prevRank, prev != r.rank {
                                let up = r.rank < prev
                                HStack(spacing: 2) {
                                    Image(systemName: up ? "arrow.up" : "arrow.down").font(.system(size: 10, weight: .bold))
                                    Text("\(abs(prev - r.rank))").font(MMFont.number(12, .medium))
                                }
                                .foregroundStyle(up ? MMColor.accent : MMColor.ink3)
                            }
                            Text("\(r.rank)").font(MMFont.number(14, .semibold)).monospacedDigit()
                                .frame(minWidth: 34).padding(.vertical, 5)
                                .background(MMColor.fg(0.10), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                        }
                        .padding(.horizontal, 16).padding(.vertical, 10)
                    }
                    .padding(.bottom, 6)
                }
            }
        }
    }
}

/// Cinq étoiles remplies selon la note (demi-étoile comprise).
struct Stars: View {
    let value: Double
    var body: some View {
        HStack(spacing: 1) {
            ForEach(0..<5, id: \.self) { i in
                let v = value - Double(i)
                Image(systemName: v >= 0.75 ? "star.fill" : v >= 0.25 ? "star.leadinghalf.filled" : "star")
            }
        }
        .font(.system(size: 10, weight: .semibold)).foregroundStyle(Color(red: 1, green: 0.78, blue: 0.25))
    }
}

/// Synchro du lancement, détachée des vues : une vue recréée au démarrage n'annule plus la goutte.
@MainActor
enum LaunchSync {
    private static var started = false
    static func runOnce(_ store: Store) {
        guard !started else { return }
        started = true
        Task { @MainActor in
            // La goutte descend de l'île une fois l'app ouverte (jamais sous l'écran de lancement).
            async let loaded: Void = store.refresh()
            while !LaunchCoordinator.shared.revealed { try? await Task.sleep(for: .milliseconds(80)) }
            HealthSyncStatus.shared.begin()
            await loaded
            try? await Task.sleep(for: .milliseconds(1300))
            HealthSyncStatus.shared.finish(succeeded: store.error == nil)
        }
    }
}
