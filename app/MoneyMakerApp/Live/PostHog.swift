//
//  PostHog.swift
//  MoneyMaker — données produit lues dans PostHog : entonnoir jusqu'à l'achat,
//  conversion du paywall, installation → payant, utilisateurs actifs, rétention.
//  La clé personnelle part une fois au serveur et n'est plus jamais renvoyée à l'app.
//

import SwiftUI

// MARK: - Modèle

enum PosthogStep: String, Codable, CaseIterable, Identifiable {
    case open, onboarding, paywall, trial, purchase
    var id: String { rawValue }
    var label: String {
        switch self {
        case .open: String(localized: "Ouverture")
        case .onboarding: String(localized: "Onboarding terminé")
        case .paywall: String(localized: "Paywall vu")
        case .trial: String(localized: "Essai démarré")
        case .purchase: String(localized: "Achat")
        }
    }
    var symbol: String {
        switch self {
        case .open: "iphone"
        case .onboarding: "list.bullet.clipboard"
        case .paywall: "rectangle.stack.badge.person.crop"
        case .trial: "hourglass"
        case .purchase: "creditcard.fill"
        }
    }
}

struct PosthogConfig: Codable, Hashable {
    var host: String
    var projectId: String
    var events: [String: String]
}

struct PosthogSummary: Codable, Hashable {
    struct Step: Codable, Hashable {
        let step: PosthogStep
        let event: String
        let users: Int
        let medianSeconds: Double?
    }
    let days: Int
    let funnel: [Step]
    let paywallConversion: Double?
    let installToPaid: Double?
    let dau: Int
    let wau: Int
    let mau: Int
    let retentionD1: Double?
    let retentionD7: Double?
    let updatedAt: Double
}

struct PosthogEventCount: Codable, Hashable { let event: String; let count: Int }

extension MoneyMakerClient {
    struct PosthogStatus: Decodable { let connected: Bool; let config: PosthogConfig? }
    struct PosthogConnectResult: Decodable { let connected: Bool; let config: PosthogConfig; let events: [PosthogEventCount] }

    func posthog(projectId: String) async throws -> PosthogStatus { try await get("projects/\(projectId)/posthog") }

    func posthogSummary(projectId: String, force: Bool = false) async throws -> PosthogSummary? {
        struct R: Decodable { let summary: PosthogSummary? }
        let r: R = try await get("projects/\(projectId)/posthog/summary\(force ? "?force=1" : "")")
        return r.summary
    }

    func connectPosthog(projectId: String, host: String, posthogProject: String, apiKey: String?, events: [String: String]?) async throws -> PosthogConnectResult {
        var body: [String: Any] = ["host": host, "projectId": posthogProject]
        if let apiKey, !apiKey.isEmpty { body["apiKey"] = apiKey }
        if let events { body["events"] = events }
        return try await send("PUT", "projects/\(projectId)/posthog", body: body)
    }

    func disconnectPosthog(projectId: String) async throws {
        struct R: Decodable { let connected: Bool }
        let _: R = try await send("DELETE", "projects/\(projectId)/posthog")
    }
}

// MARK: - Store

@MainActor
final class PosthogStore: ObservableObject {
    static let shared = PosthogStore()
    @Published private(set) var summaries: [String: PosthogSummary] = [:]
    @Published private(set) var connected: Set<String> = []
    private var loadedAt: [String: Date] = [:]

    func load(_ projectIds: [String], client: MoneyMakerClient, force: Bool = false) async {
        await withTaskGroup(of: (String, PosthogSummary?).self) { group in
            for id in projectIds where force || (loadedAt[id].map { Date().timeIntervalSince($0) > 300 } ?? true) {
                group.addTask { (id, try? await client.posthogSummary(projectId: id, force: force)) }
            }
            // Résultats regroupés puis publiés une seule fois, et seulement s'ils changent :
            // chaque écriture d'un @Published redessinait tous les écrans qui observent le store.
            var nextSummaries = summaries, nextConnected = connected
            for await (id, s) in group {
                loadedAt[id] = Date()
                if let s { nextSummaries[id] = s; nextConnected.insert(id) } else { nextSummaries[id] = nil; nextConnected.remove(id) }
            }
            if nextSummaries != summaries { summaries = nextSummaries }
            if nextConnected != connected { connected = nextConnected }
        }
    }

