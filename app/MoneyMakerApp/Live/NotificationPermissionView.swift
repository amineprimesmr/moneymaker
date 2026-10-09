//
//  NotificationPermissionView.swift
//  MoneyMaker — feuille compacte d'autorisation des notifications.
//
//  Adapté de « CompactNotificationView » (Balaji Venkatesh, 07/10/26) :
//  même pile de trois notifications en verre animée au KeyframeAnimator,
//  même cloche dont le badge compte 1-2-3 avant que tout s'évapore et reboucle.
//
//  Différences avec l'original, pour compiler et tourner ici :
//   • `@ContentBuilder` et `concentricCornerRadii` (SDK iOS 27) → `@ViewBuilder`
//     et un rayon fixe aligné sur la feuille ;
//   • `toolbarVerticalBehavior` (iOS 27.1, iPhone pliable) retiré ;
//   • verre natif iOS 26, repli matériau sur iOS 17–25 ;
//   • contenu MoneyMaker : vraies notifications de vente, en français, accent vert.
//

import SwiftUI

struct NotificationPermissionConfig {
    var title = "Sois prévenu à chaque vente"
    var description = "Le « cha-ching » en direct, tes revenus du jour\nsur l'écran verrouillé et un récap chaque soir."
    var tint: Color = MMColor.accent
    var primaryButtonTitle = "Activer les notifications"
    var secondaryButtonTitle = "Plus tard"
    var showsSecondaryButton = true

    var topNotification = Notification(title: "+59,99 € · Mon app", caption: "Nouvel abonné · annuel · 🇫🇷 FR")
    var centerNotification = Notification(title: "+9,99 € · Mon app", caption: "Essai converti · mensuel · 🇺🇸 US")
    var bottomNotification = Notification(title: "Numéro 1 🥇 · Mon app", caption: "#1 🇫🇷 FR · Payantes · catégorie")

    struct Notification {
        var assetName = "AppMark"
        var title: String
        var caption: String
    }
}

struct NotificationPermissionView: View {
    var config = NotificationPermissionConfig()
    var primaryAction: () -> Void
    var secondaryAction: () -> Void

    private let containerCornerRadius: CGFloat = 22

    var body: some View {
        VStack(spacing: 10) {
            KeyframeAnimator(initialValue: CGFloat.zero, repeating: true) { progress in
                let dismissProgress = progress > 3.2 ? (progress - 3.2) / 0.8 : 0
                VStack(spacing: 15) {
                    notificationStack(progress)
                        .compositingGroup()
                        .visualEffect { content, proxy in
                            content
                                .blur(radius: 20 * dismissProgress)
                                .opacity(1 - dismissProgress)
                                .offset(y: -proxy.size.height * dismissProgress)
                        }
                    iconView(progress, dismissProgress)
                }
            } keyframes: { _ in
                // 0-3 : les notifications arrivent, 3-4 : remise à zéro.
                MoveKeyframe(0)
                LinearKeyframe(0, duration: 0.5)
                SpringKeyframe(1, duration: 1, spring: .bouncy(duration: 0.9, extraBounce: 0.1))
                SpringKeyframe(2, duration: 1, spring: .bouncy(duration: 0.9, extraBounce: 0.1))
                SpringKeyframe(3, duration: 1, spring: .bouncy(duration: 0.9, extraBounce: 0.1))
                LinearKeyframe(3, duration: 1)
                SpringKeyframe(4, duration: 1, spring: .bouncy(duration: 0.9, extraBounce: 0))
            }

            contents()
        }
        .padding([.horizontal, .top], 15)
        .padding(.bottom, 20)
        .ignoresSafeArea(.all, edges: .bottom)
        .presentationDetents([.height(460)])
        .modifier(PageFittedSizing())
        .presentationCompactAdaptation(.sheet)
        .presentationBackground(Color.black)
        .presentationCornerRadius(38)
        .interactiveDismissDisabled()
        .environment(\.colorScheme, .dark)
    }

    // MARK: Pile de notifications

    @ViewBuilder
    private func notificationStack(_ progress: CGFloat) -> some View {
        ZStack {
            ForEach(0..<3, id: \.self) { index in
                let notification = index == 0 ? config.bottomNotification : index == 1 ? config.centerNotification : config.topNotification
                let indexProgress = progress - CGFloat(index)
                let p = max(min(indexProgress, 1), 0)
                let offset = 10 * max(indexProgress - 1, 0)
                let scale = 1 - max(indexProgress - 1, 0) * 0.05

                notificationView(notification)
                    .compositingGroup()
                    .opacity(p)
                    .scaleEffect(0.7 + (p * 0.3))
                    .scaleEffect(scale, anchor: .bottom)
                    .blur(radius: 10 * (1 - p))
                    .offset(y: -100 * (1 - p))
                    .offset(y: offset)
            }
        }
    }

