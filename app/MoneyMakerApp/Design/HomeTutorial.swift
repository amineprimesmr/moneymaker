//
//  HomeTutorial.swift
//  MoneyMaker — visite guidée à l'arrivée sur l'accueil : la vraie app rétrécit dans un iPhone et continue de vivre.
//  Un doigt touche les boutons, le menu s'ouvre, les pages changent, l'accueil défile, et une découpe suit chaque zone.
//  Mise en scène adaptée de « OneTimeOnBoarding » (Balaji Venkatesh, 10/08/25, catalogue Process).
//

import SwiftUI

/// Une zone de l'app repérée par le tutoriel.
enum HomeTutorialTarget: Hashable {
    case revenue, firstTile, moreTiles, globe
    case menuButton, businesses, menuActions
    case tabHome, tabSales, tabApps, tabRanking
    case feedList, appsSearch, gear

    init?(tabTag: Int) {
        switch tabTag {
        case 0: self = .tabHome
        case 1: self = .tabSales
        case 2: self = .tabApps
        case 3: self = .tabRanking
        default: return nil
        }
    }

    fileprivate var cornerRadius: CGFloat {
        switch self {
        case .revenue, .firstTile, .moreTiles: RecoveryTileTheme.cardRadius + 4
        case .menuButton, .gear: 24
        case .tabHome, .tabSales, .tabApps, .tabRanking: 26
        case .globe, .businesses, .menuActions, .feedList, .appsSearch: 22
        }
    }

    /// Marge autour de la zone découpée.
    fileprivate var margin: CGFloat {
        switch self {
        case .revenue, .firstTile, .moreTiles: 4
        case .menuButton, .gear: 3
        case .tabHome, .tabSales, .tabApps, .tabRanking: 0
        case .globe, .businesses, .menuActions, .feedList, .appsSearch: 6
        }
    }
}

/// Endroits de l'accueil où le tutoriel fait défiler.
enum HomeTutorialAnchor: Hashable { case top, more, globe }

/// L'état de l'app demandé par une étape. Déclaratif : le retour arrière n'a rien à défaire.
struct HomeTutorialScene: Equatable {
    var tab = 0
    var menu = false
    var detail = false
    var anchor: HomeTutorialAnchor = .top
}

