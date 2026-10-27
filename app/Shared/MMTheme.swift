//
//  MMTheme.swift
//  MoneyMaker — design system partagé (app + widgets).
//
//  Porté de V2 (Design/DesignSystem.swift, V2Font.swift, Insights/Levels) :
//  fond charbon en « puits » elliptique, champ d'étoiles, cartes 28 pt
//  blanc 6,2 % / liseré 9,6 %, Helvetica Neue, labels capitales espacées.
//  Une seule couleur d'accent ; tout le reste est en niveaux de blanc.
//
//  Aucune dépendance UIKit : ce fichier compile aussi dans l'extension widgets.
//

import SwiftUI
import Charts
import UIKit

// MARK: - Palette

enum MMColor {
    static func hex(_ v: UInt32, _ o: Double = 1) -> Color {
        Color(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255, opacity: o)
    }

    /// Accent unique — argent, CTA, courbes.
    static let accent = hex(0x00F19F)
    /// Second ton de la courbe (dégradé accent → bleu, comme les références).
    static let blue = hex(0x2E8BFF)
    static let red = hex(0xFF4D5E)
    static let orange = hex(0xFFA23C)

    /// Couleur qui suit le mode clair / sombre (dynamique UIKit : bascule instantanée, sheets et widgets compris).
    static func dyn(light: UIColor, dark: UIColor) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .light ? light : dark })
    }
    static func dynHex(light: UInt32, dark: UInt32) -> Color {
        func u(_ v: UInt32) -> UIColor { UIColor(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1) }
        return dyn(light: u(light), dark: u(dark))
    }
    /// Encre à une opacité donnée : blanc·o en sombre (identique à l'ancien `Color.white.opacity(o)`),
    /// encre presque noire en clair (légèrement renforcée pour garder le contraste sur fond clair).
    /// Mémorisée par opacité (au millième) : appelée des centaines de fois par image, elle créait à
    /// chaque fois deux UIColor et une fermeture dynamique, que SwiftUI ne savait pas comparer.
    static func fg(_ o: Double) -> Color {
        let key = Int((max(0, min(1, o)) * 1000).rounded())
        fgLock.lock(); defer { fgLock.unlock() }
        if let c = fgCache[key] { return c }
        let a = Double(key) / 1000
        let c = dyn(light: UIColor(red: 0.07, green: 0.07, blue: 0.09, alpha: CGFloat(min(1, a * 1.05))),
                    dark: UIColor(white: 1, alpha: CGFloat(a)))
        fgCache[key] = c
        return c
    }
    private static var fgCache: [Int: Color] = [:]
    private static let fgLock = NSLock()

    static let edge = dyn(light: UIColor(red: 0.949, green: 0.949, blue: 0.965, alpha: 1), dark: UIColor(red: 0.012, green: 0.012, blue: 0.016, alpha: 1))
    static let mid = dyn(light: UIColor(red: 0.973, green: 0.973, blue: 0.984, alpha: 1), dark: UIColor(red: 0.055, green: 0.055, blue: 0.064, alpha: 1))
    static let well = dyn(light: .white, dark: UIColor(red: 0.092, green: 0.093, blue: 0.104, alpha: 1))

    /// Fond de page / sheet : noir pur en sombre, gris groupé Apple (#F2F2F7) en clair.
    static let bg = dyn(light: UIColor(red: 0.949, green: 0.949, blue: 0.969, alpha: 1), dark: .black)
    /// Surface élevée (sheets, menus) : noir en sombre, blanc en clair.
    static let surface = dyn(light: .white, dark: .black)

    static let ink = dyn(light: UIColor(red: 0.07, green: 0.07, blue: 0.09, alpha: 1), dark: .white)
    /// Encre inverse (texte sur une pastille `ink`).
    static let inkInverse = dyn(light: .white, dark: .black)
    static let ink2 = fg(0.62)
    static let ink3 = dyn(light: UIColor(red: 0.07, green: 0.07, blue: 0.09, alpha: 0.42), dark: UIColor(white: 1, alpha: 0.34))
    static let hairline = fg(0.08)
    /// Carte : verre blanc 6,2 % en sombre, carte blanche opaque en clair.
    static let cardFill = dyn(light: .white, dark: UIColor(white: 1, alpha: 0.062))
    static let cardBorder = dyn(light: UIColor(white: 0, alpha: 0.07), dark: UIColor(white: 1, alpha: 0.096))
    /// Ombre douce des cartes : invisible en sombre, légère en clair.
    static let cardShadow = dyn(light: UIColor(white: 0, alpha: 0.06), dark: .clear)

    static let chartGradient = LinearGradient(colors: [blue, accent], startPoint: .leading, endPoint: .trailing)
}

