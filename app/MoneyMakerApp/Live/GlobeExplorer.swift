//
//  GlobeExplorer.swift
//  MoneyMaker — la page Planète.
//
//  Ouverte en touchant la planète de l'Accueil (zoom natif depuis la planète). Une grande
//  planète manipulable dans tous les sens, avec inertie, pincer pour zoomer, double‑toucher
//  pour zoomer, toucher un pays pour le centrer et ouvrir sa fiche (verre).
//
//  Rendu : le même moteur que l'Accueil (GlobeRender), une seule Canvas. La caméra vit dans un
//  objet hors SwiftUI : tourner ou zoomer ne recalcule aucune vue, seule la Canvas se redessine.
//  Cadence native (120 i/s) pendant les gestes et les animations, 30 i/s au repos, pause hors écran.
//

import SwiftUI

// MARK: - Ouverture depuis l'Accueil

/// Passe le projet choisi sous la planète et le pays touché à la page Planète.
@MainActor
enum GlobeExplorerHandoff {
    static var project: String?
    static var country: String?

    static func open(project: String?, country: String?) {
        self.project = project
        self.country = country
        Router.shared.pending = .globe
    }

    static func take() -> (project: String?, country: String?) {
        defer { project = nil; country = nil }
        return (project, country)
    }
}

private let globeZoomID = "mm.globe"

/// La planète de l'Accueil est la source du zoom vers la page Planète.
struct GlobeZoomSource: ViewModifier {
    @Environment(\.homeZoom) private var ns
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *), let ns { content.matchedTransitionSource(id: globeZoomID, in: ns) } else { content }
    }
}

struct GlobeZoomDestination: ViewModifier {
    let ns: Namespace.ID
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) { content.navigationTransition(.zoom(sourceID: globeZoomID, in: ns)) } else { content }
    }
}

// MARK: - Caméra

/// Caméra de la page Planète : rotation libre avec inertie, ressorts vers une cible, zoom amorti.
final class GlobeExplorerCamera {
    var spin = -0.35, tilt = 0.32, scale = 1.0
    var vSpin = 0.0, vTilt = 0.0, vScale = 0.0
    var targetSpin: Double?, targetTilt: Double?
    var targetScale = 1.0
    var dragging = false, pinching = false
    var cruise = true
    var lastTick = Date()

    static let minScale = 0.85, maxScale = 4.0
    static let tiltLimit = 1.3

    var camera: GlobeCamera { GlobeCamera(spin: spin, tilt: tilt, scale: scale) }

    /// Ressort critique (ω ≈ 8) : arrive vite, sans rebond ni à‑coup.
    private func spring(_ x: inout Double, _ v: inout Double, to t: Double, dt: Double, k: Double = 64) {
        let a = k * (t - x) - 2 * k.squareRoot() * v
        v += a * dt
        x += v * dt
    }

    func advance(to now: Date, reduceMotion: Bool) {
        let dt = min(1.0 / 30, max(0, now.timeIntervalSince(lastTick)))
        lastTick = now
        guard dt > 0 else { return }
        if !pinching { spring(&scale, &vScale, to: targetScale, dt: dt, k: 90) }
        guard !dragging else { return }
        if let ts = targetSpin, let tt = targetTilt {
            spring(&spin, &vSpin, to: ts, dt: dt)
            spring(&tilt, &vTilt, to: tt, dt: dt)
            if abs(ts - spin) < 0.0005, abs(tt - tilt) < 0.0005, abs(vSpin) + abs(vTilt) < 0.002 {
                targetSpin = nil; targetTilt = nil; vSpin = 0; vTilt = 0
            }
            return
        }
        // Inertie qui s'amortit ; sans sélection, elle retombe vers une rotation de croisière douce.
        let decay = exp(-dt * 2.4)
        let goal = cruise && !reduceMotion ? -0.09 / scale : 0
        vSpin = goal + (vSpin - goal) * decay
        vTilt *= decay
        spin += vSpin * dt
        tilt += vTilt * dt
        // Retour doux de l'inclinaison dans ses bornes (ressort plutôt qu'un mur).
        let lim = Self.tiltLimit
        if abs(tilt) > lim { tilt += ((tilt > 0 ? lim : -lim) - tilt) * min(1, dt * 10); vTilt *= 0.5 }
    }

