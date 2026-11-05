//
//  AgentSetup.swift
//  MoneyMaker — sans compte : un seul message à copier pour que l'agent de code configure tout via le MCP.
//  Les étapes détaillées vivent sur usemoneymaker.com/setup.md.
//

import SwiftUI
import UIKit

struct AgentSetupView: View {
    let onHasAccount: () -> Void

    private let message = String(localized: "Configure MoneyMaker pour moi en suivant https://usemoneymaker.com/setup.md")
    private let agents: [(logo: String, name: String, color: Color)] = [
        ("AgentClaude", "Claude Code", MMColor.hex(0xD97757)),
        ("AgentCodex", "Codex", .white),
        ("AgentCursor", "Cursor", .white),
    ]
    @State private var agent = 0
    @State private var typed = 0
    @State private var copied = false
    @State private var copies = 0
    @State private var resetCopied: Task<Void, Never>?

    var body: some View {
        // Petite fenêtre (iPad redimensionné) : on défile, et les boutons du bas restent visibles.
        GeometryReader { geo in
            if geo.size.height < 600 {
                ScrollView {
                    column.padding(.top, 16)
                        .frame(maxWidth: .infinity)
                }
                .scrollBounceBehavior(.basedOnSize)
                .safeAreaInset(edge: .bottom, spacing: 0) { accountButtons }
            } else {
                column
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .overlay(alignment: .bottom) { accountButtons }
            }
        }
        .sensoryFeedback(.success, trigger: copies)
        .task {
            for i in 0...message.count {
                typed = i
                try? await Task.sleep(for: .milliseconds(18))
                if Task.isCancelled { return }
            }
        }
    }

    private var column: some View {
        VStack(spacing: 0) {
            agentLogo.padding(.bottom, 20).mmAppear(0)

            VStack(spacing: 10) {
                Text("Ton agent s'occupe de tout")
                    .font(MMFont.system(26, .semibold)).foregroundStyle(MMColor.ink).multilineTextAlignment(.center)
                Text("Colle ce message dans \(agents[agent].name). Il crée ton compte et branche tes revenus.")
                    .font(MMFont.system(15)).foregroundStyle(MMColor.ink2).multilineTextAlignment(.center)
                    .contentTransition(.opacity)
            }
            .mmAppear(0)

            messageCard.padding(.top, 28).mmAppear(1)
            copyButton.padding(.top, 14).mmAppear(2)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: MMAdaptive.formWidth)
    }

    private var accountButtons: some View {
        VStack(spacing: 0) {
            DemoButton()
            Button(action: onHasAccount) {
                Text("J'ai déjà un compte")
                    .font(MMFont.system(15, .semibold)).foregroundStyle(MMColor.ink)
                    .frame(maxWidth: .infinity).frame(minHeight: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(MMPressStyle())
        }
        .padding(.bottom, 12)
        .mmAppear(3)
    }

    /// Les agents défilent : le logo sortant s'efface et rétrécit pendant que le suivant arrive.
    private var agentLogo: some View {
        ZStack {
            Image(agents[agent].logo)
                .resizable().renderingMode(.template).scaledToFit().frame(width: 34, height: 34)
                .foregroundStyle(agents[agent].color)
                .id(agent)
                .transition(.asymmetric(insertion: .scale(scale: 0.6).combined(with: .opacity).combined(with: .offset(y: 14)),
                                        removal: .scale(scale: 0.6).combined(with: .opacity).combined(with: .offset(y: -14))))
        }
        .frame(width: 72, height: 72)
        .clipped()
        .mmGlass(in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1.8))
                if Task.isCancelled { return }
                withAnimation(.spring(response: 0.5, dampingFraction: 0.82)) { agent = (agent + 1) % agents.count }
            }
        }
        .accessibilityHidden(true)
    }

    private var messageCard: some View {
        // Le texte complet réserve la hauteur : la carte ne bouge pas pendant la frappe.
        Text(message).opacity(0)
            .overlay(alignment: .topLeading) { Text(String(message.prefix(typed))) }
            .font(.system(size: 15, design: .monospaced)).foregroundStyle(MMColor.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .mmGlass(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(MMColor.accent, lineWidth: 2).opacity(copied ? 1 : 0)
            }
            .scaleEffect(copied ? 1.02 : 1)
            .accessibilityLabel(message)
    }

    private var copyButton: some View {
        Button(action: copy) {
            HStack(spacing: 8) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .contentTransition(.symbolEffect(.replace))
                Text(copied ? "Copié !" : "Copier le message")
                    .contentTransition(.opacity)
            }
            .font(MMFont.system(16, .semibold)).foregroundStyle(copied ? .black : MMColor.bg)
            .frame(maxWidth: .infinity).frame(height: 52)
            .background(copied ? MMColor.accent : MMColor.ink, in: Capsule())
        }
        .buttonStyle(MMPressStyle())
    }

    private func copy() {
        UIPasteboard.general.string = message
        copies += 1
        withAnimation(.spring(response: 0.35, dampingFraction: 0.65)) { copied = true }
        resetCopied?.cancel()
        resetCopied = Task {
            try? await Task.sleep(for: .seconds(2.2))
            guard !Task.isCancelled else { return }
            withAnimation(.smooth) { copied = false }
        }
    }
}

/// Assombrit le bas du décor : les textes restent lisibles sur le sol éclairé.
struct PanoramaScrim: View {
    var body: some View {
        LinearGradient(stops: [.init(color: .clear, location: 0.26), .init(color: .black.opacity(0.75), location: 0.46)],
                       startPoint: .top, endPoint: .bottom)
            .ignoresSafeArea()
    }
}
