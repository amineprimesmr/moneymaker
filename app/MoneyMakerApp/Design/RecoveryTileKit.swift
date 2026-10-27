//  Copié de V2 (Features/Home/RecoveryTileKit.swift) : tuiles des pages Effort et Récupération.

import SwiftUI

//
//  RecoveryTileKit.swift
//  V2 — langage visuel « tuiles » de la page Récupération
//
//  Reproduction du tableau de bord de référence : cartes anthracite à biseau
//  3D, matrice de points animée dans un coin, jauge en arc bleu → rose,
//  curseur violet, courbe à bosse violette, rangées de mini-cartes avec delta
//  vert. Tout ce qui est couleur, rayon, épaisseur et espacement vit ici.
//

// MARK: - Thème

enum RecoveryTileTheme {
    static func color(_ hex: UInt32, opacity: Double = 1) -> Color {
        Color.auto(hex: hex, opacity: opacity)
    }

    /// Fond de page : noir légèrement relevé, uniforme.
    static let page = MMColor.dynHex(light: 0xF2F2F7, dark: 0x0A0A0B)

    /// Surface des cartes, du coin haut-gauche (clair) au bas-droit (sombre).
    static let cardTop = MMColor.dynHex(light: 0xFFFFFF, dark: 0x060607)
    static let cardBottom = MMColor.dynHex(light: 0xFAFAFC, dark: 0x000000)
    /// Biseau : liseré clair en haut-gauche, quasi absent en bas-droit.
    static let bevelLight = MMColor.dyn(light: UIColor(white: 0, alpha: 0.06), dark: UIColor(white: 1, alpha: 0.07))
    static let bevelDark = Color.v2Ink.opacity(0.0)

    static let title = color(0x8E8E93)
    static let icon = color(0x8E8E93)
    static let value = Color.v2Ink
    static let footer = MMColor.dynHex(light: 0x6E6E73, dark: 0x9A9A9F)
    static let footerStrong = Color.v2Ink
    static let silhouette = Color.v2Ink.opacity(0.05)

    /// Jauge : bleu → violet → rose → magenta ; reste gris anthracite.
    static let gaugeBlue = color(0x2B5CFF)
    static let gaugeViolet = color(0x9A4DE8)
    static let gaugePink = color(0xFF4FAE)
    static let gaugeMagenta = color(0xD92C8C)
    static let gaugeTrack = MMColor.dynHex(light: 0xE3E3E8, dark: 0x3A3A3D)

    /// Curseur et courbe : violet sombre → lavande claire.
    static let violetDeep = color(0x5638C7)
    static let violetBright = color(0x8D6CF2)
    static let curveBase = MMColor.dynHex(light: 0xC7C7CC, dark: 0x4B4B4F)

    static let deltaUp = color(0x3ED75C)
    static let deltaDown = color(0xFF4D4D)
    static let warn = color(0xFFB340)

    static let cardRadius: CGFloat = 28
    static let miniRadius: CGFloat = 20
    static let gridSpacing: CGFloat = 11
    static let pagePadding: CGFloat = 20
    static let tileHeight: CGFloat = 100
    static let miniHeight: CGFloat = 66

    static let entrance = Animation.spring(response: 0.55, dampingFraction: 0.86)

    static let spring = Animation.spring(response: 0.28, dampingFraction: 0.9, blendDuration: 0.06)
}

// MARK: - Matrice de points animée

/// Halo de petits points carrés ancré dans un coin de la carte.
///
/// Performance : aucun redessin par image. Deux couches statiques (chaque
/// point tiré au sort dans l'une ou l'autre) sont rastérisées une fois, puis
/// un simple fondu croisé en boucle, composé par le GPU, donne le
/// scintillement. Coût par carte ≈ deux textures, zéro CPU en continu.
/// Graine du motif de points : chaque carte a son propre nuage, irrégulier.
private struct RecoveryDotSeedKey: EnvironmentKey { static let defaultValue = 0 }
extension EnvironmentValues {
    var recoveryDotSeed: Int {
        get { self[RecoveryDotSeedKey.self] }
        set { self[RecoveryDotSeedKey.self] = newValue }
    }
}

struct RecoveryDotMatrix: View {
    @Environment(\.recoveryDotSeed) private var seed
    var anchor: UnitPoint = .topTrailing
    var reach: CGFloat = 0.78
    var maxOpacity: Double = 0.30
    var animated: Bool = true
    /// Couleur des points (blanc sur les cartes sombres, noir sur fond clair).
    var ink: Color = MMColor.ink
    /// Phase pilotée de l'extérieur (0…1, ex. TimelineView à faible cadence) : remplace l'animation répétée.
    var pulse: Double? = nil
    @State private var phase = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            RecoveryDotLayer(anchor: anchor, reach: reach, maxOpacity: maxOpacity, parity: 0, seed: seed, ink: ink)
                .equatable()
                .opacity(pulse.map { 0.55 + 0.45 * $0 } ?? (phase ? 1.0 : 0.55))
            RecoveryDotLayer(anchor: anchor, reach: reach, maxOpacity: maxOpacity, parity: 1, seed: seed, ink: ink)
                .equatable()
                .opacity(pulse.map { 1.0 - 0.45 * $0 } ?? (phase ? 0.55 : 1.0))
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear {
            guard pulse == nil, animated, !reduceMotion, !phase else { return }
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { phase = true }
        }
    }

}

