import SwiftUI

// Repris de V2 (HomeSyncBanner) : bannière de synchronisation de l'accueil : une goutte gluante qui se
// détache de la Dynamic Island (GooeyRefreshable), tourne pendant la lecture,
// pose une coche verte quand c'est fini, puis remonte dans l'île.
//
// Elle existe parce que l'absence de score n'est pas lisible sans elle : entre
// « la montre n'a rien enregistré » et « on est en train de lire HealthKit »,
// l'écran est identique. La bannière tranche.

// MARK: - État

/// Où en est la collecte HealthKit → upload → recalcul serveur.
@Observable
@MainActor
final class HealthSyncStatus {

    static let shared = HealthSyncStatus()

    enum Phase: Equatable {
        case idle
        case syncing
        case done
        case failed
    }

    /// Textes de la bannière : l'accueil raconte la synchro HealthKit, le fil
    /// et le classement leur propre actualisation.
    struct Titles {
        let running: String
        let done: String
        let failed: String

        static var health: Titles {
            Titles(running: String(localized: "Synchronisation…"),
                   done: String(localized: "Synchronisation terminée"),
                   failed: String(localized: "Synchronisation impossible"))
        }
    }

    private(set) var phase: Phase = .idle
    var isRefreshing: Bool { phase == .syncing }
    @ObservationIgnored let titles: () -> Titles

    @ObservationIgnored private var hideTask: Task<Void, Never>?

    /// `titles` est relu à chaque affichage pour suivre le changement de langue.
    init(titles: @escaping () -> Titles = { .health }) {
        self.titles = titles
    }

    func begin() {
        hideTask?.cancel()
        hideTask = nil
        guard phase != .syncing else { return }
        phase = .syncing
    }

    func finish(succeeded: Bool, playCompletionSound: Bool = true) {
        guard phase == .syncing else { return }
        phase = succeeded ? .done : .failed
        UINotificationFeedbackGenerator().notificationOccurred(succeeded ? .success : .error)

        hideTask?.cancel()
        hideTask = Task { @MainActor [weak self] in
            // Keep the result readable, then promptly return to the island.
            while !LaunchCoordinator.shared.revealed, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(80))
            }
            try? await Task.sleep(for: .milliseconds(succeeded ? 900 : 1400))
            guard !Task.isCancelled else { return }
            self?.phase = .idle
        }
    }

    /// A tap on the settled banner puts it away without waiting.
    func dismiss() {
        guard phase == .done || phase == .failed else { return }
        hideTask?.cancel()
        hideTask = nil
        phase = .idle
    }

    /// Si l'utilisateur quitte l'onglet Accueil pendant une sync, la tâche
    /// SwiftUI est annulée mais l'état peut rester bloqué sur `.syncing`.
    func resetIfAbandoned() {
        guard phase == .syncing else { return }
        hideTask?.cancel()
        hideTask = nil
        phase = .idle
    }
}

// MARK: - Bannière

/// La synchronisation, racontée par la Dynamic Island elle-même (d'après
/// GooeyRefreshable) : une goutte noire se détache de l'île — au rythme du
/// doigt quand on tire pour actualiser, toute seule quand la synchro part au
/// lancement — tourne pendant la lecture HealthKit, pose une coche verte (ou
/// une alerte) quand c'est fini, puis remonte se fondre dans l'île.
///
/// L'île et la goutte sont floutées ensemble puis passées au seuil alpha
/// (shader Metal) : elles fusionnent en UNE silhouette, avec le pont gluant
/// entre les deux. Une fois la goutte détachée, le shader se coupe et le
/// rendu redevient net.
struct HomeSyncBanner: View {
    /// Traction du « tirer pour actualiser », 0…1.
    var pullProgress: CGFloat = 0

    /// État fourni par le parent (qui l'observe) : la bannière se réévalue à chaque changement.
    let status: HealthSyncStatus
    @Environment(\.scenePhase) private var scenePhase
    /// Lu directement (Observation) : la bannière suit la synchro sans dépendre de son parent.
    private var phase: HealthSyncStatus.Phase { status.phase }
    private var isSyncVisible: Bool { status.phase != .idle && scenePhase == .active }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Descente de la goutte pilotée par la synchro (0 ou 1, animée).
    @State private var syncProgress: CGFloat = 0
    /// La goutte posée s'étire en bannière de verre (0 = goutte, 1 = bannière).
    @State private var expand: CGFloat = 0
    @State private var settlePulse = false
    @State private var sequence: Task<Void, Never>?
    @State private var sequenceID = UUID()
    /// Garde la goutte à l'écran jusqu'à la FIN de sa remontée : la
    /// condition d'affichage lirait sinon la valeur finale (0) et la
    /// retirerait en fondu dès le début du mouvement.
    @State private var dropMounted = false