    /// Fait tourner la planète par le chemin le plus court pour mettre (lat, lng) face à soi.
    func focus(lat: Double, lng: Double) {
        let lo = lng * .pi / 180, la = lat * .pi / 180
        targetSpin = spin + remainder(lo - spin, 2 * .pi)
        targetTilt = max(-Self.tiltLimit, min(Self.tiltLimit, la))
    }

    /// Bornes de zoom avec un léger élastique au‑delà.
    static func rubber(_ s: Double) -> Double {
        if s < minScale { return minScale - (minScale - s) * 0.35 }
        if s > maxScale { return maxScale + (s - maxScale) * 0.25 }
        return s
    }
    static func clamp(_ s: Double) -> Double { max(minScale, min(maxScale, s)) }
}

// MARK: - Page

struct GlobeExplorer: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var cam = GlobeExplorerCamera()
    @State private var haptics = GlobeHaptics()
    @State private var heat = GlobeHeat()
    @State private var selected: String?
    @State private var picked: String?
    @State private var expanded = false
    @State private var visible = false
    /// Cadence native pendant les gestes et les animations, puis 60 i/s au repos (page dédiée : fluidité d'abord).
    @State private var fast = true
    @State private var calmToken = 0
    @State private var canvasSize: CGSize = .zero
    @State private var dragStart: (spin: Double, tilt: Double)?
    @State private var pinchStart: Double?
    @State private var apps: [String: [TrackedAppSummary]] = [:]
    @State private var sheetDrag: CGFloat = 0

    // MARK: Données

    private var allProjects: [ProjectSummary] { store.overview?.projects ?? [] }
    private var pickedProject: ProjectSummary? { picked.flatMap { id in allProjects.first { $0.projectId == id } } }
    private var projects: [ProjectSummary] { pickedProject.map { [$0] } ?? store.viewProjects }
    private var currency: String { pickedProject?.currency ?? store.overview?.currency ?? "EUR" }

    var body: some View {
        let spots = store.globeSpots(for: projects)
        let ranked = spots.filter { $0.value >= 0.01 }.sorted { $0.value > $1.value }
        let total = max(spots.reduce(0) { $0 + $1.value }, 0.0001)

        GeometryReader { geo in
            ZStack {
                globe(spots: spots)
                    .offset(y: selected == nil ? 0 : -geo.size.height * (expanded ? 0.26 : 0.12))
                    .animation(.spring(response: 0.55, dampingFraction: 0.86), value: selected)
                    .animation(.spring(response: 0.55, dampingFraction: 0.86), value: expanded)

                VStack(spacing: 12) {
                    topBar(count: ranked.count, total: total)
                    chips(ranked)
                    Spacer(minLength: 0)
                    HStack { Spacer(); zoomControls }
                        .opacity(expanded ? 0 : 1)
                    bottom(spots: spots, total: total, maxHeight: geo.size.height * 0.62)
                }
                .padding(.bottom, 8)
            }
        }
        .mmPage(stars: true)
        .toolbar(.hidden, for: .navigationBar)
        .sensoryFeedback(.selection, trigger: selected)
        .onAppear {
            visible = true
            let h = GlobeExplorerHandoff.take()
            if let p = h.project { picked = p }
            if let cc = h.country {
                // Après le zoom d'ouverture : la planète tourne ensuite vers le pays.
                Task { try? await Task.sleep(for: .milliseconds(380)); select(cc) }
            }
            kick()
        }
        .onDisappear { visible = false }
        .onChange(of: picked) { _, _ in
            if let cc = selected, !store.globeSpots(for: projects).contains(where: { $0.cc == cc && $0.value > 0 }) { deselect() }
            kick()
        }
        .task(id: projects.map(\.projectId)) { await loadApps() }
    }

    // MARK: Planète

    private func globe(spots: [GlobeSpot]) -> some View {
        let live = visible && scenePhase == .active
        return TimelineView(.animation(minimumInterval: fast ? nil : 1.0 / 60, paused: !live)) { tl in
            Canvas(rendersAsynchronously: true) { ctx, size in
                draw(&ctx, size: size, now: tl.date, spots: spots)
            }
        }
        .onGeometryChange(for: CGSize.self) { $0.size } action: { canvasSize = $0 }
        .contentShape(Rectangle())
        .gesture(rotate.simultaneously(with: pinch))
        .onTapGesture(count: 2, coordinateSpace: .local) { p in doubleTap(at: p) }
        .onTapGesture(count: 1, coordinateSpace: .local) { p in tap(at: p, spots: spots) }
        .accessibilityElement()
        .accessibilityLabel(Text("Planète des ventes"))
        .accessibilityHint(Text("Glisser pour tourner, pincer pour zoomer, toucher un pays pour voir son détail."))
    }

    private func draw(_ ctx: inout GraphicsContext, size: CGSize, now: Date, spots: [GlobeSpot]) {
        cam.cruise = selected == nil
        cam.advance(to: now, reduceMotion: reduceMotion)
        let c = cam.camera
        let r = GlobeRender.radius(size, c)
        let center = CGPoint(x: size.width / 2, y: size.height / 2)

        // Halo d'atmosphère dessiné dans la Canvas : il suit le zoom sans recalcul de vue.
        let halo = r * 1.28
        ctx.fill(Path(ellipseIn: CGRect(x: center.x - halo, y: center.y - halo, width: halo * 2, height: halo * 2)),
                 with: .radialGradient(Gradient(stops: [.init(color: .clear, location: 0.70),
                                                        .init(color: Color(red: 0.42, green: 0.36, blue: 0.95).opacity(0.30), location: 0.78),
                                                        .init(color: Color(red: 0.30, green: 0.30, blue: 0.78).opacity(0.10), location: 0.88),
                                                        .init(color: .clear, location: 1)]),
                                       center: center, startRadius: 0, endRadius: halo))

        GlobeRender.draw(&ctx, size: size, now: now, spots: spots, heat: heat.values(for: spots), cam: c, highlight: selected)

        // Pays choisi : anneau qui respire autour de la base du faisceau.
        if let cc = selected, let co = GlobeData.countries[cc],
           let q = GlobeRender.project(cam: c, GlobeData.unit(lat: co.lat, lng: co.lng), size: size), q.z > 0 {
            let t = now.timeIntervalSinceReferenceDate
            let breath = reduceMotion ? 0.5 : 0.5 + 0.5 * sin(t * 2.6)
            let fade = min(1, q.z * 3)
            for (i, base) in [14.0, 24.0].enumerated() {
                let rr = base + 5 * breath + Double(i) * 2
                ctx.stroke(Path(ellipseIn: CGRect(x: q.point.x - rr, y: q.point.y - rr, width: rr * 2, height: rr * 2)),
                           with: .color(MMColor.ink.opacity((i == 0 ? 0.85 : 0.30 * (1 - breath)) * fade)),
                           lineWidth: i == 0 ? 1.4 : 1)
            }
        }
    }

    // MARK: Gestes

    private var rotate: some Gesture {
        DragGesture(minimumDistance: 1)
            .onChanged { v in
                if dragStart == nil {
                    dragStart = (cam.spin, cam.tilt)
                    cam.dragging = true; cam.targetSpin = nil; cam.targetTilt = nil
                    cam.vSpin = 0; cam.vTilt = 0
                    haptics.grab(); fast = true
                }
                guard let s = dragStart else { return }
                let k = 0.0085 / cam.scale
                cam.spin = s.spin - v.translation.width * k
                let t = s.tilt + v.translation.height * k
                let lim = GlobeExplorerCamera.tiltLimit
                // Élastique au‑delà des pôles.
                cam.tilt = abs(t) > lim ? (t > 0 ? lim : -lim) + (t - (t > 0 ? lim : -lim)) * 0.3 : t
                cam.lastTick = .now
                haptics.rotated(to: cam.spin, speed: 0)
            }
            .onEnded { v in
                let k = 0.0085 / cam.scale
                cam.vSpin = max(-8, min(8, -v.velocity.width * k))
                cam.vTilt = max(-5, min(5, v.velocity.height * k))
                cam.dragging = false; cam.lastTick = .now
                dragStart = nil
                haptics.release(speed: abs(cam.vSpin) + abs(cam.vTilt))
                kick()
            }
    }

    private var pinch: some Gesture {
        MagnifyGesture()
            .onChanged { v in
                if pinchStart == nil { pinchStart = cam.scale; cam.pinching = true; cam.vScale = 0; fast = true }
                cam.scale = GlobeExplorerCamera.rubber((pinchStart ?? 1) * v.magnification)
                cam.targetScale = cam.scale
            }
            .onEnded { _ in
                cam.pinching = false
                cam.targetScale = GlobeExplorerCamera.clamp(cam.scale)
                pinchStart = nil
                kick()
            }
    }

    private func doubleTap(at p: CGPoint) {
        zoom(to: cam.targetScale < 1.8 ? 2.4 : 1)
    }

    private func zoom(to s: Double) {
        cam.targetScale = GlobeExplorerCamera.clamp(s)
        haptics.grab()
        kick()
    }

    private func tap(at p: CGPoint, spots: [GlobeSpot]) {
        guard canvasSize != .zero else { return }
        let c = cam.camera
        let best = spots.compactMap { s -> (String, CGFloat)? in
            guard s.value > 0, let co = GlobeData.countries[s.cc],
                  let q = GlobeRender.project(cam: c, GlobeData.unit(lat: co.lat, lng: co.lng), size: canvasSize), q.z > 0.1 else { return nil }
            return (s.cc, hypot(q.point.x - p.x, q.point.y - p.y))
        }.min { $0.1 < $1.1 }
        if let best, best.1 < 36 { select(best.0) } else if selected != nil { deselect() }
    }

    private func select(_ cc: String) {
        guard let co = GlobeData.countries[cc] else { return }
        withAnimation(.spring(response: 0.5, dampingFraction: 0.86)) { selected = cc }
        cam.focus(lat: co.lat, lng: co.lng)
        if cam.targetScale < 1.6 { cam.targetScale = 1.6 }
        kick()
    }

    private func deselect() {
        withAnimation(.spring(response: 0.45, dampingFraction: 0.9)) { selected = nil; expanded = false }
        cam.targetScale = min(cam.targetScale, 1.2)
        kick()
    }

    /// Passe en cadence native pour 2,5 s, puis revient à 60 i/s si rien ne bouge.
    private func kick() {
        fast = true
        calmToken += 1
        let token = calmToken
        Task {
            try? await Task.sleep(for: .milliseconds(2500))
            if token == calmToken, !cam.dragging, !cam.pinching { fast = false }
        }
    }

    // MARK: Barre du haut

    private func topBar(count: Int, total: Double) -> some View {
        HStack(spacing: 12) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left").font(.system(size: 16, weight: .semibold)).foregroundStyle(MMColor.ink)
                    .frame(width: 44, height: 44).mmGlass(in: Circle(), interactive: true)
            }
            .buttonStyle(MMPressStyle(scale: 0.92))
            .accessibilityLabel(Text("Retour"))
            VStack(alignment: .leading, spacing: 1) {
                Text("Planète").font(MMFont.system(20, .semibold)).foregroundStyle(MMColor.ink)
                Text("\(count) pays · \(Int(total * 1e6).money(currency, compact: true))")
                    .font(MMFont.system(12)).foregroundStyle(MMColor.ink3).contentTransition(.numericText())
            }
            Spacer()
            if allProjects.count > 1 {
                Menu {
                    Picker(selection: Binding(get: { picked }, set: { v in withAnimation(.snappy) { picked = v } })) {
                        Text("Tous les projets").tag(String?.none)
                        ForEach(allProjects) { p in Text(p.name).tag(String?.some(p.projectId)) }
                    } label: { EmptyView() }
                } label: {
                    HStack(spacing: 6) {
                        if let p = pickedProject { ProjectIcon(project: p, size: 22) }
                        Text(pickedProject?.name ?? String(localized: "Tous")).font(MMFont.system(13, .medium)).lineLimit(1)
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundStyle(MMColor.ink)
                    .padding(.horizontal, 12).frame(height: 44)
                    .mmGlass(in: Capsule(), interactive: true)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
    }

    // MARK: Pays en pastilles

    private func chips(_ ranked: [GlobeSpot]) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(Array(ranked.prefix(40).enumerated()), id: \.element.cc) { i, s in
                        let on = selected == s.cc
                        Button { on ? deselect() : select(s.cc) } label: {
                            HStack(spacing: 6) {
                                Text("\(i + 1)").font(MMFont.number(11, .semibold)).foregroundStyle(on ? MMColor.edge : MMColor.ink3)
                                Text(flagEmoji(s.cc)).font(.system(size: 16))
                                Text(Int(s.value * 1e6).money(currency, compact: true)).font(MMFont.number(13, .regular)).mmNumeric()
                                    .foregroundStyle(on ? MMColor.edge : MMColor.ink)
                            }
                            .padding(.horizontal, 12).frame(height: 36)
                            .background { if on { Capsule().fill(MMColor.ink) } }
                            .mmGlass(in: Capsule(), interactive: true)
                        }
                        .buttonStyle(MMPressStyle(scale: 0.94))
                        .id(s.cc)
                        .accessibilityLabel(Text("\(GlobeData.name(s.cc)), \(Int(s.value * 1e6).money(currency))"))
                    }
                }
                .padding(.horizontal, 16)
            }
            .scrollIndicators(.hidden)
            .onChange(of: selected) { _, cc in
                guard let cc else { return }
                withAnimation(.snappy) { proxy.scrollTo(cc, anchor: .center) }
            }
        }
        .frame(height: 40)
    }

    // MARK: Zoom

    private var zoomControls: some View {
        VStack(spacing: 0) {
            Button { zoom(to: cam.targetScale * 1.5) } label: { Image(systemName: "plus").frame(width: 44, height: 44) }
                .accessibilityLabel(Text("Zoomer"))
            Rectangle().fill(MMColor.hairline).frame(width: 24, height: 1)
            Button { zoom(to: cam.targetScale / 1.5) } label: { Image(systemName: "minus").frame(width: 44, height: 44) }
                .accessibilityLabel(Text("Dézoomer"))
            Rectangle().fill(MMColor.hairline).frame(width: 24, height: 1)
            Button {
                deselect()
                cam.targetSpin = cam.spin + remainder(-0.35 - cam.spin, 2 * .pi); cam.targetTilt = 0.32
                zoom(to: 1)
            } label: { Image(systemName: "scope").frame(width: 44, height: 44) }
                .accessibilityLabel(Text("Recentrer"))
        }
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(MMColor.ink)
        .buttonStyle(MMPressStyle(scale: 0.9))
        .mmGlass(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .padding(.trailing, 16)
    }

    // MARK: Fiche du pays

    @ViewBuilder
    private func bottom(spots: [GlobeSpot], total: Double, maxHeight: CGFloat) -> some View {
        if let cc = selected, let s = spots.first(where: { $0.cc == cc }) {
            CountrySheet(cc: cc, spot: s, total: total, currency: currency, projects: projects,
                         feed: store.feed, apps: apps, expanded: $expanded,
                         onClose: { deselect() })
                .frame(maxHeight: expanded ? maxHeight : nil, alignment: .top)
                .offset(y: max(-40, sheetDrag) * (sheetDrag < 0 ? 0.3 : 1))
                .simultaneousGesture(
                    DragGesture(minimumDistance: 12)
                        .onChanged { v in if abs(v.translation.height) > abs(v.translation.width) { sheetDrag = v.translation.height } }
                        .onEnded { v in
                            let dy = v.predictedEndTranslation.height
                            withAnimation(.spring(response: 0.45, dampingFraction: 0.86)) {
                                sheetDrag = 0
                                if dy < -60 { expanded = true } else if dy > 80 { if expanded { expanded = false } else { deselect() } }
                            }
                        }
                )
                .padding(.horizontal, 10)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .id(cc)
        } else {
            HStack(spacing: 8) {
                Image(systemName: "hand.tap").font(.system(size: 13, weight: .semibold))
                Text(spots.contains { $0.value > 0 } ? "Touche un pays pour voir son détail" : "Tes premières ventes apparaîtront ici, pays par pays.")
                    .font(MMFont.system(13, .medium))
            }
            .foregroundStyle(MMColor.ink2)
            .padding(.horizontal, 16).frame(height: 44)
            .mmGlass(in: Capsule())
            .transition(.opacity.combined(with: .scale(scale: 0.9)))
        }
    }

    private func loadApps() async {
        let ids = projects.map(\.projectId).filter { apps[$0] == nil }
        guard !ids.isEmpty else { return }
        let client = store.client
        await withTaskGroup(of: (String, [TrackedAppSummary]).self) { g in
            for id in ids { g.addTask { (id, ((try? await client.trackedApps(projectId: id)) ?? []).filter { $0.own != false }) } }
            for await (id, list) in g { apps[id] = list }
        }
    }
}