/// Une couche de points. `Equatable` : SwiftUI ne la redessine pas tant que
/// ses paramètres ne changent pas, même si la page au-dessus se réévalue à
/// chaque image (ouverture du coach, défilement…).
private struct RecoveryDotLayer: View, Equatable {
    let anchor: UnitPoint
    let reach: CGFloat
    let maxOpacity: Double
    let parity: Int
    var seed: Int = 0
    var ink: Color = MMColor.ink

    var body: some View {
        Canvas(opaque: false, rendersAsynchronously: true) { canvas, size in
            // Une taille infinie ou NaN ferait tourner les boucles sans fin.
            guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0,
                  size.width < 4000, size.height < 4000 else { return }
            let spacing: CGFloat = 4.6
            let dot: CGFloat = 1.5
            let origin = CGPoint(x: anchor.x * size.width, y: anchor.y * size.height)
            let radius = max(size.width, size.height) * reach
            // Points regroupés par palier d'opacité : ~24 remplissages au lieu d'un par point
            // (des centaines par carte), et la couleur dynamique n'est résolue qu'une fois par palier.
            let levels = 24
            var buckets = [Path](repeating: Path(), count: levels)
            let s = Double(seed &* 37 % 100) / 100 * .pi * 2
            var x: CGFloat = spacing / 2
            var column = 0
            while x < size.width {
                var y: CGFloat = spacing / 2
                var row = 0
                while y < size.height {
                    // Tirage déterministe : un point sur deux dans chaque couche.
                    let hash = (column &* 73 &+ row &* 151 &+ column &* row &* 7) & 1
                    if hash == parity {
                        let dx = x - origin.x, dy = y - origin.y
                        // Contour irrégulier : le rayon ondule selon l'angle, différemment par carte.
                        let angle = atan2(dy, dx)
                        let wobble = 1 + 0.22 * sin(angle * 3 + s) + 0.14 * sin(angle * 7 - s * 1.7) + 0.08 * sin(angle * 13 + s * 2.3)
                        let d = sqrt(dx * dx + dy * dy) / (radius * wobble)
                        // Bruit par point : trous, grappes plus denses.
                        var h = UInt64(bitPattern: Int64(column &* 92_821 &+ row &* 68_917 &+ seed &* 1_299_709))
                        h = (h ^ (h >> 13)) &* 0x5bd1e995; h ^= h >> 15
                        let noise = Double(h % 1000) / 1000
                        if d < 1 && noise > 0.22 {
                            // Fraction de maxOpacity, de 0 à 1,25 (0,35 + 0,9 au plus).
                            let f = pow(1 - d, 1.7) * (0.35 + noise * 0.9) / 1.25
                            buckets[min(levels - 1, Int(f * Double(levels)))]
                                .addRect(CGRect(x: x - dot / 2, y: y - dot / 2, width: dot, height: dot))
                        }
                    }
                    y += spacing
                    row += 1
                }
                x += spacing
                column += 1
            }
            for (i, path) in buckets.enumerated() where !path.isEmpty {
                let alpha = maxOpacity * 1.25 * (Double(i) + 0.5) / Double(levels)
                canvas.fill(path, with: .color(ink.opacity(alpha)))
            }
        }
    }
}

// MARK: - Surface de carte

