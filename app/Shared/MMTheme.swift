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

    static let edge = Color(.sRGB, red: 0.012, green: 0.012, blue: 0.016)
    static let mid = Color(.sRGB, red: 0.055, green: 0.055, blue: 0.064)
    static let well = Color(.sRGB, red: 0.092, green: 0.093, blue: 0.104)

    static let ink = Color.white
    static let ink2 = Color.white.opacity(0.62)
    static let ink3 = Color.white.opacity(0.34)
    static let hairline = Color.white.opacity(0.08)
    static let cardFill = Color.white.opacity(0.062)
    static let cardBorder = Color.white.opacity(0.096)

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
    var body: some View {
        Color.black.ignoresSafeArea().allowsHitTesting(false).accessibilityHidden(true)
    }
}

// MARK: - Cartes

struct MMCard<Content: View>: View {
    var padding: CGFloat = 18
    var radius: CGFloat = 28
    var glow: Color? = nil
    @ViewBuilder var content: () -> Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content()
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                shape.fill(MMColor.cardFill)
                    .overlay {
                        shape.strokeBorder(
                            LinearGradient(colors: [Color.white.opacity(0.16), MMColor.cardBorder, Color.white.opacity(0.04)],
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
                    .foregroundStyle(Color.white.opacity(0.35))
                PointMark(x: .value("Jour", s.date), y: .value("Valeur", s.value))
                    .symbol {
                        Circle().fill(.white).frame(width: 9, height: 9)
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