    /// Jamais sous l'écran de lancement : la goutte arrive une fois dans l'app.

    /// La traction pilote TOUTE l'animation : la première moitié fait
    /// descendre la goutte, la seconde l'étire en bannière.
    private var pullDrop: CGFloat { min(pullProgress / 0.5, 1) }
    private var pullExpand: CGFloat { min(max((pullProgress - 0.5) / 0.5, 0), 1) }
    private var progress: CGFloat { max(pullDrop, syncProgress) }
    private var expansion: CGFloat { max(pullExpand, expand) }

    /// Lu une fois : la goutte suit le doigt image par image, et parcourir
    /// toutes les fenêtres de toutes les scènes à chaque image coûtait cher.
    @State private var safeTop: CGFloat = Self.currentSafeTop()



    private static func currentSafeTop() -> CGFloat {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }?
            .safeAreaInsets.top ?? 59
    }

    var body: some View {
        ZStack {
            if dropMounted || pullProgress > 0.001 {
                if reduceMotion {
                    reducedDrop
                } else if #available(iOS 26.0, *) {
                    liquidDrop
                } else {
                    gooeyDrop
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        // Lecture explicite de l'état dans le corps : garantit le suivi (Observation) de la synchro.
        .background { Text(verbatim: "\(phase)\(isSyncVisible)").opacity(0).accessibilityHidden(true) }
        .allowsHitTesting(false)
        .onChange(of: isSyncVisible, initial: true) { _, visible in
            runSequence(visible)
        }
        .onChange(of: phase) { _, phase in
            guard phase == .done || phase == .failed else { return }
            UIAccessibility.post(notification: .announcement, argument: title(for: phase))
        }
        .onDisappear {
            sequence?.cancel()
            sequenceID = UUID()
            dropMounted = false
            syncProgress = 0
            expand = 0
        }
        .accessibilityHidden(true)
    }

    // MARK: Séquence

    /// Lente et lisible : la goutte descend, se pose, s'étire en bannière ;
    /// au retour, la bannière se resserre en goutte qui remonte dans l'île.
    private func runSequence(_ visible: Bool) {
        sequence?.cancel()
        let token = UUID()
        sequenceID = token
        guard visible || dropMounted else { return }
        if visible {
            if !dropMounted {
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    syncProgress = pullDrop
                    expand = pullExpand
                }
            }
            dropMounted = true
        }
        if reduceMotion {
            withAnimation(.easeOut(duration: 0.25)) {
                syncProgress = visible ? 1 : 0
                expand = visible ? 1 : 0
            } completion: {
                if sequenceID == token, !visible, !isSyncVisible { dropMounted = false }
            }
            return
        }
        sequence = Task { @MainActor in
            if visible {
                // Déjà étirée par la traction : on garde la bannière telle
                // quelle, sans rejouer la descente.
                if pullExpand > 0.25 || pullDrop >= 1 {
                    syncProgress = 1
                    withAnimation(.easeInOut(duration: 0.28)) { expand = 1 }
                    return
                }
                // La goutte descend, marque un court temps sous l'île, puis
                // s'étire en bannière.
                withAnimation(.easeInOut(duration: 0.38)) { syncProgress = 1 }
                try? await Task.sleep(for: .milliseconds(220))
                guard !Task.isCancelled else { return }
                withAnimation(.easeInOut(duration: 0.3)) { expand = 1 }
            } else {
                // L'aller à l'envers : la bannière redevient goutte, puis
                // remonte se fondre dans l'île.
                withAnimation(.easeInOut(duration: 0.24)) { expand = 0 }
                try? await Task.sleep(for: .milliseconds(180))
                guard !Task.isCancelled else { return }
                withAnimation(.easeInOut(duration: 0.32)) {
                    syncProgress = 0
                } completion: {
                    if sequenceID == token, !isSyncVisible { dropMounted = false }
                }
            }
        }
    }

    // MARK: Goutte

    /// Tout en Liquid Glass (iOS 26) : l'île est une capsule de verre teintée
    /// noire posée sur la vraie, et la goutte une capsule de verre qui s'en
    /// détache. Dans un `GlassEffectContainer`, deux verres proches fusionnent
    /// comme un liquide : c'est le cou gluant, en verre. La même goutte
    /// s'étire ensuite en bannière.
    @available(iOS 26.0, *)
    private var liquidDrop: some View {
        let top = safeTop
        let hasDynamicIsland = top >= 59
        let p = min(max(progress, 0), 1.2)
        let dropProgress = p > 0.12 ? min((p - 0.12) / 0.88, 1.2) : 0
        let dropSize = 30 + dropProgress * 26
        let islandCenter: CGFloat = hasDynamicIsland ? 11 + 37.33 / 2 : -20
        let travel = (hasDynamicIsland ? top + 22 : top + 40) * p
        let height = SyncGlassBanner.height(expansion, dropSize: dropSize)

        return GlassEffectContainer(spacing: 34) {
            ZStack(alignment: .top) {
                Capsule(style: .continuous)
                    .fill(.clear)
                    .frame(width: 122, height: 36)
                    .glassEffect(.regular.tint(Color.black), in: Capsule(style: .continuous)) // fixed-scheme: the island is black
                    .offset(y: islandCenter - 18)
                    .opacity(scenePhase == .active && hasDynamicIsland ? 1 : 0)

                SyncGlassBanner(
                    phase: phase,
                    expand: expansion,
                    dropSize: dropSize,
                    pulse: settlePulse,
                    title: title(for: phase)
                )
                .offset(y: islandCenter + travel - height / 2)
            }
            .frame(maxWidth: .infinity, alignment: .top)
        }
    }

    private var gooeyDrop: some View {
        let top = safeTop
        let hasDynamicIsland = top >= 59
        let p = min(max(progress, 0), 1.2)
        let extraOffset: CGFloat = hasDynamicIsland ? 0 : 15
        let travel = (top < 35 ? top + 35 + 15 : top + extraOffset + 16) * p
        let blurRadius: CGFloat = 25
        let shaderOn = abs(progress - 1) > 0.001

        return Rectangle()
            .fill(.clear)
            .frame(height: top)
            .overlay(alignment: hasDynamicIsland ? .center : .top) {
                // 100 × 33 et non la taille exacte de l'île : l'île réelle
                // recouvre les bords, rien ne déborde autour d'elle.
                Capsule()
                    .fill(Color.black) // fixed-scheme: the Dynamic Island is always black
                    .frame(width: 100, height: 33)
                    .opacity(scenePhase == .active ? 1 : 0)
                    .mask {
                        Capsule().padding(.top, 5)
                    }
                    .overlay(alignment: .bottom) {
                        let dropProgress = p > 0.2 ? (p - 0.2) / 0.8 : 0
                        let size = 34 + dropProgress * 22
                        // La goutte est colorée : un dégradé qui tourne, fondu
                        // dans le noir de l'île par le seuil gluant.
                        TimelineView(.animation(minimumInterval: 1.0 / 60)) { timeline in
                            Circle()
                                .fill(SyncDropGradient.shading(at: timeline.date))
                        }
                            .frame(width: size, height: size)
                            // La goutte laisse sa place à la bannière qui en naît.
                            .opacity(1 - min(expansion * 2.2, 1))
                            .offset(y: travel)
                    }
                    .compositingGroup()
                    .blur(radius: max(blurRadius - blurRadius * p, 0))
                    .visualEffect { [shaderOn] content, proxy in
                        content.layerEffect(
                            ShaderLibrary.syncIslandAlphaThreshold(),
                            maxSampleOffset: proxy.size,
                            isEnabled: shaderOn
                        )
                    }
                    .overlay(alignment: .bottom) {
                        // LA goutte : une seule capsule de verre, de la
                        // sortie de l'île jusqu'à la bannière déployée. Le
                        // pont gluant noir reste dessous, invisible une fois
                        // la goutte détachée.
                        let dropProgress = p > 0.2 ? (p - 0.2) / 0.8 : 0
                        let dropSize = 34 + dropProgress * 22
                        // Noire au départ, identique à la goutte qu'elle
                        // remplace : elle ne fait que s'étirer et s'éclaircir.
                        if expansion > 0.001 {
                        SyncGlassBanner(
                            phase: phase,
                            expand: expansion,
                            dropSize: dropSize,
                            pulse: settlePulse,
                            title: title(for: phase)
                        )
                        // Centre de la capsule = centre de la goutte.
                        .offset(y: travel + (SyncGlassBanner.height(expansion, dropSize: dropSize) - dropSize) / 2)
                        }
                    }
                    .offset(y: top < 35 ? -35 : 0)
            }
    }

    /// Mouvement réduit : pas de fusion, la goutte apparaît simplement.
    private var reducedDrop: some View {
        let top = safeTop
        return SyncGlassBanner(phase: phase, expand: 1, pulse: false, title: title(for: phase))
            .opacity(progress)
            .offset(y: top + 8)
            .frame(maxWidth: .infinity, alignment: .top)
    }

    private func title(for phase: HealthSyncStatus.Phase) -> String {
        let titles = status.titles()
        switch phase {
        case .syncing, .idle: return titles.running
        case .done: return titles.done
        case .failed: return titles.failed
        }
    }
}

