//
//  SideMenu.swift
//  MoneyMaker — menu latéral façon X.
//
//  Adapté de « XStyleSideBar / CustomSideMenu » (Balaji Venkatesh, 08/05/26) :
//  le contenu glisse vers la droite en suivant le doigt, prend des coins
//  concentriques à l'écran et s'assombrit ; le menu apparaît derrière en fondu
//  avec un léger zoom. Le geste respecte les défilements horizontaux.
//
//  Différences : fond noir pur, voile sombre au lieu du gris système, geste UIKit
//  natif sur iOS 18+ (UIGestureRecognizerRepresentable), bouton seul sur iOS 17.
//

import SwiftUI

struct SideMenu<MenuContent: View, Content: View>: View {
    var isEnabled: Bool = true
    var sideBarWidth: CGFloat = 300
    @Binding var isExpanded: Bool
    /// Change quand le contenu doit vraiment être reconstruit (onglet, navigation…). Pendant le
    /// glissé, seul `progress` bouge : le contenu n'est pas recalculé à chaque image.
    var contentKey: AnyHashable = 0
    @ViewBuilder var menuContent: (_ progress: CGFloat) -> MenuContent
    @ViewBuilder var content: (_ progress: CGFloat) -> Content

    @State private var progress: CGFloat = 0
    @State private var xOffset: CGFloat = 0
    @State private var haptics = false

    var body: some View {
        ZStack(alignment: .leading) {
            menuContent(progress)
                .frame(width: sideBarWidth)
                .frame(maxHeight: .infinity)
                .opacity(progress)
                .scaleEffect(0.95 + (0.05 * progress))

            StableContent(key: contentKey, content: content(0))
                .equatable()
                .containerRelativeFrame(.horizontal)
                .frame(maxHeight: .infinity)
                .background { backgroundShape.fill(Color.black).ignoresSafeArea() }
                .overlay {
                    backgroundShape
                        .fill(Color.black.opacity(0.45))
                        .stroke(Color.white.opacity(0.12), lineWidth: 1)
                        .ignoresSafeArea()
                        .contentShape(.rect)
                        .onTapGesture { withAnimation(animation) { dismissMenu() } }
                        .opacity(progress)
                }
                .mask { backgroundShape.ignoresSafeArea() }
                .compositingGroup()
                .shadow(color: .black.opacity(0.5 * progress), radius: 24, x: -10, y: 0)
                .offset(x: xOffset)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.ignoresSafeArea())
        .contentShape(.rect)
        .modifier(SideMenuPan(isEnabled: isEnabled, isExpanded: $isExpanded) { state, translationX, velocityX in
            let translation = translationX + (isExpanded ? sideBarWidth : 0)
            if state == .began || state == .changed {
                xOffset = min(max(translation, 0), sideBarWidth)
                progress = xOffset / sideBarWidth
            } else {
                withAnimation(animation) {
                    if (xOffset + velocityX / 5) > (sideBarWidth / 2) { expandMenu() } else { dismissMenu() }
                }
            }
        })
        .sensoryFeedback(.impact(weight: .light), trigger: haptics)
        .onChange(of: isExpanded) { _, newValue in
            withAnimation(animation) {
                if newValue && progress != 1 { expandMenu() }
                if !newValue && progress != 0 { dismissMenu() }
            }
        }
    }

    private func expandMenu() {
        if !isExpanded { haptics.toggle() }
        xOffset = sideBarWidth; progress = 1; isExpanded = true
    }

    private func dismissMenu() {
        if isExpanded { haptics.toggle() }
        xOffset = 0; progress = 0; isExpanded = false
    }

    private var backgroundShape: some Shape {
        if #available(iOS 26, *) {
            return ConcentricRectangle(corners: .concentric, isUniform: true)
        } else {
            return RoundedRectangle(cornerRadius: 50, style: .continuous)
        }
    }

    private var animation: Animation { .interactiveSpring(duration: 0.25, extraBounce: 0.02) }
}

// MARK: - Geste

/// Glisser horizontal : UIKit sur iOS 18+ (cède la priorité aux défilements horizontaux), rien sur iOS 17.
private struct SideMenuPan: ViewModifier {
    var isEnabled: Bool
    @Binding var isExpanded: Bool
    var handle: (UIGestureRecognizer.State, CGFloat, CGFloat) -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.gesture(SideMenuGesture(isEnabled: isEnabled, isExpanded: $isExpanded) { g in
                handle(g.state, g.translation(in: g.view).x, g.velocity(in: g.view).x)
            })
        } else {
            content
        }
    }
}

@available(iOS 18.0, *)
private struct SideMenuGesture: UIGestureRecognizerRepresentable {
    var isEnabled: Bool
    @Binding var isExpanded: Bool
    var handle: (UIPanGestureRecognizer) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let gesture = UIPanGestureRecognizer()
        gesture.delegate = context.coordinator
        gesture.maximumNumberOfTouches = 1
        return gesture
    }

    func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
        recognizer.isEnabled = isEnabled
        context.coordinator.parent = self
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) { handle(recognizer) }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: SideMenuGesture
        init(parent: SideMenuGesture) { self.parent = parent }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
            let v = pan.velocity(in: pan.view)
            let horizontal = abs(v.x) > abs(v.y)
            return (horizontal && v.x > 0) || (horizontal && v.x < 0 && parent.isExpanded)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            if let scroll = other.view as? UIScrollView { return scroll.contentOffset.x <= 0 }
            return false
        }
    }
}

/// Contenu qui ne se redessine que si sa clé change (ses vues internes restent réactives à leurs propres données).
private struct StableContent<C: View>: View, Equatable {
    let key: AnyHashable
    let content: C
    var body: some View { content }
    static func == (a: Self, b: Self) -> Bool { a.key == b.key }
}