enum HomeTutorialStep: Int, CaseIterable, Identifiable {
    case revenue, detail, moreData, globe, menu, menuActions, sales, apps, appsSearch, ranking, settings

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .revenue: String(localized: "Tes revenus en un coup d'œil")
        case .detail: String(localized: "Le détail de chaque carte")
        case .moreData: String(localized: "Encore plus de chiffres")
        case .globe: String(localized: "La planète de tes ventes")
        case .menu: String(localized: "Tes business")
        case .menuActions: String(localized: "Ajouter un business")
        case .sales: String(localized: "Chaque vente, en direct")
        case .apps: String(localized: "Tes apps sur les stores")
        case .appsSearch: String(localized: "N'importe quelle app")
        case .ranking: String(localized: "Le classement")
        case .settings: String(localized: "Tes réglages")
        }
    }

    var message: String {
        switch self {
        case .revenue: String(localized: "Ce que tu gagnes aujourd'hui, ton MRR et tes revenus récents, dès l'ouverture.")
        case .detail: String(localized: "Touche une carte pour ouvrir sa courbe et voir d'où vient le chiffre.")
        case .moreData: String(localized: "En faisant défiler : utilisateurs payants, essais en cours et plus encore.")
        case .globe: String(localized: "Tes ventes pays par pays. Touche la planète pour l'explorer.")
        case .menu: String(localized: "Le menu à gauche liste tes business. Coche ceux à afficher : l'accueil change aussitôt.")
        case .menuActions: String(localized: "Connecte un nouveau business ou ouvre les réglages depuis le menu.")
        case .sales: String(localized: "Tes ventes, abonnements et remboursements, au moment où ils arrivent.")
        case .apps: String(localized: "Les classements, les notes et les avis de tes apps, pays par pays.")
        case .appsSearch: String(localized: "Cherche une app sur les stores pour voir ses classements et ses avis.")
        case .ranking: String(localized: "Compare tes revenus vérifiés avec les autres business, si tu choisis d'y apparaître.")
        case .settings: String(localized: "Apparence, trophées, icône de l'app. Tu peux aussi y revoir ce tutoriel.")
        }
    }

    /// Zone éclairée. `nil` : toute la page est visible.
    fileprivate var spot: HomeTutorialTarget? {
        switch self {
        case .revenue: .revenue
        case .detail: nil
        case .moreData: .moreTiles
        case .globe: .globe
        case .menu: .businesses
        case .menuActions: .menuActions
        case .sales: .feedList
        case .apps: nil
        case .appsSearch: .appsSearch
        case .ranking: nil
        case .settings: .gear
        }
    }

    /// Ce que le doigt touche avant d'arriver à cette étape.
    fileprivate var tap: HomeTutorialTarget? {
        switch self {
        case .detail: .firstTile
        case .menu: .menuButton
        case .sales: .tabSales
        case .apps: .tabApps
        case .ranking: .tabRanking
        case .settings: .tabHome
        default: nil
        }
    }

    /// Le doigt fait défiler la page en arrivant à cette étape.
    fileprivate var swipes: Bool { self == .moreData || self == .globe }

    /// État à atteindre avant que le doigt touche : le bouton doit être visible et atteignable.
    fileprivate var prepare: HomeTutorialScene? {
        switch self {
        case .menu, .sales: HomeTutorialScene()
        default: nil
        }
    }

    fileprivate var scene: HomeTutorialScene {
        switch self {
        case .revenue, .settings: HomeTutorialScene()
        case .detail: HomeTutorialScene(detail: true)
        case .moreData: HomeTutorialScene(anchor: .more)
        case .globe: HomeTutorialScene(anchor: .globe)
        case .menu, .menuActions: HomeTutorialScene(menu: true)
        case .sales: HomeTutorialScene(tab: 1)
        case .apps, .appsSearch: HomeTutorialScene(tab: 2)
        case .ranking: HomeTutorialScene(tab: 3)
        }
    }

    /// Zones sans lesquelles l'étape n'a pas de sens (compte vide, carte masquée).
    fileprivate var required: [HomeTutorialTarget] {
        switch self {
        case .revenue: [.revenue]
        case .detail: [.firstTile]
        case .moreData: [.moreTiles]
        case .globe: [.globe]
        case .menu: [.menuButton]
        case .menuActions: [.menuActions]
        case .sales: [.tabSales]
        case .apps, .appsSearch: [.tabApps]
        case .ranking: [.tabRanking]
        case .settings: [.gear, .tabHome]
        }
    }
}

/// État de la scène, observé seulement par le calque du tutoriel : la zone éclairée bouge à chaque image du défilement,
/// ni l'accueil ni la barre d'onglets ne doivent se recalculer pour autant.
@MainActor
private final class HomeTutorialStage: NSObject, ObservableObject {
    struct Finger: Equatable {
        var point: CGPoint
        var pressed = false
    }

    private struct Probe { weak var view: UIView? }
    private var probes: [HomeTutorialTarget: Probe] = [:]
    private var displayLink: CADisplayLink?

    @Published var steps: [HomeTutorialStep] = []
    @Published var index = 0
    @Published var spot: HomeTutorialTarget? { didSet { refreshSpot() } }
    /// Cadre de la zone éclairée, dans le repère de l'app.
    @Published private(set) var spotFrame: CGRect?
    @Published var finger: Finger?
    @Published var shrunk = false
    var screen: CGSize = .zero
    var safeArea: UIEdgeInsets = .zero

    func register(_ view: UIView, for target: HomeTutorialTarget) { probes[target] = Probe(view: view) }

    func unregister(_ view: UIView, for target: HomeTutorialTarget) {
        if probes[target]?.view === view { probes[target] = nil }
    }

