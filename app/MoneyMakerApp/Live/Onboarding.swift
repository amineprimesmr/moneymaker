//
//  Onboarding.swift
//  MoneyMaker — présentation avant la création de compte : composant « Accueil animé » de Process,
//  adapté à l'iOS 17 minimum de l'app (verre natif sur iOS 26, matériau sinon).
//

import SwiftUI

struct OnboardingView: View {
    let onComplete: () -> Void

    @Binding var currentIndex: Int
    @State private var introPlaying = true
    @State private var introRun = 0
    private let introModel = IntroModel.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct Item {
        let title: String
        let subtitle: String
        let image: String
        var zoomScale: CGFloat = 1
        var zoomAnchor: UnitPoint = .center
    }

    private let items: [Item] = [
        .init(title: String(localized: "Tous tes revenus au même endroit"),
              subtitle: String(localized: "App Store et Stripe,\nen direct."),
              image: "OnboardingHome"),
        .init(title: String(localized: "Chaque vente, en direct"),
              subtitle: String(localized: "Un son de caisse et une notification\nà chaque paiement."),
              image: "OnboardingSales", zoomScale: 1.3, zoomAnchor: .init(x: 0.5, y: -0.3)),
        .init(title: String(localized: "Tes clients sur la planète"),
              subtitle: String(localized: "Vois d'où viennent tes ventes,\npartout dans le monde."),
              image: "OnboardingGlobe"),
        .init(title: String(localized: "Grimpe au classement"),
              subtitle: String(localized: "Compare tes revenus vérifiés\navec les autres business."),
              image: "OnboardingRanking", zoomScale: 1.3, zoomAnchor: .init(x: 0.5, y: -0.3)),
        .init(title: String(localized: "Les chiffres qui comptent"),
              subtitle: String(localized: "MRR, abonnés, churn et conversion,\npour chaque business."),
              image: "OnboardingDetail"),
    ]

    private var animation: Animation { .interpolatingSpring(duration: 0.65, bounce: 0, initialVelocity: 0) }
    private var isLast: Bool { currentIndex == items.count - 1 }

