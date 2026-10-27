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
            // Une seule publication pour tous les business (une par réponse redessinait le menu N fois).
            var next = byProject
            for await (id, s) in g { if let s { next[id] = s } }
            byProject = next
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
            Color(white: 0.16)
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

/// Ne reçoit que ce qu'il affiche (pas tout le Store) et se compare sur ces entrées :
/// les ticks du direct, le flux et les chargements ne le redessinent plus.
struct BusinessSideBar: View, Equatable {
    @ObservedObject private var setup = SetupCache.shared
    let projects: [ProjectSummary]
    let activeIds: Set<String>
    let client: MoneyMakerClient
    @Binding var isExpanded: Bool
    /// Coche / décoche un business ; false si refusé (dernier business).
    var toggleProject: (String) -> Bool
    var open: (ProjectSummary) -> Void
    var openSettings: () -> Void
    /// Menu inversé par rapport à l'app : papier clair en mode sombre, ardoise en mode clair.
    @Environment(\.colorScheme) private var appScheme
    private var ink: Color { appScheme == .light ? .white : .black }

    static func == (a: Self, b: Self) -> Bool {
        a.activeIds == b.activeIds
            && a.client.token == b.client.token && a.projects == b.projects
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Logo en modèle : noir sur le papier clair, blanc sur l'ardoise.
            Image("Logo").resizable().scaledToFit().frame(height: 30)
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
                        Text("Aucun business pour l'instant.").font(MMFont.system(14)).foregroundStyle(ink.opacity(0.4))
                    }
                    Rectangle().fill(ink.opacity(0.08)).frame(height: 1).padding(.vertical, 12)
                    menuButton("plus.circle.fill", "Nouveau business") {
                        // Au-delà du business gratuit : le paywall Pro ; sinon le dashboard web.
                        Task { await ProPaywall.shared.newBusiness(client: client) }
                    }
                    menuButton("gearshape.fill", "Réglages") { openSettings() }
                    menuButton("safari.fill", "Dashboard web") {
                        UIApplication.shared.open(URL(string: "https://usemoneymaker.com")!)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 12)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
            .mask { Rectangle().ignoresSafeArea() }
            .scrollClipDisabled()
            .refreshable { await setup.load(projects, client: client, force: true) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding([.horizontal, .top], 18)
        .environment(\.colorScheme, appScheme == .light ? .dark : .light)
        .task(id: projects.map(\.projectId)) { await setup.load(projects, client: client) }
        // Rafraîchi après l'animation d'ouverture (pas pendant : chaque réponse redessinait le menu
        // et faisait sauter le glissé). Écoute sans redessiner le panneau.
        .onReceive(IGMenuVisibility.shared.$visible.removeDuplicates()) { open in
            guard open else { return }
            Task { try? await Task.sleep(for: .milliseconds(450)); await setup.load(projects, client: client) }
        }
        .sensoryFeedback(.selection, trigger: activeIds)
        .sensoryFeedback(.error, trigger: refused)
    }

    @State private var refused = 0
    @State private var shake: String?

    /// Sélection multiple : le menu reste ouvert, l'Accueil se transforme derrière en direct.
    /// Le dernier business coché ne peut pas être retiré (vibration d'erreur + petite secousse).
    private func toggle(_ id: String) {
        if !toggleProject(id) {
            refused += 1
            withAnimation(.spring(response: 0.18, dampingFraction: 0.3)) { shake = id }
            Task { try? await Task.sleep(for: .milliseconds(260)); withAnimation(.spring) { shake = nil } }
        }
    }

