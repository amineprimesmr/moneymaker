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

// MARK: - Icône d'un business

/// Icône App Store du business (coins continus façon iOS), initiale en repli.
struct ProjectIcon: View {
    let project: ProjectSummary?
    var size: CGFloat = 40

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous)
        Group {
            if let s = project?.iconUrl, let url = URL(string: s) {
                CachedImage(url: url) { fallback }
            } else { fallback }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
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

/// Les logos des business choisis, alignés à gauche comme des cartes posées en éventail.
/// Empilement explicite (ZStack + profondeur fixe) : le premier est devant, chaque suivant
/// derrière le précédent, le logo mis en avant passe devant tout — jamais d'inversion,
/// même pendant les animations. Relief : tranche extrudée + biseau, une seule ombre douce.
struct LogoFan: View {
    let projects: [ProjectSummary]
    var focusId: String? = nil
    var onTap: (String) -> Void = { _ in }
    var size: CGFloat = 36
    var maxShown = 7

    var body: some View {
        let shown = Array(projects.prefix(maxShown))
        let extra = projects.count - shown.count
        let step = size * 0.88                         // ≈ 12 % de recouvrement
        let width = size + step * CGFloat(max(shown.count - 1, 0)) + (extra > 0 ? size * 0.9 : 0)
        ZStack(alignment: .leading) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { i, p in
                let focused = focusId == p.projectId
                let dimmed = focusId != nil && !focused
                Button { onTap(p.projectId) } label: {
                    tile(p)
                        .rotation3DEffect(.degrees(focused ? -8 : -22), axis: (x: 0.12, y: 1, z: 0), anchor: .leading, perspective: 0.45)
                        .scaleEffect(focused ? 1.1 : 1, anchor: .bottomLeading)
                        .offset(y: focused ? -3 : 0)
                        .opacity(dimmed ? 0.38 : 1)
                        .saturation(dimmed ? 0.15 : 1)
                }
                .buttonStyle(MMPressStyle(scale: 0.92))
                .accessibilityLabel(p.name)
                .accessibilityAddTraits(focused ? .isSelected : [])
                .offset(x: step * CGFloat(i))
                .zIndex(focused ? 1000 : Double(shown.count - i))
                .transition(.asymmetric(
                    insertion: .scale(scale: 0.4, anchor: .leading).combined(with: .opacity),
                    removal: .scale(scale: 0.6, anchor: .leading).combined(with: .opacity)))
            }
            if extra > 0 {
                Text("+\(extra)")
                    .font(MMFont.number(14, .regular)).foregroundStyle(.white)
                    .frame(width: size * 0.7, height: size * 0.7)
                    .background(Color.white.opacity(0.08), in: Circle())
                    .offset(x: step * CGFloat(shown.count) + size * 0.15)
                    .zIndex(0)
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .frame(width: width, height: size * 1.2, alignment: .leading)
        .padding(.leading, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.spring(response: 0.45, dampingFraction: 0.82), value: projects.map(\.projectId))
        .animation(.spring(response: 0.38, dampingFraction: 0.78), value: focusId)
        .sensoryFeedback(.selection, trigger: focusId)
    }

    /// Une icône en relief : tranche sombre sous la face, face légèrement bombée, ombre douce.
    private func tile(_ p: ProjectSummary) -> some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous)
        return ZStack {
            ForEach((1...4).reversed(), id: \.self) { k in
                shape.fill(Color(white: 0.16 - Double(k) * 0.03))
                    .offset(x: CGFloat(k) * 0.6, y: CGFloat(k) * 0.8)
            }
            ProjectIcon(project: p, size: size)
                .overlay {
                    shape.fill(LinearGradient(stops: [
                        .init(color: .white.opacity(0.18), location: 0),
                        .init(color: .clear, location: 0.4),
                        .init(color: .clear, location: 0.7),
                        .init(color: .black.opacity(0.22), location: 1)], startPoint: .top, endPoint: .bottom))
                        .blendMode(.overlay)
                }
                .overlay(shape.strokeBorder(Color.black.opacity(0.35), lineWidth: 0.5))
        }
        .frame(width: size, height: size)
        .compositingGroup()
        .shadow(color: .black.opacity(0.55), radius: 5, x: 2, y: 4)
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
                .padding(.bottom, 18)
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 6) {
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

    private func row(_ p: ProjectSummary) -> some View {
        let progress = setup.byProject[p.projectId]?.progress
        let selected = store.activeIds.contains(p.projectId)
        return HStack(spacing: 14) {
            ProjectIcon(project: p, size: 38)
                .opacity(selected ? 1 : 0.4)
                .saturation(selected ? 1 : 0)
                .overlay(alignment: .bottomTrailing) {
                    if let progress {
                        Circle().fill(progress >= 1 ? MMColor.accent : MMColor.orange)
                            .frame(width: 9, height: 9)
                            .overlay(Circle().stroke(Color.black, lineWidth: 2))
                            .offset(x: 3, y: 3)
                    }
                }
            Text(p.name).font(MMFont.system(17, .semibold))
                .foregroundStyle(selected ? Color.white : MMColor.ink3).lineLimit(1)
            Spacer(minLength: 8)
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(selected ? MMColor.accent : Color.white.opacity(0.25))
                .contentTransition(.symbolEffect(.replace))
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .animation(.snappy(duration: 0.25), value: selected)
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