// MARK: - Bannière de verre

/// La bannière née de la goutte : capsule Liquid Glass neutre (ni contour ni
/// lueur colorés), noire comme l'île au départ puis de plus en plus claire à
/// mesure qu'elle s'étire. Le chargement vit DEDANS : anneau en dégradé qui
/// tourne, et un reflet qui balaie le titre en boucle.
struct SyncGlassBanner: View {
    let phase: HealthSyncStatus.Phase
    /// 0 = goutte, 1 = bannière déployée.
    let expand: CGFloat
    /// Diamètre de la goutte (la bannière en part et y revient).
    var dropSize: CGFloat = 40
    let pulse: Bool
    let title: String

    static let fullWidth: CGFloat = 270
    static let fullHeight: CGFloat = 54

    static func height(_ expand: CGFloat, dropSize: CGFloat = 40) -> CGFloat {
        dropSize + (fullHeight - dropSize) * min(max(expand, 0), 1.1)
    }

    var body: some View {
        let e = min(max(expand, 0), 1.1)
        let width = dropSize + (Self.fullWidth - dropSize) * e
        let height = Self.height(e, dropSize: dropSize)
        let shape = Capsule(style: .continuous)
        let reveal = min(max((e - 0.35) / 0.65, 0), 1)

        // Seul le mouvement (reflet, anneau) suit l'horloge ; la taille et
        // le déploiement restent dehors, pour que la bannière se resserre en
        // goutte même quand l'horloge est à l'arrêt.
        let glyphIn = min(max((e - 0.7) / 0.3, 0), 1)
        HStack(spacing: 12) {
            ZStack {
                // L'anneau et le résultat sont toujours là, superposés : on
                // passe de l'un à l'autre sans jamais recréer de vue.
                SyncSpinner(isSpinning: phase == .syncing || phase == .idle)
                    .opacity(phase == .syncing || phase == .idle ? 1 : 0)
                    .scaleEffect(phase == .syncing || phase == .idle ? 1 : 0.4)
                resultSymbol
            }
            .frame(width: 22, height: 22)
            // L'anneau n'apparaît qu'une fois la bannière posée.
            .opacity(glyphIn)
            .scaleEffect(0.6 + 0.4 * glyphIn)

            // 60 i/s suffisent à un reflet : à 120 Hz, le verre au-dessus de la
            // page se recomposait deux fois plus pour rien.
            TimelineView(.animation(minimumInterval: 1.0 / 60, paused: phase != .syncing)) { timeline in
                shimmerTitle(t: timeline.date.timeIntervalSinceReferenceDate)
            }
        }
        .padding(.horizontal, 20)
        .opacity(reveal)
        .blur(radius: 10 * (1 - reveal))
        .scaleEffect(0.85 + 0.15 * reveal)
        .frame(width: width, height: height)
        .clipShape(shape)
        .modifier(SyncBannerGlass(shape: shape, expand: e))
        .shadow(color: Color.black.opacity(0.35 * e), radius: 16, y: 8) // fixed-scheme: soft neutral shadow
        .scaleEffect(pulse ? 1.05 : 1)
        .animation(.spring(response: 0.55, dampingFraction: 0.8), value: phase)
    }

