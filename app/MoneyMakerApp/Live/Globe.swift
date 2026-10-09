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
//  regroupés en 6 niveaux d'opacité → ~8 remplissages par image quel que soit
//  le nombre de points (même principe que le champ d'étoiles de V2).
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
    @State private var spin = -0.35          // rad — Europe/Afrique de face au départ
    private let tilt = 0.32                  // rad — inclinaison fixe, penchée vers le nord
    @State private var velocity = 0.0
    @State private var dragStart: Double?
    /// nil = pas encore décidé ; false = geste vertical → laissé au défilement de la page.
    @State private var horizontalDrag: Bool?
    @State private var lastTick = Date()
    @State private var dragging = false
    @State private var haptics = GlobeHaptics()

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: reduceMotion && !dragging)) { tl in
            Canvas(rendersAsynchronously: true) { ctx, size in
                draw(&ctx, size: size, now: tl.date)
            }
            .onChange(of: tl.date) { _, now in advance(to: now) }
        }
        .contentShape(Circle())
        .simultaneousGesture(interactive ? drag : nil)
        .simultaneousGesture(interactive ? SpatialTapGesture().onEnded { tap($0.location) } : nil)
        .accessibilityElement()
        .accessibilityLabel("Planète des ventes : \(spots.filter { $0.value > 0 }.count) pays")
    }

    // MARK: Mouvement

    private func advance(to now: Date) {
        let dt = min(0.05, now.timeIntervalSince(lastTick))
        lastTick = now
        guard !dragging else { return }
        // Rotation automatique douce + inertie qui retombe vers elle.
        let cruise = reduceMotion ? 0 : 0.09
        velocity += (cruise - velocity) * min(1, dt * 1.6)
        spin += velocity * dt
        // Crans pendant l'inertie, qui s'estompent avec la vitesse (rien pendant la croisière).
        if interactive, abs(velocity) > 0.6 { haptics.rotated(to: spin, speed: abs(velocity)) }
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
                spin = dragStart! + v.translation.width * k
                haptics.rotated(to: spin, speed: abs(v.velocity.width) * k)
            }
            .onEnded { v in
                defer { horizontalDrag = nil }
                guard horizontalDrag == true else { return }
                velocity = max(-6, min(6, v.velocity.width * 0.0085))
                dragStart = nil; dragging = false; lastTick = .now
                haptics.release(speed: abs(velocity))
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

    private struct Projected { let point: CGPoint; let z: Double }

    private func project(_ v: GeoPoint, size: CGSize, lift: Double = 1) -> Projected? {
        let r = min(size.width, size.height) / 2 * 0.86
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        // Rotation autour de Y (spin) puis de X (tilt).
        let cs = cos(spin), sn = sin(spin)
        let x1 = v.x * cs - v.z * sn, z1 = v.x * sn + v.z * cs
        let ct = cos(tilt), st = sin(tilt)
        let y2 = v.y * ct - z1 * st, z2 = v.y * st + z1 * ct
        return Projected(point: CGPoint(x: c.x + x1 * r * lift, y: c.y - y2 * r * lift), z: z2)
    }

    // MARK: Dessin

    private func draw(_ ctx: inout GraphicsContext, size: CGSize, now: Date) {
        if tapSize != size { DispatchQueue.main.async { tapSize = size } }
        let r = min(size.width, size.height) / 2 * 0.86
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        let disc = Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))

        // Corps de la planète : sombre, éclairé en haut à gauche.
        ctx.fill(disc, with: .radialGradient(Gradient(colors: [Color(white: 0.13), Color(white: 0.04), .black]),
                                             center: CGPoint(x: c.x - r * 0.35, y: c.y - r * 0.4), startRadius: 0, endRadius: r * 1.5))
        ctx.stroke(disc, with: .color(.white.opacity(0.07)), lineWidth: 0.5)

        // Terres : 6 niveaux d'opacité selon la profondeur → 6 remplissages.
        var buckets = [Path](repeating: Path(), count: 6)
        let dot = max(1.1, r / 150)
        for p in GlobeData.land {
            guard let q = project(p, size: size), q.z > 0 else { continue }
            let b = min(5, Int(q.z * 6))
            let s = dot * (0.55 + 0.45 * q.z)
            buckets[b].addEllipse(in: CGRect(x: q.point.x - s, y: q.point.y - s, width: s * 2, height: s * 2))
        }
        for (i, path) in buckets.enumerated() where !path.isEmpty {
            ctx.fill(path, with: .color(.white.opacity(0.10 + 0.42 * Double(i) / 5)))
        }

        // Faisceaux des pays (derrière → devant pour un empilement correct).
        let maxV = max(spots.map(\.value).max() ?? 1, 0.0001)
        let t = now.timeIntervalSinceReferenceDate
        let placed = spots.compactMap { s -> (GlobeSpot, GeoPoint, Projected)? in
            guard s.value > 0, let co = GlobeData.countries[s.cc] else { return nil }
            let g = GlobeData.unit(lat: co.lat, lng: co.lng)
            guard let q = project(g, size: size), q.z > -0.05 else { return nil }
            return (s, g, q)
        }.sorted { $0.2.z < $1.2.z }

        for (s, g, base) in placed {
            let norm = sqrt(s.value / maxV)
            let fade = max(0, min(1, base.z * 3))
            let selected = s.cc == highlight
            let h = 1 + 0.06 + 0.28 * norm + (selected ? 0.06 : 0)
            guard let top = project(g, size: size, lift: h) else { continue }
            var beam = Path(); beam.move(to: base.point); beam.addLine(to: top.point)
            let tint = selected ? Color.white : MMColor.accent
            ctx.stroke(beam, with: .linearGradient(Gradient(colors: [tint.opacity(0.95 * fade), tint.opacity(0.05 * fade)]),
                                                   startPoint: base.point, endPoint: top.point),
                       style: StrokeStyle(lineWidth: 2 + 2.5 * norm, lineCap: .round))
            // Base lumineuse.
            let gr = 3 + 7 * norm
            ctx.fill(Path(ellipseIn: CGRect(x: base.point.x - gr, y: base.point.y - gr, width: gr * 2, height: gr * 2)),
                     with: .radialGradient(Gradient(colors: [tint.opacity(0.9 * fade), tint.opacity(0)]), center: base.point, startRadius: 0, endRadius: gr))
            ctx.fill(Path(ellipseIn: CGRect(x: top.point.x - 2, y: top.point.y - 2, width: 4, height: 4)), with: .color(.white.opacity(0.9 * fade)))

            // Onde : vente récente (< 10 min) → anneaux qui s'étendent, en boucle douce.
            if let last = s.lastSale, now.timeIntervalSince(last) < 600, fade > 0 {
                for k in 0..<2 {
                    let ph = (t * 0.7 + Double(k) * 0.5).truncatingRemainder(dividingBy: 1)
                    let rr = 4 + 22 * ph
                    ctx.stroke(Path(ellipseIn: CGRect(x: base.point.x - rr, y: base.point.y - rr * 0.6, width: rr * 2, height: rr * 1.2)),
                               with: .color(MMColor.accent.opacity((1 - ph) * 0.8 * fade)), lineWidth: 1.4)
                }
            }
        }
    }
}

