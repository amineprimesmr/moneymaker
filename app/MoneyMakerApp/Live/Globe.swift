//
//  Globe.swift
//  MoneyMaker — la planète des ventes.
//
//  Une sphère en points (terres Natural Earth, 4 237 points sur une spirale de
//  Fibonacci) qui tourne lentement. Chaque pays qui a rapporté de l'argent
//  porte un faisceau lumineux proportionnel à son revenu ; une vente reçue en
//  direct déclenche une onde qui s'étend depuis le pays. Glisser fait tourner
//  la planète avec de l'inertie, toucher un faisceau affiche le pays.
//
//  Coût : une seule Canvas, projection orthographique faite à la main, points
//  regroupés en 32 paliers d'opacité → ~34 remplissages par image quel que soit
//  le nombre de points, sans bandeaux visibles.
//

import SwiftUI
import UIKit

// MARK: - Données statiques

struct GeoPoint { let x, y, z: Double }

enum GlobeData {
    /// Points des terres, en vecteurs unitaires (lat/lng précalculés une fois).
    static let land: [GeoPoint] = {
        guard let url = Bundle.main.url(forResource: "land", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let flat = try? JSONDecoder().decode([Double].self, from: data) else { return [] }
        return stride(from: 0, to: flat.count - 1, by: 2).map { unit(lat: flat[$0], lng: flat[$0 + 1]) }
    }()

    struct Country: Decodable { let name: String; let lat: Double; let lng: Double }
    static let countries: [String: Country] = {
        guard let url = Bundle.main.url(forResource: "countries", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return [:] }
        return (try? JSONDecoder().decode([String: Country].self, from: data)) ?? [:]
    }()

    static func name(_ cc: String) -> String {
        Locale.current.localizedString(forRegionCode: cc) ?? countries[cc]?.name ?? cc
    }

    static func unit(lat: Double, lng: Double) -> GeoPoint {
        let la = lat * .pi / 180, lo = lng * .pi / 180
        return GeoPoint(x: cos(la) * sin(lo), y: sin(la), z: cos(la) * cos(lo))
    }
}

/// Un pays sur la planète : revenu (pour la hauteur du faisceau) et dernière vente (pour l'onde).
struct GlobeSpot: Identifiable, Hashable {
    let cc: String
    let value: Double
    let lastSale: Date?
    var id: String { cc }
}

// MARK: - Vue

struct GlobeView: View {
    var spots: [GlobeSpot]
    var interactive = true
    var highlight: String? = nil
    var onSelect: ((String?) -> Void)? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Moteur de rotation hors SwiftUI : le faire tourner ne recalcule pas la vue, seule la Canvas se redessine.
    @State private var motion = GlobeMotion()
    private var spin: Double { motion.spin }
    private let tilt = 0.32                  // rad — inclinaison fixe, penchée vers le nord
    @State private var dragStart: Double?
    /// nil = pas encore décidé ; false = geste vertical → laissé au défilement de la page.
    @State private var horizontalDrag: Bool?
    @State private var dragging = false
    @State private var haptics = GlobeHaptics()
    /// Chaleur de chaque point de terre, recalculée seulement quand les ventes changent.
    @State private var heat = GlobeHeat()

    var body: some View {
        // 60 i/s quand on la manipule ou qu'elle file sur sa lancée, 30 i/s en croisière lente.
        TimelineView(.animation(minimumInterval: dragging || abs(motion.velocity) > 0.3 ? 1.0 / 60 : 1.0 / 30, paused: (reduceMotion || ScrollActivity.shared.scrolling) && !dragging)) { tl in
            Canvas(rendersAsynchronously: true) { ctx, size in
                draw(&ctx, size: size, now: tl.date)
            }
        }
        .background { if !PerfProbe.isOff("atmo") { GlobeAtmosphere() } }
        .contentShape(Circle())
        .modifier(GlobeDragModifier(enabled: interactive, legacy: drag, changed: panChanged, ended: panEnded))
        .simultaneousGesture(interactive ? SpatialTapGesture().onEnded { tap($0.location) } : nil)
        .accessibilityElement()
        .accessibilityLabel("Planète des ventes : \(spots.filter { $0.value > 0 }.count) pays")
    }

    // MARK: Mouvement

    /// Avance la rotation — appelé depuis le dessin, sans toucher à l'état SwiftUI.
    private func advance(to now: Date) {
        let dt = min(0.05, now.timeIntervalSince(motion.lastTick))
        motion.lastTick = now
        guard !dragging else { return }
        // Rotation automatique douce + inertie qui retombe vers elle.
        let cruise = reduceMotion ? 0 : -0.09   // d'ouest en est, comme la Terre
        motion.velocity += (cruise - motion.velocity) * min(1, dt * 1.6)
        motion.spin += motion.velocity * dt
        // Crans pendant l'inertie, qui s'estompent avec la vitesse (rien pendant la croisière).
        if interactive, abs(motion.velocity) > 0.6 { haptics.rotated(to: motion.spin, speed: abs(motion.velocity)) }
    }

    /// Glissé horizontal (UIKit) : un geste vertical n'est jamais capté, la page défile normalement.
    private func panChanged(_ dx: CGFloat) {
        if dragStart == nil { dragStart = spin; dragging = true; haptics.grab() }
        let k = 0.0085
        motion.spin = dragStart! - dx * k
        haptics.rotated(to: spin, speed: 0)
    }

