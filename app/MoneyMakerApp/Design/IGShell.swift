//
//  IGShell.swift
//  MoneyMaker — coque façon Instagram.
//
//  Adapté de « InstagramStyleTabBar » (Balaji Venkatesh, 24/07/26 et 18/10/26) :
//  - le menu des business est une page entière cachée à gauche : l'app glisse vers la droite
//    en suivant le doigt, coins concentriques, le menu arrive derrière avec une parallaxe ;
//  - la tab bar est un UISegmentedControl en Liquid Glass qui rétrécit quand on fait défiler
//    vers le bas et revient dès qu'on la touche ou qu'on remonte.
//  iOS 26 seulement (verre natif, ConcentricRectangle) ; avant, l'ancienne coque reste en place.
//

import SwiftUI
import UIKit

/// État partagé de la coque : seules les petites vues qui l'observent se redessinent
/// pendant un glissé (le bouton du menu, la tab bar), jamais les écrans entiers.
@MainActor
final class IGChrome: ObservableObject {
    static let shared = IGChrome()
    /// 0 = app visible, 1 = menu ouvert.
    @Published var menuProgress: CGFloat = 0 {
        didSet {
            let v = menuProgress > 0.001
            if IGMenuVisibility.shared.visible != v { IGMenuVisibility.shared.visible = v }
        }
    }
}

/// Menu visible ou non : ne change qu'au début et à la fin du glissement (pas à chaque image).
@MainActor
final class IGMenuVisibility: ObservableObject {
    static let shared = IGMenuVisibility()
    @Published var visible = false
}

/// État de la tab bar, séparé du menu : il change à chaque image pendant le défilement,
/// et seule la tab bar doit alors se redessiner (pas la coque, le menu ou les écrans).
@MainActor
final class IGTabChrome: ObservableObject {
    static let shared = IGTabChrome()
    /// 0 = tab bar pleine taille, 1 = réduite.
    @Published var tabProgress: CGFloat = 0
}

// MARK: - Menu en page entière

@available(iOS 26.0, *)
struct IGAccessoryView<Accessory: View, Content: View>: View {
    var isEnabled: Bool
    @Binding var isVisible: Bool
    var contentKey: AnyHashable = 0
    /// Change quand le menu doit vraiment être reconstruit (ses données) : jamais à l'ouverture,
    /// sinon tout le menu se recalcule sur la première image de l'animation et elle saccade.
    var accessoryKey: AnyHashable = 0
    /// Largeur du menu : l'app glisse de cette largeur et reste visible à droite.
    var sideBarWidth: CGFloat = 300
    /// Fond pleine largeur derrière le menu et l'app : visible aussi dans les coins arrondis de l'app.
    var backdrop: AnyView = AnyView(MMColor.bg.ignoresSafeArea())
    @ViewBuilder var accessory: () -> Accessory
    @ViewBuilder var content: () -> Content

    @ObservedObject private var chrome = IGChrome.shared
    @State private var containerWidth: CGFloat = 1
    @State private var haptics = false
    @State private var safeTop: CGFloat = 0
    @State private var safeBottom: CGFloat = 0