struct RecoveryTileSurface<Content: View>: View {
    var radius: CGFloat = RecoveryTileTheme.cardRadius
    var dotsAnchor: UnitPoint? = .topTrailing
    var dotsReach: CGFloat = 0.78
    /// Cartes de rangée : pas d'ombre interne ni de scintillement, ombre courte.
    var light: Bool = false
    @ViewBuilder var content: Content
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background {
                // L'ombre porte sur le fond seul (statique, calculée une fois) : posée
                // sur tout le groupe, le scintillement des points la faisait
                // recalculer à chaque image, pour chaque tuile, défilement compris.
                ZStack {
                    // Relief 3D (fond, ombres, reflets, arêtes) : tout est statique, donc rastérisé
                    // une seule fois (drawingGroup) au lieu d'être recomposé à chaque image du défilement.
                    // La marge de 40 pt garde l'ombre portée dans la texture.
                    ZStack {
                        let isLight = scheme == .light
                        surfaceFill(shape)
                            .shadow(color: .black.opacity(isLight ? 0.05 : 0.7), radius: 2, x: 0, y: isLight ? 1 : 2)
                            .shadow(color: .black.opacity(isLight ? 0.07 : 0.75), radius: isLight ? 16 : 22, x: isLight ? 0 : 6, y: isLight ? 6 : 16)
                        shape.fill(RadialGradient(colors: [.white.opacity(isLight ? 0 : 0.09), .clear], center: .topLeading, startRadius: 0, endRadius: 140))
                    }
                    .padding(40).drawingGroup().padding(-40)
                    if let dotsAnchor {
                        // Points fixes dans les cartes : un scintillement répété (animation SwiftUI)
                        // recalculait toute la page 60 fois par seconde, défilement compris.
                        RecoveryDotMatrix(anchor: dotsAnchor, reach: dotsReach, animated: false)
                            .clipShape(shape)
                            .drawingGroup()
                    }
                    ZStack {
                        shape.strokeBorder(
                            LinearGradient(colors: [RecoveryTileTheme.bevelLight, RecoveryTileTheme.bevelDark],
                                           startPoint: .topLeading, endPoint: .bottomTrailing),
                            lineWidth: 1
                        )
                        // Rebord lumineux limité à l'angle haut-gauche (dégradé radial centré sur le coin).
                        shape.strokeBorder(RadialGradient(stops: [
                            .init(color: .white.opacity(scheme == .light ? 0 : 0.6), location: 0),
                            .init(color: .white.opacity(scheme == .light ? 0 : 0.22), location: 0.45),
                            .init(color: .clear, location: 1),
                        ], center: .topLeading, startRadius: 0, endRadius: 110), lineWidth: 1.5)
                        // Arête sombre opposée, en bas à droite : la carte paraît bombée.
                        shape.strokeBorder(RadialGradient(colors: [.black.opacity(scheme == .light ? 0.06 : 0.9), .clear],
                                                          center: .bottomTrailing, startRadius: 0, endRadius: 140), lineWidth: 2)
                    }
                    .drawingGroup()
                    .allowsHitTesting(false)
                }
            }
    }

    @ViewBuilder
    private func surfaceFill(_ shape: RoundedRectangle) -> some View {
        let gradient = LinearGradient(
            colors: [RecoveryTileTheme.cardTop, RecoveryTileTheme.cardBottom],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        if false {
            shape.fill(gradient)
        } else {
            shape.fill(
                gradient
                    .shadow(.inner(color: .white.opacity(scheme == .light ? 0.9 : 0.16), radius: 2, x: 1.5, y: 1.5))
                    .shadow(.inner(color: .black.opacity(scheme == .light ? 0.035 : 0.9), radius: 6, x: -3, y: -4))
            )
        }
    }
}

// MARK: - En-tête icône + titre

struct RecoveryTileHeader: View {
    let symbol: String
    let title: String
    var size: CGFloat = 15

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: symbol)
                .font(V2Font.system(size: size + 2, weight: .semibold))
                .foregroundStyle(RecoveryTileTheme.icon)
            Text(title)
                .font(V2Font.system(size: size, weight: .regular))
                .foregroundStyle(RecoveryTileTheme.title)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
    }
}

// MARK: - Tuile héros (grande valeur + silhouette + pastille)

struct RecoveryHeroTile: View {
    let symbol: String
    let title: String
    let value: String
    let badgeColor: Color
    let silhouetteSymbol: String
    let footerLead: String
    let footerStrong: String