    private func panEnded(_ vx: CGFloat) {
        guard dragStart != nil else { return }
        motion.velocity = max(-6, min(6, -vx * 0.0085))
        dragStart = nil; dragging = false; motion.lastTick = .now
        haptics.release(speed: abs(motion.velocity))
    }

    /// Rotation uniquement autour de l'axe des pôles, sur 360°, sans fin. L'inclinaison reste fixe.
    /// Un geste plutôt vertical est ignoré pour laisser défiler la page.
    private var drag: some Gesture {
        DragGesture(minimumDistance: 6)
            .onChanged { v in
                if horizontalDrag == nil { horizontalDrag = abs(v.translation.width) > abs(v.translation.height) }
                guard horizontalDrag == true else { return }
                if dragStart == nil { dragStart = spin; dragging = true; haptics.grab() }
                let k = 0.0085
                motion.spin = dragStart! - v.translation.width * k   // la surface suit le doigt
                haptics.rotated(to: spin, speed: abs(v.velocity.width) * k)
            }
            .onEnded { v in
                defer { horizontalDrag = nil }
                guard horizontalDrag == true else { return }
                motion.velocity = max(-6, min(6, -v.velocity.width * 0.0085))
                dragStart = nil; dragging = false; motion.lastTick = .now
                haptics.release(speed: abs(motion.velocity))
            }
    }

    private func tap(_ p: CGPoint) {
        // Le pays visible le plus proche du doigt (rayon de 28 pt).
        guard let size = tapSize else { return }
        let best = spots.compactMap { s -> (String, CGFloat)? in
            guard let c = GlobeData.countries[s.cc], let q = project(GlobeData.unit(lat: c.lat, lng: c.lng), size: size), q.z > 0.1 else { return nil }
            return (s.cc, hypot(q.point.x - p.x, q.point.y - p.y))
        }.min { $0.1 < $1.1 }
        onSelect?(best.flatMap { $0.1 < 28 ? $0.0 : nil })
    }
    @State private var tapSize: CGSize?

    // MARK: Projection

    private func project(_ v: GeoPoint, size: CGSize, lift: Double = 1) -> GlobeProjected? {
        GlobeRender.project(cam: GlobeCamera(spin: spin, tilt: tilt), v, size: size, lift: lift)
    }

    // MARK: Dessin

    private func draw(_ ctx: inout GraphicsContext, size: CGSize, now: Date) {
        advance(to: now)
        if tapSize != size { DispatchQueue.main.async { tapSize = size } }
        GlobeRender.draw(&ctx, size: size, now: now, spots: spots, heat: heat.values(for: spots),
                         cam: GlobeCamera(spin: spin, tilt: tilt), highlight: highlight)
    }
}

// MARK: - Rendu partagé (Accueil et page Planète)

/// Caméra de la planète : rotation autour des pôles, inclinaison, et zoom (1 = taille de base).
struct GlobeCamera { var spin: Double; var tilt: Double; var scale: Double = 1 }
struct GlobeProjected { let point: CGPoint; let z: Double }

enum GlobeRender {
    static func radius(_ size: CGSize, _ cam: GlobeCamera) -> CGFloat {
        min(size.width, size.height) / 2 * 0.86 * cam.scale
    }

    static func project(cam: GlobeCamera, _ v: GeoPoint, size: CGSize, lift: Double = 1) -> GlobeProjected? {
        let r = radius(size, cam)
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        // Rotation autour de Y (spin) puis de X (tilt).
        let cs = cos(cam.spin), sn = sin(cam.spin)
        let x1 = v.x * cs - v.z * sn, z1 = v.x * sn + v.z * cs
        let ct = cos(cam.tilt), st = sin(cam.tilt)
        let y2 = v.y * ct - z1 * st, z2 = v.y * st + z1 * ct
        return GlobeProjected(point: CGPoint(x: c.x + x1 * r * lift, y: c.y - y2 * r * lift), z: z2)
    }