// MARK: - Typographie (V2Font)

enum MMFont {
    static func name(_ w: Font.Weight) -> String {
        switch w {
        case .ultraLight: return "HelveticaNeue-UltraLight"
        case .thin: return "HelveticaNeue-Thin"
        case .light: return "HelveticaNeue-Light"
        case .medium, .semibold: return "HelveticaNeue-Medium"
        case .bold, .heavy, .black: return "HelveticaNeue-Bold"
        default: return "HelveticaNeue"
        }
    }

    static func system(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom(name(weight), size: size, relativeTo: .body)
    }

    /// Grands chiffres : fins, serrés, chasse fixe — le « 400 % » des références.
    static func number(_ size: CGFloat, _ weight: Font.Weight = .light) -> Font {
        .custom(name(weight), size: size, relativeTo: .largeTitle).monospacedDigit()
    }
}

// MARK: - Fond de page

/// Fond de page : noir pur, de A à Z.
struct MMBackdrop: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Group {
            if scheme == .light { light } else { dark }
        }
        .ignoresSafeArea().allowsHitTesting(false).accessibilityHidden(true)
    }

    /// Clair : gris groupé Apple, une lueur blanche au centre, bords qui fonçent à peine.
    private var light: some View {
        let edge = Color(red: 0.925, green: 0.925, blue: 0.945)
        return ZStack {
            edge
            EllipticalGradient(stops: [
                .init(color: Color(red: 0.985, green: 0.985, blue: 0.992), location: 0),
                .init(color: Color(red: 0.955, green: 0.955, blue: 0.970), location: 0.42),
                .init(color: edge, location: 0.85),
            ], center: UnitPoint(x: 0.5, y: 0.40), startRadiusFraction: 0.06, endRadiusFraction: 0.85)
        }
    }

    private var dark: some View {
        // Fond de V2 (AppPageBackdrop) : gris anthracite en ovale, bords qui retombent au noir.
        let edge = Color(red: 0.022, green: 0.022, blue: 0.026)
        return ZStack {
            edge
            EllipticalGradient(stops: [
                .init(color: Color(red: 0.112, green: 0.113, blue: 0.124), location: 0),
                .init(color: Color(red: 0.068, green: 0.068, blue: 0.078), location: 0.38),
                .init(color: edge, location: 0.78),
                .init(color: edge, location: 1),
            ], center: UnitPoint(x: 0.5, y: 0.40), startRadiusFraction: 0.06, endRadiusFraction: 0.82)
            LinearGradient(stops: [
                .init(color: .black.opacity(0.70), location: 0), .init(color: .black.opacity(0.32), location: 0.12),
                .init(color: .black.opacity(0.08), location: 0.24), .init(color: .clear, location: 0.36),
                .init(color: .clear, location: 0.64), .init(color: .black.opacity(0.08), location: 0.76),
                .init(color: .black.opacity(0.32), location: 0.88), .init(color: .black.opacity(0.70), location: 1),
            ], startPoint: .leading, endPoint: .trailing)
            LinearGradient(stops: [
                .init(color: .black.opacity(0.28), location: 0), .init(color: .clear, location: 0.16),
                .init(color: .clear, location: 0.72), .init(color: .black.opacity(0.38), location: 1),
            ], startPoint: .top, endPoint: .bottom)
        }
    }
}

