//
//  ThemePicker.swift
//  MoneyMaker — choix de l'apparence (Système / Clair / Sombre).
//
//  Porté d'ATPicker (Balaji Venkatesh) : aperçu animé soleil / lune / étoiles / collines,
//  segmenté à capsule glissante. Adapté au design MoneyMaker (Helvetica Neue, cartes 28 pt,
//  iOS 17 : pas de ConcentricRectangle ni de Color.mix), intégré en ligne dans les Réglages.
//

import SwiftUI
import UIKit

// MARK: - Préférence

enum AppTheme: String, CaseIterable, Identifiable {
    case system, light, dark

    static let storageKey = "mm.theme"
    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return String(localized: "Système")
        case .light: return String(localized: "Clair")
        case .dark: return String(localized: "Sombre")
        }
    }

    var symbol: String {
        switch self {
        case .light: return "sun.max.fill"
        case .dark: return "moon.fill"
        case .system: return "circle.lefthalf.filled"
        }
    }

    var caption: String {
        switch self {
        case .light: return String(localized: "L'apparence claire reste active, jour et nuit.")
        case .dark: return String(localized: "L'apparence sombre reste active, jour et nuit.")
        case .system: return String(localized: "Suit les réglages de ton iPhone, jour et nuit.")
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    var interfaceStyle: UIUserInterfaceStyle {
        switch self {
        case .system: return .unspecified
        case .light: return .light
        case .dark: return .dark
        }
    }

    static var current: AppTheme { AppTheme(rawValue: UserDefaults.standard.string(forKey: storageKey) ?? "") ?? .system }

    /// Applique le thème à toutes les fenêtres (sheets et fullScreenCovers compris).
    /// Transition : une capture de l'écran actuel est posée par-dessus, le thème change dessous
    /// d'un coup (un seul recalcul), puis la capture s'efface. Aucun rendu intermédiaire à moitié
    /// clair / à moitié sombre, et rien d'animé dans l'arbre SwiftUI.
    @MainActor
    static func apply(_ theme: AppTheme, animated: Bool) {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        for w in windows where w.overrideUserInterfaceStyle != theme.interfaceStyle {
            guard animated, !w.isHidden, w.bounds.width > 0, let snap = w.snapshotView(afterScreenUpdates: false) else {
                w.overrideUserInterfaceStyle = theme.interfaceStyle
                continue
            }
            snap.isUserInteractionEnabled = false
            w.addSubview(snap)
            w.overrideUserInterfaceStyle = theme.interfaceStyle
            UIView.animate(withDuration: 0.4, delay: 0.05, options: [.curveEaseInOut, .allowUserInteraction]) {
                snap.alpha = 0
            } completion: { _ in snap.removeFromSuperview() }
        }
    }
}

/// Applique `mm.theme` à la racine via la fenêtre UIKit (le retour à « Système »
/// est fiable et les sheets déjà ouvertes basculent aussi).
struct AppThemeModifier: ViewModifier {
    @AppStorage(AppTheme.storageKey) private var raw = AppTheme.system.rawValue
    func body(content: Content) -> some View {
        let theme = AppTheme(rawValue: raw) ?? .system
        // Uniquement la fenêtre UIKit : doubler avec preferredColorScheme faisait basculer SwiftUI
        // avant la fenêtre (deux recalculs, fondu raté, parfois un écran resté dans l'ancien mode).
        content
            .onAppear { AppTheme.apply(theme, animated: false) }
            .onChange(of: raw) { _, new in AppTheme.apply(AppTheme(rawValue: new) ?? .system, animated: true) }
    }
}

extension View {
    func mmAppTheme() -> some View { modifier(AppThemeModifier()) }
}

// MARK: - Sélecteur (aperçu animé + segmenté)

struct ThemePicker: View {
    @Binding var value: AppTheme
    @Environment(\.colorScheme) private var colorScheme
    @State private var isDark = true
    @Namespace private var animation

    var body: some View {
        VStack(spacing: 14) {
            AnimatedPreview()
                .frame(height: 170)

            segmented

            Text(value.caption)
                .font(MMFont.system(13))
                .foregroundStyle(MMColor.ink2)
                .lineLimit(1).minimumScaleFactor(0.8)
                .contentTransition(.opacity)
                .animation(.smooth(duration: 0.45, extraBounce: 0), value: value)
        }
        .sensoryFeedback(.selection, trigger: value)
        .onAppear { isDark = colorScheme == .dark }
        // L'aperçu suit le mode réellement affiché (donc aussi « Système »), pas la valeur choisie.
        .onChange(of: colorScheme) { _, new in
            DispatchQueue.main.async {
                withAnimation(.interpolatingSpring(duration: 1, bounce: 0, initialVelocity: 0)) { isDark = new == .dark }
            }
        }
    }

    // MARK: Aperçu

    @ViewBuilder
    private func AnimatedPreview() -> some View {
        GeometryReader {
            let size = $0.size
            let gradient = isDark ? [Palette.darkTop, Palette.darkBottom] : [Palette.lightTop, Palette.lightBottom]
            ZStack {
                LinearGradient(colors: gradient, startPoint: .top, endPoint: .bottom)

                StarsView(count: 18).opacity(isDark ? 1 : 0)

                // Soleil et lune tournent autour d'un même axe.
                ZStack {
                    Image(systemName: "moon.fill")
                        .font(.system(size: 42))
                        .foregroundStyle(Palette.moon)
                        .shadow(color: Palette.moon.opacity(0.6), radius: 15)
                        .rotationEffect(.degrees(isDark ? -130 : 0))
                        .frame(width: size.width, height: size.width)
                        .offset(x: -(size.width - 40) / 2)
                        .rotationEffect(.degrees(isDark ? 130 : -30))
                        .offset(y: 10)

                    Image(systemName: "sun.max.fill")
                        .font(.system(size: 72, weight: .ultraLight))
                        .foregroundStyle(.yellow)
                        .shadow(color: .white, radius: 15)
                        .compositingGroup()
                        .keyframeAnimator(initialValue: CGFloat.zero, repeating: true) { content, rotation in
                            content.rotationEffect(.degrees(rotation))
                        } keyframes: { _ in
                            LinearKeyframe(360, duration: 60)
                        }
                        .frame(width: size.width, height: size.width)
                        .offset(x: -(size.width - 40) / 2)
                        .rotationEffect(.degrees(isDark ? 200 : 130))
                        .offset(y: 10)
                }
                .frame(width: size.width, height: size.height, alignment: .top)

                // Étoile filante, la nuit seulement.
                if isDark {
                    KeyframeAnimator(initialValue: CGFloat.zero, repeating: true) { offset in
                        let opacity = max(min(offset / 200, 1), 0)
                        Capsule()
                            .fill(LinearGradient(colors: [Palette.moon, Palette.moon.opacity(0.5), Palette.moon.opacity(0.3), .clear],
                                                 startPoint: .trailing, endPoint: .leading))
                            .frame(width: 100, height: 2)
                            .offset(x: offset, y: 25)
                            .rotationEffect(.degrees(25))
                            .opacity(1 - opacity)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    } keyframes: { _ in
                        MoveKeyframe(-100)
                        LinearKeyframe(-100, duration: 1.5)
                        CubicKeyframe(200, duration: 1.8)
                        LinearKeyframe(200, duration: 3)
                    }
                }

                // Nuages, le jour.
                HStack(spacing: 0) {
                    cloud(44).offset(x: isDark ? -100 : 0, y: -26)
                    Spacer(minLength: 0)
                    cloud(48).offset(x: isDark ? 100 : 0)
                    Spacer(minLength: 0)
                    cloud(36).offset(x: isDark ? 100 : 0, y: 30)
                }
                .padding(.horizontal, 20)
                .compositingGroup()
                .blur(radius: isDark ? 30 : 0)
                .opacity(isDark ? 0 : 1)

                // Collines + maison éclairée la nuit.
                ZStack {
                    GroundShape(density: 0.5).fill(isDark ? Palette.hillTopDark : Palette.hillTopLight)
                    GroundShape(density: 0.35).fill(isDark ? Palette.hillCenterDark : Palette.hillCenterLight)
                    GroundShape(density: 0.2).fill(isDark ? Palette.hillBottomDark : Palette.hillBottomLight)
                    Image(systemName: "house.lodge.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(Color(white: isDark ? 0.1 : 0.4))
                        .background(alignment: .bottom) {
                            Circle().fill(.yellow.opacity(isDark ? 1 : 0)).frame(width: 11, height: 11)
                                .shadow(color: .yellow.opacity(isDark ? 1 : 0), radius: 5)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                        .offset(x: 50, y: -84 * 0.37)
                }
                .frame(height: 84)
                .frame(maxHeight: .infinity, alignment: .bottom)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(MMColor.cardBorder, lineWidth: 1) }
        .accessibilityHidden(true)
    }

    private func cloud(_ size: CGFloat) -> some View {
        Image(systemName: "cloud.fill").font(.system(size: size)).foregroundStyle(.white).shadow(color: .black.opacity(0.1), radius: 5)
    }

    // MARK: Segmenté

    private var segmented: some View {
        HStack(spacing: 0) {
            ForEach(AppTheme.allCases) { theme in
                let selected = value == theme
                let tint: Color = isDark ? RecoveryTileTheme.violetBright : Palette.sunTint
                let rotation: CGFloat = theme == .light ? 180 : theme == .dark ? -15 : (isDark ? 180 : 0)
                Button {
                    value = theme
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: theme.symbol)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(selected ? tint : MMColor.ink)
                            .rotationEffect(.degrees(selected ? rotation : 0))
                        Text(theme.title)
                            .font(MMFont.system(15, .medium))
                            .foregroundStyle(MMColor.ink)
                            .lineLimit(1).minimumScaleFactor(0.8)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background {
                        if selected {
                            ZStack {
                                Capsule().fill(MMColor.surface)
                                Capsule().stroke(tint, lineWidth: 1.5).padding(0.5)
                            }
                            .compositingGroup()
                            .shadow(color: tint.opacity(0.3), radius: 10)
                            .matchedGeometryEffect(id: "mm.theme.capsule", in: animation)
                        }
                    }
                    .contentShape(.capsule)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .frame(height: 42)
        .padding(4)
        .background(MMColor.fg(0.07), in: .capsule)
        .animation(.bouncy(duration: 0.5, extraBounce: 0.1), value: value)
    }

    // MARK: Palette de l'aperçu

    private enum Palette {
        static let darkTop = MMColor.hex(0x0B0B1E)
        static let darkBottom = MMColor.hex(0x2A1F5C)
        static let lightTop = MMColor.hex(0x7CC4FF)
        static let lightBottom = MMColor.hex(0xD9EEFF)
        static let moon = MMColor.hex(0xE8E6FF)
        static let sunTint = MMColor.hex(0xFFB020)
        static let hillTopDark = MMColor.hex(0x2B2350)
        static let hillCenterDark = MMColor.hex(0x1D1838)
        static let hillBottomDark = MMColor.hex(0x120F24)
        static let hillTopLight = MMColor.hex(0x9ED88A)
        static let hillCenterLight = MMColor.hex(0x6CC06A)
        static let hillBottomLight = MMColor.hex(0x46A253)
    }
}

private struct StarsView: View {
    var count: Int
    var body: some View {
        Canvas { context, size in
            for i in 0..<count {
                let x = random(i, 1) * size.width
                let y = random(i, 2) * size.height * 0.7
                let d = random(i, 3) > 0.66 ? 3.0 : 2.0
                context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: d, height: d)), with: .color(.white.opacity(0.5 + random(i, 4) * 0.5)))
            }
        }
        .allowsHitTesting(false)
    }

    private func random(_ i: Int, _ seed: Double) -> Double {
        let value = sin(Double(i) * 22.5 + seed * 99.2) * 43.6
        return value - value.rounded(.down)
    }
}

private struct GroundShape: Shape {
    var density: CGFloat
    func path(in rect: CGRect) -> Path {
        let width = rect.width, height = rect.height
        let base = height * (1 - density), wave = height * density * 0.55
        return Path { p in
            p.move(to: CGPoint(x: 0, y: base))
            p.addCurve(to: CGPoint(x: width * 0.5, y: base + wave * 0.3),
                       control1: CGPoint(x: width * 0.18, y: base - wave), control2: CGPoint(x: width * 0.35, y: base - wave * 0.8))
            p.addCurve(to: CGPoint(x: width, y: base - wave * 0.4),
                       control1: CGPoint(x: width * 0.65, y: base + wave * 1.4), control2: CGPoint(x: width * 0.85, y: base - wave))
            p.addLine(to: CGPoint(x: width, y: height))
            p.addLine(to: CGPoint(x: 0, y: height))
            p.closeSubpath()
        }
    }
}