    /// Le titre, traversé d'un reflet dégradé qui glisse sans fin pendant
    /// la synchro ; posé et net une fois le résultat connu.
    private func shimmerTitle(t: TimeInterval) -> some View {
        let sweep = CGFloat((t * 0.55).truncatingRemainder(dividingBy: 1)) * 2.4 - 0.7
        return Text(title)
            .font(MMFont.system(16, .semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .foregroundStyle(
                phase == .syncing
                    ? AnyShapeStyle(LinearGradient(
                        stops: [
                            .init(color: Color.white.opacity(0.55), location: sweep - 0.35), // fixed-scheme: glass over the island
                            .init(color: Color.white, location: sweep), // fixed-scheme: glass over the island
                            .init(color: Color.white.opacity(0.55), location: sweep + 0.35), // fixed-scheme: glass over the island
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    ))
                    : AnyShapeStyle(Color.white) // fixed-scheme: glass over the island
            )
            .id(title)
            .transition(AnyTransition.asymmetric(
                insertion: AnyTransition(.blurReplace).combined(with: .offset(y: 6)),
                removal: AnyTransition(.blurReplace).combined(with: .offset(y: -6))
            ))
    }

    /// La coche se dessine d'un trait (iOS 26), l'alerte rebondit.
    @ViewBuilder
    private var resultSymbol: some View {
        let isDone = phase == .done
        let isFailed = phase == .failed
        ZStack {
            if #available(iOS 26.0, *) {
                if isDone {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 21, weight: .semibold))
                        .foregroundStyle(Color.white, Color(syncHex: 0x34C77B)) // fixed-scheme: glass over the island
                        .transition(.symbolEffect(.drawOn))
                }
            } else {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 21, weight: .semibold))
                    .foregroundStyle(Color.white, Color(syncHex: 0x34C77B)) // fixed-scheme: glass over the island
                    .symbolEffect(.bounce, value: isDone)
                    .opacity(isDone ? 1 : 0)
                    .scaleEffect(isDone ? 1 : 0.4)
            }
            Image(systemName: "exclamationmark.circle.fill")
                .font(.system(size: 21, weight: .semibold))
                .foregroundStyle(Color.white, Color(syncHex: 0xE0674F)) // fixed-scheme: glass over the island
                .symbolEffect(.bounce, value: isFailed)
                .opacity(isFailed ? 1 : 0)
                .scaleEffect(isFailed ? 1 : 0.4)
        }
    }
}

