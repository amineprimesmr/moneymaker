import SwiftUI
import Charts


struct RootView: View {
    @StateObject private var store = Store()
    @ObservedObject private var paywall = ProPaywall.shared
    /// Jeton reçu par lien alors qu'un compte est déjà connecté : changement de compte à confirmer.
    @State private var pendingSwitch: String?
    @State private var switchError: String?
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
        .fullScreenCover(isPresented: $paywall.isPresented) { ProPaywallView().environmentObject(store) }
        // Statut Pro chargé dès la connexion : le paywall et les Réglages l'affichent sans attendre.
        .task(id: store.token) { if store.token != nil { await paywall.refresh(client: store.client) } }
        .environmentObject(store)
        .onReceive(Router.shared.$pendingToken.compactMap { $0 }) { t in
            Router.shared.pendingToken = nil
            // Personne de connecté : connexion directe. Sinon, on demande avant de changer de compte.
            if store.token == nil { Task { await store.signIn(t) } }
            else if t.trimmingCharacters(in: .whitespacesAndNewlines) != store.token { pendingSwitch = t }
        }
        .alert("Changer de compte ?", isPresented: Binding(get: { pendingSwitch != nil }, set: { if !$0 { pendingSwitch = nil } })) {
            Button("Changer de compte") {
                guard let t = pendingSwitch else { return }
                pendingSwitch = nil
                Task { switchError = await store.switchAccount(to: t) }
            }
            Button("Annuler", role: .cancel) { pendingSwitch = nil }
        } message: {
            Text("Ce lien ouvre un autre compte MoneyMaker. Tu seras déconnecté du compte actuel.")
        }
        .alert("Connexion impossible", isPresented: Binding(get: { switchError != nil }, set: { if !$0 { switchError = nil } })) {
            Button("OK", role: .cancel) { switchError = nil }
        } message: {
            Text(switchError ?? "")
        }
        .task {
            #if DEBUG
            if ProcessInfo.processInfo.environment["MM_UI_TEST_ONBOARDING"] != nil {
                UserDefaults.standard.removeObject(forKey: "onboardingSeen")
            }
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
    private enum Step { case agentSetup, signIn }
    @State private var step = Step.agentSetup
    @AppStorage("onboardingSeen") private var onboardingSeen = false
    @State private var onboardingPage = 0
    @EnvironmentObject var store: Store

    var body: some View {
        ZStack {
            OnboardingPanorama(page: onboardingSeen ? OnboardingPanorama.pageCount - 1 : onboardingPage)
            if !onboardingSeen {
                OnboardingView(onComplete: {
                    Analytics.capture("onboarding_completed")
                    withAnimation(.interpolatingSpring(duration: 0.65, bounce: 0, initialVelocity: 0)) { onboardingSeen = true }
                }, currentIndex: $onboardingPage)
                .onChange(of: onboardingPage, initial: true) { _, page in Analytics.capture("onboarding_step_viewed", ["step": "\(page + 1)"]) }
            } else {
                switch step {
                case .agentSetup:
                    AgentSetupView { step = .signIn }
                case .signIn:
                    AuthView { step = .agentSetup }
                }
            }
        }
        #if DEBUG
        .overlay(alignment: .topTrailing) {
            if onboardingSeen {
                Menu {
                    Button("Rejouer depuis le début", systemImage: "arrow.counterclockwise") { step = .agentSetup; onboardingPage = 0; onboardingSeen = false }
                    Button("Message pour l'agent", systemImage: "doc.on.doc") { step = .agentSetup }
                    Button("Connexion", systemImage: "person") { step = .signIn }
                } label: {
                    Image(systemName: "ladybug.fill").font(.system(size: 15, weight: .semibold)).foregroundStyle(MMColor.ink)
                        .frame(width: 42, height: 42).mmGlass(in: Circle())
                }
                .padding(.trailing, 24).padding(.top, 5)
            }
        }
        #endif
        // Un jeton refusé doit se voir : seul l'écran de connexion affiche l'erreur.
        .onChange(of: store.error) { _, e in if e != nil, step == .agentSetup { onboardingSeen = true; step = .signIn } }
        .environment(\.colorScheme, .dark)
        .transition(.opacity)
        .animation(MMMotion.reveal, value: step)
        .animation(MMMotion.reveal, value: onboardingSeen)
    }
}

private struct AuthView: View {
    let onBack: () -> Void
    @EnvironmentObject var store: Store
    @State private var authError: String?
    @State private var emailMode = false