    var body: some View {
        RecoveryTileSurface(dotsAnchor: .bottomLeading, dotsReach: 0.6) {
            ZStack(alignment: .topLeading) {
                Color.clear
                    .overlay(alignment: .bottomTrailing) {
                        Image(systemName: silhouetteSymbol)
                            .font(.system(size: 118, weight: .regular))
                            .foregroundStyle(RecoveryTileTheme.silhouette)
                            .offset(x: 10, y: 4)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: RecoveryTileTheme.cardRadius, style: .continuous))
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .center) {
                        RecoveryTileHeader(symbol: symbol, title: title)
                        Spacer(minLength: 4)
                        badge
                    }
                    Text(value).mmNumeric()
                        .font(V2Font.system(size: 34, weight: .medium))
                        .foregroundStyle(RecoveryTileTheme.value)
                        .padding(.top, 6)
                    Spacer(minLength: 0)
                    (Text(footerLead).foregroundStyle(RecoveryTileTheme.footer)
                        + Text(footerStrong).foregroundStyle(RecoveryTileTheme.footerStrong))
                        .font(V2Font.system(size: 15, weight: .regular))
                        .lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(16)
            }
            .frame(maxWidth: .infinity)
            .frame(height: RecoveryTileTheme.tileHeight)
            .clipped()
        }
    }

    private var badge: some View {
        Circle()
            .fill(badgeColor)
            .overlay {
                Circle().fill(
                    LinearGradient(
                        colors: [Color.v2Ink.opacity(0.35), .clear, Color.v2InkInverse.opacity(0.28)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
            }
            .overlay { Circle().strokeBorder(Color.v2Ink.opacity(0.18), lineWidth: 0.8) }
            .frame(width: 32, height: 32)
            .shadow(color: badgeColor.opacity(0.25), radius: 5, x: 0, y: 2)
    }
}

// MARK: - Tuile jauge en arc

struct RecoveryGaugeTile: View {
    let symbol: String
    let title: String
    let value: String
    let unit: String
    /// 0 = tout à gauche, 1 = tout à droite.
    let fraction: Double
    let leadingLabel: String
    let trailingLabel: String

    var body: some View {
        RecoveryTileSurface(dotsAnchor: .topTrailing, dotsReach: 0.75) {
            VStack(alignment: .leading, spacing: 0) {
                RecoveryTileHeader(symbol: symbol, title: title)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ZStack {
                    RecoveryArcGauge(fraction: fraction)
                        .padding(.horizontal, 2)
                    VStack(spacing: 0) {
                        Text(value).mmNumeric()
                            .font(V2Font.system(size: 34, weight: .medium))
                            .foregroundStyle(RecoveryTileTheme.value)
                        Text(unit)
                            .font(V2Font.system(size: 15, weight: .regular))
                            .foregroundStyle(RecoveryTileTheme.value)
                    }
                    .offset(y: 14)
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 4)
                HStack {
                    Text(leadingLabel)
                    Spacer()
                    Text(trailingLabel)
                }
                .font(V2Font.system(size: 15, weight: .regular))
                .foregroundStyle(RecoveryTileTheme.value.opacity(0.9))
                .padding(.horizontal, 4)
                .padding(.top, -14)
            }
            .padding(16)
            .frame(maxWidth: .infinity)
            .frame(height: RecoveryTileTheme.tileHeight)
        }
    }
}

/// Arc de 240° ouvert vers le bas : bouts gris, corps dégradé, repère blanc.
struct RecoveryArcGauge: View {
    let fraction: Double
    @State private var shown: Double = 0.5
    private let lineWidth: CGFloat = 9
    private let startAngle: Double = 152   // bas-gauche
    private let sweep: Double = 236
    private let stubFraction: Double = 0.14

    var body: some View {
        GeometryReader { proxy in
            let size = min(proxy.size.width, proxy.size.height * 1.25)
            let radius = size / 2 - lineWidth
            let center = CGPoint(x: proxy.size.width / 2, y: proxy.size.height / 2 + radius * 0.16)
            let clamped = min(max(shown, 0), 1)
            let markerAngle = Angle.degrees(startAngle + sweep * clamped)

            ZStack {
                arc(center: center, radius: radius, from: 0, to: 1)
                    .stroke(RecoveryTileTheme.gaugeTrack, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                arc(center: center, radius: radius, from: stubFraction, to: 1 - stubFraction)
                    .stroke(
                        AngularGradient(
                            stops: [
                                .init(color: RecoveryTileTheme.gaugeBlue, location: 0.0),
                                .init(color: RecoveryTileTheme.gaugeBlue, location: 0.32),
                                .init(color: RecoveryTileTheme.gaugeViolet, location: 0.48),
                                .init(color: RecoveryTileTheme.gaugePink, location: 0.62),
                                .init(color: RecoveryTileTheme.gaugeMagenta, location: 0.88),
                                .init(color: RecoveryTileTheme.gaugeMagenta, location: 1.0),
                            ],
                            center: UnitPoint(x: center.x / proxy.size.width, y: center.y / proxy.size.height),
                            startAngle: .degrees(startAngle),
                            endAngle: .degrees(startAngle + sweep)
                        ),
                        style: StrokeStyle(lineWidth: lineWidth, lineCap: .butt)
                    )
                Capsule()
                    .fill(Color.v2Ink)
                    .frame(width: 4, height: 18)
                    .shadow(color: .white.opacity(0.7), radius: 4)
                    .shadow(color: .black.opacity(0.5), radius: 2, y: 1)
                    .rotationEffect(markerAngle + .degrees(90))
                    .position(
                        x: center.x + cos(markerAngle.radians) * radius,
                        y: center.y + sin(markerAngle.radians) * radius
                    )
            }
        }
        .frame(height: 124)
        .onAppear { withAnimation(RecoveryTileTheme.entrance.delay(0.15)) { shown = fraction } }
        .onChange(of: fraction) { _, new in withAnimation(RecoveryTileTheme.entrance) { shown = new } }
    }

    private func arc(center: CGPoint, radius: CGFloat, from: Double, to: Double) -> Path {
        var path = Path()
        path.addArc(
            center: center,
            radius: radius,
            startAngle: .degrees(startAngle + sweep * from),
            endAngle: .degrees(startAngle + sweep * to),
            clockwise: false
        )
        return path
    }
}

// MARK: - Tuile curseur

struct RecoverySliderTile: View {
    let symbol: String
    let title: String
    let value: String
    let fraction: Double
    let footerLead: String
    let footerStrong: String

    var body: some View {
        RecoveryTileSurface(dotsAnchor: .topTrailing, dotsReach: 0.55) {
            VStack(alignment: .leading, spacing: 0) {
                RecoveryTileHeader(symbol: symbol, title: title)
                Text(value).mmNumeric()
                    .font(V2Font.system(size: 34, weight: .medium))
                    .foregroundStyle(RecoveryTileTheme.value)
                    .padding(.top, 6)
                Spacer(minLength: 0)
                RecoverySliderTrack(fraction: fraction)
                    .frame(height: 18)
                    .padding(.horizontal, -16) // la piste court d'un bord à l'autre
                Spacer(minLength: 0)
                VStack(alignment: .leading, spacing: 2) {
                    Text(footerLead)
                        .foregroundStyle(RecoveryTileTheme.footer)
                    Text(footerStrong)
                        .foregroundStyle(RecoveryTileTheme.footerStrong)
                }
                .font(V2Font.system(size: 15, weight: .regular))
                .lineLimit(1)
                .minimumScaleFactor(0.85)
            }
            .padding(16)
            .frame(maxWidth: .infinity)
            .frame(height: RecoveryTileTheme.tileHeight)
        }
    }
}

struct RecoverySliderTrack: View {
    let fraction: Double
    @State private var shown: Double = 0

    var body: some View {
        GeometryReader { proxy in
            let clamped = min(max(shown, 0), 1)
            let x = proxy.size.width * clamped
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(
                        LinearGradient(
                            stops: [
                                .init(color: RecoveryTileTheme.violetDeep.opacity(0.0), location: 0),
                                .init(color: RecoveryTileTheme.violetDeep.opacity(0.75), location: 0.12),
                                .init(color: RecoveryTileTheme.violetBright, location: max(0.14, clamped)),
                                .init(color: RecoveryTileTheme.violetDeep.opacity(0.55), location: min(1, clamped + 0.12)),
                                .init(color: RecoveryTileTheme.violetDeep.opacity(0.0), location: min(1, clamped + 0.3)),
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(height: 4)
                    .frame(maxHeight: .infinity)
                Circle()
                    .fill(Color.v2Ink)
                    .frame(width: 14, height: 14)
                    .shadow(color: .white.opacity(0.55), radius: 5)
                    .shadow(color: .black.opacity(0.5), radius: 2, y: 1)
                    .position(x: x, y: proxy.size.height / 2)
            }
        }
        .onAppear { withAnimation(RecoveryTileTheme.entrance.delay(0.2)) { shown = fraction } }
        .onChange(of: fraction) { _, new in withAnimation(RecoveryTileTheme.entrance) { shown = new } }
    }
}

// MARK: - Tuile courbe à bosse

struct RecoveryCurveTile: View {
    let symbol: String
    let title: String
    let value: String
    /// Début / fin de la bosse mise en valeur, en fraction de la largeur.
    let highlight: ClosedRange<Double>
    /// Hauteur de la bosse (0…1).
    let peak: Double
    var footerLead: String? = nil
    var footerStrong: String? = nil

    var body: some View {
        RecoveryTileSurface(dotsAnchor: .topTrailing, dotsReach: 0.8) {
            VStack(alignment: .leading, spacing: 0) {
                RecoveryTileHeader(symbol: symbol, title: title)
                Text(value).mmNumeric()
                    .font(V2Font.system(size: 34, weight: .medium))
                    .foregroundStyle(RecoveryTileTheme.value)
                    .padding(.top, 6)
                if let footerLead, let footerStrong {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(footerLead).foregroundStyle(RecoveryTileTheme.footer)
                        Text(footerStrong).foregroundStyle(RecoveryTileTheme.footerStrong)
                    }
                    .font(V2Font.system(size: 13, weight: .regular))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .padding(.top, 6)
                }
                Spacer(minLength: 0)
                RecoveryBumpCurve(highlight: highlight, peak: peak)
                    .frame(height: footerLead == nil ? 104 : 74)
                    .padding(.horizontal, -16)
                    .padding(.bottom, -16)
            }
            .padding(16)
            .frame(maxWidth: .infinity)
            .frame(height: RecoveryTileTheme.tileHeight)
        }
    }
}

struct RecoveryBumpCurve: View {
    let highlight: ClosedRange<Double>
    let peak: Double
    @State private var grow: Double = 0

    var body: some View {
        GeometryReader { proxy in
            let w = proxy.size.width, h = proxy.size.height
            let baseY = h * 0.58
            let full = curvePath(width: w, baseY: baseY, amplitude: h * 0.62, from: 0, to: 1)
            let bump = curvePath(width: w, baseY: baseY, amplitude: h * 0.62, from: highlight.lowerBound, to: highlight.upperBound)
            ZStack {
                full.stroke(RecoveryTileTheme.curveBase, style: StrokeStyle(lineWidth: 1.4, lineCap: .round))
                bump.trim(from: 0, to: grow).stroke(
                    LinearGradient(
                        colors: [RecoveryTileTheme.violetDeep, RecoveryTileTheme.violetBright, RecoveryTileTheme.violetDeep],
                        startPoint: .leading,
                        endPoint: .trailing
                    ),
                    style: StrokeStyle(lineWidth: 3.2, lineCap: .round)
                )
                .shadow(color: RecoveryTileTheme.violetBright.opacity(0.45), radius: 5)
                .drawingGroup()
                ForEach([highlight.lowerBound, highlight.upperBound], id: \.self) { f in
                    Circle()
                        .fill(Color.v2Ink)
                        .frame(width: 6, height: 6)
                        .overlay { Circle().stroke(Color.v2InkInverse.opacity(0.7), lineWidth: 1.2) }
                        .position(point(at: f, width: w, baseY: baseY, amplitude: h * 0.62))
                        .opacity(grow > 0.05 ? 1 : 0)
                }
            }
        }
        .onAppear { withAnimation(.easeOut(duration: 0.9).delay(0.25)) { grow = 1 } }
    }

    /// Ondulation douce + bosse gaussienne centrée sur la plage mise en valeur.
    private func point(at f: Double, width: CGFloat, baseY: CGFloat, amplitude: CGFloat) -> CGPoint {
        let center = (highlight.lowerBound + highlight.upperBound) / 2
        let halfWidth = max(0.11, (highlight.upperBound - highlight.lowerBound) / 2)
        let gaussian = exp(-pow((f - center) / (halfWidth * 0.55), 2))
        // Amorce basse à gauche qui remonte, ondulation douce ensuite.
        let ripple = 0.05 * sin(f * .pi * 2.0 + 0.9) + 0.32 * max(0, 0.22 - f) / 0.22
        let y = baseY - amplitude * (peak * gaussian) + amplitude * ripple
        return CGPoint(x: width * f, y: y)
    }

    private func curvePath(width: CGFloat, baseY: CGFloat, amplitude: CGFloat, from: Double, to: Double) -> Path {
        var path = Path()
        let steps = 80
        for i in 0...steps {
            let f = from + (to - from) * Double(i) / Double(steps)
            let p = point(at: f, width: width, baseY: baseY, amplitude: amplitude)
            if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        return path
    }
}

// MARK: - Mini-tuile (rangées horizontales)

struct RecoveryMiniTile: View {
    let symbol: String
    let title: String
    let value: String
    /// Delta signé déjà formaté (« +1.3 % », « -4 min »). `nil` → rien.
    let delta: String?
    /// Largeur fixe dans une rangée défilante ; `nil` → remplit sa colonne de grille.
    var width: CGFloat? = 150

    private var isNegative: Bool {
        guard let delta else { return false }
        return delta.hasPrefix("-") || delta.hasPrefix("−")
    }

    var body: some View {
        RecoveryTileSurface(radius: RecoveryTileTheme.miniRadius, dotsAnchor: .topTrailing, dotsReach: 0.7, light: true) {
            VStack(alignment: .leading, spacing: 4) {
                RecoveryTileHeader(symbol: symbol, title: title, size: 14)
                Text(value).mmNumeric()
                    .font(V2Font.system(size: 21, weight: .semibold))
                    .foregroundStyle(RecoveryTileTheme.value)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .padding(.top, 1)
                HStack(spacing: 4) {
                    if let delta {
                        Image(systemName: isNegative ? "arrowtriangle.down.fill" : "arrowtriangle.up.fill")
                            .font(.system(size: 9, weight: .bold))
                        Text(delta)
                            .font(V2Font.system(size: 13, weight: .regular))
                    } else {
                        Text(" ")
                            .font(V2Font.system(size: 13, weight: .regular))
                    }
                }
                .foregroundStyle(isNegative ? RecoveryTileTheme.deltaDown : RecoveryTileTheme.deltaUp)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(width: width, height: RecoveryTileTheme.miniHeight, alignment: .leading)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
        }
    }
}

// MARK: - Section (titre + rangée défilante)

struct RecoveryTileSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(V2Font.system(size: 20, weight: .semibold))
                .foregroundStyle(Color.v2Ink)
                .padding(.horizontal, RecoveryTileTheme.pagePadding)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: RecoveryTileTheme.gridSpacing) {
                    content
                }
                .padding(.horizontal, RecoveryTileTheme.pagePadding)
                .padding(.vertical, 14) // place pour l'ombre portée
            }
            .padding(.vertical, -14)

        }
    }
}

// MARK: - Carte rapport (bas de page)

struct RecoveryReportTile: View {
    let title: String
    let lead: String
    let strong: String
    let action: () -> Void

    var body: some View {
        RecoveryTileSurface(radius: RecoveryTileTheme.miniRadius, dotsAnchor: .bottomTrailing, dotsReach: 0.5) {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 5) {
                    RecoveryTileHeader(symbol: "doc.text.fill", title: title, size: 15)
                    (Text(lead).foregroundStyle(RecoveryTileTheme.footer)
                        + Text(strong).foregroundStyle(RecoveryTileTheme.footerStrong))
                        .font(V2Font.system(size: 15, weight: .regular))
                        .lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Button(action: action) {
                    ZStack {
                        Circle()
                            .fill(
                                LinearGradient(
                                    colors: [RecoveryTileTheme.violetBright, RecoveryTileTheme.violetDeep],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                            .overlay { Circle().strokeBorder(Color.v2Ink.opacity(0.18), lineWidth: 0.8) }
                        Image(systemName: "arrow.down.circle")
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundStyle(Color.v2Ink)
                    }
                    .frame(width: 52, height: 52)
                    .shadow(color: RecoveryTileTheme.violetBright.opacity(0.45), radius: 10, x: 0, y: 4)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity)
        }
    }
}

// MARK: - Apparition en cascade

struct RecoveryTileEntrance: ViewModifier {
    let index: Int
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 18)
            .scaleEffect(shown ? 1 : 0.97)
            .onAppear {
                guard !shown else { return }
                if reduceMotion { shown = true; return }
                withAnimation(RecoveryTileTheme.entrance.delay(0.05 + Double(index) * 0.07)) { shown = true }
            }
    }
}

extension View {
    func recoveryTileEntrance(_ index: Int) -> some View {
        modifier(RecoveryTileEntrance(index: index))
    }
}

#Preview("Tuiles") {
    ScrollView {
        VStack(spacing: 20) {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible())], spacing: 16) {
                RecoveryHeroTile(symbol: "heart.fill", title: String(localized: "Récupération"), value: "97%", badgeColor: .green, silhouetteSymbol: "bed.double.fill", footerLead: "Tous les signaux sont ", footerStrong: "au vert")
                RecoveryGaugeTile(symbol: "waveform.path.ecg", title: String(localized: "VFC"), value: "23", unit: "ms", fraction: 0.5, leadingLabel: "Bas", trailingLabel: "Haut")
                RecoverySliderTile(symbol: "clock.fill", title: String(localized: "Coucher"), value: "23:10", fraction: 0.62, footerLead: "Meilleure fenêtre ce soir", footerStrong: "entre 22h30 et 23h30")
                RecoveryCurveTile(symbol: "moon.zzz.fill", title: String(localized: "Sommeil profond"), value: "1h12", highlight: 0.42...0.7, peak: 0.9)
            }
            .padding(.horizontal, 20)
            RecoveryTileSection(title: String(localized: "Sommeil")) {
                RecoveryMiniTile(symbol: "bolt.fill", title: String(localized: "Performance"), value: "11.3%", delta: "+1.32 %")
                RecoveryMiniTile(symbol: "dot.radiowaves.left.and.right", title: String(localized: "Efficacité"), value: "7.2%", delta: "+0.3 %")
                RecoveryMiniTile(symbol: "eye.fill", title: String(localized: "Régularité"), value: "5.45%", delta: "-0.26 %")
            }
        }
        .padding(.vertical, 30)
    }
    .background(RecoveryTileTheme.page)
}

