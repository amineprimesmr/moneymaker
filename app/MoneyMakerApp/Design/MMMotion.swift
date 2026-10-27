//
//  MMMotion.swift
//  Mouvement commun de l'app : mêmes courbes partout, montants qui défilent chiffre par chiffre,
//  et un état « mise à jour » pendant que les chiffres sont recalculés (devise, période, sources).
//

import SwiftUI

enum MMMotion {
    /// Données qui changent (nouvelle devise, nouvelle période, rafraîchissement).
    static let data = Animation.smooth(duration: 0.6, extraBounce: 0.04)
    /// Réglage qui bascule : réponse immédiate, sans rebond.
    static let settle = Animation.smooth(duration: 0.38)
    /// Contenu qui apparaît ou change de forme (cartes, lignes, sections).
    static let reveal = Animation.spring(response: 0.5, dampingFraction: 0.84)
    /// Petits éléments vifs (pastilles, coches, valeurs d'un réglage).
    static let snappy = Animation.snappy(duration: 0.3, extraBounce: 0.08)
}

extension View {
    /// Montant ou compteur : les chiffres roulent au lieu de sauter.
    func mmNumeric() -> some View {
        contentTransition(.numericText()).monospacedDigit()
    }

    /// Pendant un recalcul, le contenu se floute légèrement puis revient net avec les nouvelles valeurs.
    func mmUpdating(_ active: Bool) -> some View {
        modifier(UpdatingModifier(active: active))
    }

    /// Insertion ou retrait d'une section : glisse, fond et défloute (au lieu d'apparaître d'un coup).
    func mmSectionTransition() -> some View {
        transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 12)).combined(with: .scale(scale: 0.98, anchor: .top)),
                               removal: .opacity.combined(with: .scale(scale: 0.98, anchor: .top))))
    }

    /// Retour haptique léger à chaque changement, si les haptiques sont activés.
    func mmSettingFeedback<T: Equatable>(_ trigger: T) -> some View {
        sensoryFeedback(.selection, trigger: trigger) { _, _ in AppPrefs.haptics }
    }
}

private struct UpdatingModifier: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .opacity(active ? 0.45 : 1)
            .blur(radius: active && !reduceMotion ? 3 : 0)
            .scaleEffect(active && !reduceMotion ? 0.985 : 1)
            .animation(MMMotion.data, value: active)
            .allowsHitTesting(!active)
    }
}