    private func row(_ p: ProjectSummary) -> some View {
        let progress = setup.byProject[p.projectId]?.progress
        let selected = activeIds.contains(p.projectId)
        return HStack(spacing: 14) {
            ProjectIcon(project: p, size: 38)
                .opacity(selected ? 1 : 0.4)
                .saturation(selected ? 1 : 0)
                .overlay(alignment: .bottomTrailing) {
                    if let progress {
                        Circle().fill(progress >= 1 ? MMColor.accent : MMColor.orange)
                            .frame(width: 9, height: 9)
                            .overlay(Circle().stroke(appScheme == .light ? Color(white: 0.12) : .white, lineWidth: 2))
                            .offset(x: 3, y: 3)
                    }
                }
            Text(p.name).font(MMFont.system(17, .semibold))
                .foregroundStyle(selected ? ink : ink.opacity(0.35)).lineLimit(1)
            Spacer(minLength: 8)
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(selected ? Color(red: 0, green: 0.72, blue: 0.47) : ink.opacity(0.18))
                .contentTransition(.symbolEffect(.replace))
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .animation(.snappy(duration: 0.25), value: selected)
        .offset(x: shake == p.projectId ? 8 : 0)
    }

    private func menuButton(_ icon: String, _ title: LocalizedStringKey, action: @escaping () -> Void) -> some View {
        Button { isExpanded = false; action() } label: {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.system(size: 18)).frame(width: 28)
                Text(title).font(MMFont.system(17, .semibold))
            }
            .foregroundStyle(ink.opacity(0.85))
            .padding(.vertical, 6)
        }
        .buttonStyle(MMPressStyle(scale: 0.96))
    }
}

/// Fond du menu : blanc, avec un nuage de petits carrés sombres qui scintille en bas,
/// au contour irrégulier comme celui des cartes de l'Accueil.
struct SideBarBackdrop: View {
    /// Seulement « menu visible ou non » : observer la progression redessinait ce fond à chaque image du glissement.
    @ObservedObject private var menu = IGMenuVisibility.shared
    @Environment(\.colorScheme) private var appScheme

    var body: some View {
        let inverted = appScheme == .light
        ZStack {
            // Blanc cassé en mode sombre, ardoise profonde en mode clair (le menu inverse l'app).
            LinearGradient(colors: inverted ? [Color(white: 0.14), Color(white: 0.07)] : [Color(white: 0.93), Color(white: 0.86)],
                           startPoint: .top, endPoint: .bottom)
            // Toujours montés (rastérisés une fois) : les créer au début du glissement faisait sauter l'animation.
            SideBarDots(drifting: menu.visible, ink: inverted ? .white : .black)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

private struct SideBarDots: View {
    let drifting: Bool
    var ink: Color = .black
    @State private var drift = false

    var body: some View {
        // Chaque nappe est rastérisée seule (`drawingGroup`) et c'est la texture qui dérive : avant, le
        // `drawingGroup` englobait les décalages animés et refaisait tout le rendu Metal à chaque image.
        ZStack(alignment: .bottom) {
            RecoveryDotMatrix(anchor: .bottomLeading, reach: 0.62, maxOpacity: 0.55, animated: false, ink: ink)
                .environment(\.recoveryDotSeed, 7)
                .frame(height: 420)
                .drawingGroup()
                .offset(y: drift ? -6 : 6)
            RecoveryDotMatrix(anchor: .bottomTrailing, reach: 0.5, maxOpacity: 0.35, animated: false, ink: ink)
                .environment(\.recoveryDotSeed, 13)
                .frame(height: 300)
                .drawingGroup()
                .offset(y: drift ? 5 : -5)
            RecoveryDotMatrix(anchor: .topTrailing, reach: 0.75, maxOpacity: 0.5, animated: false, ink: ink)
                .environment(\.recoveryDotSeed, 21)
                .frame(height: 380)
                .drawingGroup()
                .frame(maxHeight: .infinity, alignment: .top)
                .offset(y: drift ? 6 : -6)
            RecoveryDotMatrix(anchor: .topLeading, reach: 0.55, maxOpacity: 0.35, animated: false, ink: ink)
                .environment(\.recoveryDotSeed, 33)
                .frame(height: 260)
                .drawingGroup()
                .frame(maxHeight: .infinity, alignment: .top)
                .offset(y: drift ? -5 : 5)
        }
        // La dérive ne tourne que menu visible ; menu fermé, rien ne s'anime derrière l'app.
        .onChange(of: drifting, initial: true) { _, on in
            if on { withAnimation(.easeInOut(duration: 4).repeatForever(autoreverses: true)) { drift = true } }
            else { withAnimation(.linear(duration: 0)) { drift = false } }
        }
    }
}
