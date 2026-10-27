//
//  WidgetStyle.swift
//  MoneyMaker — design system commun à TOUS les widgets (écran d'accueil, écran verrouillé,
//  Live Activity). Même grammaire que les tuiles de l'accueil (RecoveryTileKit) :
//  fond noir profond (clair : blanc → #F2F2F7), nuage de « petits carrés » statique dans un coin,
//  libellés capitales espacées, grands chiffres fins, courbe lisse verte (argent) ou violette,
//  liserés fins. Aucun néon, aucun halo coûteux, pas de Swift Charts (mémoire < 30 Mo).
//

import SwiftUI
import WidgetKit

// MARK: - Palette

enum WTone {
    case money, violet

    /// Vert « argent » de l'app (vif / profond).
    static let moneyBright = Color(red: 0.25, green: 0.92, blue: 0.52)
    static let moneyDeep = Color(red: 0.06, green: 0.62, blue: 0.32)
    static let violetBright = MMColor.hex(0x8D6CF2)
    static let violetDeep = MMColor.hex(0x5638C7)

    var bright: Color { self == .money ? Self.moneyBright : Self.violetBright }
    var deep: Color { self == .money ? Self.moneyDeep : Self.violetDeep }
}

// MARK: - Fond

/// Fond unique de tous les widgets : noir quasi pur à peine levé en haut (sombre),
/// blanc → gris groupé un peu plus soutenu (clair). Le nuage de points vit dans un coin.
/// `date` = date de l'entrée de timeline : le nuage se redessine (fondu) à chaque entrée.
struct WidgetBackdrop: View {
    var dots: UnitPoint? = .topTrailing
    var reach: CGFloat = 0.62
    var date: Date? = nil
    var body: some View {
        ZStack {
            LinearGradient(colors: [MMColor.dynHex(light: 0xFFFFFF, dark: 0x0A0A0B), MMColor.dynHex(light: 0xEBEBF0, dark: 0x000000)],
                           startPoint: .top, endPoint: .bottom)
            if let dots {
                let seed = date.map { Int($0.timeIntervalSince1970 / 300) } ?? 0
                WDots(anchor: dots, reach: reach, seed: seed)
                    .id(seed)
                    .transition(.opacity)
                    .animation(.easeInOut(duration: 1.4), value: seed)
            }
        }
    }
}

/// Nuage de « petits carrés », même dessin que RecoveryDotMatrix dans l'app : contour irrégulier
/// (le rayon ondule selon l'angle), opacité et densité décroissantes, bruit par point.
/// `seed` fait tourner le contour et redistribue les trous : chaque entrée de timeline a son motif.
/// Un seul Canvas, points regroupés par palier d'opacité (~16 remplissages).
struct WDots: View {
    var anchor: UnitPoint = .topTrailing
    var reach: CGFloat = 0.62
    var maxOpacity: Double = 0.26
    var seed: Int = 0
    var spacing: CGFloat = 5
    var dot: CGFloat = 1.7