// MARK: - Fiche

private struct CountrySheet: View {
    let cc: String
    let spot: GlobeSpot
    let total: Double
    let currency: String
    let projects: [ProjectSummary]
    let feed: [FeedEvent]
    let apps: [String: [TrackedAppSummary]]
    @Binding var expanded: Bool
    let onClose: () -> Void

    /// Filtrés une fois par mise à jour de la fiche (et non à chaque lecture dans le corps).
    private let events: [FeedEvent]
    private let sales: [FeedEvent]

    init(cc: String, spot: GlobeSpot, total: Double, currency: String, projects: [ProjectSummary],
         feed: [FeedEvent], apps: [String: [TrackedAppSummary]], expanded: Binding<Bool>, onClose: @escaping () -> Void) {
        self.cc = cc; self.spot = spot; self.total = total; self.currency = currency
        self.projects = projects; self.feed = feed; self.apps = apps
        self._expanded = expanded; self.onClose = onClose
        let ids = Set(projects.map(\.projectId))
        let ev = feed.filter { $0.country == cc && ids.contains($0.projectId) && $0.isSandbox != true }
        events = ev
        sales = ev.filter(\.isRevenue)
    }
    private var share: Double { spot.value / total }

    private var byProject: [(ProjectSummary, Int)] {
        projects.compactMap { p in p.revenueByCountry?[cc].flatMap { $0 > 0 ? (p, $0) : nil } }.sorted { $0.1 > $1.1 }
    }