// MARK: - Cartes

struct MMCard<Content: View>: View {
    var padding: CGFloat = 18
    var radius: CGFloat = 28
    var glow: Color? = nil
    @ViewBuilder var content: () -> Content
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content()
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                shape.fill(MMColor.cardFill)
                    .overlay {
                        shape.strokeBorder(
                            LinearGradient(colors: [MMColor.fg(0.16), MMColor.cardBorder, MMColor.fg(0.04)],
                                           startPoint: .top, endPoint: .bottom), lineWidth: 1)
                    }
                    .overlay {
                        // « Lueur » sans ombre floue : un liseré teinté en haut de la carte (gratuit à dessiner).
                        if let glow {
                            shape.strokeBorder(LinearGradient(colors: [glow.opacity(0.35), .clear], startPoint: .top, endPoint: .center), lineWidth: 1)
                        }
                    }
            }
            .clipShape(shape)
            // L'ombre (passe hors écran floutée, sur tout le contenu) n'existe qu'en clair : en sombre elle
            // était transparente mais toujours calculée, pour chaque carte, à chaque image du défilement.
            // Tracée depuis la seule forme : le contenu n'est plus rastérisé pour la flouter.
            .background {
                if scheme == .light {
                    shape.fill(MMColor.cardFill).shadow(color: MMColor.cardShadow, radius: 12, y: 4)
                }
            }
    }
}

/// Label capitales, tracking large — ouvre chaque carte.
struct MMLabel: View {
    let text: String
    var trailing: String? = nil
    var tint: Color = MMColor.ink3

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(text.uppercased()).font(MMFont.system(11, .medium)).tracking(2.2).foregroundStyle(tint)
            Spacer(minLength: 8)
            if let trailing { Text(trailing).font(MMFont.system(11, .medium)).foregroundStyle(MMColor.ink3) }
        }
    }
}

/// Puce de variation (+12,4 %).
struct MMDelta: View {
    let value: Double?
    var body: some View {
        if let value, value.isFinite {
            let up = value >= 0
            HStack(spacing: 3) {
                Image(systemName: up ? "arrow.up.right" : "arrow.down.right").font(.system(size: 9, weight: .bold))
                Text(abs(value).formatted(.percent.precision(.fractionLength(1)))).font(MMFont.system(12, .medium)).monospacedDigit()
            }
            .foregroundStyle(up ? MMColor.accent : MMColor.red)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background((up ? MMColor.accent : MMColor.red).opacity(0.12), in: Capsule())
        }
    }
}

// MARK: - Courbe lumineuse

struct MMPoint: Identifiable, Hashable {
    let date: Date
    let value: Double
    var id: Date { date }
}

/// Ligne lissée + aire en dégradé + halo flou, sélection au doigt optionnelle.
struct MMGlowChart: View {
    let points: [MMPoint]
    var selection: Binding<Date?>? = nil
    var showsAxis = false
    var lineWidth: CGFloat = 2.2

    var body: some View {
        let maxY = max(points.map(\.value).max() ?? 1, 0.0001) * 1.12
        // Un seul graphique : l'aire en dégradé tient lieu de halo (l'ancien double flouté coûtait cher).
        line(maxY: maxY, area: true)
            .modifier(SelectionModifier(selection: selection))
    }

    private var selected: MMPoint? {
        guard let d = selection?.wrappedValue else { return nil }
        return points.min { abs($0.date.timeIntervalSince(d)) < abs($1.date.timeIntervalSince(d)) }
    }