    var body: some View {
        Canvas(opaque: false) { ctx, size in
            guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0,
                  size.width < 2000, size.height < 2000 else { return }
            let origin = CGPoint(x: anchor.x * size.width, y: anchor.y * size.height)
            let radius = max(size.width, size.height) * reach
            let levels = 16
            var buckets = [Path](repeating: Path(), count: levels)
            let ph = Double(seed % 997) * 0.618 * .pi
            var x = spacing / 2, column = 0
            while x < size.width {
                var y = spacing / 2, row = 0
                while y < size.height {
                    let dx = x - origin.x, dy = y - origin.y
                    let angle = atan2(dy, dx)
                    let wobble = 1 + 0.22 * sin(angle * 3 + ph) + 0.14 * sin(angle * 7 - ph * 1.7) + 0.08 * sin(angle * 13 + ph * 2.3)
                    let d = sqrt(dx * dx + dy * dy) / (radius * wobble)
                    if d < 1 {
                        var h = UInt64(bitPattern: Int64(column &* 92_821 &+ row &* 68_917 &+ (seed % 64) &* 1_299_709))
                        h = (h ^ (h >> 13)) &* 0x5bd1e995; h ^= h >> 15
                        let noise = Double(h % 1000) / 1000
                        if noise > 0.3 {
                            let f = pow(1 - d, 1.7) * (0.35 + noise * 0.9) / 1.25
                            let s = dot * (0.8 + 0.4 * CGFloat(1 - d))
                            buckets[min(levels - 1, Int(f * Double(levels)))]
                                .addRect(CGRect(x: x - s / 2, y: y - s / 2, width: s, height: s))
                        }
                    }
                    y += spacing; row += 1
                }
                x += spacing; column += 1
            }
            for (i, path) in buckets.enumerated() where !path.isEmpty {
                ctx.fill(path, with: .color(MMColor.ink.opacity(maxOpacity * 1.25 * (Double(i) + 0.5) / Double(levels))))
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Texte

/// Barre du haut, sans titre : pastille « direct » facultative + texte discret à droite.
struct WHeader: View {
    var trailing: String? = nil
    var live = false
    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            if live { Circle().fill(WTone.moneyBright).frame(width: 6, height: 6) }
            Spacer(minLength: 6)
            if let trailing { Text(trailing).font(MMFont.system(11, .medium)).foregroundStyle(MMColor.ink3).lineLimit(1) }
        }
    }
}

/// Grand chiffre fin, serré.
struct WValue: View {
    let text: String
    var size: CGFloat = 30
    var numeric: Double? = nil
    var body: some View {
        Text(text).font(MMFont.number(size)).tracking(-size * 0.028).foregroundStyle(MMColor.ink)
            .lineLimit(1).minimumScaleFactor(0.5)
            .contentTransition(.numericText(value: numeric ?? 0))
    }
}

/// Variation discrète : flèche + pourcentage, sans fond.
struct WDelta: View {
    let value: Double?
    var body: some View {
        if let value, value.isFinite {
            let up = value >= 0
            HStack(spacing: 2) {
                Image(systemName: up ? "arrow.up.right" : "arrow.down.right").font(.system(size: 8, weight: .bold))
                Text(abs(value).formatted(.percent.precision(.fractionLength(0)))).font(MMFont.system(12, .medium)).monospacedDigit()
            }
            .foregroundStyle(up ? WTone.moneyBright : MMColor.red)
        }
    }
}

/// Petite statistique : libellé discret au-dessus, valeur au-dessous.
struct WStat: View {
    let label: String
    let value: String
    var alignment: HorizontalAlignment = .leading
    var size: CGFloat = 17
    var body: some View {
        VStack(alignment: alignment, spacing: 2) {
            Text(label).font(MMFont.system(11)).foregroundStyle(MMColor.ink3).lineLimit(1)
            Text(value).font(MMFont.number(size, .regular)).foregroundStyle(MMColor.ink).lineLimit(1).minimumScaleFactor(0.6)
        }
    }
}

/// Carte intérieure : gris presque noir + liseré fin (sombre), blanc cassé + liseré noir 7 % (clair).
struct WCard<Content: View>: View {
    var padding: CGFloat = 10
    @ViewBuilder var content: Content
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        content
            .padding(padding)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            // Case gravée : ombre intérieure en haut, liseré clair en bas, comme enfoncée dans le fond.
            .background(shape.fill(Self.fill
                .shadow(.inner(color: .black.opacity(0.9), radius: 5, x: 0, y: 3))
                .shadow(.inner(color: MMColor.fg(0.07), radius: 1, x: 0, y: -1))))
            .overlay(shape.strokeBorder(LinearGradient(colors: [Color.black.opacity(0.7), Color.black.opacity(0.2), MMColor.fg(0.16)],
                                                       startPoint: .top, endPoint: .bottom), lineWidth: 1))
            // Rebord du fond éclairé juste sous la case.
            .background(shape.stroke(MMColor.fg(0.08), lineWidth: 1).offset(y: 1))
    }
    /// Plus sombre que les cartes de l'app : blanc 4 % (sombre), gris très clair (clair).
    private static var fill: Color { MMColor.dynHex(light: 0xFAFAFC, dark: 0x111113) }
}

struct WHairline: View {
    var body: some View { Rectangle().fill(MMColor.hairline).frame(height: 0.75) }
}

// MARK: - Courbe

/// Courbe lisse en dégradé (profond → vif), voile léger dessous, point sur la dernière valeur.
/// Tracé SwiftUI pur : rien d'animé, rien de flouté.
struct WLine: View {
    let values: [Double]
    var tone: WTone = .money
    var lineWidth: CGFloat = 2
    var area = true
    var endDot = true
    /// Base à zéro (montants) ; sinon la courbe occupe toute la hauteur.
    var zeroBased = true

