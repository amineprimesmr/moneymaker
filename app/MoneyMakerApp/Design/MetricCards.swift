//
//  MetricCards.swift
//  MoneyMaker — cartes de données de l'Accueil, reprises de la page Effort de V2
//  (Features/Home/ScoreDetailComponents.swift · ScoreStatCard, Design/VeriHealthDesign.swift).
//
//  Toutes les cartes sont identiques : pleine largeur, 138 pt de haut, coins 32,
//  fond « vignette » (bords lumineux, cœur teinté, grain), libellé en haut à gauche,
//  variation en haut à droite, gros chiffre en bas à gauche, graphique à droite.
//  Toucher une carte ouvre son détail.
//

import SwiftUI

// MARK: - Thème (VeriCardTheme)

struct MetricTheme: Hashable {
    let rim: Color
    let inner: Color

    private static func hex(_ v: UInt32) -> Color {
        Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
    static let mint = MetricTheme(rim: hex(0x58D8A8), inner: hex(0x38A878))
    static let cobalt = MetricTheme(rim: hex(0x5878E0), inner: hex(0x3858C0))
    static let violet = MetricTheme(rim: hex(0xB070F0), inner: hex(0x7840C0))
    static let amber = MetricTheme(rim: hex(0xF8C038), inner: hex(0xD09820))
    static let sky = MetricTheme(rim: hex(0x6898F8), inner: hex(0x4878D0))
    static let ember = MetricTheme(rim: hex(0xF07830), inner: hex(0xC04818))
    static let teal = MetricTheme(rim: hex(0x40C8C0), inner: hex(0x289890))
    static let rose = MetricTheme(rim: hex(0xF06878), inner: hex(0xC04858))
}

/// Encre sombre sur les cartes claires (VeriCardInk).
enum MetricInk {
    static let primary = Color.black.opacity(0.88)
    static let secondary = Color.black.opacity(0.58)
    static let stroke = Color.black.opacity(0.42)
    static let muted = Color.black.opacity(0.16)
}

// MARK: - Fond vignette (VeriVignetteCardBackground)

struct MetricVignette: View {
    let theme: MetricTheme
    var cornerRadius: CGFloat = 32

    var body: some View {
        ZStack {
            mesh
            edgeGlow(theme.rim, strength: 1)
            if theme.inner != theme.rim { edgeGlow(theme.rim.opacity(0.72), strength: 0.48) }
            RadialGradient(colors: [theme.rim.opacity(0.55), .clear], center: .topLeading, startRadius: 0, endRadius: 260)
                .blendMode(.plusLighter)
            RadialGradient(colors: [theme.rim.opacity(0.35), .clear], center: .bottomTrailing, startRadius: 0, endRadius: 220)
                .blendMode(.plusLighter)
            MetricGrain()
        }
        .saturation(0.62)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }

    @ViewBuilder private var mesh: some View {
        if #available(iOS 18.0, *) {
            MeshGradient(width: 3, height: 3, points: [
                .init(0, 0), .init(0.5, 0), .init(1, 0),
                .init(0, 0.5), .init(0.5, 0.5), .init(1, 0.5),
                .init(0, 1), .init(0.5, 1), .init(1, 1),
            ], colors: [
                theme.rim.opacity(0.92), theme.rim.opacity(0.78), theme.rim.opacity(0.92),
                theme.rim.opacity(0.72), theme.inner, theme.rim.opacity(0.72),
                theme.rim.opacity(0.92), theme.rim.opacity(0.78), theme.rim.opacity(0.92),
            ])
        } else {
            ZStack {
                theme.rim.opacity(0.85)
                RadialGradient(colors: [theme.inner, theme.inner.opacity(0)], center: .center, startRadius: 0, endRadius: 200)
            }
        }
    }

    private func edgeGlow(_ color: Color, strength: Double) -> some View {
        let stops: (Double) -> [Gradient.Stop] = { s in [
            .init(color: color.opacity(0.58 * s), location: 0),
            .init(color: color.opacity(0.38 * s), location: 0.14),
            .init(color: color.opacity(0.22 * s), location: 0.28),
            .init(color: color.opacity(0.10 * s), location: 0.44),
            .init(color: color.opacity(0.04 * s), location: 0.58),
            .init(color: .clear, location: 0.78),
        ] }
        return ZStack {
            LinearGradient(stops: stops(strength), startPoint: .top, endPoint: .bottom)
            LinearGradient(stops: stops(strength), startPoint: .bottom, endPoint: .top)
            LinearGradient(stops: stops(strength * 0.92), startPoint: .leading, endPoint: .trailing)
            LinearGradient(stops: stops(strength * 0.92), startPoint: .trailing, endPoint: .leading)
        }
        .blendMode(.plusLighter)
    }
}

/// Grain fin, dessiné une fois (positions déterministes).
private struct MetricGrain: View {
    var body: some View {
        Canvas { ctx, size in
            var seed: UInt64 = 0x9E3779B97F4A7C15
            func next() -> CGFloat { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return CGFloat(seed >> 33) / CGFloat(UInt32.max >> 1) }
            for _ in 0..<Int(size.width * size.height / 60) {
                let r = CGRect(x: next() * size.width, y: next() * size.height, width: 1, height: 1)
                ctx.fill(Path(r), with: .color(.white.opacity(Double(next()) * 0.10)))
            }
        }
        .blendMode(.overlay)
        .allowsHitTesting(false)
        .drawingGroup()
    }
}