    var body: some View {
        let progress = chrome.menuProgress
        IGStable(key: contentKey, content: content())
            .equatable()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                ConcentricRectangle(corners: .concentric, isUniform: true)
                    .fill(MMColor.bg)
                    .ignoresSafeArea()
            }
            .overlay {
                // Toucher l'app qui dépasse referme le menu.
                ConcentricRectangle(corners: .concentric, isUniform: true)
                    .stroke(MMColor.fg(0.12), lineWidth: 1)
                    .opacity(progress)
                    .ignoresSafeArea()
                    .contentShape(.rect)
                    .allowsHitTesting(progress > 0.01)
                    .onTapGesture { isVisible = false }
            }
            // Découpe étendue aux zones sûres (barre d'état, bas) pour ne laisser aucun trou ;
            // menu fermé, elle déborde largement : aucun arrondi visible, aucun rendu hors champ.
            .clipShape(ScreenCornerShape(top: safeTop, bottom: safeBottom, radius: progress > 0.001 ? 55 : 0,
                                         slack: progress > 0.001 ? 0 : 1000))
            .onGeometryChange(for: EdgeInsets.self) { $0.safeAreaInsets } action: { safeTop = $0.top; safeBottom = $0.bottom }
            .offset(x: progress * menuWidth)
            .background(alignment: .leading) {
                // Le menu ne se réévalue ni à chaque image du glissé ni à l'ouverture : seulement quand
                // ses données changent (accessoryKey) ou sur ses propres états observés.
                IGStable(key: accessoryKey, content: accessory())
                    .equatable()
                    .frame(width: menuWidth)
                    .frame(maxHeight: .infinity)
                    .compositingGroup()
                    .opacity(0.5 + min(progress, 0.5))
                    .offset(x: (1 - progress) * (-menuWidth / 6))
            }
            .contentShape(.rect)
            .gesture(IGPanGesture(isEnabled: isEnabled, isVisible: $isVisible) { g in
                let translation = g.translation(in: g.view).x + (isVisible ? menuWidth : 0)
                let velocity = g.velocity(in: g.view).x / 5
                if g.state == .began || g.state == .changed {
                    chrome.menuProgress = max(min(translation / menuWidth, 1), 0)
                } else {
                    let open = translation + velocity > menuWidth / 2
                    if open != isVisible { haptics.toggle() }
                    withAnimation(animation) {
                        isVisible = open
                        chrome.menuProgress = open ? 1 : 0
                    }
                }
            })
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { containerWidth = max($0, 1) }
            .onChange(of: isVisible, initial: true) { _, v in
                withAnimation(animation) {
                    if v && chrome.menuProgress != 1 { chrome.menuProgress = 1 }
                    if !v && chrome.menuProgress != 0 { chrome.menuProgress = 0 }
                }
            }
            .sensoryFeedback(.impact(weight: .light), trigger: haptics)
            .background { backdrop }
    }

    private var menuWidth: CGFloat { min(sideBarWidth, containerWidth) }

    private var animation: Animation { .interpolatingSpring(duration: 0.3, bounce: 0, initialVelocity: 0) }
}

@available(iOS 26.0, *)
private struct IGPanGesture: UIGestureRecognizerRepresentable {
    var isEnabled: Bool
    @Binding var isVisible: Bool
    var handle: (UIPanGestureRecognizer) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let g = UIPanGestureRecognizer()
        g.maximumNumberOfTouches = 1
        g.delegate = context.coordinator
        return g
    }

    func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
        recognizer.isEnabled = isEnabled || isVisible
        context.coordinator.parent = self
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) { handle(recognizer) }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: IGPanGesture
        init(parent: IGPanGesture) { self.parent = parent }

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard let pan = g as? UIPanGestureRecognizer else { return false }
            let v = pan.velocity(in: pan.view)
            let horizontal = abs(v.x) > abs(v.y)
            return (horizontal && v.x > 0) || (horizontal && v.x < 0 && parent.isVisible)
        }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            if let scroll = other.view as? UIScrollView { return scroll.contentOffset.x <= 0 }
            return true
        }
    }
}

private struct IGStable<C: View>: View, Equatable {
    let key: AnyHashable
    let content: C
    var body: some View { content }
    static func == (a: Self, b: Self) -> Bool { a.key == b.key }
}

// MARK: - Bouton du menu (le « + » d'Instagram : contour qui se trace, puis se remplit)

struct IGMenuButton: View {
    var action: () -> Void
    @ObservedObject private var chrome = IGChrome.shared

