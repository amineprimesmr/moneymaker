//
//  BuildDemo.swift
//  MoneyMaker — mode « construction » pour la vidéo de démo (DEBUG uniquement, MM_BUILD_DEMO=1).
//
//  Chaque section se construit une seule fois, à son tour, dans l'ordre où elle devient visible :
//  contour tracé en accent, squelette, puis le contenu se pose. Ce qui est déjà construit
//  (tab bar, en-tête, pages visitées) ne bouge plus. Hors de ce mode, rien ne change.
//

import SwiftUI

enum BuildDemo {
    #if DEBUG
    static let isOn = ProcessInfo.processInfo.environment["MM_BUILD_DEMO"] != nil
    #else
    static let isOn = false
    #endif
    /// Écart entre deux sections.
    static let step = 0.11
    @MainActor private static var next = Date.distantPast

    /// File d'attente globale : délai avant que la section suivante puisse se construire.
    @MainActor static func slot() -> Double {
        let now = Date()
        // Nouvelle page (file vide) : petit temps d'avance pour que la transition se termine.
        // Jamais plus de 1,6 s d'attente : une longue liste ne bloque pas la page suivante.
        let at = min(next < now ? now.addingTimeInterval(0.35) : next, now.addingTimeInterval(1.6))
        next = at.addingTimeInterval(step)
        return at.timeIntervalSince(now)
    }
}

private struct BuildStep: ViewModifier {
    var radius: CGFloat
    /// 0 caché, 1 squelette, 2 posé, 3 terminé.
    @State private var phase = 0
    @State private var started = false
    @ObservedObject private var launch = LaunchCoordinator.shared
    @Environment(\.mmTabVisible) private var tabVisible

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .opacity(phase >= 2 ? 1 : 0)
            .blur(radius: phase >= 2 ? 0 : 10)
            .scaleEffect(phase >= 2 ? 1 : 0.94, anchor: .top)
            .offset(y: phase >= 2 ? 0 : 16)
            .background {
                ZStack {
                    shape.fill(Color.primary.opacity(0.06)).opacity(phase == 1 ? 1 : 0)
                    shape.trim(from: 0, to: phase >= 1 ? 1 : 0)
                        .stroke(MMColor.accent, lineWidth: 1.5)
                        .shadow(color: MMColor.accent.opacity(0.7), radius: 8)
                        .opacity(phase == 1 ? 1 : 0)
                }
                .allowsHitTesting(false)
            }
            .onAppear { start() }
            .onChange(of: launch.revealed) { _, _ in start() }
            .onChange(of: tabVisible) { _, _ in start() }
    }

    private func start() {
        guard !started, launch.revealed, tabVisible else { return }
        started = true
        let delay = BuildDemo.slot()
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            withAnimation(.easeOut(duration: 0.3)) { phase = 1 }
            try? await Task.sleep(for: .seconds(0.26))
            withAnimation(.spring(response: 0.42, dampingFraction: 0.78)) { phase = 2 }
            try? await Task.sleep(for: .seconds(0.35))
            withAnimation(.easeOut(duration: 0.3)) { phase = 3 }
        }
    }
}

extension View {
    /// Construction de la section en mode démo ; sans effet sinon.
    @ViewBuilder
    func mmBuild(radius: CGFloat = 22) -> some View {
        if BuildDemo.isOn { modifier(BuildStep(radius: radius)) } else { self }
    }
}
