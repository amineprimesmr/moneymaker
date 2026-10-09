//
//  LaunchSplash.swift
//  MoneyMaker — animation d'entrée, reprise de V2 (App/V2App.swift, LaunchSplashView).
//
//  1. Le tag se « bombe » de gauche à droite sur fond noir, les coulures descendent.
//  2. Reveal « masque inversé » de V2 : le logo plonge à 0,8×, puis devient un trou
//     découpé dans le fond qui grossit jusqu'à laisser l'app remplir l'écran.
//
//  Le zoom est ancré dans le trait le plus épais du tag (point mesuré sur l'image :
//  0,235 × 0,237) pour que l'écran finisse entièrement à l'intérieur de la lettre.
//

import SwiftUI

struct LaunchSplashView: View {
    var onFinished: () -> Void

    private let logoWidth: CGFloat = 250
    private let anchor = UnitPoint(x: 0.2347, y: 0.2369)
    /// Rayon du trait à l'ancre ≈ 3 pt à cette taille ; 220× couvre largement tout iPhone.
    private let revealScale: CGFloat = 220

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sprayed: CGFloat = 0     // 0…1 : progression du bombage
    @State private var drips: CGFloat = 0       // 0…1 : coulures
    @State private var drawn = false
    @State private var scaleDown = false
    @State private var scaleUp = false

    var body: some View {
        ZStack {
            if drawn { reveal } else { spray }
        }
        .ignoresSafeArea()
        .allowsHitTesting(!scaleUp)
        .task { await run() }
    }

    private var logo: some View {
        Image("Logo").resizable().scaledToFit().frame(width: logoWidth)
    }

    /// Phase 1 : le tag apparaît sous un masque qui balaie de gauche à droite (bord flou = brume de bombe),
    /// puis le bas se dévoile pour laisser couler les gouttes.
    private var spray: some View {
        Color.black.overlay {
            logo
                .mask {
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
                .shadow(color: .white.opacity(0.25 * Double(sprayed)), radius: 14)
        }
    }

    /// Phase 2 : fond noir troué par le logo, posé sur une plaque blanche identique à la frame d'avant.
    private var reveal: some View {
        Rectangle()
            .fill(Color.black)
            .mask {
                Rectangle()
                    .overlay {
                        logo
                            .blendMode(.destinationOut)
                            .scaleEffect(scaleUp ? revealScale : (scaleDown ? 0.8 : 1), anchor: anchor)
                            .animation(.smooth(duration: 0.3, extraBounce: 0), value: scaleDown)
                    }
            }
            .compositingGroup()
            .background { Color.white.opacity(scaleUp ? 0 : 1) }
    }

    private func run() async {
        if reduceMotion {
            sprayed = 1; drips = 1
            try? await Task.sleep(for: .seconds(0.35))
            withAnimation(.easeOut(duration: 0.25)) { scaleUp = true }
            try? await Task.sleep(for: .seconds(0.25))
            onFinished(); return
        }
        withAnimation(.easeInOut(duration: 0.9)) { sprayed = 1 }
        try? await Task.sleep(for: .seconds(0.75))
        withAnimation(.easeIn(duration: 0.45)) { drips = 1 }
        try? await Task.sleep(for: .seconds(0.55))
        drawn = true
        try? await Task.sleep(for: .seconds(0.2))
        scaleDown = true
        try? await Task.sleep(for: .seconds(0.12))
        withAnimation(.smooth(duration: 1, extraBounce: 0), completionCriteria: .logicallyComplete) {
            scaleUp = true
        } completion: {
            onFinished()
        }
    }
}