    var body: some View {
        let progress = min(chrome.menuProgress * 2, 1)
        let expanded = progress == 1
        Button(action: action) {
            ZStack {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(MMColor.ink)
                    .opacity(expanded ? 1 : 0)
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .trim(from: 0, to: progress)
                    .stroke(MMColor.ink, lineWidth: 2)
                    .rotationEffect(.degrees(-90))
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(expanded ? MMColor.inkInverse : MMColor.ink)
                    .animation(.snappy) { $0.scaleEffect(progress != 0 ? 0.8 : 1) }
            }
            .frame(width: 34, height: 34)
            .animation(.snappy, value: expanded)
            .keyframeAnimator(initialValue: 1.0, trigger: expanded) { c, s in c.scaleEffect(s) } keyframes: { _ in
                MoveKeyframe(1.0)
                CubicKeyframe(0.8, duration: 0.15)
                CubicKeyframe(1, duration: 0.15)
            }
            .frame(width: 42, height: 42)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Business connectés")
    }
}

// MARK: - Tab bar

@available(iOS 26.0, *)
struct IGTabBar: View {
    @Binding var selection: Int
    let items: [MMTabBar.Item]
    var onReselect: (Int) -> Void

    @ObservedObject private var chrome = IGTabChrome.shared

    var body: some View {
        IGSegmented(selection: $selection, icons: items.map(\.icon), onReselect: onReselect) {
            if chrome.tabProgress != 0 {
                withAnimation(.interpolatingSpring(duration: 0.25, bounce: 0, initialVelocity: 0)) { chrome.tabProgress = 0 }
            }
        }
        .padding(4)
        .glassEffect(.regular.interactive(), in: .capsule)
        .scaleEffect(1 - chrome.tabProgress * 0.15, anchor: .bottom)
        .padding(.horizontal, 20)
        .sensoryFeedback(.selection, trigger: selection)
    }
}

@available(iOS 26.0, *)
private struct IGSegmented: UIViewRepresentable {
    @Binding var selection: Int
    let icons: [String]
    var onReselect: (Int) -> Void
    var onInteraction: () -> Void

    func makeUIView(context: Context) -> IGSegmentControl {
        let images = icons.compactMap {
            UIImage(systemName: $0)?.withConfiguration(UIImage.SymbolConfiguration(font: .systemFont(ofSize: 20)))
        }
        let control = IGSegmentControl(items: images)
        control.selectedSegmentIndex = selection
        control.selectedSegmentTintColor = UIColor(Color.gray.opacity(0.25))
        control.tintColor = .label
        control.addTarget(context.coordinator, action: #selector(Coordinator.valueChanged(_:)), for: .valueChanged)
        control.onTouchBegan = onInteraction
        control.onReselect = { onReselect(control.selectedSegmentIndex) }
        // Fond du segmented retiré : seul le verre reste.
        DispatchQueue.main.async {
            for v in control.subviews where v is UIImageView && v != control.subviews.last { v.alpha = 0 }
        }
        return control
    }

    func updateUIView(_ uiView: IGSegmentControl, context: Context) {
        context.coordinator.parent = self
        uiView.onTouchBegan = onInteraction
        if uiView.selectedSegmentIndex != selection { uiView.selectedSegmentIndex = selection }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: IGSegmentControl, context: Context) -> CGSize? {
        CGSize(width: proposal.replacingUnspecifiedDimensions().width, height: 50)
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject {
        var parent: IGSegmented
        init(parent: IGSegmented) { self.parent = parent }
        @MainActor @objc func valueChanged(_ sender: UISegmentedControl) {
            withAnimation(.snappy) { parent.selection = sender.selectedSegmentIndex }
        }
    }
}

final class IGSegmentControl: UISegmentedControl {
    var onTouchBegan: (() -> Void)?
    var onReselect: (() -> Void)?
    private var indexAtTouch = -1

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        indexAtTouch = selectedSegmentIndex
        super.touchesBegan(touches, with: event)
        onTouchBegan?()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesEnded(touches, with: event)
        if selectedSegmentIndex == indexAtTouch { onReselect?() }
    }
}

// MARK: - Tab bar qui rétrécit au défilement

extension View {
    /// À poser sur le ScrollView principal d'un onglet : la tab bar rétrécit quand on descend.
    @ViewBuilder
    func igShrinksTabBar() -> some View {
        if #available(iOS 26.0, *) { modifier(IGTabBarScroll()) } else { self }
    }
}

@available(iOS 26.0, *)
private struct IGTabBarScroll: ViewModifier {
    /// Écrit sans observer : observer ici redessinerait tout l'écran défilant à chaque image.
    private var chrome: IGTabChrome { IGTabChrome.shared }
    /// Suivi du défilement hors de l'état SwiftUI : rien n'est invalidé à chaque image.
    @State private var track = Track()

