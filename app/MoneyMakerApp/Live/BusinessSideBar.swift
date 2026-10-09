//
//  BusinessSideBar.swift
//  MoneyMaker — panneau latéral de l'Accueil : tous les business et l'état de leurs connexions.
//
//  Pour chaque business : MRR, abonnés, progression de la mise en route et une pastille
//  par canal (SDK, App Store, Google Play, Stripe, classements). Vert = branché et
//  vérifié, gris = pas encore. Les canaux sans objet (ex. pas d'app Android) sont masqués.
//

import SwiftUI

struct SetupStep: Codable, Hashable { let id: String; let done: Bool; let optional: Bool? }
struct SetupStatus: Codable, Hashable { let steps: [SetupStep]; let progress: Double }

extension MoneyMakerClient {
    func setup(projectId: String) async throws -> SetupStatus { try await get("projects/\(projectId)/setup") }
}

@MainActor
final class SetupCache: ObservableObject {
    static let shared = SetupCache()
    @Published var byProject: [String: SetupStatus] = [:]
    private var loadedAt: Date?

    func load(_ projects: [ProjectSummary], client: MoneyMakerClient, force: Bool = false) async {
        if !force, let t = loadedAt, Date().timeIntervalSince(t) < 120 { return }
        loadedAt = Date()
        await withTaskGroup(of: (String, SetupStatus?).self) { g in
            for p in projects { g.addTask { (p.projectId, try? await client.setup(projectId: p.projectId)) } }
            for await (id, s) in g { if let s { byProject[id] = s } }
        }
    }
}

/// Un canal de revenus / de données et l'étape de mise en route qui le valide.
private struct Channel: Identifiable {
    let id: String, label: String, icon: String
    static let all: [Channel] = [
        .init(id: "sdk", label: "SDK", icon: "chevron.left.forwardslash.chevron.right"),
        .init(id: "asc", label: "App Store", icon: "apple.logo"),
        .init(id: "google", label: "Google Play", icon: "play.fill"),
        .init(id: "stripe", label: "Stripe", icon: "creditcard.fill"),
        .init(id: "appstore", label: "Classements", icon: "trophy.fill"),
    ]
}

struct BusinessSideBar: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var setup = SetupCache.shared
    @Binding var isExpanded: Bool
    var open: (ProjectSummary) -> Void
    var openSettings: () -> Void

    var body: some View {
        let o = store.overview
        let projects = o?.projects ?? []
        VStack(alignment: .leading, spacing: 4) {
            Image("Logo").resizable().scaledToFit().frame(height: 30)
                .shadow(color: .white.opacity(0.15), radius: 8)
                .padding(.bottom, 14)
            Text(o.map { $0.mrrMicros.money($0.currency) } ?? "—")
                .font(MMFont.number(30)).tracking(-0.8).foregroundStyle(.white)
            HStack(spacing: 2) {
                Text("\(projects.count)").fontWeight(.bold)
                Text("business").foregroundStyle(MMColor.ink2)
                Text("\(connectedCount(projects))").fontWeight(.bold).padding(.leading, 10)
                Text("connectés").foregroundStyle(MMColor.ink2)
            }
            .font(MMFont.system(14, .medium))
            .padding(.top, 2)

            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(projects) { p in
                        Button { isExpanded = false; open(p) } label: { row(p) }
                            .buttonStyle(MMPressStyle(scale: 0.97))
                    }
                    if projects.isEmpty {
                        Text("Aucun business pour l'instant.").font(MMFont.system(14)).foregroundStyle(MMColor.ink3)
                    }
                    Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.vertical, 12)
                    menuButton("plus.circle.fill", "Nouveau business") {
                        UIApplication.shared.open(URL(string: "https://moneymaker-io.web.app")!)
                    }
                    menuButton("gearshape.fill", "Réglages") { openSettings() }
                    menuButton("safari.fill", "Dashboard web") {
                        UIApplication.shared.open(URL(string: "https://moneymaker-io.web.app")!)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 18)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
            .mask { Rectangle().ignoresSafeArea() }
            .overlay(alignment: .top) { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.horizontal, -18) }
            .padding(.top, 16)
            .scrollClipDisabled()
            .refreshable { await setup.load(projects, client: store.client, force: true) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding([.horizontal, .top], 18)
        .task(id: projects.map(\.projectId)) { await setup.load(projects, client: store.client) }
        .onChange(of: isExpanded) { _, open in if open { Task { await setup.load(projects, client: store.client) } } }
    }

    private func connectedCount(_ projects: [ProjectSummary]) -> Int {
        projects.filter { (setup.byProject[$0.projectId]?.progress ?? 0) >= 1 }.count
    }

    private func row(_ p: ProjectSummary) -> some View {
        let status = setup.byProject[p.projectId]
        let channels = Channel.all.filter { c in
            guard let step = status?.steps.first(where: { $0.id == c.id }) else { return false }
            return step.done || step.optional != true
        }
        let progress = status?.progress
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.07))
                    Text(String(p.name.prefix(1)).uppercased()).font(MMFont.system(16, .semibold)).foregroundStyle(.white)
                    if let progress {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .trim(from: 0, to: progress)
                            .stroke(progress >= 1 ? MMColor.accent : MMColor.orange, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    }
                }
                .frame(width: 40, height: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(p.name).font(MMFont.system(16, .semibold)).foregroundStyle(.white).lineLimit(1)
                    Text(progress.map { $0 >= 1 ? "Tout est branché" : "Mise en route \(Int($0 * 100)) %" } ?? "Vérification…")
                        .font(MMFont.system(12)).foregroundStyle(progress.map { $0 >= 1 ? MMColor.accent : MMColor.orange } ?? MMColor.ink3)
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(p.mrrMicros.money(p.currency, compact: true)).font(MMFont.number(15, .regular)).foregroundStyle(.white)
                    Text("\(p.activeSubscriptions) abonnés").font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                }
            }
            if !channels.isEmpty {
                HStack(spacing: 6) {
                    ForEach(channels) { c in
                        let done = status?.steps.first(where: { $0.id == c.id })?.done == true
                        Image(systemName: c.icon)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(done ? MMColor.accent : MMColor.ink3)
                            .frame(width: 26, height: 22)
                            .background((done ? MMColor.accent : Color.white).opacity(done ? 0.14 : 0.06), in: Capsule())
                            .accessibilityLabel("\(c.label) \(done ? "branché" : "à brancher")")
                    }
                }
                .padding(.leading, 52)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.white.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Color.white.opacity(0.06)))
        .contentShape(Rectangle())
    }

    private func menuButton(_ icon: String, _ title: String, action: @escaping () -> Void) -> some View {
        Button { isExpanded = false; action() } label: {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.system(size: 18)).frame(width: 28)
                Text(title).font(MMFont.system(17, .semibold))
            }
            .foregroundStyle(.white)
            .padding(.vertical, 6)
        }
        .buttonStyle(MMPressStyle(scale: 0.96))
    }
}