    static func draw(_ ctx: inout GraphicsContext, size: CGSize, now: Date, spots: [GlobeSpot], heat: [Double],
                     cam: GlobeCamera, highlight: String?) {
        let r = radius(size, cam)
        let c = CGPoint(x: size.width / 2, y: size.height / 2)

        // Disque sombre : la planète se détache de la lueur d'atmosphère posée derrière.
        ctx.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)),
                 with: .radialGradient(Gradient(colors: [GlobePalette.oceanTop, GlobePalette.oceanEdge]), center: CGPoint(x: c.x, y: c.y - r * 0.35),
                                       startRadius: 0, endRadius: r * 1.1))

        // Terres : opacité et taille continues selon la profondeur (32 paliers → aucun bandeau visible),
        // fondu vers le bord. Les points proches des ventes s'allument en vert, proportionnellement au volume.
        let levels = 32, hot = 6
        var buckets = [Path](repeating: Path(), count: levels)
        var heated = [Path](repeating: Path(), count: hot * 8)
        let dot = max(1.1, r / 150 / max(1, cam.scale.squareRoot()))
        let bounds = CGRect(origin: .zero, size: size).insetBy(dx: -8, dy: -8)
        let h = heat
        let hasHeat = h.count == GlobeData.land.count
        let clip = cam.scale > 1
        // Trigonométrie de la caméra calculée une fois par image (et non 4 237 fois) :
        // même projection que `project`, déroulée dans la boucle chaude.
        let cs = cos(cam.spin), sn = sin(cam.spin), ct = cos(cam.tilt), st = sin(cam.tilt)
        let land = GlobeData.land
        for i in land.indices {
            let v = land[i]
            let z1 = v.x * sn + v.z * cs
            let z = v.y * st + z1 * ct
            guard z > 0.02 else { continue }
            let x1 = v.x * cs - v.z * sn, y2 = v.y * ct - z1 * st
            let pt = CGPoint(x: c.x + x1 * r, y: c.y - y2 * r)
            if clip && !bounds.contains(pt) { continue }
            let depth = min(1, z)
            let w = hasHeat ? h[i] : 0
            let s = dot * (0.45 + 0.55 * sqrt(depth)) * (1 + 0.45 * w)
            let rect = CGRect(x: pt.x - s, y: pt.y - s, width: s * 2, height: s * 2)
            if w > 0.04 {
                heated[min(hot - 1, Int(w * Double(hot))) * 8 + min(7, Int(depth * 8))].addEllipse(in: rect)
            } else {
                buckets[min(levels - 1, Int(depth * Double(levels)))].addEllipse(in: rect)
            }
        }
        for (i, path) in buckets.enumerated() where !path.isEmpty {
            let depth = (Double(i) + 0.5) / Double(levels)
            let edge = min(1, depth / 0.22)            // 0 au bord → 1 dès 22 % de profondeur
            ctx.fill(path, with: .color(GlobePalette.land.opacity((0.10 + 0.40 * depth) * edge * edge)))
        }
        for (i, path) in heated.enumerated() where !path.isEmpty {
            let w = (Double(i / 8) + 0.5) / Double(hot), depth = (Double(i % 8) + 0.5) / 8
            let edge = min(1, depth / 0.22)
            ctx.fill(path, with: .color(MMColor.accent.opacity((0.30 + 0.70 * w) * (0.35 + 0.65 * depth) * edge * edge)))
        }

        // Faisceaux des pays (derrière → devant pour un empilement correct).
        let maxV = max(spots.map(\.value).max() ?? 1, 0.0001)
        let t = now.timeIntervalSinceReferenceDate
        let placed = spots.compactMap { s -> (GlobeSpot, GeoPoint, GlobeProjected)? in
            guard s.value > 0, let co = GlobeData.countries[s.cc] else { return nil }
            let g = GlobeData.unit(lat: co.lat, lng: co.lng)
            guard let q = project(cam: cam, g, size: size), q.z > -0.05 else { return nil }
            return (s, g, q)
        }.sorted { $0.2.z < $1.2.z }

        for (s, g, base) in placed {
            // Linéaire : un pays qui vend deux fois plus a un faisceau deux fois plus haut.
            let norm = s.value / maxV
            let fade = max(0, min(1, base.z * 3))
            let selected = s.cc == highlight
            let lift = 1 + 0.04 + 0.34 * norm + (selected ? 0.06 : 0)
            guard let top = project(cam: cam, g, size: size, lift: lift) else { continue }
            var beam = Path(); beam.move(to: base.point); beam.addLine(to: top.point)
            let tint = selected ? MMColor.ink : MMColor.accent
            ctx.stroke(beam, with: .linearGradient(Gradient(colors: [tint.opacity(0.95 * fade), tint.opacity(0.05 * fade)]),
                                                   startPoint: base.point, endPoint: top.point),
                       style: StrokeStyle(lineWidth: 1.5 + 3 * norm, lineCap: .round))
            // Base lumineuse.
            let gr = 3 + 7 * norm
            ctx.fill(Path(ellipseIn: CGRect(x: base.point.x - gr, y: base.point.y - gr, width: gr * 2, height: gr * 2)),
                     with: .radialGradient(Gradient(colors: [tint.opacity(0.9 * fade), tint.opacity(0)]), center: base.point, startRadius: 0, endRadius: gr))
            ctx.fill(Path(ellipseIn: CGRect(x: top.point.x - 2, y: top.point.y - 2, width: 4, height: 4)), with: .color(MMColor.ink.opacity(0.9 * fade)))

            // Vente récente (< 10 min) : la base du faisceau respire doucement, sans anneau.
            if let last = s.lastSale, now.timeIntervalSince(last) < 600, fade > 0 {
                let breath = 0.5 + 0.5 * sin(t * 3)
                let pr = gr * (1.4 + 0.8 * breath)
                ctx.fill(Path(ellipseIn: CGRect(x: base.point.x - pr, y: base.point.y - pr, width: pr * 2, height: pr * 2)),
                         with: .radialGradient(Gradient(colors: [MMColor.accent.opacity(0.55 * fade * (0.6 + 0.4 * breath)), MMColor.accent.opacity(0)]),
                                               center: base.point, startRadius: 0, endRadius: pr))
            }
        }
    }
}

// MARK: - Données de la planète depuis le Store

extension Store {
    /// Revenu par pays (toutes les apps) + horodatage de la dernière vente vue en direct.
    var globeSpots: [GlobeSpot] { globeSpots(for: viewProjects) }