    func forget(_ id: String) { summaries[id] = nil; connected.remove(id); loadedAt[id] = nil }

    /// Résumé cumulé sur les business du périmètre (les effectifs s'additionnent, les taux se recalculent).
    func combined(_ projectIds: [String]) -> PosthogSummary? {
        let list = projectIds.compactMap { summaries[$0] }
        guard let first = list.first else { return nil }
        if list.count == 1 { return first }
        let steps = PosthogStep.allCases.compactMap { step -> PosthogSummary.Step? in
            let parts = list.compactMap { $0.funnel.first { $0.step == step } }
            guard !parts.isEmpty else { return nil }
            return .init(step: step, event: parts[0].event, users: parts.reduce(0) { $0 + $1.users }, medianSeconds: parts.compactMap(\.medianSeconds).max())
        }
        let at = { (s: PosthogStep) in steps.first { $0.step == s }?.users }
        let ratio = { (a: Int?, b: Int?) -> Double? in guard let a, let b, a > 0 else { return nil }; return Double(b) / Double(a) }
        let avg = { (v: [Double]) -> Double? in v.isEmpty ? nil : v.reduce(0, +) / Double(v.count) }
        return PosthogSummary(
            days: first.days, funnel: steps,
            paywallConversion: ratio(at(.paywall), at(.purchase)),
            installToPaid: ratio(at(.open) ?? steps.first?.users, at(.purchase)),
            dau: list.reduce(0) { $0 + $1.dau }, wau: list.reduce(0) { $0 + $1.wau }, mau: list.reduce(0) { $0 + $1.mau },
            retentionD1: avg(list.compactMap(\.retentionD1)), retentionD7: avg(list.compactMap(\.retentionD7)),
            updatedAt: list.map(\.updatedAt).min() ?? first.updatedAt
        )
    }
}

func percentText(_ v: Double?) -> String {
    guard let v else { return "—" }
    return v.formatted(.percent.precision(.fractionLength(v < 0.1 ? 1 : 0)))
}

// MARK: - Connexion