/// L'anneau de chargement : un arc en dégradé qui tourne à vitesse
/// constante, piloté par sa seule horloge — aucune transition ni ressort
/// extérieur ne peut le faire hoqueter.
private struct SyncSpinner: View {
    var isSpinning: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: !isSpinning)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            Circle()
                .trim(from: 0, to: 0.75)
                .stroke(
                    AngularGradient(
                        stops: [
                            .init(color: Color.white.opacity(0), location: 0), // fixed-scheme: glass over the island
                            .init(color: Color(syncHex: 0x9CC8FF), location: 0.4),
                            .init(color: Color.white, location: 0.75), // fixed-scheme: glass over the island
                        ],
                        center: .center
                    ),
                    style: StrokeStyle(lineWidth: 2.5, lineCap: .round)
                )
                .rotationEffect(.radians(t * 2 * .pi / 0.85))
        }
        .padding(1.5)
        .transaction { $0.animation = nil }
    }
}

/// Verre neutre : teinté noir comme l'île quand la bannière est encore une
/// goutte, presque transparent une fois déployée (comme la bulle Siri).
private struct SyncBannerGlass<S: Shape>: ViewModifier {
    let shape: S
    let expand: CGFloat

    func body(content: Content) -> some View {
        let tint = 0.45 - 0.33 * min(max(expand, 0), 1)
        if #available(iOS 26.0, *) {
            // Pas `.interactive()` : la bannière ne reçoit aucun toucher
            // (allowsHitTesting(false)), l'effet ne faisait que coûter.
            content.glassEffect(.regular.tint(Color.black.opacity(tint)), in: shape) // fixed-scheme: born from the black island
        } else {
            content
                .background(.ultraThinMaterial, in: shape)
                .background(Color.black.opacity(tint), in: shape) // fixed-scheme: born from the black island
        }
    }
}

/// Le dégradé animé de la goutte : bleu, violet, cyan, qui tourne en continu.
/// Une seule source, lue à la même date par la goutte et par la bannière.
enum SyncDropGradient {
    static let colors: [Color] = [
        Color(syncHex: 0x3D8BFF), Color(syncHex: 0x8B5CFF), Color(syncHex: 0x22D3EE), Color(syncHex: 0x3D8BFF),
    ]

    static func shading(at date: Date) -> AngularGradient {
        let t = date.timeIntervalSinceReferenceDate
        return AngularGradient(
            colors: colors,
            center: .center,
            angle: .degrees((t * 80).truncatingRemainder(dividingBy: 360))
        )
    }
}

