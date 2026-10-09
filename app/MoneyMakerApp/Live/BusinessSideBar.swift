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

// MARK: - Icône d'un business

/// Icône App Store du business (coins continus façon iOS), initiale en repli.
struct ProjectIcon: View {
    let project: ProjectSummary?
    var size: CGFloat = 40

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous)
        Group {
            if let s = project?.iconUrl, let url = URL(string: s) {
                AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.25))) { phase in
                    if let img = phase.image { img.resizable().scaledToFill() } else { fallback }
                }
            } else { fallback }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5))
    }

    private var fallback: some View {
        ZStack {
            Color.white.opacity(0.08)
            if let p = project {
                Text(String(p.name.prefix(1)).uppercased()).font(MMFont.system(size * 0.42, .semibold)).foregroundStyle(.white)
            } else {
                Image(systemName: "square.stack.3d.up.fill").font(.system(size: size * 0.38, weight: .semibold)).foregroundStyle(.white)
            }
        }
    }
}

/// Icônes empilées des premiers business — l'avatar de « Tous les business ».
struct ProjectIconStack: View {
    let projects: [ProjectSummary]
    var size: CGFloat = 40
    var body: some View {
        let shown = Array(projects.prefix(3))
        ZStack {
            if shown.isEmpty { ProjectIcon(project: nil, size: size) }
            ForEach(Array(shown.enumerated().reversed()), id: \.element.id) { i, p in
                ProjectIcon(project: p, size: size * 0.78)
                    .offset(x: CGFloat(i) * size * 0.14, y: CGFloat(i) * -size * 0.08)
                    .shadow(color: .black.opacity(0.5), radius: 3, x: -1)
            }
        }
        .frame(width: size, height: size, alignment: .bottomLeading)
    }
}

// MARK: - Éventail 3D des business affichés

/// Les logos des business choisis, côte à côte, inclinés et légèrement superposés, en perspective.
/// Le logo du centre est au premier plan ; chacun flotte doucement avec un décalage de phase.
/// Entrées/sorties en ressort quand la sélection change. Toucher ouvre le sélecteur.
struct LogoFan: View {
    let projects: [ProjectSummary]
    var size: CGFloat = 62
    var maxShown = 6
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shown = Array(projects.prefix(maxShown))
        let extra = projects.count - shown.count
        let n = shown.count
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { tl in
            let t = reduceMotion ? 0 : tl.date.timeIntervalSinceReferenceDate
            HStack(spacing: n > 1 ? -size * 0.3 : 0) {
                ForEach(Array(shown.enumerated()), id: \.element.id) { i, p in
                    let c = Double(i) - Double(n - 1) / 2            // position par rapport au centre
                    let float = sin(t * 1.3 + Double(i) * 1.1) * 2.5
                    tile(p)
                        .rotation3DEffect(.degrees(-c * 16), axis: (x: 0, y: 1, z: 0), perspective: 0.55)
                        .rotationEffect(.degrees(c * 6))
                        .offset(y: abs(c) * 7 + float)
                        .zIndex(10 - abs(c))
                        .transition(.asymmetric(
                            insertion: .scale(scale: 0.3).combined(with: .opacity).combined(with: .offset(y: 18)),
                            removal: .scale(scale: 0.5).combined(with: .opacity)))
                }
                if extra > 0 {
                    Text("+\(extra)")
                        .font(MMFont.number(16, .regular)).foregroundStyle(.white)
                        .frame(width: size * 0.62, height: size * 0.62)
                        .background(Color.white.opacity(0.1), in: Circle())
                        .overlay(Circle().strokeBorder(Color.white.opacity(0.15)))
                        .padding(.leading, size * 0.42)
                        .transition(.scale.combined(with: .opacity))
                }
            }
        }
        .frame(height: size * 1.35)
        .animation(.spring(response: 0.5, dampingFraction: 0.72), value: projects.map(\.projectId))
        .accessibilityElement()
        .accessibilityLabel(projects.map(\.name).joined(separator: ", "))
    }

    private func tile(_ p: ProjectSummary) -> some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous)
        return ProjectIcon(project: p, size: size)
            .overlay {
                // Reflet : lumière venant du haut, comme une vraie icône vitrée.
                shape.fill(LinearGradient(colors: [Color.white.opacity(0.22), .clear, .clear], startPoint: .top, endPoint: .bottom))
                    .blendMode(.plusLighter)
            }
            .overlay(shape.strokeBorder(Color.white.opacity(0.18), lineWidth: 0.75))
            .shadow(color: .black.opacity(0.65), radius: 12, y: 8)
            .shadow(color: .white.opacity(0.05), radius: 1)
    }
}