    private var byProduct: [(String, Int, Int)] {
        Dictionary(grouping: sales) { $0.productId ?? "—" }
            .map { ($0.key, $0.value.count, $0.value.reduce(0) { $0 + ($1.shownMicros ?? 0) }) }
            .sorted { $0.1 == $1.1 ? $0.2 > $1.2 : $0.1 > $1.1 }
    }

    private var ranks: [(TrackedAppSummary, TrackedAppSummary.Top)] {
        apps.values.flatMap { $0 }.flatMap { app in
            (app.topRankings ?? []).filter { $0.cc.uppercased() == cc.uppercased() }.map { (app, $0) }
        }
        .sorted { $0.1.rank < $1.1.rank }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Capsule().fill(MMColor.ink3).frame(width: 36, height: 5)
                .frame(maxWidth: .infinity).padding(.top, 8).padding(.bottom, 10)
                .contentShape(Rectangle())
                .onTapGesture { withAnimation(.spring(response: 0.45, dampingFraction: 0.86)) { expanded.toggle() } }
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel(expanded ? Text("Réduire") : Text("Afficher le détail"))
            header.padding(.horizontal, 18)
            stats.padding(.horizontal, 18).padding(.top, 14).padding(.bottom, expanded ? 6 : 16)
            if expanded {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if !byProject.isEmpty { projectsSection }
                        if !byProduct.isEmpty { productsSection }
                        if !ranks.isEmpty { ranksSection }
                        feedSection
                    }
                    .padding(.horizontal, 18).padding(.vertical, 12)
                }
                .scrollIndicators(.hidden)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .mmGlass(in: RoundedRectangle(cornerRadius: 30, style: .continuous))
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text(flagEmoji(cc)).font(.system(size: 36))
            VStack(alignment: .leading, spacing: 2) {
                Text(GlobeData.name(cc)).font(MMFont.system(19, .semibold)).foregroundStyle(MMColor.ink).lineLimit(1)
                Text("\(share.formatted(.percent.precision(.fractionLength(0...1)))) du revenu")
                    .font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
            }
            Spacer(minLength: 8)
            Button {
                withAnimation(.spring(response: 0.45, dampingFraction: 0.86)) { expanded.toggle() }
            } label: {
                Image(systemName: expanded ? "chevron.down" : "chevron.up")
                    .font(.system(size: 13, weight: .bold)).foregroundStyle(MMColor.ink)
                    .frame(width: 34, height: 34).background(MMColor.cardFill, in: Circle())
            }
            .buttonStyle(MMPressStyle(scale: 0.9))
            .accessibilityLabel(expanded ? Text("Réduire") : Text("Afficher le détail"))
            Button(action: onClose) {
                Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).foregroundStyle(MMColor.ink2)
                    .frame(width: 34, height: 34).background(MMColor.cardFill, in: Circle())
            }
            .buttonStyle(MMPressStyle(scale: 0.9))
            .accessibilityLabel(Text("Fermer"))
        }
    }

    private var stats: some View {
        HStack(spacing: 8) {
            tile(Text("Revenu"), Text(Int(spot.value * 1e6).money(currency)))
            tile(Text("Ventes récentes"), Text(sales.count.formatted()))
            if let last = sales.first?.date ?? spot.lastSale {
                tile(Text("Dernière vente"), Text(last, format: .relative(presentation: .named)))
            } else {
                tile(Text("Part"), Text(share.formatted(.percent.precision(.fractionLength(0)))))
            }
        }
    }

    private func tile(_ label: Text, _ value: Text) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            label.font(MMFont.system(11)).foregroundStyle(MMColor.ink3).lineLimit(1)
            value.font(MMFont.number(17, .regular)).foregroundStyle(MMColor.ink).lineLimit(1).minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(MMColor.cardFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func section<C: View>(_ title: String, trailing: String? = nil, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            MMLabel(text: title, trailing: trailing)
            VStack(spacing: 0) { content() }
                .background(MMColor.cardFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
    }

    private func divider(_ i: Int) -> some View {
        Group { if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 14) } }
    }

    private var projectsSection: some View {
        let top = byProject.first?.1 ?? 1
        return section(String(localized: "Projets")) {
            ForEach(Array(byProject.prefix(6).enumerated()), id: \.element.0.projectId) { i, row in
                divider(i)
                HStack(spacing: 12) {
                    ProjectIcon(project: row.0, size: 30)
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(row.0.name).font(MMFont.system(14, .medium)).foregroundStyle(MMColor.ink).lineLimit(1)
                            Spacer()
                            Text(row.1.money(row.0.currency, compact: true)).font(MMFont.number(14, .regular)).foregroundStyle(MMColor.ink).mmNumeric()
                        }
                        GeometryReader { g in
                            Capsule().fill(MMColor.chartGradient).frame(width: max(4, g.size.width * Double(row.1) / Double(top)), height: 3)
                        }
                        .frame(height: 3)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
            }
        }
    }

    private var productsSection: some View {
        section(String(localized: "Produits"), trailing: String(localized: "ventes récentes")) {
            ForEach(Array(byProduct.prefix(5).enumerated()), id: \.element.0) { i, row in
                divider(i)
                HStack {
                    Text(row.0).font(MMFont.system(13, .medium)).foregroundStyle(MMColor.ink).lineLimit(1).truncationMode(.middle)
                    Spacer()
                    Text("\(row.1)×").font(MMFont.number(13, .medium)).foregroundStyle(MMColor.ink2)
                    Text(row.2.money(currency)).font(MMFont.number(14, .regular)).foregroundStyle(MMColor.ink).mmNumeric()
                }
                .padding(.horizontal, 14).padding(.vertical, 11)
            }
        }
    }

    private func chartName(_ t: TrackedAppSummary.Top) -> String {
        let c = t.chart.lowercased()
        let base = c.contains("gross") ? String(localized: "Revenus") : c.contains("paid") ? String(localized: "Payantes") : c.contains("free") ? String(localized: "Gratuites") : t.chart
        return t.scope == "genre" ? String(localized: "\(base) · Catégorie") : base
    }

    private var ranksSection: some View {
        section(String(localized: "Classement App Store")) {
            ForEach(Array(ranks.prefix(8).enumerated()), id: \.offset) { i, row in
                divider(i)
                HStack(spacing: 12) {
                    AsyncImage(url: row.0.icon.flatMap(URL.init(string:))) { img in img.resizable().scaledToFill() } placeholder: { MMColor.well }
                        .frame(width: 30, height: 30).clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.0.name ?? "App").font(MMFont.system(14, .medium)).foregroundStyle(MMColor.ink).lineLimit(1)
                        Text(chartName(row.1)).font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                    }
                    Spacer()
                    if let prev = row.1.prevRank, prev != row.1.rank {
                        let up = row.1.rank < prev
                        HStack(spacing: 2) {
                            Image(systemName: up ? "arrow.up" : "arrow.down").font(.system(size: 10, weight: .bold))
                            Text("\(abs(prev - row.1.rank))").font(MMFont.number(12, .medium))
                        }
                        .foregroundStyle(up ? MMColor.accent : MMColor.ink3)
                    }
                    Text("#\(row.1.rank)").font(MMFont.number(14, .semibold)).monospacedDigit().foregroundStyle(MMColor.ink)
                        .frame(minWidth: 40).padding(.vertical, 5)
                        .background(MMColor.cardFill, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
                .padding(.horizontal, 14).padding(.vertical, 9)
            }
        }
    }

    private var feedSection: some View {
        section(String(localized: "Activité récente"), trailing: events.isEmpty ? nil : "\(events.count)") {
            if events.isEmpty {
                Text("Aucune transaction récente depuis ce pays.").font(MMFont.system(13)).foregroundStyle(MMColor.ink2)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(14)
            }
            ForEach(Array(events.prefix(12).enumerated()), id: \.element.id) { i, e in
                divider(i)
                HStack(spacing: 12) {
                    Image(systemName: e.symbol).font(.system(size: 12, weight: .bold))
                        .foregroundStyle(e.isRevenue ? MMColor.accent : MMColor.ink2)
                        .frame(width: 30, height: 30).background(MMColor.cardFill, in: Circle())
                    VStack(alignment: .leading, spacing: 1) {
                        Text(e.title).font(MMFont.system(14, .medium)).foregroundStyle(MMColor.ink).lineLimit(1)
                        HStack(spacing: 4) {
                            if let n = e.projectName { Text(n).lineLimit(1); Text("·") }
                            Text(e.date, format: .relative(presentation: .named))
                        }
                        .font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                    }
                    Spacer()
                    if let p = e.shownMicros, p > 0 {
                        Text(p.money(e.shownCurrency ?? currency)).font(MMFont.number(14, .regular)).mmNumeric()
                            .foregroundStyle(e.isRevenue ? MMColor.ink : MMColor.ink3)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 9)
            }
        }
    }
}