/// Police de V2 (Helvetica Neue), pour les tuiles copiées telles quelles.
enum V2Font {
    static func system(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let name = switch weight {
        case .light: "HelveticaNeue-Light"
        case .medium, .semibold: "HelveticaNeue-Medium"
        case .bold: "HelveticaNeue-Bold"
        default: "HelveticaNeue"
        }
        return .custom(name, size: size, relativeTo: .body)
    }
    static func score(size: CGFloat) -> Font { .custom("DINAlternate-Bold", size: size, relativeTo: .body) }
}

// Équivalents MoneyMaker des couleurs de V2 (app toujours en sombre).
fileprivate extension Color {
    static func auto(hex: UInt32, opacity: Double = 1) -> Color {
        Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: opacity)
    }
    static let v2Ink = MMColor.ink
    static let v2InkInverse = MMColor.inkInverse
}

/// Tuile Pas de la page Effort (StrainStepsTile), barres à la couleur de MoneyMaker.
struct RecoveryBarsTile: View {
    let symbol: String
    let title: String
    let value: String
    let history: [Double]
    let footerLead: String
    let footerStrong: String
    var tint: Color = Color(red: 0, green: 0.945, blue: 0.624)

    private var maxValue: Double { max(history.max() ?? 0, 0.0001) }

    var body: some View {
        RecoveryTileSurface(dotsAnchor: .topTrailing, dotsReach: 0.7) {
            VStack(alignment: .leading, spacing: 0) {
                RecoveryTileHeader(symbol: symbol, title: title)
                Text(value).mmNumeric()
                    .font(V2Font.score(size: 30))
                    .foregroundStyle(RecoveryTileTheme.value)
                    .lineLimit(1).minimumScaleFactor(0.6)
                    .padding(.top, 6)
                Spacer(minLength: 8)
                HStack(alignment: .bottom, spacing: 5) {
                    ForEach(Array(history.enumerated()), id: \.offset) { index, v in
                        let isLast = index == history.count - 1
                        RoundedRectangle(cornerRadius: 3, style: .continuous)
                            .fill(isLast ? tint : RecoveryTileTheme.gaugeTrack)
                            .frame(height: max(5, 30 * v / maxValue))
                            .frame(maxWidth: .infinity)
                            .shadow(color: isLast ? tint.opacity(0.5) : .clear, radius: 5)
                    }
                }
                .frame(height: 30)
                HStack(spacing: 4) {
                    Text(footerLead).foregroundStyle(RecoveryTileTheme.footer)
                    Text(footerStrong).foregroundStyle(RecoveryTileTheme.footerStrong)
                }
                .font(V2Font.system(size: 12, weight: .medium))
                .lineLimit(1)
                .padding(.top, 8)
            }
            .padding(16)
        }
        .frame(height: RecoveryTileTheme.tileHeight)
    }
}