// MARK: - Panneau

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
            HStack {
                Text("AFFICHER")
                    .font(MMFont.system(11, .medium)).tracking(2.2).foregroundStyle(MMColor.ink3)
                Spacer()
                Text("\(store.activeIds.count) sur \(projects.count)")
                    .font(MMFont.system(12, .medium)).foregroundStyle(MMColor.ink3)
                    .contentTransition(.numericText())
            }
            Text(summary(projects)).font(MMFont.system(12)).foregroundStyle(MMColor.ink3).lineLimit(1).minimumScaleFactor(0.8)
                .padding(.top, 2)

            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(projects) { p in
                        Button { toggle(p.projectId) } label: { row(p) }
                            .buttonStyle(MMPressStyle(scale: 0.97))
                            .contextMenu {
                                Button { isExpanded = false; open(p) } label: { Label("Voir le détail", systemImage: "chart.bar.doc.horizontal") }
                            }
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
                .padding(.top, 12)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
            .mask { Rectangle().ignoresSafeArea() }
            .scrollClipDisabled()
            .refreshable { await setup.load(projects, client: store.client, force: true) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding([.horizontal, .top], 18)
        .task(id: projects.map(\.projectId)) { await setup.load(projects, client: store.client) }
        .onChange(of: isExpanded) { _, open in if open { Task { await setup.load(projects, client: store.client) } } }
        .sensoryFeedback(.selection, trigger: store.activeIds)
        .sensoryFeedback(.error, trigger: refused)
    }

    @State private var refused = 0
    @State private var shake: String?

    /// Sélection multiple : le menu reste ouvert, l'Accueil se transforme derrière en direct.
    /// Le dernier business coché ne peut pas être retiré (vibration d'erreur + petite secousse).
    private func toggle(_ id: String) {
        if !store.toggle(id) {
            refused += 1
            withAnimation(.spring(response: 0.18, dampingFraction: 0.3)) { shake = id }
            Task { try? await Task.sleep(for: .milliseconds(260)); withAnimation(.spring) { shake = nil } }
        }
    }

    /// « Connecté » = au moins une source de revenus branchée et validée, ou un achat déjà reçu.
    /// (La mise en route à 100 % est une autre notion : elle est affichée sur chaque ligne.)
    private static let sources: Set<String> = ["sdk", "asc", "google", "stripe", "firstPurchase"]

    private func isConnected(_ p: ProjectSummary) -> Bool? {
        guard let status = setup.byProject[p.projectId] else { return nil }
        return status.steps.contains { Self.sources.contains($0.id) && $0.done } || p.mrrMicros > 0 || p.netRevenueMicros > 0
    }

    private func summary(_ projects: [ProjectSummary]) -> String {
        let known = projects.compactMap(isConnected)
        guard known.count == projects.count else { return "\(projects.count) business · vérification…" }
        let connected = known.filter { $0 }.count
        let toFinish = projects.filter { (setup.byProject[$0.projectId]?.progress ?? 1) < 1 }.count
        var parts = ["\(projects.count) business", connected == projects.count ? "tous connectés" : "\(connected) connecté\(connected > 1 ? "s" : "")"]
        if toFinish > 0 { parts.append("\(toFinish) à finir") }
        return parts.joined(separator: " · ")
    }

    private func card<C: View>(selected: Bool, @ViewBuilder _ content: () -> C) -> some View {
        content()
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.white.opacity(selected ? 0.09 : 0.04)))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(selected ? MMColor.accent.opacity(0.85) : Color.white.opacity(0.06), lineWidth: selected ? 1.5 : 1))
            .contentShape(Rectangle())
            .animation(.snappy(duration: 0.25), value: selected)
    }

    private func row(_ p: ProjectSummary) -> some View {
        let status = setup.byProject[p.projectId]
        let channels = Channel.all.filter { c in
            guard let step = status?.steps.first(where: { $0.id == c.id }) else { return false }
            return step.done || step.optional != true
        }
        let progress = status?.progress
        let selected = store.activeIds.contains(p.projectId)
        return card(selected: selected) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(selected ? MMColor.accent : Color.white.opacity(0.3))
                        .contentTransition(.symbolEffect(.replace))
                    ProjectIcon(project: p, size: 40)
                        .opacity(selected ? 1 : 0.45)
                        .saturation(selected ? 1 : 0)
                        .overlay(alignment: .bottomTrailing) {
                            if let progress {
                                Circle().fill(progress >= 1 ? MMColor.accent : MMColor.orange)
                                    .frame(width: 10, height: 10)
                                    .overlay(Circle().stroke(Color.black, lineWidth: 2))
                                    .offset(x: 3, y: 3)
                            }
                        }
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
                    .padding(.leading, 84)
                }
            }
        }
        .offset(x: shake == p.projectId ? 8 : 0)
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
