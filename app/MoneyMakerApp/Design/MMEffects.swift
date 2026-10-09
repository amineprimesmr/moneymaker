//
//  MMEffects.swift
//  MoneyMaker — effets et composants interactifs (app uniquement).
//
//  Repris de V2 : champ d'étoiles (LevelStarfieldView, 6 remplissages par
//  frame, 30 Hz, RNG SplitMix64 déterministe), glass natif iOS 26 avec repli
//  ultraThinMaterial (GlassPressButtonStyle), anneau de jauge (RingView).
//

import SwiftUI

// MARK: - Page

extension View {
    /// Fond noir pur, barre de navigation transparente, place réservée sous la tab bar.
    func mmPage(stars: Bool = false) -> some View {
        frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                ZStack {
                    MMBackdrop()
                    if stars { MMStarfield().ignoresSafeArea() }
                }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
            .contentMargins(.bottom, MMTabBarMetrics.clearance, for: .scrollContent)
    }

    /// Glass natif iOS 26, matériau sinon.
    @ViewBuilder
    func mmGlass<S: Shape>(in shape: S, interactive: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            background(.ultraThinMaterial, in: shape)
                .overlay { shape.stroke(Color.white.opacity(0.10), lineWidth: 1) }
        }
    }

    /// Les éléments se posent en douceur quand ils entrent dans le scroll.
    func mmScrollReveal() -> some View {
        scrollTransition(.interactive, axis: .vertical) { c, phase in
            c.opacity(phase.isIdentity ? 1 : 0.35)
                .scaleEffect(phase.isIdentity ? 1 : 0.96)
                .blur(radius: phase.isIdentity ? 0 : 2)
        }
    }

    /// Apparition échelonnée au premier affichage.
    func mmAppear(_ index: Int) -> some View { modifier(AppearModifier(index: index)) }
}

private struct AppearModifier: ViewModifier {
    let index: Int
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 18)
            .onAppear {
                withAnimation(.spring(response: 0.6, dampingFraction: 0.86).delay(Double(index) * 0.06)) { shown = true }
            }
    }
}

// MARK: - Boutons

/// Pression : léger enfoncement à ressort + retour haptique.
struct MMPressStyle: ButtonStyle {
    var scale: CGFloat = 0.97
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.7), value: configuration.isPressed)
            .sensoryFeedback(.impact(weight: .light), trigger: configuration.isPressed) { _, new in new }
    }
}

/// Capsule pleine d'accent — l'unique CTA plein de l'app.
struct MMPrimaryButton: View {
    let title: String
    var loading = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if loading { ProgressView().tint(.black) }
                Text(title).font(MMFont.system(16, .medium))
            }
            .foregroundStyle(.black)
            .frame(maxWidth: .infinity).padding(.vertical, 17)
            .background(MMColor.accent, in: Capsule())
            .shadow(color: MMColor.accent.opacity(0.35), radius: 22, y: 8)
        }
        .buttonStyle(MMPressStyle())
    }
}

/// Bouton rond en verre (menu, retour…).
struct MMGlassIconButton: View {
    let systemImage: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage).font(.system(size: 15, weight: .semibold)).foregroundStyle(MMColor.ink)
                .frame(width: 42, height: 42).contentShape(Circle())
                .mmGlass(in: Circle(), interactive: true)
        }
        .buttonStyle(MMPressStyle(scale: 0.92))
    }
}

// MARK: - Sélecteur de période

/// Segments en capsule, pastille qui glisse (matchedGeometry) + tick haptique.
struct MMSegmented<T: Hashable>: View {
    let options: [(T, String)]
    @Binding var selection: T
    @Namespace private var ns

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.0) { value, label in
                let on = value == selection
                Button {
                    withAnimation(.spring(response: 0.38, dampingFraction: 0.82)) { selection = value }
                } label: {
                    Text(label).font(MMFont.system(13, on ? .medium : .regular))
                        .foregroundStyle(on ? MMColor.ink : MMColor.ink3)
                        .frame(maxWidth: .infinity).padding(.vertical, 8)
                        .background {
                            if on { Capsule().fill(Color.white.opacity(0.12)).matchedGeometryEffect(id: "pill", in: ns) }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(Color.white.opacity(0.04), in: Capsule())
        .overlay { Capsule().strokeBorder(MMColor.hairline, lineWidth: 1) }
        .sensoryFeedback(.selection, trigger: selection)
    }
}

// MARK: - Jauge

/// RingView de V2, version fine avec halo.
struct MMRing: View {
    let value: Double // 0…1
    var color: Color = MMColor.accent
    var lineWidth: CGFloat = 6
    @State private var shown = 0.0

    var body: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.08), lineWidth: lineWidth)
            Circle().trim(from: 0, to: shown)
                .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .shadow(color: color.opacity(0.6), radius: 6)
        }
        .onAppear { withAnimation(.easeOut(duration: 1.1).delay(0.2)) { shown = max(0, min(1, value)) } }
        .onChange(of: value) { _, v in withAnimation(.easeOut(duration: 0.6)) { shown = max(0, min(1, v)) } }
    }
}

// MARK: - Squelette de chargement

struct MMShimmer: ViewModifier {
    @State private var phase: CGFloat = -1
    func body(content: Content) -> some View {
        content.overlay {
            GeometryReader { g in
                LinearGradient(colors: [.clear, Color.white.opacity(0.08), .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: g.size.width * 0.6)
                    .offset(x: phase * g.size.width * 1.6)
            }
            .mask(content)
        }
        .onAppear { withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) { phase = 1 } }
    }
}

// MARK: - Champ d'étoiles

struct MMStarfield: View {
    var count = 110
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let stars: [Star]

    init(count: Int = 110, seed: UInt64 = 0xB16B00B5) {
        self.count = count
        var rng = SplitMix64(seed: seed)
        stars = (0..<count).map { _ in
            Star(x: rng.unit(), y: rng.unit(), r: 0.4 + rng.unit() * 1.1, phase: rng.unit() * 2 * .pi, speed: 0.35 + rng.unit() * 0.55)
        }
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { t in
            let time = reduceMotion ? 0 : t.date.timeIntervalSinceReferenceDate
            Canvas { ctx, size in
                var buckets = [Path](repeating: Path(), count: 6)
                for s in stars {
                    let wave = 0.5 + 0.5 * sin(time * s.speed + s.phase)
                    let b = min(Int(wave * 6), 5)
                    buckets[b].addEllipse(in: CGRect(x: s.x * size.width - s.r, y: s.y * size.height - s.r, width: s.r * 2, height: s.r * 2))
                }
                for (i, p) in buckets.enumerated() where !p.isEmpty {
                    ctx.fill(p, with: .color(.white.opacity(0.06 + 0.40 * (Double(i) + 0.5) / 6)))
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private struct Star { let x, y: Double; let r: CGFloat; let phase, speed: Double }

    private struct SplitMix64 {
        var state: UInt64
        init(seed: UInt64) { state = seed == 0 ? 0x9E37_79B9_7F4A_7C15 : seed }
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
        mutating func unit() -> Double { Double(next() >> 11) * (1.0 / 9_007_199_254_740_992.0) }
    }
}
