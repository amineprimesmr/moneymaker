//
//  LaunchSplash.swift
//  MoneyMaker — animation d'entrée.
//
//  1. Sur fond noir, le tag se « bombe » au centre de gauche à droite, puis les coulures descendent.
//  2. Il glisse et rétrécit jusqu'à sa place exacte en haut de l'Accueil (cadre mesuré en direct),
//     pendant que le noir s'efface : c'est le même logo, on ne voit jamais de saut.
//  3. Une fois posé, les sections de la page apparaissent l'une après l'autre (`mmAppear`).
//
//  Sans destination (écran de connexion), le logo s'efface simplement sur place.
//

import SwiftUI

/// Coordonne l'entrée : où atterrit le logo, et quand les sections peuvent apparaître.
@MainActor
final class LaunchCoordinator: ObservableObject {
    static let shared = LaunchCoordinator()
    /// Cadre global du logo d'en-tête de l'Accueil.
    @Published var headerLogoFrame: CGRect?
    /// Le logo est posé : les sections et le logo d'en-tête prennent le relais.
    @Published private(set) var revealed = false
    /// Le logo volant est arrivé : le logo d'en-tête s'affiche à sa place exacte.
    @Published var logoLanded = false

    func reveal() {
        guard !revealed else { return }
        revealed = true
        NotificationPrompt.shared.splashFinished = true
    }
}

struct LaunchSplashView: View {
    var onFinished: () -> Void

    @ObservedObject private var coord = LaunchCoordinator.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sprayed: CGFloat = 0
    @State private var drips: CGFloat = 0
    @State private var landed = false
    @State private var target: CGRect?

    private let startWidth: CGFloat = 250

    var body: some View {
        GeometryReader { g in
            let center = CGPoint(x: g.size.width / 2, y: g.size.height / 2)
            let width = landed ? (target?.width ?? startWidth) : startWidth
            let position = landed ? (target.map { CGPoint(x: $0.midX, y: $0.midY) } ?? center) : center
            ZStack {
                Color.black.opacity(landed ? 0 : 1)
                Image("Logo")
                    .resizable().scaledToFit()
                    .frame(width: width)
                    .mask { sprayMask }
                    .shadow(color: .white.opacity(landed ? 0.18 : 0.28 * Double(sprayed)), radius: landed ? 10 : 16)
                    .opacity(landed && target == nil ? 0 : 1)
                    .position(position)
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(!landed)
        .task { await run() }
    }

    /// Balayage gauche → droite au bord flou (brume de bombe), puis dévoilement du bas pour les coulures.
    private var sprayMask: some View {
        GeometryReader { g in
            let w = g.size.width, h = g.size.height
            ZStack(alignment: .topLeading) {
                LinearGradient(stops: [.init(color: .white, location: 0), .init(color: .white, location: 0.82), .init(color: .clear, location: 1)],
                               startPoint: .leading, endPoint: .trailing)
                    .frame(width: (w + 60) * sprayed, height: h * 0.68)
                Rectangle().frame(width: w, height: h * (0.68 + 0.32 * drips)).opacity(drips > 0 ? 1 : 0)
            }
        }
    }

    private func run() async {
        if reduceMotion {
            sprayed = 1; drips = 1
        } else {
            withAnimation(.easeInOut(duration: 0.85)) { sprayed = 1 }
            try? await Task.sleep(for: .seconds(0.7))
            withAnimation(.easeIn(duration: 0.4)) { drips = 1 }
            try? await Task.sleep(for: .seconds(0.55))
        }
        // Attend que l'Accueil ait mesuré son en-tête (au plus 1,5 s : sinon, on s'efface sur place).
        for _ in 0..<30 where coord.headerLogoFrame == nil { try? await Task.sleep(for: .milliseconds(50)) }
        target = coord.headerLogoFrame
        let move: Animation = reduceMotion ? .easeOut(duration: 0.25) : .spring(response: 0.75, dampingFraction: 0.88)
        withAnimation(move, completionCriteria: .logicallyComplete) {
            landed = true
        } completion: {
            coord.reveal()
            coord.logoLanded = true
            onFinished()
        }
        // Les sections commencent à monter pendant la fin du glissé, pas après.
        try? await Task.sleep(for: .seconds(reduceMotion ? 0.1 : 0.35))
        coord.reveal()
    }
}