    var body: some View {
        GeometryReader { g in
            let pts = points(in: g.size)
            ZStack {
                if area {
                    areaPath(pts, height: g.size.height)
                        .fill(LinearGradient(colors: [tone.bright.opacity(0.34), tone.bright.opacity(0.10), tone.bright.opacity(0)], startPoint: .top, endPoint: .bottom))
                    // Lueur : la courbe floutée sous le trait.
                    curve(pts).stroke(tone.bright.opacity(0.55), style: StrokeStyle(lineWidth: lineWidth * 3, lineCap: .round, lineJoin: .round))
                        .blur(radius: 7)
                }
                curve(pts)
                    .stroke(LinearGradient(colors: [tone.deep.opacity(0.35), tone.deep, tone.bright], startPoint: .leading, endPoint: .trailing),
                            style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
                if endDot, let last = pts.last {
                    Circle().fill(MMColor.ink).frame(width: lineWidth * 3.4, height: lineWidth * 3.4).position(last)
                }
            }
        }
        .accessibilityHidden(true)
    }

    private func points(in s: CGSize) -> [CGPoint] {
        let v = values.count > 1 ? values : [values.first ?? 0, values.first ?? 0]
        let hi = v.max() ?? 0, lo = zeroBased ? 0 : (v.min() ?? 0), span = hi - lo
        let inset = lineWidth * 2
        return v.enumerated().map { i, x in
            CGPoint(x: s.width * CGFloat(i) / CGFloat(v.count - 1),
                    y: span > 0 ? inset + (s.height - inset * 2) * (1 - CGFloat((x - lo) / span)) : s.height - inset)
        }
    }

    private func curve(_ p: [CGPoint]) -> Path {
        var path = Path()
        guard let first = p.first else { return path }
        path.move(to: first)
        for i in 1..<p.count {
            let a = p[i - 1], b = p[i], mx = (a.x + b.x) / 2
            path.addCurve(to: b, control1: CGPoint(x: mx, y: a.y), control2: CGPoint(x: mx, y: b.y))
        }
        return path
    }

    private func areaPath(_ p: [CGPoint], height: CGFloat) -> Path {
        var path = curve(p)
        guard let first = p.first, let last = p.last else { return path }
        path.addLine(to: CGPoint(x: last.x, y: height)); path.addLine(to: CGPoint(x: first.x, y: height)); path.closeSubpath()
        return path
    }
}

/// Barres verticales fines (la dernière en couleur), pour les séries courtes.
struct WBars: View {
    let values: [Double]
    var tone: WTone = .money
    var body: some View {
        let hi = max(values.max() ?? 0, 0.0001)
        GeometryReader { g in
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(Array(values.enumerated()), id: \.offset) { i, v in
                    RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                        .fill(i == values.count - 1 ? tone.bright : MMColor.fg(0.14))
                        .frame(maxWidth: .infinity)
                        .frame(height: max(2, g.size.height * CGFloat(v / hi)))
                }
            }
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
        .accessibilityHidden(true)
    }
}

/// Barre de progression fine (objectif).
struct WProgress: View {
    let value: Double
    var tone: WTone = .money
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(MMColor.fg(0.08))
                Capsule().fill(LinearGradient(colors: [tone.deep, tone.bright], startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(3, g.size.width * min(1, max(0, value))))
            }
        }
        .frame(height: 3)
    }
}