    var body: some View {
        GeometryReader { geo in
            let intro = introTransform(geo)
            ZStack(alignment: .bottom) {
                Color.black.ignoresSafeArea().opacity(introPlaying ? 1 : 0)

                // Les captures ne sont montées qu'après l'intro : rien d'inutile à composer pendant le dézoom.
                PhoneMockup(images: items.dropFirst().map(\.image), showImages: !introPlaying, index: currentIndex) {
                    IntroDashboard(model: introModel)
                }
                .scaleEffect(items[currentIndex].zoomScale, anchor: items[currentIndex].zoomAnchor)
                .padding(.top, 35).padding(.horizontal, 50).padding(.bottom, 220)
                .scaleEffect(introPlaying ? intro.scale : 1)
                .offset(y: introPlaying ? intro.offsetY : 0)

                VStack(spacing: 10) {
                    texts
                    indicator
                    continueButton.padding(.horizontal, 30)
                }
                .padding(.top, 20).padding(.horizontal, 15).padding(.bottom, 8)
                .frame(height: 210)
                .background { bottomFade }
                .opacity(introPlaying ? 0 : 1)
                .accessibilityHidden(introPlaying)

                if currentIndex > 0 {
                    MMGlassIconButton(systemImage: "chevron.left") {
                        withAnimation(animation) { currentIndex -= 1 }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(.leading, 15).padding(.top, 5)
                }

                if introPlaying {
                    Color.clear.contentShape(Rectangle()).ignoresSafeArea().onTapGesture(perform: skipIntro)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { introModel.viewportWidth = $0 }
        .statusBarHidden(introPlaying)
        .task(id: introRun) {
            guard introPlaying else { return }
            if reduceMotion { introModel.finishNow(); introPlaying = false; return }
            await introModel.play(onDezoom: revealOnboarding)
        }
    }

    /// Le téléphone grossi jusqu'à ce que son écran remplisse le vrai : le dézoom final n'est que le retour à l'échelle 1.
    private func introTransform(_ geo: GeometryProxy) -> (scale: CGFloat, offsetY: CGFloat) {
        let ratio: CGFloat = 1206.0 / 2622.0
        let size = geo.size, insets = geo.safeAreaInsets
        let phoneWidth = min(size.width - 100, (size.height - 255) * ratio)
        guard phoneWidth > 0 else { return (1, 0) }
        let fullHeight = size.height + insets.top + insets.bottom
        let scale = max((size.width + insets.leading + insets.trailing) / phoneWidth, fullHeight / (phoneWidth / ratio))
        let phoneCenter = (35 + size.height - 220) / 2
        let screenCenter = (size.height + insets.bottom - insets.top) / 2
        // L'échelle s'applique autour du centre de la zone, pas du téléphone, placé plus haut.
        return (scale, screenCenter - (size.height / 2 + scale * (phoneCenter - size.height / 2)))
    }

    private func skipIntro() {
        introRun += 1
        introModel.finishNow()
        revealOnboarding()
    }

    private func revealOnboarding() {
        withAnimation(.spring(duration: 2.2, bounce: 0)) { introPlaying = false }
    }

    /// Liquid Glass natif sur iOS 26, bouton plein de l'app sinon.
    @ViewBuilder
    private var continueButton: some View {
        let title = isLast ? String(localized: "Commencer") : String(localized: "Continuer")
        if #available(iOS 26.0, *) {
            Button(action: advance) {
                Text(title).font(MMFont.system(16, .semibold)).foregroundStyle(MMColor.ink)
                    .frame(maxWidth: .infinity).padding(.vertical, 10)
            }
            .buttonStyle(.glass)
        } else {
            MMPrimaryButton(title: title, action: advance)
        }
    }

    /// Visible seulement quand la capture zoomée passe sous le texte.
    private var bottomFade: some View {
        Rectangle().fill(MMColor.bg.opacity(0.96))
            .blur(radius: 15)
            .padding([.horizontal, .bottom], -30).padding(.top, -8)
            .opacity(items[currentIndex].zoomScale > 1 ? 1 : 0)
            .ignoresSafeArea()
    }

    private func advance() {
        if isLast { onComplete() } else { withAnimation(animation) { currentIndex += 1 } }
    }

    private var texts: some View {
        ZStack {
            ForEach(items.indices, id: \.self) { index in
                let isActive = currentIndex == index
                VStack(spacing: 6) {
                    Text(items[index].title)
                        .font(MMFont.system(22, .semibold)).lineLimit(1).minimumScaleFactor(0.8)
                        .foregroundStyle(MMColor.ink)
                    Text(items[index].subtitle)
                        .font(MMFont.system(15)).lineLimit(2).multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .foregroundStyle(MMColor.ink2)
                }
                .opacity(isActive ? 1 : 0)
                .offset(x: CGFloat(index - currentIndex) * 120)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var indicator: some View {
        HStack(spacing: 6) {
            ForEach(items.indices, id: \.self) { index in
                let isActive = currentIndex == index
                Capsule().fill(MMColor.ink.opacity(isActive ? 1 : 0.4)).frame(width: isActive ? 25 : 6, height: 6)
            }
        }
        .padding(.bottom, 5)
    }
}

/// iPhone dessiné en vectoriel : tout est proportionnel à la largeur de l'écran, le cadre reste fixe
/// et seuls les écrans glissent dedans, comme sur un vrai téléphone.
private struct PhoneMockup<FirstPage: View>: View {
    let images: [String]
    let showImages: Bool
    let index: Int
    @ViewBuilder let firstPage: () -> FirstPage
    /// Décodées avant la première transition : sinon chaque capture se décode à sa première apparition, en pleine animation.
    @State private var decoded: [String: UIImage] = [:]

    var body: some View {
        Color.clear
            .aspectRatio(1206.0 / 2622.0, contentMode: .fit)
            .overlay {
                GeometryReader { geo in
                    let w = geo.size.width, h = geo.size.height
                    let bezel = w * 0.032, radius = w * 0.135
                    let screen = RoundedRectangle(cornerRadius: radius, style: .continuous)
                    ZStack {
                        firstPage()
                            .frame(width: 402, height: 402 * h / w)
                            .scaleEffect(w / 402)
                            .frame(width: w, height: h)
                            .offset(x: CGFloat(-index) * (w + bezel))
                        ForEach(showImages ? Array(images.indices) : [], id: \.self) { i in
                            screenImage(images[i]).frame(width: w, height: h)
                                .offset(x: CGFloat(i + 1 - index) * (w + bezel))
                        }
                    }
                    .frame(width: w, height: h)
                    .clipShape(screen)
                    .overlay(alignment: .top) {
                        Capsule().fill(.black)
                            .frame(width: w * 0.32, height: w * 0.095).padding(.top, w * 0.028)
                    }
                    .background {
                        RoundedRectangle(cornerRadius: radius + bezel, style: .continuous)
                            .fill(.black).padding(-bezel)
                    }
                    .background {
                        RoundedRectangle(cornerRadius: radius + bezel * 1.35, style: .continuous)
                            .fill(titanium).padding(-bezel * 1.35)
                    }
                    .background(alignment: .topLeading) {
                        ZStack(alignment: .topLeading) {
                            button(x: -bezel * 1.7, y: h * 0.135, height: h * 0.032)
                            button(x: -bezel * 1.7, y: h * 0.205, height: h * 0.062)
                            button(x: -bezel * 1.7, y: h * 0.285, height: h * 0.062)
                            button(x: w + bezel * 1.35, y: h * 0.24, height: h * 0.095)
                            button(x: w + bezel * 1.35, y: h * 0.56, height: h * 0.07)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .task {
                for name in images where decoded[name] == nil {
                    guard let image = UIImage(named: name) else { continue }
                    decoded[name] = await image.byPreparingForDisplay() ?? image
                }
            }
    }

    @ViewBuilder
    private func screenImage(_ name: String) -> some View {
        if let image = decoded[name] {
            Image(uiImage: image).resizable()
        } else {
            Color.black
        }
    }

    private var titanium: LinearGradient {
        LinearGradient(colors: [Color(white: 0.62), Color(white: 0.30), Color(white: 0.52)],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    private func button(x: CGFloat, y: CGFloat, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 1.5).fill(titanium)
            .frame(width: 3, height: height).offset(x: x, y: y)
    }
}

/// Le décor des captures App Store, en tranches pleine résolution : on avance dedans d'une page à l'autre,
/// de l'onboarding jusqu'à la page de l'agent. Seules les tranches voisines sont montées.
struct OnboardingPanorama: View {
    let page: Int
    static let pageCount = 6

    var body: some View {
        GeometryReader { geo in
            let height = geo.size.height
            // Sur un écran large, la bande grandit jusqu'à toujours couvrir toute la largeur.
            let slice = max(height * 1320 / 2868, geo.size.width)
            let isLast = page == Self.pageCount - 1
            ZStack(alignment: .topLeading) {
                // Une seule bande qui glisse d'un bloc : les images se chevauchent de 2 pt, aucun joint noir possible.
                HStack(spacing: -2) {
                    ForEach(0..<Self.pageCount, id: \.self) { i in
                        Image("OnboardingPanorama\(i + 1)").resizable()
                            .frame(width: slice + 2, height: max(height, slice * 2868 / 1320))
                    }
                }
                .offset(x: -CGFloat(page) * slice)
                .frame(width: geo.size.width, height: height, alignment: .topLeading)
                .clipped()
                // Décor flou partout, un peu plus sur la page de l'agent pour laisser ressortir le texte.
                .animation(.easeInOut(duration: 1.1)) { $0.blur(radius: isLast ? 18 : 10, opaque: true) }
                Color.black
                    .animation(.easeInOut(duration: 1.1)) { $0.opacity(isLast ? 0.62 : 0.45) }
            }
            .clipped()
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}