    private func line(maxY: Double, area: Bool) -> some View {
        Chart {
            ForEach(points) { p in
                if area {
                    AreaMark(x: .value("Jour", p.date), y: .value("Valeur", p.value))
                        .interpolationMethod(.catmullRom)
                        .foregroundStyle(LinearGradient(colors: [MMColor.accent.opacity(0.28), MMColor.blue.opacity(0.06), .clear],
                                                        startPoint: .top, endPoint: .bottom))
                }
                LineMark(x: .value("Jour", p.date), y: .value("Valeur", p.value))
                    .interpolationMethod(.catmullRom)
                    .lineStyle(StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
                    .foregroundStyle(MMColor.chartGradient)
            }
            if area, let s = selected {
                RuleMark(x: .value("Jour", s.date))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
                    .foregroundStyle(MMColor.fg(0.35))
                PointMark(x: .value("Jour", s.date), y: .value("Valeur", s.value))
                    .symbol {
                        Circle().fill(MMColor.ink).frame(width: 9, height: 9)
                            .background(Circle().fill(MMColor.accent.opacity(0.35)).frame(width: 22, height: 22))
                    }
            }
        }
        .chartYScale(domain: 0...maxY)
        .chartXAxis {
            if showsAxis && area {
                AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                    AxisValueLabel(format: .dateTime.day().month(.abbreviated)).font(MMFont.system(10)).foregroundStyle(MMColor.ink3)
                }
            }
        }
        .chartYAxis {
            if showsAxis && area {
                AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { _ in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 4])).foregroundStyle(MMColor.hairline)
                }
            }
        }
        .chartLegend(.hidden)
    }
}

private struct SelectionModifier: ViewModifier {
    let selection: Binding<Date?>?
    func body(content: Content) -> some View {
        if let selection { content.chartXSelection(value: selection) } else { content }
    }
}

/// Mini-courbe pour les lignes de liste : un simple tracé (pas de Swift Charts).
struct MMSparkline: View {
    let values: [Double]
    var body: some View {
        SparkShape(values: values)
            .stroke(MMColor.chartGradient, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
    }
}

private struct SparkShape: Shape {
    let values: [Double]
    func path(in r: CGRect) -> Path {
        var p = Path()
        guard values.count > 1 else { return p }
        let maxV = max(values.max() ?? 1, 0.0001) * 1.1
        for (i, v) in values.enumerated() {
            let pt = CGPoint(x: r.minX + r.width * CGFloat(i) / CGFloat(values.count - 1), y: r.maxY - r.height * CGFloat(v / maxV))
            i == 0 ? p.move(to: pt) : p.addLine(to: pt)
        }
        return p
    }
}

// MARK: - Séries

/// Clés `yyyy-MM-dd` (UTC) des `days` derniers jours, du plus ancien au plus récent — calculées une fois par jour.
enum DayKeys {
    private static let formatter: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "UTC"); f.locale = Locale(identifier: "en_US_POSIX"); return f
    }()
    private static var cache: [Int: (day: Int, keys: [(String, Date)])] = [:]
    private static let lock = NSLock()

    static func last(_ days: Int) -> [(String, Date)] {
        let now = Date(), today = Int(now.timeIntervalSince1970 / 86400)
        lock.lock(); defer { lock.unlock() }
        if let c = cache[days], c.day == today { return c.keys }
        let keys = (0..<max(days, 1)).reversed().map { i -> (String, Date) in
            let d = now.addingTimeInterval(Double(-i) * 86400)
            return (formatter.string(from: d), d)
        }
        cache[days] = (today, keys)
        return keys
    }
}

/// Revenu par jour (clé `yyyy-MM-dd` UTC), du plus ancien au plus récent.
func dailySeries(_ byDay: [String: Int], days: Int) -> [MMPoint] {
    DayKeys.last(days).map { MMPoint(date: $0.1, value: Double(byDay[$0.0] ?? 0) / 1e6) }
}

/// Variation de la seconde moitié de la série par rapport à la première.
func halfOverHalf(_ pts: [MMPoint]) -> Double? {
    guard pts.count >= 4 else { return nil }
    let mid = pts.count / 2
    let a = pts[..<mid].reduce(0) { $0 + $1.value }, b = pts[mid...].reduce(0) { $0 + $1.value }
    return a > 0 ? (b - a) / a : nil
}

extension Overview {
    var revenueByDay: [String: Int] {
        projects.reduce(into: [:]) { acc, p in p.revenueByDay.forEach { acc[$0.key, default: 0] += $0.value } }
    }
}