// MARK: - États

/// Déconnecté : sobre, sans logo coloré.
struct SignedOutView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Spacer(minLength: 0)
            Text("Ouvre MoneyMaker pour te connecter").font(MMFont.system(14)).foregroundStyle(MMColor.ink2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// Valeurs d'une série de points (MMPoint → Double).
extension Array where Element == MMPoint {
    var values: [Double] { map(\.value) }
    /// Cumul (trajectoire du mois).
    var cumulative: [Double] { var s = 0.0; return map { s += $0.value; return s } }
}

// MARK: - Ajouts : or (record), anneau d'objectif, pointillés, boutons

extension WTone {
    /// Or discret du record (jamais saturé).
    static let gold = Color(red: 0.96, green: 0.78, blue: 0.36)
    static let goldDeep = Color(red: 0.78, green: 0.56, blue: 0.18)
}

/// Anneau fin d'objectif : piste 8 %, arc dégradé, or une fois l'objectif atteint.
struct WRing: View {
    let progress: Double
    var lineWidth: CGFloat = 3
    var track: Color = MMColor.fg(0.10)
    var body: some View {
        let done = progress >= 1
        ZStack {
            Circle().stroke(track, lineWidth: lineWidth)
            Circle().trim(from: 0, to: min(1, max(0.02, progress)))
                .stroke(done ? AnyShapeStyle(WTone.gold) : AnyShapeStyle(AngularGradient(colors: [WTone.moneyDeep, WTone.moneyBright], center: .center)),
                        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .accessibilityLabel(Text("\(Int(progress * 100)) %"))
    }
}

/// Pastille « Record du jour 🏆 » : liseré or fin, sans fond plein.
struct WRecordBadge: View {
    let record: MMRecord
    var compact = false
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "trophy.fill").font(.system(size: compact ? 8 : 9, weight: .semibold))
            Text(compact ? String(localized: "Record") : String(localized: "Record du jour")).font(MMFont.system(compact ? 9 : 10, .semibold)).lineLimit(1)
            if !compact {
                Text("+\(record.gain.formatted(.percent.precision(.fractionLength(0))))").font(MMFont.system(10, .medium)).monospacedDigit().opacity(0.8)
            }
        }
        .foregroundStyle(WTone.gold)
        .padding(.horizontal, 7).padding(.vertical, 3)
        .background(Capsule().fill(WTone.gold.opacity(0.10)))
        .overlay(Capsule().strokeBorder(WTone.gold.opacity(0.35), lineWidth: 0.75))
        .fixedSize()
    }
}

/// Courbe réelle (pleine) + projection (pointillés) sur un même repère, à base zéro.
struct WProjectionChart: View {
    let actual: [Double]
    let projected: [Double]
    let total: Int
    var tone: WTone = .money
    var reference: Double? = nil