    /// Mesuré jusqu'à la vue racine, sous la réduction de la fenêtre : toujours dans le repère de l'app, réduite ou non.
    func frame(of target: HomeTutorialTarget) -> CGRect? {
        guard let view = probes[target]?.view, let root = view.window?.rootViewController?.view else { return nil }
        return view.convert(view.bounds, to: root)
    }

    func startFollowing() {
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    func stopFollowing() {
        displayLink?.invalidate()
        displayLink = nil
    }

    @objc private func tick() { refreshSpot() }

    private func refreshSpot() {
        let frame = spot.flatMap { self.frame(of: $0) }
        if frame != spotFrame { spotFrame = frame }
    }
}

/// Vue invisible posée derrière une zone repérée.
private struct HomeTutorialProbe: UIViewRepresentable {
    let target: HomeTutorialTarget
    let stage: HomeTutorialStage

    func makeUIView(context: Context) -> ProbeView { ProbeView(target: target, stage: stage) }
    func updateUIView(_ view: ProbeView, context: Context) {}

    final class ProbeView: UIView {
        private let target: HomeTutorialTarget
        private let stage: HomeTutorialStage

        init(target: HomeTutorialTarget, stage: HomeTutorialStage) {
            self.target = target
            self.stage = stage
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            isAccessibilityElement = false
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError() }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window == nil { stage.unregister(self, for: target) } else { stage.register(self, for: target) }
        }
    }
}

@MainActor
final class HomeTutorial: ObservableObject {
    static let shared = HomeTutorial()
    /// Faux si la fenêtre est trop large pour le faux iPhone (iPad, écran intérieur de l'iPhone Duo).
    var isAvailable = true

    private static let seenKey = "mm.homeTutorialSeen"
    private static let shrinkAnimation = Animation.smooth(duration: 0.35, extraBounce: 0)
    fileprivate static let scale: CGFloat = 0.65

    /// Vrai tant que le tutoriel peut encore se jouer : les zones ne sont mesurées que dans ce cas.
    @Published fileprivate var measuring: Bool
    /// Incrémenté par « Revoir le tutoriel » dans les Réglages.
    @Published private(set) var replayRequest = 0
    /// État demandé à l'app. `nil` en dehors du tutoriel.
    @Published private(set) var scene: HomeTutorialScene?

    fileprivate let stage = HomeTutorialStage()
    private var overlayWindow: UIWindow?
    private weak var appWindow: UIWindow?
    private var transition: Task<Void, Never>?
    private var finish: ((Bool) -> Void)?
    private var running = false

    private init() { measuring = !UserDefaults.standard.bool(forKey: Self.seenKey) }

    func requestReplay() { replayRequest += 1 }

    /// Se termine quand le tutoriel est fini ou qu'il n'a pas à se jouer.
    /// `canStart` faux à la dernière seconde (lien profond, autre onglet) : il sera proposé au prochain lancement.
    func runIfNeeded(store: Store, canDetail: () -> Bool, canStart: () -> Bool) async {
        guard !UserDefaults.standard.bool(forKey: Self.seenKey), allowedOnThisLaunch else { measuring = false; return }
        await run(store: store, canDetail: canDetail, canStart: canStart)
    }

    func replay(store: Store, canDetail: () -> Bool, canStart: () -> Bool) async {
        guard !running else { return }
        // Laisse les Réglages se fermer : les zones se mesurent une fois l'accueil de nouveau visible.
        try? await Task.sleep(for: .seconds(0.7))
        for _ in 0..<30 where Self.isCovered { try? await Task.sleep(for: .milliseconds(100)) }
        measuring = true
        await run(store: store, canDetail: canDetail, canStart: canStart)
    }

    /// Un lien profond ou une notification prend la main : l'app revient telle quelle, sans remonter à l'accueil.
    func abort() {
        guard running, let finish else { return }
        self.finish = nil
        transition?.cancel()
        scene = nil
        stage.finger = nil
        setShrunk(false)
        finish(false)
    }