    var body: some View {
        VStack(spacing: 0) {
            MMGlassIconButton(systemImage: "chevron.left") { if emailMode { emailMode = false } else { onBack() } }
                .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 5)
            // Le formulaire libère le haut de l'écran pour tenir au-dessus du clavier.
            Color.clear.frame(maxHeight: emailMode ? 0 : 215).layoutPriority(1)
            Spacer()
            Text("Connecte-toi à ton compte")
                .font(MMFont.system(26, .semibold)).foregroundStyle(MMColor.ink)
            Spacer()

            VStack(spacing: 14) {
                NativeSignInButtons(error: $authError, emailMode: $emailMode)

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
        }
        .padding(.horizontal, 24).padding(.bottom, 20)
        .frame(maxWidth: MMAdaptive.formWidth)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(PanoramaScrim())
        .animation(.smooth(duration: 0.4), value: emailMode)
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
    @ObservedObject private var tutorial = HomeTutorial.shared
    @State private var menuOpen = false
    @State private var rootWidth: CGFloat = 0
    private var pinsSidebar: Bool { rootWidth >= MMAdaptive.sidebarMinWidth }

    private let items: [MMTabBar.Item] = [
        .init(tag: 0, title: String(localized: "Accueil"), icon: "square.grid.2x2.fill"),
        .init(tag: 1, title: String(localized: "Ventes"), icon: "bolt.fill"),
        .init(tag: 2, title: String(localized: "Apps"), icon: "star.fill"),
        .init(tag: 3, title: String(localized: "Classement"), icon: "trophy.fill"),
    ]
    @State private var showSettings = false

    var body: some View {
        shell
        .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
            rootWidth = size.width
            tutorial.isAvailable = MMAdaptive.allowsTutorial(in: size)
            if size.width >= MMAdaptive.sidebarMinWidth { menuOpen = false }
        }
        .task { LaunchSync.runOnce(store) }
        .fullScreenCover(isPresented: $showSettings) { LiveSettingsView().mmCoverColumn() }
        // Le tutoriel passe avant la demande de notifications : rien ne s'ouvre par-dessus.
        .task {
            await tutorial.runIfNeeded(store: store, canDetail: { tutorialMetric != nil }, canStart: canStartTutorial)
            await prompt.presentIfNeeded()
        }
        .onChange(of: tutorial.replayRequest) { _, _ in
            tab = 0; menuOpen = false; homePath = NavigationPath()
            Task { await tutorial.replay(store: store, canDetail: { tutorialMetric != nil }, canStart: canStartTutorial) }
        }
        .onChange(of: tutorial.scene) { _, scene in applyTutorial(scene) }
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

    private func canStartTutorial() -> Bool { tab == 0 && homePath.isEmpty && !menuOpen && router.pending == nil && tutorial.isAvailable }

    /// La carte ouverte par le tutoriel : la première de l'accueil.
    private var tutorialMetric: HomeMetric? {
        store.scoped.flatMap { o in HomeMetric.visible(o, today: store.today).first(where: \.isBigTile) }
    }

    /// Le tutoriel passe par les mêmes états qu'un vrai toucher.
    private func applyTutorial(_ scene: HomeTutorialScene?) {
        guard let scene else { return }
        withAnimation(.snappy(duration: 0.35, extraBounce: 0.08)) { tab = scene.tab }
        menuOpen = scene.menu
        if scene.detail {
            if homePath.isEmpty, let metric = tutorialMetric { homePath.append(metric) }
        } else if !homePath.isEmpty {
            homePath = NavigationPath()
        }
    }

    @ViewBuilder
    private var shell: some View {
        let key: AnyHashable = "\(tab)|\(homePath.count)"
        if pinsSidebar {
            // Grand écran : le menu des business reste à gauche, l'app occupe le reste.
            HStack(spacing: 0) {
                sideBar
                    .frame(width: MMAdaptive.sidebarWidth)
                    .frame(maxHeight: .infinity)
                    .background(SideBarBackdrop().ignoresSafeArea())
                tabs
            }
            .environment(\.mmPinnedSidebar, true)
        } else if #available(iOS 26.0, *) {
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
        ShrinkingTabBar { MMTabBar(selection: $tab, items: items, onReselect: reselect, showsTutorialTargets: true) }
    }

    @State private var appsSearching = false

    private var tabs: some View {
        ZStack(alignment: .bottom) {
            MMColor.bg.ignoresSafeArea()
            // L'Accueil reste monté (scroll et état conservés) ;
            // la planète n'est rendue que visible : elle anime 60 i/s.
            OverviewView(path: $homePath, menuOpen: $menuOpen).mmReadableColumn().tabLayer(tab == 0)
            // Onglets secondaires : rendus seulement quand ils sont visibles (rien ne tourne en arrière-plan).
            if tab == 1 { NavigationStack { FeedScreen().toolbar(.hidden, for: .navigationBar) }.mmReadableColumn().transition(.opacity) }
            if tab == 2 { NavigationStack { AppsScreen(searchActive: $appsSearching).toolbar(.hidden, for: .navigationBar) }.mmReadableColumn().transition(.opacity) }
            if tab == 3 { NavigationStack { LeaderboardScreen().toolbar(.hidden, for: .navigationBar) }.mmReadableColumn().transition(.opacity) }
            // Pendant une recherche d'app, la barre laisse toute la place au clavier.
            if !(tab == 2 && appsSearching) {
                tabBar
                    .padding(.bottom, 4)
                    // Cadre pleine hauteur : sans lui, ignorer le clavier ne suffit pas et la barre monte avec.
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .ignoresSafeArea(.keyboard)
                    .transition(.opacity)
            }
        }
    }

    private func route(_ d: Router.Destination?) {
        guard let d else { return }
        // Une notification ou un lien profond prend le pas sur la visite guidée.
        if tutorial.scene != nil { tutorial.abort(); menuOpen = false }
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
    @ObservedObject private var tutorial = HomeTutorial.shared
    @Environment(\.mmPinnedSidebar) private var pinnedSidebar
    @Binding var path: NavigationPath
    @Binding var menuOpen: Bool
    @State private var showSettings = false
    @State private var selected: Date?
    @Namespace private var zoomNS

    var body: some View {
        NavigationStack(path: $path) {
            ScrollViewReader { scroller in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    header
                        .id(HomeTutorialAnchor.top)
                        .fullScreenCover(isPresented: $showSettings) { LiveSettingsView().mmCoverColumn() }
                    if !TourFlags.isOn { EnableAlertsCard().mmAppear(1) }
                    // Tout ce qui suit dépend du business choisi : changer d'identité rejoue la cascade
                    // avec les nouvelles données — l'Accueil se transforme au lieu d'ouvrir une page.
                    if store.overview?.projects.isEmpty == true {
                        // Nouveau compte sans business : une seule chose à faire, la dire clairement.
                        FirstBusinessCard { Task { await ProPaywall.shared.newBusiness(client: store.client) } }
                            .mmAppear(1)
                    } else if let o = store.scoped {
                        let scope = store.viewIds
                        // Grille de tuiles reprise de la page Effort de V2 ; toucher ouvre le détail.
                        Group { if !PerfProbe.isOff("tiles") { HomeTiles(o: o, today: store.today).mmDataSwap(scope) } }
                            .task(id: scope) { await PosthogStore.shared.load(o.projects.map(\.projectId), client: store.client) }
                        if !PerfProbe.isOff("globe") { GlobeSection().id(HomeTutorialAnchor.globe).homeTutorialTarget(.globe) }
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
            // La visite guidée fait défiler l'accueil.
            .onChange(of: tutorial.scene?.anchor) { _, anchor in
                guard let anchor else { return }
                withAnimation(.smooth(duration: 0.7)) { scroller.scrollTo(anchor, anchor: .top) }
            }
            .environment(\.homeZoom, zoomNS)
            .igShrinksTabBar()
            .simultaneousGesture(TapGesture().onEnded { store.clearFocus() })
            .islandRefreshable(.home) { await store.refresh(); return store.error == nil }
            .navigationDestination(for: ProjectSummary.self) { ProjectView(p: $0) }
            .navigationDestination(for: HomeMetric.self) { HomeMetricDetail(metric: $0).modifier(ZoomDestination(id: $0, ns: zoomNS)) }
            .navigationDestination(for: PosthogRoute.self) { _ in PosthogFunnelDetail() }
            .navigationDestination(for: Router.Destination.self) { d in
                if case .project(let id) = d {
                    if let p = store.overview?.projects.first(where: { $0.projectId == id }) { ProjectView(p: p) } else { UnknownBusinessView() }
                }
                else if case .charts(let id) = d {
                    if let pid = id ?? store.selectedProject?.projectId ?? store.overview?.projects.first?.projectId,
                       store.overview?.projects.contains(where: { $0.projectId == pid }) == true {
                        ChartsScreen(projectId: pid)
                    } else { UnknownBusinessView() }
                }
                else if case .globe = d { GlobeExplorer().modifier(GlobeZoomDestination(ns: zoomNS)) }
            }
            .toolbar(.hidden, for: .navigationBar)
            .mmPage()
            }
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
                    if !pinnedSidebar { menuButton.mmAppear(0).homeTutorialTarget(.menuButton) }
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
                    .homeTutorialTarget(.gear)
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
            StatTile(icon: "eurosign", title: o.periodStart != nil ? String(localized: "Revenu de \(CalendarMonth.name)") : String(localized: "Revenu \(o.periodDays) j"), value: o.grossRevenueMicros.money(o.currency, compact: true))
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
            .mmRail()
            .scrollClipDisabled()
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
                ProHealthCard(p: p).mmAppear(2)
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible())], spacing: 12) {
                    StatTile(icon: "eurosign", title: String(localized: "Revenu"), value: p.grossRevenueMicros.money(p.currency, compact: true))
                    StatTile(icon: "person.2", title: String(localized: "Abonnés"), value: "\(p.activeSubscriptions)")
                    StatTile(icon: "hourglass", title: String(localized: "Essais"), value: "\(p.activeTrials)")
                    StatTile(icon: "sparkle", title: String(localized: "Nouveaux"), value: "\(p.newCustomers)")
                }
                .mmAppear(3)
                GrowthSections(p: p).proLocked("Graphiques, prévision LTV et anomalies").mmAppear(4)
                if p.billingIssues > 0 {
                    MMCard(padding: 16, radius: 22, glow: MMColor.orange) {
                        Label("\(p.billingIssues) problèmes de paiement en cours", systemImage: "exclamationmark.triangle.fill")
                            .font(MMFont.system(14, .medium)).foregroundStyle(MMColor.orange)
                    }
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

    func load() async {
        let ne = try? await store.client.events(projectId: p.projectId)
        withAnimation(.easeOut(duration: 0.35)) { events = ne ?? events }
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
                Text([e.productName ?? e.productId, e.appUserId].compactMap { $0 }.joined(separator: " · "))
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

    private var label: String { FeedEvent.label(e.type, isTrial: e.isTrial) }
    /// Vert pour les ventes, rouge pour remboursements, échecs de paiement et résiliations.
    private var color: Color {
        switch e.type {
        case "INITIAL_PURCHASE", "TRIAL_CONVERTED", "RENEWAL", "NON_RENEWING_PURCHASE", "BILLING_RECOVERED", "REFUND_DECLINED", "REFUND_REVERSED": return MMColor.accent
        case "TRIAL_STARTED", "UNCANCELLATION", "GRANT", "PRODUCT_CHANGE": return MMColor.blue
        case _ where FeedEvent.negativeTypes.contains(e.type): return MMColor.red
        default: return MMColor.ink3
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
    private(set) static var finished = false
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
            finished = true
        }
    }
}

// MARK: - Accueil sans business

/// Nouveau compte : rien à afficher encore. Une phrase dit ce que fait MoneyMaker, un bouton crée
/// le premier business (même action que « Nouveau business » du menu latéral).
struct FirstBusinessCard: View {
    let action: () -> Void
    var body: some View {
        MMCard(padding: 20, glow: MMColor.accent) {
            VStack(alignment: .leading, spacing: 12) {
                Image(systemName: "plus.app.fill").font(.system(size: 26, weight: .semibold)).foregroundStyle(MMColor.accent)
                Text("Connecte ta première app").font(MMFont.system(22, .bold)).tracking(-0.4)
                Text("MoneyMaker affiche tes revenus App Store, Google Play et Stripe en direct : ventes du jour, MRR, abonnés et une notification à chaque vente.")
                    .font(MMFont.system(14)).foregroundStyle(MMColor.ink2)
                    .fixedSize(horizontal: false, vertical: true)
                Button(action: action) {
                    Label("Connecter une app", systemImage: "plus")
                        .font(MMFont.system(15, .semibold)).foregroundStyle(.black)
                        .frame(maxWidth: .infinity).padding(.vertical, 13)
                        .background(MMColor.accent, in: Capsule())
                }
                .buttonStyle(MMPressStyle())
                .padding(.top, 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Lien moneymaker://project/<id> vers un business inconnu (supprimé, ou d'un autre compte).
struct UnknownBusinessView: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "questionmark.app.dashed").font(.system(size: 40, weight: .semibold)).foregroundStyle(MMColor.ink3)
            Text("Business introuvable").font(MMFont.system(20, .semibold))
            Text("Ce business a peut-être été supprimé, ou il appartient à un autre compte MoneyMaker.")
                .font(MMFont.system(14)).foregroundStyle(MMColor.ink2).multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .toolbar(.visible, for: .navigationBar)
        .mmPage()
    }
}