/// Tuile large : texte à gauche, graphique à droite.
struct RecoveryWideTile<Chart: View>: View {
    let symbol: String
    let title: String
    let value: String
    let footerLead: String
    let footerStrong: String
    var dotsAnchor: UnitPoint = .topTrailing
    @ViewBuilder var chart: Chart

    var body: some View {
        RecoveryTileSurface(dotsAnchor: dotsAnchor, dotsReach: 0.7) {
            HStack(alignment: .center, spacing: 14) {
                VStack(alignment: .leading, spacing: 0) {
                    RecoveryTileHeader(symbol: symbol, title: title)
                    Text(value).mmNumeric()
                        .font(V2Font.system(size: 24, weight: .medium))
                        .foregroundStyle(RecoveryTileTheme.value)
                        .lineLimit(1).minimumScaleFactor(0.55)
                        .padding(.top, 15)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                chart
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .padding(.horizontal, 16).padding(.vertical, 13)
            .frame(maxWidth: .infinity)
            .frame(height: RecoveryTileTheme.tileHeight)
        }
    }
}

/// Courbe violette épurée (couleurs du curseur MRR) : trait lisse en dégradé,
/// léger voile dessous, point lumineux sur la dernière valeur.
struct RecoveryVioletLine: View {
    let values: [Double]
    /// Point mis en avant (graphique en grand) : trait vertical + point.
    var selected: Int? = nil
    /// Données d'argent : courbe verte au lieu du violet.
    var money = false
    private var bright: Color { money ? Color(red: 0.25, green: 0.92, blue: 0.52) : RecoveryTileTheme.violetBright }
    private var deep: Color { money ? Color(red: 0.06, green: 0.62, blue: 0.32) : RecoveryTileTheme.violetDeep }
    @State private var shown: CGFloat = 0

    var body: some View {
        GeometryReader { g in
            let pts = points(in: g.size)
            ZStack {
                area(pts, height: g.size.height)
                    .fill(LinearGradient(colors: [bright.opacity(0.22), .clear], startPoint: .top, endPoint: .bottom))
                    .opacity(Double(shown))
                curve(pts).trim(from: 0, to: shown)
                    .stroke(LinearGradient(colors: [deep.opacity(0.3), deep, bright],
                                           startPoint: .leading, endPoint: .trailing),
                            style: StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))
                    .shadow(color: bright.opacity(0.45), radius: 6)
                if let i = selected, pts.indices.contains(i) {
                    Path { $0.move(to: CGPoint(x: pts[i].x, y: 0)); $0.addLine(to: CGPoint(x: pts[i].x, y: g.size.height)) }
                        .stroke(MMColor.fg(0.35), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    Circle().fill(Color.v2Ink).frame(width: 11, height: 11)
                        .shadow(color: bright, radius: 6)
                        .position(pts[i])
                }
                if selected == nil, let last = pts.last {
                    Circle().fill(Color.v2Ink).frame(width: 9, height: 9)
                        .shadow(color: .white.opacity(0.7), radius: 4)
                        .position(last)
                        .opacity(shown >= 1 ? 1 : 0)
                }
            }
        }
        .padding(.vertical, 8)
        .onAppear { withAnimation(.easeOut(duration: 0.9).delay(0.15)) { shown = 1 } }
    }

    private func points(in size: CGSize) -> [CGPoint] {
        let v = values.count > 1 ? values : [values.first ?? 0, values.first ?? 0]
        let lo = v.min() ?? 0, hi = v.max() ?? 1, span = hi - lo
        return v.enumerated().map { i, x in
            CGPoint(x: size.width * CGFloat(i) / CGFloat(v.count - 1),
                    y: span > 0 ? size.height * (1 - CGFloat((x - lo) / span)) * 0.9 + size.height * 0.05 : size.height * 0.5)
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

    private func area(_ p: [CGPoint], height: CGFloat) -> Path {
        var path = curve(p)
        guard let first = p.first, let last = p.last else { return path }
        path.addLine(to: CGPoint(x: last.x, y: height))
        path.addLine(to: CGPoint(x: first.x, y: height))
        path.closeSubpath()
        return path
    }
}

/// Barres seules (pour la droite d'une tuile large).
struct RecoveryBars: View {
    let values: [Double]
    var tint: Color = Color(red: 0, green: 0.945, blue: 0.624)
    @State private var shown = false

    var body: some View {
        let hi = max(values.max() ?? 0, 0.0001)
        HStack(alignment: .bottom, spacing: 5) {
            ForEach(Array(values.enumerated()), id: \.offset) { i, v in
                let isLast = i == values.count - 1
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(isLast ? tint : RecoveryTileTheme.gaugeTrack)
                    .frame(height: max(5, 70 * v / hi * (shown ? 1 : 0.05)))
                    .frame(maxWidth: .infinity)
                    .shadow(color: isLast ? tint.opacity(0.5) : .clear, radius: 5)
            }
        }
        .frame(height: 70)
        .frame(maxHeight: .infinity, alignment: .bottom)
        .padding(.bottom, 6)
        .onAppear { withAnimation(RecoveryTileTheme.entrance.delay(0.1)) { shown = true } }
    }
}