    private var allowedOnThisLaunch: Bool {
        #if DEBUG
        let env = ProcessInfo.processInfo.environment
        if env["MM_TUTORIAL"] != nil { return true }
        // Tests UI et captures App Store : ils attendent l'accueil, sans rien par-dessus.
        if TourFlags.isOn || env["MM_UI_TEST_TOKEN"] != nil || env["MM_ROUTE"] != nil { return false }
        #endif
        return true
    }

    /// Une page, une feuille ou le paywall est ouvert par-dessus l'app.
    private static var isCovered: Bool {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .contains { $0.rootViewController?.presentedViewController != nil }
    }

    private func run(store: Store, canDetail: () -> Bool, canStart: () -> Bool) async {
        guard !running else { return }
        running = true
        defer { running = false; measuring = false }
        for _ in 0..<80 where !NotificationPrompt.shared.splashFinished { try? await Task.sleep(for: .milliseconds(100)) }
        // L'accueil doit montrer les vraies données, sans le squelette ni la bannière de synchro.
        for _ in 0..<150 where store.scoped == nil || store.loading || !LaunchSync.finished || HealthSyncStatus.shared.phase != .idle {
            try? await Task.sleep(for: .milliseconds(100))
        }
        // Fin de la cascade d'apparition des tuiles et de la remontée de la bannière.
        try? await Task.sleep(for: .seconds(1.2))
        guard !Task.isCancelled, canStart(), !Self.isCovered,
              let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive }),
              let key = scene.keyWindow else { return }

        let detailAvailable = canDetail()
        let steps = HomeTutorialStep.allCases.filter { step in
            if step == .detail && !detailAvailable { return false }
            return step.required.allSatisfy { stage.frame(of: $0) != nil }
        }
        guard let first = steps.first else { return }

        stage.steps = steps
        stage.index = 0
        stage.spot = first.spot
        stage.finger = nil
        stage.shrunk = false
        stage.screen = key.bounds.size
        stage.safeArea = key.safeAreaInsets
        appWindow = key
        stage.startFollowing()

        Analytics.capture("home_tutorial_started")
        UserDefaults.standard.set(true, forKey: Self.seenKey)
        self.scene = first.scene

        // La vraie app reste dessous, sans toucher : tout passe par le calque.
        key.isUserInteractionEnabled = false
        key.accessibilityElementsHidden = true
        let window = UIWindow(windowScene: scene)
        window.backgroundColor = .clear
        window.windowLevel = .normal + 1
        let completed = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            finish = { continuation.resume(returning: $0) }
            let host = UIHostingController(rootView: HomeTutorialOverlay(stage: stage, tutorial: self))
            host.view.backgroundColor = .clear
            host.view.accessibilityViewIsModal = true
            window.rootViewController = host
            window.isHidden = false
            overlayWindow = window
        }
        Analytics.capture(completed ? "home_tutorial_completed" : "home_tutorial_skipped")
        transition?.cancel()
        stage.stopFollowing()
        window.isHidden = true
        window.rootViewController = nil
        overlayWindow = nil
        key.layer.removeAnimation(forKey: "homeTutorialShrink")
        key.layer.sublayerTransform = CATransform3DIdentity
        key.isUserInteractionEnabled = true
        key.accessibilityElementsHidden = false
        self.scene = nil
    }

    // MARK: - Mise en scène

    /// Le contenu de la fenêtre se réduit, pas la fenêtre : le système peut la remettre en page à tout moment,
    /// et une transformation sur elle agrandirait sa zone d'affichage. Tout continue de vivre à l'identique.
    fileprivate func setShrunk(_ shrunk: Bool) {
        withAnimation(Self.shrinkAnimation) { stage.shrunk = shrunk }
        guard let layer = appWindow?.layer else { return }
        let y = stage.safeArea.top + 25 - stage.screen.height * (1 - Self.scale) / 2
        let target = shrunk
            ? CATransform3DConcat(CATransform3DMakeScale(Self.scale, Self.scale, 1), CATransform3DMakeTranslation(0, y, 0))
            : CATransform3DIdentity
        let spring = CASpringAnimation(perceptualDuration: 0.35, bounce: 0)
        spring.keyPath = "sublayerTransform"
        spring.fromValue = NSValue(caTransform3D: layer.presentation()?.sublayerTransform ?? layer.sublayerTransform)
        spring.toValue = NSValue(caTransform3D: target)
        spring.duration = spring.settlingDuration
        layer.sublayerTransform = target
        layer.add(spring, forKey: "homeTutorialShrink")
    }

    fileprivate func go(to newIndex: Int) {
        guard stage.steps.indices.contains(newIndex) else { return }
        let forward = newIndex > stage.index
        let step = stage.steps[newIndex]
        transition?.cancel()
        withAnimation(.smooth(duration: 0.25)) { stage.finger = nil }
        withAnimation(Self.shrinkAnimation) { stage.index = newIndex }
        transition = Task { [weak self] in await self?.perform(step, forward: forward) }
    }

    private func perform(_ step: HomeTutorialStep, forward: Bool) async {
        let animated = forward && !UIAccessibility.isReduceMotionEnabled
        if animated {
            if let prepare = step.prepare, scene != prepare {
                stage.spot = nil
                let closesMenu = scene?.menu == true
                scene = prepare
                try? await Task.sleep(for: .seconds(closesMenu ? 0.45 : 0.6))
            }
            guard !Task.isCancelled else { return }
            if let target = step.tap, let frame = stage.frame(of: target) {
                stage.spot = target
                try? await Task.sleep(for: .seconds(0.4))
                guard !Task.isCancelled else { return }
                await touch(frame)
            }
            guard !Task.isCancelled else { return }
        }
        // En quittant un détail, la page se referme avant de défiler.
        if scene?.detail == true, !step.scene.detail, step.scene.anchor != .top {
            scene = HomeTutorialScene()
            try? await Task.sleep(for: .seconds(0.45))
            guard !Task.isCancelled else { return }
        }
        if animated && step.swipes { swipeUp() }
        scene = step.scene
        stage.spot = step.spot
        if !step.swipes { withAnimation(.smooth(duration: 0.25)) { stage.finger = nil } }
        // Une page sans la zone attendue (aucune vente) reste visible en entier.
        guard let spot = step.spot else { return }
        try? await Task.sleep(for: .seconds(1.5))
        if !Task.isCancelled, stage.frame(of: spot) == nil, stage.spot == spot { stage.spot = nil }
    }

    private func touch(_ frame: CGRect) async {
        let point = CGPoint(x: frame.midX, y: frame.midY)
        withAnimation(.smooth(duration: 0.28)) { stage.finger = .init(point: point) }
        try? await Task.sleep(for: .seconds(0.34))
        guard !Task.isCancelled else { return }
        withAnimation(.easeOut(duration: 0.1)) { stage.finger?.pressed = true }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        try? await Task.sleep(for: .seconds(0.14))
        guard !Task.isCancelled else { return }
        withAnimation(.easeOut(duration: 0.14)) { stage.finger?.pressed = false }
    }

    /// Le geste accompagne le défilement programmé de l'accueil.
    private func swipeUp() {
        let x = stage.screen.width / 2
        stage.finger = .init(point: CGPoint(x: x, y: stage.screen.height * 0.72), pressed: true)
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(30))
            guard let self, !Task.isCancelled else { return }
            withAnimation(.smooth(duration: 0.65)) { self.stage.finger?.point.y = self.stage.screen.height * 0.28 }
            try? await Task.sleep(for: .seconds(0.65))
            withAnimation(.smooth(duration: 0.2)) { self.stage.finger = nil }
        }
    }

    fileprivate func close(completed: Bool) {
        guard finish != nil else { return }
        transition?.cancel()
        withAnimation(.smooth(duration: 0.2)) { stage.finger = nil }
        scene = HomeTutorialScene()
        stage.spot = nil
        setShrunk(false)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(0.4))
            guard let self, let finish = self.finish else { return }
            self.finish = nil
            finish(completed)
        }
    }
}