// MARK: - Données de la planète depuis le Store

extension Store {
    /// Revenu par pays (toutes les apps) + horodatage de la dernière vente vue en direct.
    var globeSpots: [GlobeSpot] {
        var byCountry: [String: Double] = [:]
        for p in overview?.projects ?? [] {
            for (cc, v) in p.revenueByCountry ?? [:] where cc != "??" { byCountry[cc, default: 0] += Double(v) / 1e6 }
        }
        var last: [String: Date] = [:]
        for e in feed where e.isRevenue { if let cc = e.country, last[cc] == nil { last[cc] = e.date } }
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
                        MMLabel(text: "Ventes dans le monde", trailing: "\(spots.filter { $0.value >= 0.01 }.count) pays")
                    }
                    .padding([.horizontal, .top], 20)
                    GlobeView(spots: spots, interactive: false).frame(height: 260).padding(.vertical, 4)
                    HStack(spacing: 8) {
                        ForEach(Array(top), id: \.cc) { s in
                            HStack(spacing: 6) {
                                Text(flagEmoji(s.cc))
                                Text(Int(s.value * 1e6).money(cur, compact: true)).font(MMFont.number(13, .regular)).lineLimit(1)
                            }
                            .padding(.horizontal, 10).padding(.vertical, 7)
                            .background(Color.white.opacity(0.06), in: Capsule())
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

struct GlobeScreen: View {
    @EnvironmentObject var store: Store
    @State private var selected: String?

    var body: some View {
        let spots = store.globeSpots
        let cur = store.overview?.currency ?? "EUR"
        let total = max(spots.reduce(0) { $0 + $1.value }, 0.0001)
        let ranked = spots.filter { $0.value >= 0.01 }.sorted { $0.value > $1.value }
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Planète").font(MMFont.system(34, .bold)).tracking(-0.8)
                    Text("\(ranked.count) pays · revenu \(store.overview?.periodDays ?? 30) j").font(MMFont.system(13)).foregroundStyle(MMColor.ink3)
                }
                ZStack(alignment: .bottom) {
                    GlobeView(spots: spots, highlight: selected) { cc in
                        withAnimation(.snappy) { selected = cc }
                    }
                    .frame(height: 380)
                    .sensoryFeedback(.selection, trigger: selected)
                    if let cc = selected, let s = spots.first(where: { $0.cc == cc }) {
                        HStack(spacing: 10) {
                            Text(flagEmoji(cc)).font(.system(size: 22))
                            VStack(alignment: .leading, spacing: 1) {
                                Text(GlobeData.countries[cc]?.name ?? cc).font(MMFont.system(14, .medium))
                                Text("\((s.value / total).formatted(.percent.precision(.fractionLength(0)))) du revenu").font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                            }
                            Spacer()
                            Text(Int(s.value * 1e6).money(cur)).font(MMFont.number(18, .regular))
                        }
                        .padding(.horizontal, 16).padding(.vertical, 12)
                        .mmGlass(in: Capsule())
                        .padding(.horizontal, 8)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
                MMLabel(text: "Classement").padding(.horizontal, 4)
                MMCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(Array(ranked.prefix(20).enumerated()), id: \.element.cc) { i, s in
                            if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 52) }
                            Button { withAnimation(.snappy) { selected = s.cc } } label: {
                                HStack(spacing: 12) {
                                    Text(flagEmoji(s.cc)).font(.system(size: 20)).frame(width: 26)
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack {
                                            Text(GlobeData.countries[s.cc]?.name ?? s.cc).font(MMFont.system(14, .medium)).lineLimit(1)
                                            Spacer()
                                            Text(Int(s.value * 1e6).money(cur, compact: true)).font(MMFont.number(14, .regular))
                                        }
                                        GeometryReader { g in
                                            Capsule().fill(MMColor.chartGradient)
                                                .frame(width: max(4, g.size.width * s.value / (ranked.first?.value ?? 1)), height: 3)
                                        }
                                        .frame(height: 3)
                                    }
                                }
                                .padding(.horizontal, 16).padding(.vertical, 11)
                                .background(selected == s.cc ? Color.white.opacity(0.05) : .clear)
                            }
                            .buttonStyle(.plain)
                        }
                        if ranked.isEmpty {
                            Text("Tes premières ventes apparaîtront ici, pays par pays.").font(MMFont.system(14)).foregroundStyle(MMColor.ink2).padding(18)
                        }
                    }
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        .navigationBarTitleDisplayMode(.inline)
        .mmPage()
    }
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