    /// Ventes par pays d'un ensemble de business (un seul quand un projet est choisi sous la planète).
    func globeSpots(for projects: [ProjectSummary]) -> [GlobeSpot] {
        let ids = Set(projects.map(\.projectId))
        var byCountry: [String: Double] = [:]
        for p in projects {
            for (cc, v) in p.revenueByCountry ?? [:] where cc != "??" { byCountry[cc, default: 0] += Double(v) / 1e6 }
        }
        var last: [String: Date] = [:]
        for e in feed where e.isRevenue && ids.contains(e.projectId) { if let cc = e.country, last[cc] == nil { last[cc] = e.date } }
        for cc in last.keys where byCountry[cc] == nil { byCountry[cc] = 0.0001 }
        return byCountry.map { GlobeSpot(cc: $0.key, value: $0.value, lastSale: last[$0.key]) }
    }
}

// MARK: - Carte d'accueil

struct GlobeCard: View {
    @EnvironmentObject var store: Store
    var body: some View {
        let spots = store.globeSpots
        let top = spots.sorted { $0.value > $1.value }.prefix(3)
        let cur = store.overview?.currency ?? "EUR"
        NavigationLink(value: Router.Destination.globe) {
            MMCard(padding: 0, glow: MMColor.accent) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        MMLabel(text: String(localized: "Ventes dans le monde"), trailing: String(localized: "\(spots.filter { $0.value >= 0.01 }.count) pays"))
                    }
                    .padding([.horizontal, .top], 20)
                    GlobeView(spots: spots, interactive: false).frame(height: 260).padding(.vertical, 4)
                    HStack(spacing: 8) {
                        ForEach(Array(top), id: \.cc) { s in
                            HStack(spacing: 6) {
                                Text(flagEmoji(s.cc))
                                Text(Int(s.value * 1e6).money(cur, compact: true)).font(MMFont.number(13, .regular)).lineLimit(1).mmNumeric()
                            }
                            .padding(.horizontal, 10).padding(.vertical, 7)
                            .background(MMColor.fg(0.06), in: Capsule())
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "arrow.up.left.and.arrow.down.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(MMColor.ink3)
                    }
                    .padding([.horizontal, .bottom], 18)
                }
            }
        }
        .buttonStyle(MMPressStyle(scale: 0.985))
    }
}

// MARK: - Écran plein

/// Planète des ventes + classement des pays, posée sous les cartes de l'Accueil.
private struct OnScreen: ViewModifier {
    @Binding var visible: Bool
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollVisibilityChange(threshold: 0.05) { visible = $0 }
        } else {
            content
        }
    }
}

struct GlobeSection: View {
    @EnvironmentObject var store: Store
    /// L'Accueil reste monté sur les autres onglets : la planète (60 i/s) ne tourne que s'il est visible.
    @Environment(\.mmTabVisible) private var tabVisible
    /// Faux tant que la planète est hors de l'écran (cartes en haut de l'Accueil) : elle ne tourne pas.
    @State private var onScreen = true
    @State private var selected: String?
    @State private var globeIn = false
    /// Projet choisi sous la planète : planète et classement ne montrent alors que lui.
    @State private var picked: String?

    var body: some View {
        let pickedProject = picked.flatMap { id in store.overview?.projects.first { $0.projectId == id } }
        let spots = pickedProject.map { store.globeSpots(for: [$0]) } ?? store.globeSpots
        let cur = pickedProject?.currency ?? store.overview?.currency ?? "EUR"
        let total = max(spots.reduce(0) { $0 + $1.value }, 0.0001)
        let ranked = spots.filter { $0.value >= 0.01 }.sorted { $0.value > $1.value }
            VStack(alignment: .leading, spacing: 16) {
                ZStack(alignment: .bottom) {
                    if tabVisible && onScreen { GlobeView(spots: spots, highlight: selected) { cc in
                        // Toucher la planète ouvre la page Planète, centrée sur le pays touché.
                        GlobeExplorerHandoff.open(project: picked, country: cc ?? selected)
                    }
                    .frame(height: 380)
                    .modifier(GlobeZoomSource())
                    .sensoryFeedback(.selection, trigger: selected)
                    .scaleEffect(globeIn ? 1 : 0.86)
                    .opacity(globeIn ? 1 : 0)
                    .onAppear { withAnimation(.spring(response: 0.8, dampingFraction: 0.85).delay(0.05)) { globeIn = true } }
                    } else { Color.clear.frame(height: 380) }
                    if let cc = selected, let s = spots.first(where: { $0.cc == cc }) {
                        HStack(spacing: 10) {
                            Text(flagEmoji(cc)).font(.system(size: 22))
                            VStack(alignment: .leading, spacing: 1) {
                                Text(GlobeData.name(cc)).font(MMFont.system(14, .medium))
                                Text("\((s.value / total).formatted(.percent.precision(.fractionLength(0)))) du revenu").font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                            }
                            Spacer()
                            Text(Int(s.value * 1e6).money(cur)).font(MMFont.number(18, .regular)).mmNumeric()
                        }
                        .padding(.horizontal, 16).padding(.vertical, 12)
                        .mmGlass(in: Capsule())
                        .padding(.horizontal, 8)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
                .modifier(OnScreen(visible: $onScreen))
                .onChange(of: picked) { _, _ in withAnimation(.snappy) { selected = nil } }
                .animation(.smooth(duration: 0.5), value: picked)
                ProjectPicker(projects: store.overview?.projects ?? [], selected: $picked)
                MMLabel(text: String(localized: "Classement"), trailing: pickedProject?.name).padding(.horizontal, 4).mmAppear(2)
                MMCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(Array(ranked.prefix(20).enumerated()), id: \.element.cc) { i, s in
                            if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 52) }
                            Button { withAnimation(.snappy) { selected = s.cc } } label: {
                                HStack(spacing: 12) {
                                    Text(flagEmoji(s.cc)).font(.system(size: 20)).frame(width: 26)
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack {
                                            Text(GlobeData.name(s.cc)).font(MMFont.system(14, .medium)).lineLimit(1)
                                            Spacer()
                                            Text(Int(s.value * 1e6).money(cur, compact: true)).font(MMFont.number(14, .regular)).mmNumeric()
                                        }
                                        GeometryReader { g in
                                            Capsule().fill(MMColor.chartGradient)
                                                .frame(width: max(4, g.size.width * s.value / (ranked.first?.value ?? 1)), height: 3)
                                        }
                                        .frame(height: 3)
                                    }
                                }
                                .padding(.horizontal, 16).padding(.vertical, 11)
                                .background(selected == s.cc ? MMColor.fg(0.05) : .clear)
                            }
                            .buttonStyle(.plain)
                        }
                        if ranked.isEmpty {
                            Text("Tes premières ventes apparaîtront ici, pays par pays.").font(MMFont.system(14)).foregroundStyle(MMColor.ink2).padding(18)
                        }
                    }
                }
            }
    }
}