extension View {
    /// Zone repérée par le tutoriel. `nil` : rien n'est mesuré.
    @ViewBuilder
    func homeTutorialTarget(_ target: HomeTutorialTarget?) -> some View {
        if let target { modifier(HomeTutorialTargetMeasure(target: target)) } else { self }
    }
}

/// Retiré dès que le tutoriel est passé : rien ne reste dans la hiérarchie.
private struct HomeTutorialTargetMeasure: ViewModifier {
    let target: HomeTutorialTarget
    @ObservedObject private var tutorial = HomeTutorial.shared

    func body(content: Content) -> some View {
        content.background {
            if tutorial.measuring { HomeTutorialProbe(target: target, stage: tutorial.stage) }
        }
    }
}

private struct HomeTutorialOverlay: View {
    @ObservedObject var stage: HomeTutorialStage
    let tutorial: HomeTutorial

    private var scale: CGFloat { HomeTutorial.scale }
    private var hasHomeButton: Bool { stage.safeArea.bottom == 0 }
    private var index: Int { min(stage.index, stage.steps.count - 1) }
    private var isLast: Bool { index == stage.steps.count - 1 }

    /// Écran de l'app, tel qu'il apparaît dans le faux iPhone.
    private var phone: CGRect {
        guard stage.shrunk else { return CGRect(origin: .zero, size: stage.screen) }
        return CGRect(x: stage.screen.width * (1 - scale) / 2, y: stage.safeArea.top + 25,
                      width: stage.screen.width * scale, height: stage.screen.height * scale)
    }

