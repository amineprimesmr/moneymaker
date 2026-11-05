//
//  AdaptiveLayout.swift
//  MoneyMaker — grands écrans : iPad, écran intérieur de l'iPhone Duo, Split View.
//
//  Tout se décide sur la largeur réellement disponible, jamais sur le modèle d'appareil :
//  un même appareil change de taille en se pliant, en tournant ou en multitâche.
//

import SwiftUI

enum MMAdaptive {
    /// Colonne de lecture des pages : au-delà, les cartes s'étireraient sans rien montrer de plus.
    static let readableWidth: CGFloat = 720
    /// Formulaires et écrans de connexion.
    static let formWidth: CGFloat = 520
    /// À partir de cette largeur, le menu des business reste affiché à gauche.
    static let sidebarMinWidth: CGFloat = 900
    static let sidebarWidth: CGFloat = 320
    /// Le tutoriel réduit l'app dans un faux iPhone : il n'a de sens que dans une fenêtre de téléphone.
    /// (L'écran extérieur de l'iPhone Duo, plus large, et l'iPad en sont exclus.)
    static func allowsTutorial(in size: CGSize) -> Bool { size.width <= 450 && size.height <= 1000 }
}

extension EnvironmentValues {
    /// Le menu des business est affiché en permanence : le bouton qui l'ouvre disparaît.
    @Entry var mmPinnedSidebar = false
}

extension View {
    /// Centre la page dans la colonne de lecture ; le fond reste en pleine largeur.
    func mmReadableColumn(_ width: CGFloat = MMAdaptive.readableWidth) -> some View {
        frame(maxWidth: width).frame(maxWidth: .infinity)
    }

    /// Même colonne pour un écran plein cadre, qui n'a pas de fond derrière lui.
    func mmCoverColumn() -> some View {
        mmReadableColumn().background(MMColor.bg.ignoresSafeArea())
    }
}