// MARK: - Chaleur des ventes

/// Pour chaque point de terre : somme des ventes des pays voisins (noyau gaussien de ~9°),
/// normalisée de 0 à 1. Calculé une fois par jeu de ventes, jamais pendant l'animation.
final class GlobeHeat {
    private var last: [GlobeSpot]?
    private var key: [String: Double] = [:]
    private var cache: [Double] = []

    /// Appelé à chaque image : comparaison directe du tableau (aucune allocation) avant toute
    /// comparaison par pays ; le noyau gaussien ne tourne que si les montants changent vraiment.
    func values(for spots: [GlobeSpot]) -> [Double] {
        if let last, last == spots { return cache }
        last = spots
        var k: [String: Double] = [:]
        for s in spots { k[s.cc] = s.value }
        if k == key { return cache }
        key = k
        let maxV = spots.map(\.value).max() ?? 0
        guard maxV > 0 else { cache = []; return cache }
        let sources = spots.compactMap { s -> (GeoPoint, Double)? in
            guard s.value > 0, let c = GlobeData.countries[s.cc] else { return nil }
            return (GlobeData.unit(lat: c.lat, lng: c.lng), s.value / maxV)
        }
        let spread = 2 * 0.16 * 0.16             // ~9° d'arc
        var out = GlobeData.land.map { p -> Double in
            sources.reduce(0) { acc, src in
                let d = p.x * src.0.x + p.y * src.0.y + p.z * src.0.z
                guard d > 0.9 else { return acc }      // au-delà de ~25° : rien
                let a = acos(min(1, d))
                return acc + src.1 * exp(-a * a / spread)
            }
        }
        let top = out.max() ?? 0
        if top > 0 { out = out.map { min(1, $0 / top) } }
        cache = out
        return cache
    }
}

// MARK: - Atmosphère

/// Couleurs de la planète, adaptées au mode clair (océan gris perle, terres ardoise).
enum GlobePalette {
    static let oceanTop = MMColor.dyn(light: UIColor(red: 0.985, green: 0.988, blue: 1.0, alpha: 1), dark: UIColor(white: 0.035, alpha: 1))
    static let oceanEdge = MMColor.dyn(light: UIColor(red: 0.875, green: 0.890, blue: 0.930, alpha: 1), dark: .black)
    static let land = MMColor.dyn(light: UIColor(red: 0.20, green: 0.24, blue: 0.36, alpha: 1), dark: .white)
}

private enum GlowTint {
    static let violet = Color(red: 0.42, green: 0.36, blue: 0.95)      // #6B5CF2
    static let indigo = Color(red: 0.30, green: 0.30, blue: 0.78)      // #4D4DC7
    static let lavender = Color(red: 0.80, green: 0.78, blue: 1.00)    // #CCC7FF
}