    @ViewBuilder
    private func notificationView(_ value: NotificationPermissionConfig.Notification) -> some View {
        HStack(spacing: 8) {
            Image(value.assetName)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 50, height: 50)
                .clipShape(RoundedRectangle(cornerRadius: containerCornerRadius - 5, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                Text(value.title).font(MMFont.system(15, .medium)).foregroundStyle(.white)
                Text(value.caption).font(MMFont.system(12)).foregroundStyle(.gray)
            }
            .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 5)
        .frame(height: 60)
        .modifier(NotificationGlass(radius: containerCornerRadius))
    }

    // MARK: Cloche

    @ViewBuilder
    private func iconView(_ progress: CGFloat, _ dismissProgress: CGFloat) -> some View {
        GeometryReader {
            let size = $0.size
            let symbolSize = size.height / 2
            let offsetProgress = 1 - (min(progress / 3, 1) - dismissProgress)
            let opacity = min(progress, 1) - dismissProgress
            let count = max(min(Int(progress.rounded()), 3), 1)

            ZStack {
                Image(systemName: "bell")
                    .font(.system(size: symbolSize))
                    .foregroundStyle(.gray)
                    .opacity(1 - opacity)
                Image(systemName: "bell.badge")
                    .font(.system(size: symbolSize))
                    .foregroundStyle(config.tint, .gray)
                    .overlay(alignment: .topTrailing) {
                        let fontSize = symbolSize * 0.2
                        Text("\(count)")
                            .font(.system(size: fontSize, weight: .bold))
                            .fontDesign(.rounded)
                            .frame(width: fontSize)
                            .fixedSize()
                            .foregroundStyle(.black)
                            .contentTransition(.numericText())
                            .animation(.linear, value: count)
                            .offset(x: -fontSize * 1.1, y: fontSize * 0.98)
                    }
                    .compositingGroup()
                    .opacity(opacity)
            }
            .compositingGroup()
            .geometryGroup()
            .offset(y: -30 * offsetProgress)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: Texte et actions

    @ViewBuilder
    private func contents() -> some View {
        VStack(spacing: 10) {
            Text(config.title)
                .font(MMFont.system(20, .bold)).tracking(-0.4)
                .foregroundStyle(.white)
                .lineLimit(1)
            Text(config.description)
                .multilineTextAlignment(.center)
                .font(MMFont.system(15))
                .foregroundStyle(MMColor.ink2)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 15)
            Button(action: primaryAction) {
                Text(config.primaryButtonTitle)
                    .font(MMFont.system(16, .semibold))
                    .foregroundStyle(.black)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 5)
            }
            .modifier(ProminentGlassButton(tint: config.tint))
            .padding(.top, 15)
            .padding(.horizontal, 15)
            if config.showsSecondaryButton {
                Button(config.secondaryButtonTitle, action: secondaryAction)
                    .font(MMFont.system(15, .medium))
                    .foregroundStyle(MMColor.ink2)
            }
        }
        .tint(config.tint)
    }
}

// MARK: - Repli selon la version d'iOS

private struct NotificationGlass: ViewModifier {
    let radius: CGFloat
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .glassEffect(.regular, in: ConcentricRectangle())
                .containerShape(.rect(cornerRadius: radius))
        } else {
            content
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5))
        }
    }
}

private struct ProminentGlassButton: ViewModifier {
    let tint: Color
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.buttonStyle(.glassProminent).tint(tint)
        } else {
            content.buttonStyle(.borderedProminent).buttonBorderShape(.capsule).controlSize(.large).tint(tint)
        }
    }
}

private struct PageFittedSizing: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.presentationSizing(.page.fitted(horizontal: true, vertical: false))
        } else {
            content
        }
    }
}

// MARK: - Présentation dans l'app

/// Affiche la feuille une fois après la connexion (puis au plus tous les 3 jours si « Plus tard »),
/// et à la demande depuis la carte d'invitation ou les réglages.
@MainActor
final class NotificationPrompt: ObservableObject {
    static let shared = NotificationPrompt()
    @Published var isPresented = false
    /// Passe à true quand l'animation d'entrée est terminée.
    var splashFinished = false

    private let key = "mm.notifPrompt.snoozedUntil"

    func presentIfNeeded() async {
        await PushManager.shared.refreshAuthorization()
        guard PushManager.shared.status == .notDetermined else { return }
        let until = UserDefaults.standard.double(forKey: key)
        guard Date().timeIntervalSince1970 >= until else { return }
        for _ in 0..<80 where !splashFinished { try? await Task.sleep(for: .milliseconds(100)) }
        try? await Task.sleep(for: .seconds(0.5))
        isPresented = true
    }

    func show() { isPresented = true }

    func enable() {
        Task {
            await PushManager.shared.requestAuthorization()
            isPresented = false
        }
    }

    func later() {
        UserDefaults.standard.set(Date().addingTimeInterval(3 * 86400).timeIntervalSince1970, forKey: key)
        isPresented = false
    }
}

#Preview {
    Color.black.sheet(isPresented: .constant(true)) {
        NotificationPermissionView { } secondaryAction: { }
    }
}