struct PosthogConnectSheet: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    let project: ProjectSummary

    @State private var region = "eu"
    @State private var posthogProject = ""
    @State private var apiKey = ""
    @State private var events: [PosthogEventCount] = []
    @State private var mapping: [String: String] = [:]
    @State private var connected = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Serveur", selection: $region) {
                        Text("Europe (eu.posthog.com)").tag("eu")
                        Text("États-Unis (us.posthog.com)").tag("us")
                    }
                    TextField("Identifiant du projet (ex. 12345)", text: $posthogProject)
                        .keyboardType(.numberPad)
                    SecureField(connected ? String(localized: "Clé personnelle (déjà enregistrée)") : String(localized: "Clé personnelle phx_…"), text: $apiKey)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: {
                    Text("Projet PostHog de \(project.name)")
                } footer: {
                    Text("Dans PostHog : Paramètres → Clés API personnelles → nouvelle clé avec le droit « Query » (lecture). L'identifiant du projet est dans l'adresse : /project/12345.")
                }

                if connected {
                    Section {
                        ForEach(PosthogStep.allCases) { step in
                            Picker(selection: Binding(get: { mapping[step.rawValue] ?? "" }, set: { mapping[step.rawValue] = $0 })) {
                                Text("Aucun").tag("")
                                ForEach(events, id: \.event) { e in Text(e.event).tag(e.event) }
                            } label: {
                                Label(step.label, systemImage: step.symbol)
                            }
                        }
                    } header: {
                        Text("Étapes de l'entonnoir")
                    } footer: {
                        Text("Proposées automatiquement d'après tes événements. Corrige si besoin, une étape « Aucun » est sautée.")
                    }
                    Section {
                        Button("Déconnecter PostHog", role: .destructive) { Task { await disconnect() } }
                    }
                }

                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(MMColor.red) }
                }
            }
            .scrollContentBackground(.hidden)
            .background { MMBackdrop() }
            .navigationTitle("PostHog")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Fermer") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(connected ? String(localized: "Enregistrer") : String(localized: "Connecter")) { Task { await save() } }
                        .disabled(busy || posthogProject.isEmpty || (!connected && apiKey.isEmpty))
                }
            }
            .overlay { if busy { ProgressView().controlSize(.large) } }
            .task { await loadStatus() }
        }
    }

    private func loadStatus() async {
        guard let s = try? await store.client.posthog(projectId: project.projectId), let c = s.config else { return }
        connected = s.connected
        region = c.host.contains("us.") ? "us" : "eu"
        posthogProject = c.projectId
        mapping = c.events
        if connected, let r = try? await store.client.connectPosthog(projectId: project.projectId, host: region, posthogProject: c.projectId, apiKey: nil, events: nil) {
            events = r.events
        }
    }

    private func save() async {
        busy = true; error = nil
        defer { busy = false }
        do {
            let r = try await store.client.connectPosthog(projectId: project.projectId, host: region, posthogProject: posthogProject,
                                                          apiKey: apiKey, events: connected ? mapping : nil)
            let wasConnected = connected
            connected = true; apiKey = ""; events = r.events; mapping = r.config.events
            await PosthogStore.shared.load([project.projectId], client: store.client, force: true)
            if wasConnected { dismiss() }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func disconnect() async {
        busy = true
        defer { busy = false }
        do {
            try await store.client.disconnectPosthog(projectId: project.projectId)
            PosthogStore.shared.forget(project.projectId)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

// MARK: - Détail : l'entonnoir

struct PosthogFunnelDetail: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var ph = PosthogStore.shared
    @State private var connecting: ProjectSummary?

    var body: some View {
        let ids = store.scoped?.projects.map(\.projectId) ?? []
        ScrollView {
            VStack(alignment: .leading, spacing: RecoveryTileTheme.gridSpacing) {
                if let s = ph.combined(ids) {
                    funnel(s)
                    PosthogTiles(summary: s, includeHeadline: true)
                    Text("Données PostHog des \(s.days) derniers jours · mises à jour \(Date(timeIntervalSince1970: s.updatedAt / 1000).formatted(.relative(presentation: .named)))")
                        .font(MMFont.system(11)).foregroundStyle(MMColor.ink3).frame(maxWidth: .infinity).padding(.top, 6)
                } else {
                    Text("Aucun business du périmètre n'est relié à PostHog.").font(MMFont.system(14)).foregroundStyle(MMColor.ink2)
                }
                connections
            }
            .padding(.horizontal, 16).padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
        .refreshable { await ph.load(ids, client: store.client, force: true) }
        .task { await ph.load(ids, client: store.client) }
        .navigationTitle("Entonnoir")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .sheet(item: $connecting) { PosthogConnectSheet(project: $0) }
        .mmPage()
    }

    private func funnel(_ s: PosthogSummary) -> some View {
        let top = Double(max(s.funnel.first?.users ?? 1, 1))
        return RecoveryTileSurface(dotsAnchor: .topTrailing, dotsReach: 0.6) {
            VStack(alignment: .leading, spacing: 14) {
                RecoveryTileHeader(symbol: "line.3.horizontal.decrease", title: String(localized: "Du premier lancement à l'achat"))
                ForEach(Array(s.funnel.enumerated()), id: \.element.step) { i, step in
                    VStack(alignment: .leading, spacing: 6) {
                        if i > 0 {
                            let prev = s.funnel[i - 1].users
                            let drop = prev > 0 ? 1 - Double(step.users) / Double(prev) : 0
                            Label("−\(percentText(drop)) perdus", systemImage: "arrow.down.right")
                                .font(V2Font.system(size: 12)).foregroundStyle(RecoveryTileTheme.deltaDown.opacity(0.85))
                        }
                        HStack {
                            Label(step.step.label, systemImage: step.step.symbol).font(V2Font.system(size: 14, weight: .medium))
                            Spacer()
                            Text(step.users.formatted()).font(V2Font.system(size: 15, weight: .medium))
                            Text(percentText(Double(step.users) / top)).font(V2Font.system(size: 13)).foregroundStyle(RecoveryTileTheme.footer)
                                .frame(width: 48, alignment: .trailing)
                        }
                        .foregroundStyle(RecoveryTileTheme.value)
                        GeometryReader { g in
                            Capsule().fill(RecoveryTileTheme.gaugeTrack.opacity(0.6))
                                .overlay(alignment: .leading) {
                                    Capsule().fill(LinearGradient(colors: [RecoveryTileTheme.violetDeep, RecoveryTileTheme.violetBright], startPoint: .leading, endPoint: .trailing))
                                        .frame(width: max(6, g.size.width * Double(step.users) / top))
                                        .shadow(color: RecoveryTileTheme.violetBright.opacity(0.4), radius: 5)
                                }
                        }
                        .frame(height: 8)
                    }
                }
            }
            .padding(18)
        }
    }

    private var connections: some View {
        VStack(alignment: .leading, spacing: 8) {
            MMLabel(text: String(localized: "Connexions PostHog")).padding(.horizontal, 4).padding(.top, 12)
            ForEach(store.scoped?.projects ?? []) { p in
                Button { connecting = p } label: {
                    HStack(spacing: 12) {
                        ProjectIcon(project: p, size: 30)
                        Text(p.name).font(MMFont.system(15, .semibold)).lineLimit(1)
                        Spacer()
                        (ph.connected.contains(p.projectId) ? Text("Connecté") : Text("Connecter"))
                            .font(MMFont.system(13, .medium))
                            .foregroundStyle(ph.connected.contains(p.projectId) ? MMColor.accent : MMColor.ink2)
                        Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(MMColor.ink3)
                    }
                    .padding(.vertical, 6)
                    .foregroundStyle(MMColor.ink)
                    .contentShape(Rectangle())
                }
                .buttonStyle(MMPressStyle(scale: 0.98))
            }
        }
    }
}

// MARK: - Cartes

/// Cartes PostHog, même style que celles de l'Accueil.
struct PosthogTiles: View {
    let summary: PosthogSummary
    /// Inclut les deux cartes principales (conversion paywall, installation → payant).
    var includeHeadline = false

    var body: some View {
        let s = summary
        VStack(spacing: RecoveryTileTheme.gridSpacing) {
            if includeHeadline {
                ForEach(PosthogTiles.headline(s), id: \.title) { $0.tile }
            }
            ForEach(PosthogTiles.extras(s), id: \.title) { $0.tile }
        }
    }

    static func headline(_ s: PosthogSummary) -> [ExtraStat] {
        [
            ExtraStat(symbol: "rectangle.stack.badge.person.crop", title: String(localized: "Conversion paywall"), value: percentText(s.paywallConversion), ratio: s.paywallConversion ?? 0),
            ExtraStat(symbol: "arrow.down.app.fill", title: String(localized: "Installation → payant"), value: percentText(s.installToPaid), ratio: s.installToPaid ?? 0),
        ]
    }

    static func extras(_ s: PosthogSummary) -> [ExtraStat] {
        var out = [
            ExtraStat(symbol: "person.fill", title: String(localized: "Utilisateurs actifs · jour"), value: s.dau.formatted(), ratio: s.mau > 0 ? Double(s.dau) / Double(s.mau) : 0),
            ExtraStat(symbol: "person.2.fill", title: String(localized: "Utilisateurs actifs · semaine"), value: s.wau.formatted(), ratio: s.mau > 0 ? Double(s.wau) / Double(s.mau) : 0),
            ExtraStat(symbol: "person.3.fill", title: String(localized: "Utilisateurs actifs · mois"), value: s.mau.formatted(), ratio: 1),
        ]
        if let r = s.retentionD1 { out.append(ExtraStat(symbol: "arrow.uturn.left.circle", title: String(localized: "Rétention J1"), value: percentText(r), ratio: r)) }
        if let r = s.retentionD7 { out.append(ExtraStat(symbol: "arrow.uturn.left.circle.fill", title: String(localized: "Rétention J7"), value: percentText(r), ratio: r)) }
        if let p = s.funnel.first(where: { $0.step == .purchase }), let secs = p.medianSeconds, secs > 0 {
            let h = secs / 3600
            out.append(ExtraStat(symbol: "timer", title: String(localized: "Délai médian avant achat"), value: h < 48 ? String(localized: "\(Int(h.rounded())) h") : String(localized: "\(Int((h / 24).rounded())) j"), ratio: min(h / 168, 1)))
        }
        return out
    }
}