    final class Track {
        var dragging = false
        var scrolledUp: Bool?
        var shift: CGFloat = 0
        var offset: CGFloat = 0
        var larger = false
    }

    private let distance: CGFloat = 100
    private let animation = Animation.interpolatingSpring(duration: 0.25, bounce: 0, initialVelocity: 0)

    // Plus de DragGesture simultané (il concurrençait le défilement) : la phase du scroll suffit.
    func body(content: Content) -> some View {
        content
            .onScrollPhaseChange { old, new in
                let scrolling = new != .idle
                if ScrollActivity.shared.scrolling != scrolling { ScrollActivity.shared.scrolling = scrolling }
                let t = track
                if new == .interacting { t.dragging = true; return }
                guard old == .interacting else { return }
                t.dragging = false
                let clamped = max(0, min(1, (t.offset - t.shift) / distance))
                let target: CGFloat = t.offset > distance / 2 && t.larger ? (clamped > 0.5 ? 1 : 0) : 0
                if target != chrome.tabProgress { withAnimation(animation) { chrome.tabProgress = target } }
                t.scrolledUp = nil
                t.shift = t.offset - target * distance
            }
            .onScrollGeometryChange(for: Bool.self, of: { $0.contentSize.height > $0.containerSize.height }) { _, v in
                track.larger = v
            }
            .onScrollGeometryChange(for: CGFloat.self, of: { $0.contentOffset.y + $0.contentInsets.top }) { old, new in
                let t = track
                t.offset = new
                guard t.dragging else { return }
                let up = old < new
                if t.scrolledUp != up {
                    t.scrolledUp = up
                    t.shift = new - chrome.tabProgress * distance
                }
                let clamped = max(0, min(1, (new - t.shift) / distance))
                // Pas d'animation par image (le doigt pilote déjà la valeur) ; écriture seulement si elle change vraiment.
                if abs(clamped - chrome.tabProgress) > 0.01 { chrome.tabProgress = clamped }
            }
    }
}

/// Applique la réduction au défilement à n'importe quelle tab bar ; un toucher la remet en taille.
struct ShrinkingTabBar<Bar: View>: View {
    @ViewBuilder var bar: () -> Bar
    @ObservedObject private var chrome = IGTabChrome.shared

    var body: some View {
        bar()
            .scaleEffect(1 - chrome.tabProgress * 0.15, anchor: .bottom)
            .simultaneousGesture(TapGesture().onEnded {
                if chrome.tabProgress != 0 {
                    withAnimation(.interpolatingSpring(duration: 0.25, bounce: 0, initialVelocity: 0)) { chrome.tabProgress = 0 }
                }
            })
    }
}


/// Vrai pendant qu'une page défile : les animations continues (planète) se mettent en pause
/// pour laisser toute la puissance au défilement. Observable : seules les vues qui le lisent se redessinent.
@Observable final class ScrollActivity {
    static let shared = ScrollActivity()
    var scrolling = false
}


/// Rectangle de l'écran entier (zones sûres comprises) aux coins de l'écran.
struct ScreenCornerShape: Shape {
    var top: CGFloat, bottom: CGFloat, radius: CGFloat, slack: CGFloat
    func path(in r: CGRect) -> Path {
        let full = CGRect(x: r.minX - slack, y: r.minY - top - slack, width: r.width + 2 * slack, height: r.height + top + bottom + 2 * slack)
        return RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: full)
    }
}