    var body: some View {
        GeometryReader { g in
            let hi = max(projected.last ?? 0, actual.last ?? 0, reference ?? 0, 0.0001)
            let n = max(total - 1, 1)
            let inset: CGFloat = 4
            let pt: (Int, Double) -> CGPoint = { i, v in
                CGPoint(x: g.size.width * CGFloat(i) / CGFloat(n), y: inset + (g.size.height - inset * 2) * (1 - CGFloat(v / hi)))
            }
            let a = actual.enumerated().map { pt($0.offset, $0.element) }
            let p = projected.enumerated().map { pt(actual.count - 1 + $0.offset, $0.element) }
            ZStack {
                if let r = reference {
                    let y = pt(0, r).y
                    Path { $0.move(to: CGPoint(x: 0, y: y)); $0.addLine(to: CGPoint(x: g.size.width, y: y)) }
                        .stroke(MMColor.fg(0.14), style: StrokeStyle(lineWidth: 0.75, dash: [2, 3]))
                }
                Path { path in
                    guard let f = a.first, let l = a.last else { return }
                    path.move(to: CGPoint(x: f.x, y: g.size.height)); a.forEach { path.addLine(to: $0) }
                    path.addLine(to: CGPoint(x: l.x, y: g.size.height)); path.closeSubpath()
                }
                .fill(LinearGradient(colors: [tone.bright.opacity(0.20), tone.bright.opacity(0)], startPoint: .top, endPoint: .bottom))
                Path { path in guard let f = p.first else { return }; path.move(to: f); p.dropFirst().forEach { path.addLine(to: $0) } }
                    .stroke(tone.bright.opacity(0.7), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, dash: [0.1, 4.5]))
                Path { path in guard let f = a.first else { return }; path.move(to: f); a.dropFirst().forEach { path.addLine(to: $0) } }
                    .stroke(LinearGradient(colors: [tone.deep.opacity(0.35), tone.deep, tone.bright], startPoint: .leading, endPoint: .trailing),
                            style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                if let l = a.last { Circle().fill(MMColor.ink).frame(width: 6.5, height: 6.5).position(l) }
                if let e = p.last, p.count > 1 { Circle().strokeBorder(tone.bright, lineWidth: 1.2).frame(width: 7, height: 7).position(e) }
            }
        }
        .accessibilityHidden(true)
    }
}

/// Petit bouton rond discret (cycle de business, direct…).
struct WIconButtonLabel: View {
    let symbol: String
    var on = false
    var body: some View {
        Image(systemName: symbol).font(.system(size: 10, weight: .semibold))
            .foregroundStyle(on ? MMColor.ink : MMColor.ink2)
            .frame(width: 22, height: 22)
            .background(Circle().fill(on ? MMColor.fg(0.14) : MMColor.fg(0.06)))
            .overlay(Circle().strokeBorder(MMColor.hairline, lineWidth: 0.75))
    }
}

/// Puce « business suivant » : initiale + nom + flèches, tap = business suivant.
struct WProjectSwitch: View {
    let name: String?
    var icon: Data? = nil
    var body: some View {
        Button(intent: CycleProjectIntent()) {
            HStack(spacing: 5) {
                WBizIcon(data: name == nil ? nil : icon, name: name, size: 17)
                Text(name ?? String(localized: "Tous")).font(MMFont.system(11, .medium)).foregroundStyle(MMColor.ink2).lineLimit(1)
                Image(systemName: "chevron.right").font(.system(size: 7, weight: .bold)).foregroundStyle(MMColor.ink3)
            }
            .padding(.leading, 3).padding(.trailing, 7).padding(.vertical, 3)
            .background(Capsule().fill(MMColor.fg(0.06)))
            .overlay(Capsule().strokeBorder(MMColor.hairline, lineWidth: 0.75))
            .frame(maxWidth: 120, alignment: .trailing)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Temps écoulé

/// « 3 min », « 2h », « 2h 14 », « 1j 5h » : court, recalculé à chaque entrée de timeline (une par minute).
/// `live` (Live Activity, sans timeline) garde le compteur natif du système.
struct WAgo: View {
    let date: Date
    var live = false
    var body: some View {
        if live { Text(date, style: .relative).monospacedDigit() } else { Text(Self.text(date)).monospacedDigit() }
    }

    static func text(_ d: Date, now: Date = .now) -> String {
        let m = max(0, Int(now.timeIntervalSince(d)) / 60)
        if m < 1 { return String(localized: "À l'instant") }
        return String(localized: "il y a \(span(m))")
    }

    private static func span(_ m: Int) -> String {
        if m < 60 { return "\(m) min" }
        let h = m / 60, r = m % 60
        if h < 24 { return r == 0 ? "\(h)h" : "\(h)h\(String(format: "%02d", r))" }
        let j = h / 24, rh = h % 24
        let day = String(localized: "j", comment: "Abréviation de jour (1j 5h)")
        return rh == 0 ? "\(j)\(day)" : "\(j)\(day) \(rh)h"
    }
}
