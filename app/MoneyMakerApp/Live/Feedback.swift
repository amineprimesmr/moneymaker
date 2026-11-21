//
//  Feedback.swift
//  MoneyMaker — « Ton avis » : idée, bug ou remarque, envoyé depuis l'app (menu et Réglages).
//  Le serveur garde chaque message et prévient l'équipe par notification.
//

import SwiftUI
import UIKit

private struct FeedbackAck: Decodable { let ok: Bool }

extension MoneyMakerClient {
    func sendFeedback(kind: String, message: String) async throws {
        let info = Bundle.main.infoDictionary
        let version = "\(info?["CFBundleShortVersionString"] as? String ?? "?") (\(info?["CFBundleVersion"] as? String ?? "?"))"
        let _: FeedbackAck = try await send("POST", "feedback", body: [
            "kind": kind, "message": message, "appVersion": version,
            "device": UIDevice.current.model + " · iOS " + UIDevice.current.systemVersion,
            "lang": Locale.current.language.languageCode?.identifier ?? "fr",
        ])
    }
}

/// Carte en bas du menu : invite à dire ce qu'il faudrait améliorer.
struct FeedbackMenuCard: View {
    let ink: Color
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Image(systemName: "bubble.left.and.text.bubble.right.fill").font(.system(size: 18))
                    Text("Ton avis compte").font(MMFont.system(16, .semibold))
                }
                Text("Une idée, un bug, quelque chose à changer ? Dis-le-moi, je lis tout.")
                    .font(MMFont.system(13))
                    .foregroundStyle(ink.opacity(0.55))
                    .fixedSize(horizontal: false, vertical: true)
                Text("Donner mon avis")
                    .font(MMFont.system(14, .semibold))
                    .foregroundStyle(ink == .white ? .black : .white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(ink.opacity(0.9), in: Capsule())
                    .padding(.top, 2)
            }
            .foregroundStyle(ink.opacity(0.9))
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ink.opacity(0.06), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(ink.opacity(0.08), lineWidth: 0.5))
        }
        .buttonStyle(MMPressStyle(scale: 0.98))
    }
}

/// Feuille d'envoi : type de message, texte libre, envoi, merci.
struct FeedbackSheet: View {
    let client: MoneyMakerClient
    @Environment(\.dismiss) private var dismiss
    @State private var kind = "idea"
    @State private var message = ""
    @State private var sending = false
    @State private var sent = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private let kinds: [(id: String, title: LocalizedStringKey, icon: String)] = [
        ("idea", "Idée", "lightbulb.fill"), ("bug", "Bug", "ladybug.fill"), ("other", "Autre", "ellipsis.bubble.fill"),
    ]
    private var canSend: Bool { message.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 && !sending }

    var body: some View {
        NavigationStack {
            Group {
                if sent { thanks } else { form }
            }
            .background(MMColor.bg.ignoresSafeArea())
            .navigationTitle(Text("Ton avis"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button((sent ? "OK" : "Fermer") as LocalizedStringKey) { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
        .sensoryFeedback(.success, trigger: sent)
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Qu'est-ce qu'il faudrait améliorer, ajouter ou changer ? Chaque message arrive directement chez moi.")
                    .font(MMFont.system(15))
                    .foregroundStyle(MMColor.ink2)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    ForEach(kinds, id: \.id) { k in
                        Button { kind = k.id } label: {
                            Label(k.title, systemImage: k.icon)
                                .font(MMFont.system(14, .semibold))
                                .padding(.horizontal, 14).padding(.vertical, 9)
                                .foregroundStyle(kind == k.id ? MMColor.bg : MMColor.ink)
                                .background(kind == k.id ? MMColor.ink : MMColor.fg(0.06), in: Capsule())
                        }
                        .buttonStyle(MMPressStyle(scale: 0.96))
                    }
                }
                .sensoryFeedback(.selection, trigger: kind)

                ZStack(alignment: .topLeading) {
                    if message.isEmpty {
                        Text((kind == "bug" ? "Ce qui ne marche pas, et sur quel écran…" : "Ton idée ou ta remarque…") as LocalizedStringKey)
                            .font(MMFont.system(16))
                            .foregroundStyle(MMColor.ink3)
                            .padding(.horizontal, 5).padding(.vertical, 8)
                            .allowsHitTesting(false)
                    }
                    TextEditor(text: $message)
                        .font(MMFont.system(16))
                        .scrollContentBackground(.hidden)
                        .focused($focused)
                        .frame(minHeight: 180)
                }
                .padding(12)
                .background(MMColor.fg(0.05), in: RoundedRectangle(cornerRadius: 18, style: .continuous))

                if let error {
                    Text(error).font(MMFont.system(13)).foregroundStyle(MMColor.red)
                }

                Button { Task { await submit() } } label: {
                    HStack(spacing: 8) {
                        if sending { ProgressView().tint(MMColor.bg) }
                        Text((sending ? "Envoi…" : "Envoyer") as LocalizedStringKey)
                    }
                    .font(MMFont.system(16, .semibold))
                    .foregroundStyle(MMColor.bg)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 15)
                    .background(MMColor.ink.opacity(canSend ? 1 : 0.3), in: Capsule())
                }
                .buttonStyle(MMPressStyle(scale: 0.98))
                .disabled(!canSend)
                .accessibilityLabel(Text((sending ? "Envoi…" : "Envoyer") as LocalizedStringKey))
            }
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear { focused = true }
    }

    private var thanks: some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "checkmark.circle.fill").font(.system(size: 56)).foregroundStyle(MMColor.accent)
            Text("Merci !").font(MMFont.system(24, .bold))
            Text("Ton message est bien arrivé. C'est grâce à vos retours que l'app avance.")
                .font(MMFont.system(15)).foregroundStyle(MMColor.ink2)
                .multilineTextAlignment(.center).padding(.horizontal, 32)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    private func submit() async {
        guard !sending else { return }
        sending = true; error = nil
        defer { sending = false }
        do {
            try await client.sendFeedback(kind: kind, message: message.trimmingCharacters(in: .whitespacesAndNewlines))
            focused = false
            withAnimation(.snappy) { sent = true }
        } catch {
            self.error = (error as? APIError)?.message ?? String(localized: "L'envoi n'a pas marché. Vérifie ta connexion et réessaie.")
        }
    }
}