/// Halo violet irrégulier autour de la planète : trois nappes floues décalées, de tailles
/// différentes, qui dérivent et respirent très lentement (cycles de 11 à 17 s, déphasés).
/// Chaque nappe est floutée une seule fois (drawingGroup) ; seules leur rotation, leur
/// échelle et leur opacité s'animent, ce qui ne recalcule jamais le flou.
struct GlobeAtmosphere: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var scale

    var body: some View {
        GeometryReader { g in
            let d = min(g.size.width, g.size.height) * 0.86
            ZStack {
                // Halo plus discret mais plus vivant : les nappes tournent, respirent et glissent
                // autour de la planète. Animé par Core Animation (serveur de rendu) : aucun coût
                // pour l'app, même à 120 Hz pendant le défilement.
                HaloLayers(d: d, scale: min(scale, 2), animated: !reduceMotion)
                    .frame(width: g.size.width, height: g.size.height)
                // Liseré du limbe : fin, plus vif en haut, qui s'éteint vers le bas.
                Circle().strokeBorder(LinearGradient(colors: [GlowTint.lavender.opacity(0.9), GlowTint.violet.opacity(0.35), .clear],
                                                     startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.45)), lineWidth: 1.2)
                    .frame(width: d * 1.004, height: d * 1.004)
                    .blur(radius: 0.7)
            }
            .frame(width: g.size.width, height: g.size.height)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Les trois nappes du halo en CALayer : image floutée rendue une fois, puis rotation, échelle,
/// position et opacité animées en boucle par Core Animation.
private struct HaloLayers: UIViewRepresentable {
    let d: CGFloat, scale: CGFloat, animated: Bool

    struct Spec { let color: Color; let w, h, x, y, blur: CGFloat; let opacity: Double
        let rot: (Double, Double); let sc: (CGFloat, CGFloat); let dx: (CGFloat, CGFloat); let dy: (CGFloat, CGFloat)
        let fade: (Float, Float); let period: Double }
    static let specs: [Spec] = [
        .init(color: GlowTint.violet, w: 1.30, h: 1.18, x: -0.06, y: -0.05, blur: 0.16, opacity: 0.22,
              rot: (-18, 22), sc: (0.94, 1.09), dx: (-0.04, 0.05), dy: (0.03, -0.03), fade: (1, 1), period: 6.5),
        .init(color: GlowTint.indigo, w: 1.18, h: 1.32, x: 0.08, y: 0.04, blur: 0.18, opacity: 0.18,
              rot: (16, -26), sc: (1.1, 0.93), dx: (0.04, -0.05), dy: (-0.02, 0.04), fade: (1, 1), period: 8.5),
        .init(color: GlowTint.lavender, w: 1.08, h: 1.02, x: 0, y: -0.10, blur: 0.10, opacity: 0.10,
              rot: (0, 0), sc: (0.98, 1.04), dx: (0, 0), dy: (0, 0), fade: (0.45, 1), period: 4.5),
    ]

    final class V: UIView {
        var key = ""
        override func layoutSubviews() { super.layoutSubviews(); onLayout?() }
        var onLayout: (() -> Void)?
    }

    func makeUIView(context: Context) -> V { let v = V(); v.isUserInteractionEnabled = false; v.backgroundColor = .clear; return v }

    func updateUIView(_ v: V, context: Context) {
        let k = "\(Int(d))-\(animated)"
        v.onLayout = { [weak v] in guard let v else { return }; build(v, key: k) }
        build(v, key: k)
    }

    @MainActor private func build(_ v: V, key: String) {
        guard v.bounds.width > 0, d > 0, v.key != key || v.layer.sublayers?.isEmpty != false else {
            // Re-centre seulement si la taille a changé.
            v.layer.sublayers?.enumerated().forEach { i, l in
                let s = Self.specs[i]; l.position = CGPoint(x: v.bounds.midX + d * s.x, y: v.bounds.midY + d * s.y) }
            return
        }
        v.key = key
        v.layer.sublayers?.forEach { $0.removeFromSuperlayer() }
        for s in Self.specs {
            let pad = d * s.blur * 2.2
            let size = CGSize(width: d * s.w + pad * 2, height: d * s.h + pad * 2)
            let r = ImageRenderer(content: Ellipse()
                .fill(RadialGradient(colors: [s.color.opacity(s.opacity), s.color.opacity(s.opacity * 0.35), .clear],
                                     center: .center, startRadius: d * 0.30, endRadius: d * 0.62))
                .frame(width: d * s.w, height: d * s.h)
                .blur(radius: d * s.blur)
                .frame(width: size.width, height: size.height))
            r.scale = scale
            let l = CALayer()
            l.contents = r.cgImage
            l.bounds = CGRect(origin: .zero, size: size)
            l.position = CGPoint(x: v.bounds.midX + d * s.x, y: v.bounds.midY + d * s.y)
            v.layer.addSublayer(l)
            guard animated else { continue }
            func anim(_ path: String, _ from: Any, _ to: Any) {
                let a = CABasicAnimation(keyPath: path)
                a.fromValue = from; a.toValue = to; a.duration = s.period; a.autoreverses = true
                a.repeatCount = .infinity; a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                a.isRemovedOnCompletion = false
                l.add(a, forKey: path)
            }
            anim("transform.rotation.z", s.rot.0 * .pi / 180, s.rot.1 * .pi / 180)
            anim("transform.scale", s.sc.0, s.sc.1)
            anim("transform.translation.x", d * s.dx.0, d * s.dx.1)
            anim("transform.translation.y", d * s.dy.0, d * s.dy.1)
            if s.fade.0 != s.fade.1 { anim("opacity", s.fade.0, s.fade.1) }
        }
    }
}

// MARK: - Horizon

/// Trait d'horizon derrière la planète, comme un lever de soleil vu de l'orbite :
/// une ligne très fine, blanche au centre, qui s'éteint vers les bords ; au-dessus, un
/// éventail de lumière lavande → violet qui monte et se dissout ; en dessous, le noir.
/// Rendu une fois ; seule l'intensité de l'éventail respire, très lentement.
struct HorizonGlow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathe = false

    var body: some View {
        GeometryReader { g in
            let w = g.size.width, h = g.size.height
            ZStack(alignment: .bottom) {
                // Éventail large et diffus (les bords violets de l'image).
                Ellipse()
                    .fill(RadialGradient(colors: [GlowTint.violet.opacity(0.55), GlowTint.indigo.opacity(0.22), .clear],
                                         center: .center, startRadius: 0, endRadius: w * 0.55))
                    .frame(width: w * 1.25, height: h * 1.7)
                    .offset(y: h * 0.85)
                    .blur(radius: 30)
                // Cœur lumineux, plus étroit et plus clair.
                Ellipse()
                    .fill(RadialGradient(colors: [.white.opacity(0.95), GlowTint.lavender.opacity(0.75), GlowTint.violet.opacity(0.25), .clear],
                                         center: .center, startRadius: 0, endRadius: w * 0.30))
                    .frame(width: w * 0.75, height: h * 0.9)
                    .offset(y: h * 0.45)
                    .blur(radius: 14)
                    .opacity(breathe ? 1 : 0.82)
                    .animation(reduceMotion ? nil : .easeInOut(duration: 6).repeatForever(autoreverses: true), value: breathe)
            }
            .frame(width: w, height: h)
            // Tout ce qui est sous la ligne est coupé : le « sol » reste noir.
            .mask(Rectangle().frame(height: h).frame(maxHeight: .infinity, alignment: .top))
            .overlay(alignment: .bottom) {
                ZStack {
                    // Bavure douce de la ligne.
                    Capsule().fill(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: GlowTint.lavender.opacity(0.7), location: 0.3),
                                                          .init(color: .white, location: 0.5), .init(color: GlowTint.lavender.opacity(0.7), location: 0.7),
                                                          .init(color: .clear, location: 1)], startPoint: .leading, endPoint: .trailing))
                        .frame(height: 5).blur(radius: 4)
                    // Le trait lui-même, net.
                    Capsule().fill(LinearGradient(stops: [.init(color: .clear, location: 0.02), .init(color: GlowTint.lavender.opacity(0.55), location: 0.2),
                                                          .init(color: .white, location: 0.5), .init(color: GlowTint.lavender.opacity(0.55), location: 0.8),
                                                          .init(color: .clear, location: 0.98)], startPoint: .leading, endPoint: .trailing))
                        .frame(height: 1.2)
                }
                .offset(y: 0.6)
            }
            .drawingGroup()
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { if !reduceMotion { breathe = true } }
    }
}