// MARK: - Décor graphique

enum MetricDecoration: Hashable {
    /// Courbe des valeurs (tracée à l'apparition).
    case sparkline([Double])
    /// Barres verticales.
    case bars([Double])
    /// Jauge circulaire 0…1.
    case gauge(Double)
    /// Arc de progression 0…1.
    case arc(Double)
}

private struct SparklineShape: Shape {
    let values: [Double]
    func path(in rect: CGRect) -> Path {
        var p = Path()
        guard values.count > 1 else { return p }
        let lo = values.min() ?? 0, hi = values.max() ?? 1, span = max(hi - lo, 0.0001)
        let pts = values.enumerated().map { i, v in
            CGPoint(x: rect.minX + rect.width * CGFloat(i) / CGFloat(values.count - 1),
                    y: rect.maxY - rect.height * CGFloat((v - lo) / span))
        }
        p.move(to: pts[0])
        for i in 1..<pts.count {
            let a = pts[i - 1], b = pts[i], mx = (a.x + b.x) / 2
            p.addCurve(to: b, control1: CGPoint(x: mx, y: a.y), control2: CGPoint(x: mx, y: b.y))
        }
        return p
    }
}

private struct DecorationView: View {
    let decoration: MetricDecoration
    let appeared: Bool

    var body: some View {
        switch decoration {
        case .sparkline(let v):
            ZStack {
                SparklineShape(values: v).trim(from: 0, to: appeared ? 1 : 0)
                    .stroke(MetricInk.stroke, style: StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))
                if let last = v.last, let lo = v.min(), let hi = v.max(), appeared {
                    GeometryReader { g in
                        let y = g.size.height * (1 - CGFloat((last - lo) / max(hi - lo, 0.0001)))
                        Circle().fill(MetricInk.primary).frame(width: 7, height: 7).position(x: g.size.width, y: y)
                    }
                    .transition(.opacity)
                }
            }
            .frame(width: 128, height: 52)
        case .bars(let v):
            let hi = max(v.max() ?? 1, 0.0001)
            HStack(alignment: .bottom, spacing: 3) {
                ForEach(Array(v.enumerated()), id: \.offset) { i, x in
                    Capsule().fill(i == v.count - 1 ? MetricInk.primary : MetricInk.stroke)
                        .frame(width: 5, height: max(4, 52 * CGFloat(x / hi) * (appeared ? 1 : 0.05)))
                }
            }
            .frame(width: 128, height: 52, alignment: .bottomTrailing)
        case .gauge(let f):
            ZStack {
                Circle().stroke(MetricInk.muted, lineWidth: 7)
                Circle().trim(from: 0, to: appeared ? min(max(f, 0), 1) : 0)
                    .stroke(MetricInk.stroke, style: StrokeStyle(lineWidth: 7, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(Int((min(max(f, 0), 1) * 100).rounded()))%")
                    .font(.system(size: 13, weight: .bold, design: .rounded)).foregroundStyle(MetricInk.primary)
            }
            .frame(width: 58, height: 58)
        case .arc(let f):
            ZStack {
                Circle().trim(from: 0, to: 0.5).stroke(MetricInk.muted, style: StrokeStyle(lineWidth: 8, lineCap: .round))
                Circle().trim(from: 0, to: appeared ? 0.5 * min(max(f, 0), 1) : 0)
                    .stroke(MetricInk.stroke, style: StrokeStyle(lineWidth: 8, lineCap: .round))
            }
            .rotationEffect(.degrees(180))
            .frame(width: 92, height: 92)
            .frame(height: 50, alignment: .top)
        }
    }
}

// MARK: - Carte (ScoreStatCard)

struct MetricCard: View {
    let title: String
    let value: String
    var delta: Double? = nil
    var caption: String? = nil
    let theme: MetricTheme
    let decoration: MetricDecoration
    var index: Int = 0

    @State private var appeared = false

    var body: some View {
        ZStack {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(MetricInk.secondary)
                    Spacer(minLength: 8)
                    if let delta, delta.isFinite {
                        Text("\(delta >= 0 ? "+" : "")\(Int((delta * 100).rounded()))%")
                            .font(.system(size: 16, weight: .bold)).foregroundStyle(MetricInk.primary)
                    }
                }
                Spacer(minLength: 0)
                VStack(alignment: .leading, spacing: 2) {
                    Text(value).mmNumeric()
                        .font(.system(size: 34, weight: .bold)).tracking(-0.8)
                        .foregroundStyle(MetricInk.primary)
                        .lineLimit(1).minimumScaleFactor(0.5)
                        .contentTransition(.numericText())
                    if let caption {
                        Text(caption).font(.caption.weight(.medium)).foregroundStyle(MetricInk.secondary).lineLimit(1)
                    }
                }
                .frame(maxWidth: 190, alignment: .leading)
            }
            DecorationView(decoration: decoration, appeared: appeared)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                .padding(.bottom, 4)
        }
        .padding(20)
        .frame(maxWidth: .infinity)
        .frame(height: 138)
        .background { MetricVignette(theme: theme) }
        .contentShape(RoundedRectangle(cornerRadius: 32, style: .continuous))
        .shadow(color: theme.rim.opacity(0.14), radius: 18, y: 8)
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : 14)
        .onAppear {
            withAnimation(.spring(response: 0.7, dampingFraction: 0.85).delay(0.12 + Double(index) * 0.08)) { appeared = true }
        }
    }
}