// MARK: - Spinner natif masqué

/// Rend invisible le spinner du `.refreshable` natif : la goutte de l'île le
/// remplace. Le geste et l'appel de rafraîchissement restent ceux d'iOS.
struct RefreshSpinnerHider: UIViewRepresentable {
    func makeUIView(context: Context) -> SpinnerHiderView { SpinnerHiderView() }
    func updateUIView(_ view: SpinnerHiderView, context: Context) { view.hide() }

    final class SpinnerHiderView: UIView {
        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            backgroundColor = .clear
        }

        required init?(coder: NSCoder) { nil }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            hide()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            hide()
        }

        func hide() {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                // La scroll view est une voisine proche : on remonte quelques
                // niveaux et on cherche celle qui porte un refreshControl.
                var ancestor: UIView? = self.superview
                for _ in 0..<6 {
                    guard let current = ancestor else { break }
                    if let control = Self.refreshControl(in: current) {
                        control.tintColor = .clear
                        control.alpha = 0
                        return
                    }
                    ancestor = current.superview
                }
            }
        }

        private static func refreshControl(in view: UIView) -> UIRefreshControl? {
            if let scroll = view as? UIScrollView, let control = scroll.refreshControl { return control }
            for sub in view.subviews {
                if let found = refreshControl(in: sub) { return found }
            }
            return nil
        }
    }
}

// MARK: - Tirer pour actualiser, raconté par l'île (fil, classement)

/// Traction + état d'une page qui rafraîchit avec la goutte de l'île, comme
/// l'accueil. Seule la bannière lit `pull` : la page ne se réévalue pas
/// pendant le glissé.
@Observable
@MainActor
final class IslandRefreshState {
    var pull: CGFloat = 0
    let status: HealthSyncStatus

    init(titles: @escaping () -> HealthSyncStatus.Titles) {
        status = HealthSyncStatus(titles: titles)
    }

    init(status: HealthSyncStatus) { self.status = status }

    /// Accueil : même état pour la synchro du lancement et le « tirer pour actualiser ».
    static let home = IslandRefreshState(status: .shared)
}

/// La bannière d'une page : à poser en overlay haut, hors de la pile de
/// navigation, avec `.ignoresSafeArea()` (comme `HomeSyncBannerHost`).
struct IslandRefreshBanner: View {
    let state: IslandRefreshState
    var body: some View { IslandRefreshBannerBody(pull: state.pull, status: state.status) }
}

/// Observe la synchro, l'ouverture de l'app et la scène, et passe l'état à la bannière.
private struct IslandRefreshBannerBody: View {
    let pull: CGFloat
    let status: HealthSyncStatus

    var body: some View {
        HomeSyncBanner(pullProgress: pull, status: status)
    }
}

/// La traction du doigt pilote la goutte (iOS 18+) ; avant, la goutte part seule.
private struct IslandPullTracker: ViewModifier {
    let state: IslandRefreshState
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: CGFloat.self) { geometry in
                min(max(-(geometry.contentOffset.y + geometry.contentInsets.top) / 130, 0), 1)
            } action: { _, progress in
                // Écrit seulement quand la traction bouge vraiment (ou revient à 0 / atteint 1) :
                // chaque écriture réévalue la bannière et son verre.
                if progress == 0 || progress == 1 || abs(progress - state.pull) > 0.008 { state.pull = progress }
            }
        } else {
            content
        }
    }
}

extension View {
    /// `.refreshable` natif (geste iOS) sans son spinner : la traction pilote
    /// la goutte, puis la bannière tourne pendant `action` et pose une coche
    /// verte (action réussie) ou une alerte, avant de remonter dans l'île.
    func islandRefreshable(_ state: IslandRefreshState, action: @escaping () async -> Bool) -> some View {
        self
            .modifier(IslandPullTracker(state: state))
            .background { RefreshSpinnerHider() }
            .refreshable {
                state.status.begin()
                // Tâche non structurée : si SwiftUI annule le geste (vue redessinée pendant le chargement),
                // la requête continue au lieu d'échouer en « annulée ».
                let succeeded = await Task { @MainActor in await action() }.value
                state.status.finish(succeeded: succeeded, playCompletionSound: false)
            }
    }
}


extension Color {
    /// Couleur 0xRRGGBB (palette de la bannière, reprise de V2).
    init(syncHex hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