// MARK: - Moteur de rotation

/// État de rotation mutable hors du système de mise à jour de SwiftUI.
final class GlobeMotion {
    var spin = -0.35          // rad — Europe/Afrique de face au départ
    var velocity = 0.0
    var lastTick = Date()
}

// MARK: - Retours haptiques

/// Crans façon molette : un tick tous les 10° de rotation, plus net quand on tourne vite,
/// limité à ~28 par seconde pour rester précis sans bourdonner.
final class GlobeHaptics {
    private let tick = UISelectionFeedbackGenerator()
    private let soft = UIImpactFeedbackGenerator(style: .soft)
    private let rigid = UIImpactFeedbackGenerator(style: .rigid)
    private var lastDetent: Int?
    private var lastAt = Date.distantPast
    private let step = 10.0 * .pi / 180

    func grab() {
        soft.prepare(); tick.prepare(); rigid.prepare()
        soft.impactOccurred(intensity: 0.55)
        lastDetent = nil
    }

    func rotated(to angle: Double, speed: Double) {
        let detent = Int((angle / step).rounded(.down))
        defer { lastDetent = detent }
        guard let last = lastDetent, last != detent else { return }
        let now = Date()
        guard now.timeIntervalSince(lastAt) > 0.035 else { return }
        lastAt = now
        if speed > 2.5 { rigid.impactOccurred(intensity: min(1, 0.35 + speed / 12)) } else { tick.selectionChanged() }
        tick.prepare()
    }

    func release(speed: Double) {
        if speed > 1 { soft.impactOccurred(intensity: min(1, 0.4 + speed / 8)) }
        lastDetent = nil
    }
}


// MARK: - Projets sous la planète

/// Un bouton par projet : le choisir affiche, ici même dans l'Accueil, le classement App Store
/// de son app (rang, pays, étoiles, notes). Les ventes restent dans les cartes au-dessus.
struct ProjectPicker: View {
    let projects: [ProjectSummary]
    @EnvironmentObject var store: Store
    @Binding var selected: String?
    @State private var apps: [String: [TrackedAppSummary]] = [:]