    private func onPhone(_ rect: CGRect) -> CGRect {
        let phone = phone
        let ratio = phone.width / max(stage.screen.width, 1)
        return CGRect(x: phone.minX + rect.minX * ratio, y: phone.minY + rect.minY * ratio,
                      width: rect.width * ratio, height: rect.height * ratio)
    }

    /// Zone éclairée, limitée à l'écran : elle suit le défilement et le glissé du menu.
    private var spotRect: CGRect? {
        guard let spot = stage.spot, let frame = stage.spotFrame else { return nil }
        let visible = frame.insetBy(dx: -spot.margin, dy: -spot.margin).intersection(CGRect(origin: .zero, size: stage.screen))
        return visible.isNull || visible.isEmpty ? nil : onPhone(visible)
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            veil
            surround
            phoneShape
            fingerView
            bottomView
                .frame(width: stage.screen.width, height: stage.screen.height, alignment: .bottom)
        }
        .frame(width: stage.screen.width, height: stage.screen.height, alignment: .topLeading)
        .contentShape(.rect)
        .ignoresSafeArea()
        .preferredColorScheme(.dark)
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .sensoryFeedback(.selection, trigger: stage.index)
        .onAppear { if !stage.shrunk { tutorial.setShrunk(true) } }
    }

    /// Voile sur l'app, percé sur la zone en cours. Sans zone, toute la page reste visible.
    private var veil: some View {
        let rect = spotRect
        let radius = (stage.spot?.cornerRadius ?? 0) * scale
        return Rectangle()
            .fill(.black.opacity(0.55))
            .reverseMask {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .frame(width: rect?.width ?? 0, height: rect?.height ?? 0)
                    .offset(x: rect?.minX ?? stage.screen.width / 2, y: rect?.minY ?? stage.screen.height / 2)
                    .animation(.smooth(duration: 0.35, extraBounce: 0), value: stage.spot)
            }
            .opacity(stage.shrunk && stage.spot != nil ? 1 : 0)
            .animation(.smooth(duration: 0.3), value: stage.spot == nil)
    }

    /// Noir tout autour du téléphone : la vraie app n'apparaît que dans son écran.
    private var surround: some View {
        let phone = phone
        return Rectangle()
            .fill(.black)
            .reverseMask {
                RoundedRectangle(cornerRadius: stage.shrunk ? (hasHomeButton ? 15 : 35) * scale : 0, style: .circular)
                    .frame(width: phone.width, height: phone.height)
                    .offset(x: phone.minX, y: phone.minY)
            }
    }

    private var phoneShape: some View {
        let phone = phone
        let outset = stage.shrunk ? 6 * scale : 0
        return ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: stage.shrunk ? (hasHomeButton ? 20 : 45) * scale : 0, style: .continuous)
                .stroke(.white, lineWidth: stage.shrunk ? 15 * scale : 0)
                .frame(width: phone.width + outset * 2, height: phone.height + outset * 2)
                .offset(x: phone.minX - outset, y: phone.minY - outset)

            if !hasHomeButton {
                Capsule()
                    .fill(.black)
                    .frame(width: 120 * scale, height: 40 * scale)
                    .offset(x: phone.midX - 60 * scale, y: phone.minY + 20 * scale)
                    .opacity(stage.shrunk ? 1 : 0)
            }
        }
        .allowsHitTesting(false)
    }

    @ViewBuilder
    private var fingerView: some View {
        if let finger = stage.finger {
            let at = onPhone(CGRect(origin: finger.point, size: .zero)).origin
            ZStack {
                Circle().stroke(.white.opacity(0.7), lineWidth: 2)
                    .frame(width: 34, height: 34)
                    .scaleEffect(finger.pressed ? 1.5 : 1)
                    .opacity(finger.pressed ? 0 : 0.8)
                Circle().fill(.white.opacity(0.85))
                    .frame(width: 26, height: 26)
                    .scaleEffect(finger.pressed ? 0.8 : 1)
                    .shadow(color: .black.opacity(0.35), radius: 6, y: 2)
            }
            .position(at)
            .transition(.opacity)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    private var bottomView: some View {
        VStack(spacing: 10) {
            VStack(spacing: 8) {
                HStack(spacing: 4) {
                    ForEach(stage.steps.indices, id: \.self) { i in
                        Capsule()
                            .fill(.white.opacity(i <= index ? 0.9 : 0.2))
                            .frame(width: 14, height: 3)
                    }
                }
                .accessibilityHidden(true)

                ZStack {
                    ForEach(Array(stage.steps.enumerated()), id: \.element.id) { i, step in
                        if i == index {
                            VStack(spacing: 4) {
                                Text(step.title).font(MMFont.system(16, .semibold)).foregroundStyle(.white)
                                Text(step.message).font(MMFont.system(13)).foregroundStyle(.white.opacity(0.62))
                            }
                            .multilineTextAlignment(.center)
                            .minimumScaleFactor(0.85)
                            .transition(.blurReplace)
                        }
                    }
                }
                .frame(height: 62, alignment: .top)
                .frame(maxWidth: 310)
            }

            HStack(spacing: 6) {
                if index > 0 {
                    Button { tutorial.go(to: index - 1) } label: {
                        Image(systemName: "chevron.left.circle.fill")
                            .font(.system(size: 38))
                            .foregroundStyle(.white, .gray.opacity(0.4))
                    }
                    .accessibilityLabel("Retour")
                }

                Button {
                    if isLast { tutorial.close(completed: true) } else { tutorial.go(to: index + 1) }
                } label: {
                    Text(isLast ? String(localized: "C'est parti") : String(localized: "Suivant"))
                        .font(MMFont.system(16, .semibold))
                        .frame(maxWidth: .infinity)
                        .contentTransition(.numericText())
                        .foregroundStyle(.black)
                        .padding(.vertical, 10)
                        .background(.white, in: .capsule)
                }
                .buttonStyle(MMPressStyle())
            }
            .frame(maxWidth: 250)
            .frame(height: 50)
            .padding(.leading, index > 0 ? -45 : 0)

            Button { tutorial.close(completed: false) } label: {
                Text("Passer le tutoriel").font(MMFont.system(14)).underline()
            }
            .foregroundStyle(.gray)
        }
        .padding(.horizontal, 15)
        .padding(.bottom, stage.safeArea.bottom + 10)
    }
}

private extension View {
    func reverseMask<Content: View>(@ViewBuilder content: @escaping () -> Content) -> some View {
        mask {
            Rectangle()
                .overlay(alignment: .topLeading) { content().blendMode(.destinationOut) }
        }
    }
}