    var body: some View {
        if !projects.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                MMLabel(text: String(localized: "Projets"), trailing: "\(projects.count)").padding(.horizontal, 4)
                ScrollView(.horizontal) {
                    HStack(spacing: 10) {
                        ForEach(projects) { p in
                            let on = selected == p.projectId
                            Button {
                                withAnimation(.snappy) { selected = on ? nil : p.projectId }
                            } label: {
                                // Juste le logo, dans un bouton Liquid Glass ; le choisi s'allume d'un liseré.
                                ProjectIcon(project: p, size: 36)
                                    .padding(7)
                                    .mmGlass(in: Circle(), interactive: true)
                                    .overlay { Circle().strokeBorder(on ? MMColor.fg(0.7) : .clear, lineWidth: 1.5) }
                                    .scaleEffect(on ? 1.06 : 1)
                                    .opacity(selected == nil || on ? 1 : 0.55)
                                    .animation(.snappy, value: on)
                            }
                            .accessibilityLabel(Text(p.name))
                            .buttonStyle(MMPressStyle(scale: 0.96))
                        }
                    }
                    .padding(.horizontal, 2).padding(.vertical, 4)
                }
                .scrollIndicators(.hidden)
                .scrollClipDisabled()
                if let id = selected {
                    Group {
                        if let list = apps[id] {
                            if list.isEmpty {
                                MMCard { Text("Aucune app App Store suivie pour ce projet.").font(MMFont.system(14)).foregroundStyle(MMColor.ink2) }
                            } else {
                                ForEach(list) { TrackedAppCard(app: $0) }
                            }
                        } else {
                            ProgressView().frame(maxWidth: .infinity).padding(20)
                        }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                    .task(id: id) {
                        guard apps[id] == nil else { return }
                        let list = (try? await store.client.trackedApps(projectId: id)) ?? []
                        withAnimation(.snappy) { apps[id] = list.filter { $0.own != false } }
                    }
                }
            }
        }
    }
}

/// Logos des sources de revenus connectées (App Store, Stripe, Google Play…).
struct StoreBadges: View {
    let stores: [String]
    var size: CGFloat = 11
    var body: some View {
        HStack(spacing: 6) {
            ForEach(PlatformMark.primary(stores), id: \.self) { s in
                HStack(spacing: 3) {
                    switch s {
                    case "app_store": Image(systemName: "apple.logo"); Text("App Store")
                    case "stripe": Text("S").font(.system(size: size, weight: .heavy)).foregroundStyle(Color(red: 0.39, green: 0.36, blue: 1)); Text("Stripe")
                    case "play_store": Image(systemName: "play.fill").foregroundStyle(MMColor.accent); Text("Google Play")
                    default: Image(systemName: "link"); Text(s.replacingOccurrences(of: "_", with: " ").capitalized)
                    }
                }
                .font(.system(size: size, weight: .medium))
                .foregroundStyle(MMColor.ink2)
            }
        }
        .lineLimit(1)
    }
}


// MARK: - Geste de la planète

/// iOS 18+ : un pan UIKit qui ne démarre que si le doigt part à l'horizontale, sinon le défilement
/// de la page le garde (le DragGesture SwiftUI simultané bloquait le scroll parti de la planète).
private struct GlobeDragModifier<G: Gesture>: ViewModifier {
    let enabled: Bool
    let legacy: G
    let changed: (CGFloat) -> Void
    let ended: (CGFloat) -> Void
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.gesture(GlobePan(enabled: enabled, changed: changed, ended: ended))
        } else {
            content.simultaneousGesture(enabled ? legacy : nil)
        }
    }
}

@available(iOS 18.0, *)
private struct GlobePan: UIGestureRecognizerRepresentable {
    var enabled: Bool
    var changed: (CGFloat) -> Void
    var ended: (CGFloat) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let g = UIPanGestureRecognizer()
        g.maximumNumberOfTouches = 1
        g.delegate = context.coordinator
        return g
    }
    func updateUIGestureRecognizer(_ g: UIPanGestureRecognizer, context: Context) { g.isEnabled = enabled }
    func handleUIGestureRecognizerAction(_ g: UIPanGestureRecognizer, context: Context) {
        switch g.state {
        case .began, .changed: changed(g.translation(in: g.view).x)
        case .ended, .cancelled, .failed: ended(g.velocity(in: g.view).x)
        default: break
        }
    }
    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard let pan = g as? UIPanGestureRecognizer else { return true }
            let v = pan.velocity(in: pan.view)
            return abs(v.x) > abs(v.y) * 1.2
        }
        // Le menu latéral attend que la planète renonce : tourner la planète n'ouvre pas le menu.
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            !(other.view is UIScrollView)
        }
    }
}


/// Logo de la plateforme d'un business : la pomme pour une app (même si Stripe est aussi branché),
/// le « S » Stripe pour un business web.
struct PlatformMark: View {
    let stores: [String]
    var size: CGFloat = 24

    /// App Store prioritaire : une app n'affiche que la pomme.
    static func primary(_ stores: [String]) -> [String] {
        if stores.contains("app_store") { return ["app_store"] }
        if stores.contains("play_store") { return ["play_store"] }
        return stores.contains("stripe") ? ["stripe"] : Array(stores.prefix(1))
    }

    var body: some View {
        switch Self.primary(stores).first {
        case "app_store":
            Image(systemName: "apple.logo").font(.system(size: size * 0.52, weight: .semibold)).foregroundStyle(.black)
                .frame(width: size, height: size).background(.white, in: Circle())
        case "stripe":
            Text("S").font(.system(size: size * 0.56, weight: .heavy)).foregroundStyle(.white)
                .frame(width: size, height: size).background(Color(red: 0.39, green: 0.36, blue: 1), in: Circle())
        case "play_store":
            Image(systemName: "play.fill").font(.system(size: size * 0.42, weight: .bold)).foregroundStyle(.white)
                .frame(width: size, height: size).background(Color(red: 0.2, green: 0.7, blue: 0.4), in: Circle())
        default:
            EmptyView()
        }
    }
}
