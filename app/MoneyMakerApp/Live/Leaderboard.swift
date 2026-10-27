//
//  Leaderboard.swift
//  MoneyMaker — classement public des business (façon TrustMRR).
//
//  Copie de la page Classement de V2 (podium 3D, projecteur, liste en cascade, ligne
//  « toi » épinglée, sélecteur en verre) adaptée aux business : l'icône remplace
//  l'avatar, le revenu vérifié par les stores remplace l'XP. Chaque business choisit
//  d'y figurer (carte « Ton business »), avec ou sans ses montants exacts.
//

import SwiftUI

// MARK: - Modèle

struct LeaderboardEntry: Codable, Identifiable, Hashable {
    let projectId: String
    let rank: Int
    let name: String
    let tagline: String?
    let website: String?
    let iconUrl: String?
    let mrrMicros: Int?
    let revenue30dMicros: Int?
    let mrrRange: String?
    let revenueRange: String?
    let growth30d: Double?
    let activeSubscriptions: Int
    let sources: [String]
    var id: String { projectId }
}

struct LeaderboardResponse: Codable { let currency: String; let updatedAt: Double; let total: Int; let entries: [LeaderboardEntry] }

struct PublicListing: Codable, Hashable {
    var listed: Bool
    var tagline: String?
    var website: String?
    var hideAmounts: Bool?
}

enum LeaderboardSort: String, CaseIterable, Hashable {
    case mrr, revenue, growth, subscribers
    /// Critères proposés au classement (croissance et abonnés restent sur la fiche du business).
    static let ranked: [LeaderboardSort] = [.mrr, .revenue]
    var title: String {
        switch self {
        case .mrr: return "MRR"
        case .revenue: return String(localized: "Revenus")
        case .growth: return String(localized: "Croissance")
        case .subscribers: return String(localized: "Abonnés")
        }
    }
}

extension LeaderboardEntry {
    /// Valeur affichée selon le critère : montant exact, ou tranche si le business masque ses chiffres.
    func value(for sort: LeaderboardSort, currency: String) -> String {
        switch sort {
        case .mrr: return mrrMicros.map { $0.money(currency, compact: true) } ?? mrrRange ?? "—"
        case .revenue: return revenue30dMicros.map { $0.money(currency, compact: true) } ?? revenueRange ?? "—"
        case .growth: return growth30d.map { String(localized: "\($0 >= 0 ? "+" : "")\(Int(($0 * 100).rounded())) %") } ?? "—"
        case .subscribers: return activeSubscriptions.formatted()
        }
    }
    var valueUnit: (LeaderboardSort) -> String { { $0 == .mrr && mrrMicros != nil ? String(localized: "/mois") : "" } }
    /// Positif = en hausse sur 30 jours (flèche à côté du rang, comme le delta de V2).
    var trend: Int { growth30d.map { $0 > 0.005 ? 1 : $0 < -0.005 ? -1 : 0 } ?? 0 }
}

extension MoneyMakerClient {
    /// Public : marche aussi sans jeton.
    /// Jamais de cache local ; `fresh` contourne aussi le cache du CDN (après une inscription).
    static func leaderboard(sort: LeaderboardSort, fresh: Bool = false) async throws -> LeaderboardResponse {
        var url = "\(MM.baseURL.absoluteString)/leaderboard?sort=\(sort.rawValue)&limit=200"
        if fresh { url += "&t=\(Int(Date().timeIntervalSince1970))" }
        var req = URLRequest(url: URL(string: url)!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 25)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        var last: Error = APIError(message: String(localized: "Classement indisponible"))
        // Deux essais : un réseau mobile qui décroche ne doit pas laisser l'écran en erreur.
        for attempt in 0..<2 {
            do {
                let (data, res) = try await URLSession.shared.data(for: req)
                guard let http = res as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    throw APIError(message: String(localized: "Le serveur a répondu \((res as? HTTPURLResponse)?.statusCode ?? 0)"))
                }
                return try JSONDecoder().decode(LeaderboardResponse.self, from: data)
            } catch {
                if error is CancellationError || (error as? URLError)?.code == .cancelled { throw error }
                last = error
                if attempt == 0 { try? await Task.sleep(for: .milliseconds(700)) }
            }
        }
        throw last
    }
    func listing(projectId: String) async throws -> PublicListing { try await get("projects/\(projectId)/public") }
    func setListing(projectId: String, _ l: PublicListing) async throws -> PublicListing {
        var body: [String: Any] = ["listed": l.listed, "hideAmounts": l.hideAmounts ?? false]
        if let t = l.tagline { body["tagline"] = t }
        if let w = l.website { body["website"] = w }
        return try await send("PUT", "projects/\(projectId)/public", body: body)
    }
}

// MARK: - Store

@MainActor
final class LeaderboardStore: ObservableObject {
    enum Phase { case loading, ready, failed }
    @Published var phase: Phase = .loading
    @Published var entries: [LeaderboardEntry] = []
    @Published var currency = "EUR"
    @Published var total = 0
    @Published var updatedAt: Date?
    @Published var errorMessage: String?
    private var loaded: LeaderboardSort?

    func load(_ sort: LeaderboardSort, force: Bool = false) async {
        if !force, loaded == sort, phase == .ready { return }
        if entries.isEmpty || phase == .failed { phase = .loading }
        do {
            let r = try await MoneyMakerClient.leaderboard(sort: sort, fresh: force)
            withAnimation(LBTheme.reorder) {
                entries = r.entries; currency = r.currency; total = r.total
                updatedAt = Date(timeIntervalSince1970: r.updatedAt / 1000); phase = .ready
            }
            loaded = sort; errorMessage = nil
        } catch {
            // Une requête annulée (changement d'onglet) n'est pas une erreur à afficher.
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            errorMessage = error.localizedDescription
            if entries.isEmpty { phase = .failed }
        }
    }

    /// L'entrée d'un business dans le classement affiché, s'il y figure.
    func entry(for projectId: String) -> LeaderboardEntry? { entries.first { $0.projectId == projectId } }
}

// MARK: - Thème (copie de LeaderboardTheme / TeamTheme de V2)

enum LBTheme {
    static let cardFill = MMColor.cardFill
    static let cardBorder = MMColor.cardBorder
    static let rowFill = MMColor.fg(0.040)
    static let rowFillHighlighted = MMColor.fg(0.105)
    static let titleSecondary = MMColor.fg(0.55)
    static let bodyText = MMColor.fg(0.60)
    static let valueTint = MMColor.fg(0.48)
    static let promotion = MMColor.accent
    static let relegation = MMColor.red
    static let rowCornerRadius: CGFloat = 20
    static let rowSpacing: CGFloat = 6
    static let reorder = Animation.spring(response: 0.52, dampingFraction: 0.84, blendDuration: 0.1)
    static let appear = Animation.spring(response: 0.36, dampingFraction: 0.86)
    static let entrance = Animation.spring(response: 0.62, dampingFraction: 0.78)
    static let pop = Animation.spring(response: 0.5, dampingFraction: 0.62)
    static let spring = Animation.spring(response: 0.34, dampingFraction: 0.86)
    static let gold = MMColor.hex(0xE0B23C), silver = MMColor.hex(0xB9C2CC), bronze = MMColor.hex(0xB87333)
}

// MARK: - Écran

struct LeaderboardScreen: View {
    @EnvironmentObject private var store: Store
    @StateObject private var board = LeaderboardStore()
    @State private var sort: LeaderboardSort = .mrr
    @State private var selected: LeaderboardEntry?
    @State private var showJoin = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var refresh = IslandRefreshState {
        .init(running: String(localized: "Actualisation…"), done: String(localized: "Classement à jour"), failed: String(localized: "Échec de l'actualisation"))
    }

    private var mine: Set<String> { Set(store.allProjects.map(\.projectId)) }

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                header
                switch board.phase {
                case .loading: LeaderboardSkeleton().transition(.opacity)
                case .failed:
                    LeaderboardNoticeCard(systemImage: "wifi.exclamationmark", title: String(localized: "Classement indisponible"),
                                          message: board.errorMessage ?? String(localized: "Vérifie ta connexion.")) {
                        Button { Task { await board.load(sort, force: true) } } label: {
                            Text("Réessayer").font(MMFont.system(15, .semibold)).foregroundStyle(MMColor.ink)
                                .padding(.horizontal, 18).padding(.vertical, 11)
                                .mmGlass(in: Capsule(style: .continuous), interactive: true)
                        }
                        .buttonStyle(.plain).padding(.top, 4)
                    }
                case .ready: rankingContent.transition(.opacity)
                }
                if !store.isDemo && !store.allProjects.isEmpty { joinCard.mmAppear(3) }
                footer
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
        }
        .scrollIndicators(.hidden).igShrinksTabBar()
        .islandRefreshable(refresh) { await board.load(sort, force: true); return board.phase != .failed }
        .overlay(alignment: .top) { IslandRefreshBanner(state: refresh).ignoresSafeArea() }
        .mmPage()
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .task(id: sort) { await board.load(sort, force: board.phase != .ready) }
        .sheet(item: $selected) { BusinessPublicSheet(entry: $0, currency: board.currency).presentationDetents([.medium, .large]) }
        .sheet(isPresented: $showJoin) { JoinLeaderboardSheet(board: board) { Task { await board.load(sort, force: true) } } }
    }

    private var header: some View {
        VStack(spacing: 14) {
            Text("Classement").font(MMFont.system(30, .bold)).foregroundStyle(MMColor.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
            SortPicker(selection: $sort)
        }
        .mmAppear(0)
    }

    @ViewBuilder
    private var rankingContent: some View {
        let ranked = board.entries
        LeaderboardEntrance { hasAppeared in
            VStack(spacing: 28) {
                PodiumView(
                    first: ranked.indices.contains(0) ? ranked[0] : nil,
                    second: ranked.indices.contains(1) ? ranked[1] : nil,
                    third: ranked.indices.contains(2) ? ranked[2] : nil,
                    sort: sort, currency: board.currency, mine: mine,
                    hasAppeared: hasAppeared,
                    onSelect: { selected = $0 },
                    onInvite: { showJoin = true }
                )
                // Projecteur sur le podium : il tombe du haut de l'écran sur la première marche.
                .background(alignment: .top) {
                    PodiumSpotlight(color: MMColor.hex(0xEDCF85))
                        .frame(height: 300 + 320)
                        .offset(y: -300)
                        .opacity(hasAppeared ? 1 : 0)
                        .scaleEffect(x: hasAppeared ? 1 : 0.5, y: 1, anchor: .top)
                        .animation(reduceMotion ? nil : .smooth(duration: 1.2).delay(0.2), value: hasAppeared)
                }

                if ranked.count > 3 {
                    RankedRowList(rows: Array(ranked.dropFirst(3)), sort: sort, currency: board.currency, mine: mine,
                                  hasAppeared: hasAppeared) { selected = $0 }
                } else if ranked.count < 3 {
                    LeaderboardNoticeCard(systemImage: "trophy", title: String(localized: "Le classement démarre"),
                                          message: String(localized: "Inscris ton business pour prendre ta place sur le podium. Seuls des revenus vérifiés comptent.")) {
                        if !store.isDemo && !store.allProjects.isEmpty {
                            Button { showJoin = true } label: {
                                Text("Inscrire mon business").font(MMFont.system(15, .semibold)).foregroundStyle(MMColor.ink)
                                    .padding(.horizontal, 18).padding(.vertical, 11)
                                    .background { Capsule(style: .continuous).fill(MMColor.fg(0.12)) }
                                    .mmGlass(in: Capsule(style: .continuous), interactive: true)
                            }
                            .buttonStyle(.plain).padding(.top, 4)
                        }
                    }
                }
            }
        }
        .id(sort)
    }

    private var joinCard: some View {
        let listed = board.entries.filter { mine.contains($0.projectId) }
        return Button { showJoin = true } label: {
            HStack(spacing: 14) {
                ProjectIconStack(projects: store.allProjects, size: 40)
                VStack(alignment: .leading, spacing: 3) {
                    (listed.isEmpty ? Text("Inscrire mon business") : Text("Mes business au classement"))
                        .font(MMFont.system(16, .semibold)).foregroundStyle(MMColor.ink)
                    Text(listed.isEmpty ? String(localized: "Montre tes revenus vérifiés, en public.")
                         : listed.map { "\($0.name) · #\($0.rank)" }.joined(separator: "  "))
                        .font(MMFont.system(13)).foregroundStyle(LBTheme.bodyText).lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(MMColor.ink3)
            }
            .padding(16)
            .background {
                RoundedRectangle(cornerRadius: 24, style: .continuous).fill(LBTheme.cardFill)
                    .overlay { RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(LBTheme.cardBorder, lineWidth: 1) }
            }
        }
        .buttonStyle(MMPressStyle())
    }

    private var footer: some View {
        VStack(spacing: 6) {
            if let d = board.updatedAt {
                Text("\(board.total) business · mis à jour \(d.formatted(date: .omitted, time: .shortened))")
            }
        }
        .font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
        .padding(.bottom, 20)
    }
}

// MARK: - Entrée (même correctif que V2 : drapeau levé depuis onAppear seulement)

private struct LeaderboardEntrance<Content: View>: View {
    @ViewBuilder var content: (Bool) -> Content
    @State private var hasAppeared = false
    var body: some View {
        content(hasAppeared).onAppear { if !hasAppeared { hasAppeared = true } }
    }
}

// MARK: - Sélecteur en verre

private struct SortPicker: View {
    @Binding var selection: LeaderboardSort
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var ns

    var body: some View {
        HStack(spacing: 2) {
            ForEach(LeaderboardSort.ranked, id: \.self) { s in
                Button {
                    guard selection != s else { return }
                    withAnimation(reduceMotion ? nil : LBTheme.spring) { selection = s }
                } label: {
                    Text(s.title)
                        .font(MMFont.system(14, .semibold))
                        .foregroundStyle(selection == s ? MMColor.ink : MMColor.fg(0.65))
                        .lineLimit(1).minimumScaleFactor(0.8)
                        .padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 36)
                        .background {
                            if selection == s {
                                Capsule().fill(MMColor.fg(0.14)).matchedGeometryEffect(id: "lb-sort", in: ns)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == s ? [.isSelected] : [])
            }
        }
        .padding(3)
        .mmGlass(in: Capsule(style: .continuous), interactive: true)
        .sensoryFeedback(.selection, trigger: selection)
    }
}

// MARK: - Podium (copie de PodiumView de V2)

private enum PodiumSide { case left, center, right }

private struct PodiumView: View {
    let first: LeaderboardEntry?
    let second: LeaderboardEntry?
    let third: LeaderboardEntry?
    let sort: LeaderboardSort
    let currency: String
    let mine: Set<String>
    let hasAppeared: Bool
    var onSelect: (LeaderboardEntry) -> Void
    var onInvite: () -> Void

    var body: some View {
        GeometryReader { geo in
            let sideWidth = geo.size.width * 0.32
            let centerWidth = geo.size.width - sideWidth * 2
            HStack(alignment: .bottom, spacing: 0) {
                column(second, rank: 2, side: .left, icon: 62, front: 142, depth: 26, slant: 22, delay: 0.10).frame(width: sideWidth).zIndex(1)
                column(first, rank: 1, side: .center, icon: 80, front: 200, depth: 20, slant: 11, delay: 0.22).frame(width: centerWidth).zIndex(3)
                column(third, rank: 3, side: .right, icon: 62, front: 108, depth: 30, slant: 22, delay: 0.02).frame(width: sideWidth).zIndex(1)
            }
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
        .frame(height: 450)
        .background {
            Circle()
                .fill(RadialGradient(colors: [MMColor.fg(0.05), .clear], center: .center, startRadius: 12, endRadius: 190))
                .frame(width: 380, height: 380).offset(y: -22).allowsHitTesting(false)
        }
        // Les blocs se fondent dans le sol (masque, pas d'aplat : voir V2).
        .mask {
            LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.87), .init(color: .clear, location: 1)],
                           startPoint: .top, endPoint: .bottom)
        }
    }

    private func column(_ e: LeaderboardEntry?, rank: Int, side: PodiumSide, icon: CGFloat, front: CGFloat, depth: CGFloat, slant: CGFloat, delay: Double) -> some View {
        PodiumColumn(entry: e, rank: rank, side: side, iconSize: icon, frontHeight: front, topDepth: depth, slant: slant,
                     showTrophy: side == .center, isMine: e.map { mine.contains($0.projectId) } ?? false,
                     value: e?.value(for: sort, currency: currency), hasAppeared: hasAppeared, riseDelay: delay,
                     onSelect: onSelect, onInvite: onInvite)
    }
}

private struct PodiumColumn: View {
    let entry: LeaderboardEntry?
    let rank: Int
    let side: PodiumSide
    let iconSize: CGFloat
    let frontHeight: CGFloat
    let topDepth: CGFloat
    let slant: CGFloat
    let showTrophy: Bool
    let isMine: Bool
    let value: String?
    let hasAppeared: Bool
    let riseDelay: Double
    var onSelect: (LeaderboardEntry) -> Void
    var onInvite: () -> Void
    @State private var trophyBounce = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            if let entry { onSelect(entry) } else { onInvite() }
        } label: { columnContent }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .accessibilityLabel(Text(entry.map { String(localized: "Rang \(rank), \($0.name), \(value ?? "")") } ?? String(localized: "Place libre")))
    }

    private var columnContent: some View {
        VStack(spacing: 10) {
            if showTrophy {
                Text("🏆").font(.system(size: 30))
                    .offset(y: trophyBounce ? -3 : 3)
                    .scaleEffect(hasAppeared ? 1 : 0.4).opacity(hasAppeared ? 1 : 0)
                    .animation(LBTheme.pop.delay(riseDelay + 0.32), value: hasAppeared)
                    .onAppear {
                        guard !reduceMotion, !trophyBounce else { return }
                        withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true).delay(0.9)) { trophyBounce = true }
                    }
                    .onDisappear { trophyBounce = false }
            }

            Group {
                if let entry {
                    // Les marches latérales regardent vers le centre du podium.
                    LeaderboardIcon3D(entry: entry, size: iconSize, tilt: side == .left ? 14 : side == .right ? -14 : 0, isMine: isMine)
                } else {
                    RoundedRectangle(cornerRadius: iconSize * 0.2237, style: .continuous)
                        .strokeBorder(MMColor.fg(0.28), style: StrokeStyle(lineWidth: 1.5, dash: [5, 5]))
                        .background(RoundedRectangle(cornerRadius: iconSize * 0.2237, style: .continuous).fill(MMColor.fg(0.05)))
                        .overlay {
                            Image(systemName: "plus").font(.system(size: iconSize * 0.3, weight: .semibold)).foregroundStyle(MMColor.fg(0.5))
                        }
                        .frame(width: iconSize, height: iconSize)
                }
            }
            .scaleEffect(hasAppeared ? 1 : 0.5).opacity(hasAppeared ? 1 : 0)
            .animation(LBTheme.pop.delay(riseDelay + 0.16), value: hasAppeared)

            VStack(spacing: 2) {
                Text(entry?.name ?? String(localized: "Libre"))
                    .font(MMFont.system(14, .semibold))
                    .foregroundStyle(MMColor.fg(entry == nil ? 0.5 : 1))
                    .lineLimit(1).minimumScaleFactor(0.85)
                Text(value ?? " ")
                    .font(MMFont.number(13, .semibold)).monospacedDigit()
                    .foregroundStyle(MMColor.accent)
                    .lineLimit(1).minimumScaleFactor(0.7)
                    .contentTransition(.numericText())
            }
            .padding(.horizontal, 4)
            .opacity(hasAppeared ? 1 : 0).offset(y: hasAppeared ? 0 : 6)
            .animation(LBTheme.entrance.delay(riseDelay + 0.3), value: hasAppeared)

            PodiumBlock3D(rank: rank, side: side, frontHeight: frontHeight, topDepth: topDepth, slant: slant,
                          hasAppeared: hasAppeared, riseDelay: riseDelay)
                .frame(maxWidth: .infinity).padding(.top, 2)
                .scaleEffect(y: hasAppeared ? 1 : 0.001, anchor: .bottom).opacity(hasAppeared ? 1 : 0)
                .animation(LBTheme.entrance.delay(riseDelay), value: hasAppeared)
        }
    }
}

/// Un bloc du podium vu de face et légèrement du dessus (face haute éclairée, face avant
/// qui tombe dans le noir, chiffre gravé). Identique à V2.
private struct PodiumBlock3D: View {
    let rank: Int
    let side: PodiumSide
    let frontHeight: CGFloat
    let topDepth: CGFloat
    let slant: CGFloat
    let hasAppeared: Bool
    let riseDelay: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @State private var sheenOffset: CGFloat = -110
    private var isLight: Bool { colorScheme == .light }

    var body: some View { VStack(spacing: 0) { topFace; frontFace } }

    private var topFace: some View {
        let shape = PodiumTopFace(side: side, slant: slant)
        return GeometryReader { geo in
            ZStack(alignment: .leading) {
                shape.fill(topGradient)
                shape.fill(outerCornerLight)
                Rectangle()
                    .fill(LinearGradient(colors: [.clear, MMColor.fg(0.38), .clear], startPoint: .leading, endPoint: .trailing))
                    .frame(width: 64).blur(radius: 5).offset(x: sheenOffset)
            }
            .mask(shape)
            .overlay { shape.stroke(MMColor.fg(0.10), lineWidth: 0.6) }
            // Le reflet ne part qu'à la suite d'une vraie entrée, jamais seul (voir V2).
            .onChange(of: hasAppeared) { _, appeared in
                guard appeared, !reduceMotion, sheenOffset < 0 else { return }
                withAnimation(.easeInOut(duration: 1.1).delay(riseDelay + 0.9)) { sheenOffset = geo.size.width + 110 }
            }
        }
        .frame(height: topDepth)
    }

    private var topGradient: LinearGradient {
        LinearGradient(colors: [PodiumInk.tone(side == .center ? 0.52 : 0.55), PodiumInk.tone(side == .center ? 0.67 : 0.70)],
                       startPoint: .top, endPoint: .bottom)
    }

    private var outerCornerLight: LinearGradient {
        switch side {
        case .left: return LinearGradient(colors: [MMColor.fg(0.10), .clear], startPoint: .leading, endPoint: .trailing)
        case .right: return LinearGradient(colors: [.clear, MMColor.fg(0.10)], startPoint: .leading, endPoint: .trailing)
        case .center: return LinearGradient(colors: [MMColor.fg(0.05), .clear], startPoint: .top, endPoint: .bottom)
        }
    }

    private var frontFace: some View {
        GeometryReader { geo in
            ZStack {
                Rectangle().fill(LinearGradient(stops: [
                    .init(color: PodiumInk.tone(0.435), location: 0),
                    .init(color: PodiumInk.tone(0.30), location: 0.14),
                    .init(color: PodiumInk.tone(0.175), location: 0.42),
                    .init(color: PodiumInk.tone(0.10), location: 0.74),
                    .init(color: PodiumInk.tone(0.062), location: 1),
                ], startPoint: .top, endPoint: .bottom))
                Rectangle()
                    .fill(LinearGradient(colors: [.clear, MMColor.fg(side == .center ? 0.08 : 0.04), .clear], startPoint: .leading, endPoint: .trailing))
                    .mask { LinearGradient(colors: [.white, .clear], startPoint: .top, endPoint: .bottom) }
                Rectangle().fill(MMColor.fg(0.22)).frame(height: 1).frame(maxHeight: .infinity, alignment: .top)
                // Chiffre gravé dans la pierre : creux sombre en mode sombre, creux éclairé (chiffre clair) en mode clair.
                Text("\(rank)")
                    .font(MMFont.system(58, .bold))
                    .foregroundStyle(
                        LinearGradient(colors: isLight ? [Color.white.opacity(0.96), PodiumInk.tone(0.80)]
                                                       : [PodiumInk.tone(0.03), PodiumInk.tone(0.10)],
                                       startPoint: .top, endPoint: .bottom)
                            .shadow(.inner(color: Color.black.opacity(isLight ? 0.55 : 0.95), radius: isLight ? 1.2 : 1.8, x: 0, y: isLight ? 1.6 : 2.6))
                            .shadow(.inner(color: Color.white.opacity(isLight ? 0.9 : 0.14), radius: 0.6, x: 0, y: -1))
                    )
                    // Arête basse du creux qui accroche la lumière, ombre portée haute qui le creuse.
                    .background {
                        Text("\(rank)").font(MMFont.system(58, .bold))
                            .foregroundStyle(Color.white.opacity(isLight ? 0.35 : 0.20)).offset(y: 1.4).blur(radius: 0.4)
                    }
                    .background {
                        Text("\(rank)").font(MMFont.system(58, .bold))
                            .foregroundStyle(Color.black.opacity(isLight ? 0.45 : 0.6)).offset(y: -1).blur(radius: 0.8)
                    }
                    .opacity(hasAppeared ? 1 : 0).scaleEffect(hasAppeared ? 1 : 0.8)
                    .animation(LBTheme.entrance.delay(riseDelay + 0.34), value: hasAppeared)
                    .position(x: geo.size.width / 2, y: frontHeight * (side == .center ? 0.30 : side == .left ? 0.42 : 0.46))
            }
        }
        .frame(height: frontHeight)
    }
}

/// Gris légèrement froid : du béton au clair de lune, pas un gris neutre.
private enum PodiumInk {
    static func tone(_ v: Double) -> Color { Color(.sRGB, red: v * 0.965, green: v * 0.985, blue: min(v * 1.09, 1)) }
}

private struct PodiumTopFace: Shape {
    let side: PodiumSide
    let slant: CGFloat
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.maxY))
        switch side {
        case .center:
            p.addLine(to: CGPoint(x: r.minX + slant, y: r.minY)); p.addLine(to: CGPoint(x: r.maxX - slant, y: r.minY))
        case .left:
            p.addLine(to: CGPoint(x: r.minX + slant, y: r.minY)); p.addLine(to: CGPoint(x: r.maxX + slant, y: r.minY))
        case .right:
            p.addLine(to: CGPoint(x: r.minX - slant, y: r.minY)); p.addLine(to: CGPoint(x: r.maxX - slant, y: r.minY))
        }
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY))
        p.closeSubpath()
        return p
    }
}

// MARK: - Projecteur (copie d'ActivityRecordSpotlight de V2)

private struct PodiumSpotlight: View {
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible = false
    @State private var swing = false
    @State private var breathe = false

    /// En pause pendant le défilement : trois couches floutées qui tournent coûtent cher au compositeur.
    private var animating: Bool { visible && !reduceMotion && scenePhase == .active && !ScrollActivity.shared.scrolling }

    var body: some View {
        GeometryReader { g in
            let w = g.size.width, h = g.size.height
            ZStack(alignment: .top) {
                beam(w: w, h: h).padding(48).drawingGroup().padding(-48)
                rays(h: h).padding(16).drawingGroup().padding(-16)
                    .opacity(breathe ? 1 : 0.7)
                    .animation(animating ? .easeInOut(duration: 2.7).repeatForever(autoreverses: true) : .default, value: breathe)
            }
            .frame(width: w, height: h, alignment: .top)
            .rotationEffect(.degrees(swing ? 4 : -4), anchor: .top)
            .animation(animating ? .easeInOut(duration: 9.8).repeatForever(autoreverses: true) : .default, value: swing)
            .compositingGroup()
            .blendMode(.plusLighter)
        }
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .onChange(of: animating, initial: true) { _, on in swing = on; breathe = on }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func beam(w: CGFloat, h: CGFloat) -> some View {
        ZStack(alignment: .top) {
            Cone(topWidth: w * 0.10, bottomWidth: w * 0.92)
                .fill(LinearGradient(stops: [
                    .init(color: color.opacity(0.30), location: 0), .init(color: color.opacity(0.16), location: 0.45),
                    .init(color: color.opacity(0.07), location: 0.85), .init(color: color.opacity(0), location: 1),
                ], startPoint: .top, endPoint: .bottom))
                .blur(radius: 26)
            Cone(topWidth: w * 0.04, bottomWidth: w * 0.44)
                .fill(LinearGradient(stops: [
                    .init(color: MMColor.fg(0.16), location: 0), .init(color: color.opacity(0.14), location: 0.5),
                    .init(color: color.opacity(0), location: 1),
                ], startPoint: .top, endPoint: .bottom))
                .blur(radius: 14)
            Ellipse().fill(color.opacity(0.55)).frame(width: w * 0.34, height: 26).blur(radius: 20).offset(y: -13)
        }
        .frame(width: w, height: h, alignment: .top)
    }

    private func rays(h: CGFloat) -> some View {
        ZStack(alignment: .top) {
            ForEach(0..<4, id: \.self) { i in
                Capsule()
                    .fill(LinearGradient(colors: [color.opacity(0.22), color.opacity(0)], startPoint: .top, endPoint: .bottom))
                    .frame(width: [7, 4, 5, 8][i], height: h * 0.9)
                    .blur(radius: 5)
                    .rotationEffect(.degrees([-11, -4, 5, 12][i]), anchor: .top)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private struct Cone: Shape {
        var topWidth: CGFloat
        var bottomWidth: CGFloat
        func path(in r: CGRect) -> Path {
            var p = Path()
            p.move(to: CGPoint(x: r.midX - topWidth / 2, y: r.minY))
            p.addLine(to: CGPoint(x: r.midX + topWidth / 2, y: r.minY))
            p.addLine(to: CGPoint(x: r.midX + bottomWidth / 2, y: r.maxY))
            p.addLine(to: CGPoint(x: r.midX - bottomWidth / 2, y: r.maxY))
            p.closeSubpath()
            return p
        }
    }
}

// MARK: - Liste (rangs 4+, ligne « toi » épinglée en bas)

private struct RankedRowList: View {
    let rows: [LeaderboardEntry]
    let sort: LeaderboardSort
    let currency: String
    let mine: Set<String>
    var hasAppeared: Bool
    var onSelect: (LeaderboardEntry) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isOwnRowVisible: Bool

    init(rows: [LeaderboardEntry], sort: LeaderboardSort, currency: String, mine: Set<String>, hasAppeared: Bool, onSelect: @escaping (LeaderboardEntry) -> Void) {
        self.rows = rows; self.sort = sort; self.currency = currency; self.mine = mine
        self.hasAppeared = hasAppeared; self.onSelect = onSelect
        // Pile paresseuse : une ligne loin en bas n'existe pas encore, on part de sa position.
        _isOwnRowVisible = State(initialValue: rows.firstIndex { mine.contains($0.projectId) }.map { $0 < 6 } ?? true)
    }

    var body: some View {
        LazyVStack(spacing: LBTheme.rowSpacing) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                Button { onSelect(row) } label: {
                    LeaderboardRowView(entry: row, sort: sort, currency: currency, isMine: mine.contains(row.projectId))
                }
                .buttonStyle(MMPressStyle())
                .opacity(hasAppeared ? 1 : 0)
                .offset(y: hasAppeared ? 0 : 12)
                // Le retard se fige au huitième rang : au-delà, la cascade devient une attente.
                .animation(reduceMotion ? nil : LBTheme.entrance.delay(0.26 + Double(min(index, 7)) * 0.04), value: hasAppeared)
                .modifier(OwnRowVisibility(isTracked: mine.contains(row.projectId)) { isOwnRowVisible = $0 })
            }
        }
        .animation(reduceMotion ? nil : LBTheme.reorder, value: rows.map(\.projectId))
        .safeAreaInset(edge: .bottom, spacing: 0) { pinnedRow }
    }

    @ViewBuilder
    private var pinnedRow: some View {
        if let row = rows.first(where: { mine.contains($0.projectId) }), !isOwnRowVisible {
            LeaderboardRowView(entry: row, sort: sort, currency: currency, isMine: true, isPinned: true)
                .padding(.bottom, 8)
                .background {
                    LinearGradient(colors: [MMColor.bg.opacity(0), MMColor.bg], startPoint: .top, endPoint: .bottom)
                        .padding(.top, -28).allowsHitTesting(false)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .animation(reduceMotion ? nil : LBTheme.appear, value: isOwnRowVisible)
        }
    }
}

private struct OwnRowVisibility: ViewModifier {
    let isTracked: Bool
    let onChange: (Bool) -> Void
    func body(content: Content) -> some View {
        if isTracked, #available(iOS 18.0, *) {
            content.onScrollVisibilityChange(threshold: 0.6) { onChange($0) }
        } else {
            content
        }
    }
}

// MARK: - Ligne

struct LeaderboardRowView: View {
    let entry: LeaderboardEntry
    let sort: LeaderboardSort
    let currency: String
    var isMine = false
    var isPinned = false

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: LBTheme.rowCornerRadius, style: .continuous) }

    var body: some View {
        // Formaté une seule fois par rendu (montant + libellé d'accessibilité).
        let value = entry.value(for: sort, currency: currency)
        return HStack(spacing: 12) {
            VStack(spacing: 1) {
                Text("\(entry.rank)")
                    .font(MMFont.system(16, .bold)).monospacedDigit()
                    .foregroundStyle(rankTint)
                    .contentTransition(.numericText(value: Double(entry.rank)))
                if entry.trend != 0 {
                    Image(systemName: entry.trend > 0 ? "arrowtriangle.up.fill" : "arrowtriangle.down.fill")
                        .font(.system(size: 7, weight: .bold))
                        .foregroundStyle(entry.trend > 0 ? LBTheme.promotion : LBTheme.relegation)
                }
            }
            .frame(width: 26)

            LeaderboardIcon3D(entry: entry, size: 38)

            VStack(alignment: .leading, spacing: 3) {
                Text(entry.name)
                    .font(MMFont.system(16, isMine ? .bold : .semibold)).foregroundStyle(MMColor.ink)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    VerifiedSources(sources: entry.sources)
                    if let t = entry.tagline {
                        Text(t).font(MMFont.system(12.5)).foregroundStyle(LBTheme.valueTint).lineLimit(1)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text(value)
                    .font(MMFont.number(16, .bold)).monospacedDigit()
                    .foregroundStyle(MMColor.fg(0.92))
                    .contentTransition(.numericText())
                Text(entry.valueUnit(sort))
                    .font(MMFont.system(12, .bold)).foregroundStyle(MMColor.fg(0.48))
            }
            .lineLimit(1).minimumScaleFactor(0.8)
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .background {
            shape.fill(isMine ? LBTheme.rowFillHighlighted : LBTheme.rowFill)
                .overlay { shape.strokeBorder(isMine ? MMColor.accent.opacity(0.45) : MMColor.fg(0.05), lineWidth: isMine ? 1.2 : 1) }
        }
        .clipShape(shape)
        .shadow(color: isPinned ? Color.black.opacity(0.55) : .clear, radius: isPinned ? 18 : 0, y: isPinned ? -4 : 0)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Rang \(entry.rank), \(entry.name)\(isMine ? String(localized: ", ton business") : ""), \(value)"))
    }

    private var rankTint: Color {
        switch entry.rank {
        case 1: return LBTheme.gold
        case 2: return LBTheme.silver
        case 3: return LBTheme.bronze
        default: return LBTheme.valueTint
        }
    }
}

/// Pastilles « vérifié » : d'où viennent les chiffres.
private struct VerifiedSources: View {
    let sources: [String]
    var body: some View {
        HStack(spacing: 3) {
            ForEach(sources, id: \.self) { s in
                Image(systemName: s == "stripe" ? "creditcard.fill" : s == "googleplay" ? "play.fill" : "apple.logo")
                    .font(.system(size: 8.5, weight: .bold))
                    .foregroundStyle(MMColor.accent)
                    .frame(width: 16, height: 16)
                    .background(Circle().fill(MMColor.accent.opacity(0.14)))
            }
        }
        .accessibilityLabel(Text("Vérifié"))
    }
}

/// Icône du business (coins continus façon iOS), initiale en repli.
struct LeaderboardIcon: View {
    let entry: LeaderboardEntry
    var size: CGFloat = 40
    var bordered = true
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous)
        Group {
            if let s = entry.iconUrl, let url = URL(string: s) { CachedImage(url: url) { fallback } } else { fallback }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .overlay { if bordered { shape.strokeBorder(MMColor.fg(0.10), lineWidth: 0.5) } }
    }
    private var fallback: some View {
        ZStack {
            // FNV-1a sur l'id : la même teinte sur chaque appareil (comme les avatars de V2).
            let hue = Double(entry.projectId.utf8.reduce(UInt32(2_166_136_261)) { ($0 ^ UInt32($1)) &* 16_777_619 } % 360) / 360
            LinearGradient(colors: [Color(hue: hue, saturation: 0.52, brightness: 0.62), Color(hue: (hue + 0.08).truncatingRemainder(dividingBy: 1), saturation: 0.62, brightness: 0.38)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            Text(String(entry.name.prefix(1)).uppercased()).font(MMFont.system(size * 0.42, .semibold)).foregroundStyle(.white)
        }
    }
}

/// Logo du business en relief : tranche extrudée sous la face, biseau éclairé par le haut,
/// reflet glossy, ombre portée teintée par le logo lui-même. `tilt` oriente la face en 3D.
struct LeaderboardIcon3D: View {
    let entry: LeaderboardEntry
    var size: CGFloat = 40
    var tilt: Double = 0
    var isMine = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous)
        let depth = max(2, size * 0.075)
        ZStack {
            // Ombre colorée : le logo flouté, posé sous le bloc.
            LeaderboardIcon(entry: entry, size: size, bordered: false)
                .scaleEffect(0.86)
                .blur(radius: size * 0.2)
                .opacity(0.6)
                .offset(y: depth + size * 0.14)
            // Ombre de contact.
            Ellipse().fill(.black.opacity(0.55))
                .frame(width: size * 0.8, height: size * 0.16)
                .blur(radius: size * 0.06)
                .offset(y: size * 0.5 + depth)
            // Tranche : le logo assombri, décalé vers le bas.
            LeaderboardIcon(entry: entry, size: size, bordered: false)
                .brightness(-0.38)
                .overlay { shape.fill(LinearGradient(colors: [.black.opacity(0.15), .black.opacity(0.55)], startPoint: .top, endPoint: .bottom)) }
                .clipShape(shape)
                .offset(y: depth)
            // Face.
            LeaderboardIcon(entry: entry, size: size, bordered: false)
                .overlay {
                    // Reflet : bande claire sur la moitié haute.
                    shape.fill(LinearGradient(stops: [.init(color: .white.opacity(0.32), location: 0),
                                                      .init(color: .white.opacity(0.08), location: 0.42),
                                                      .init(color: .clear, location: 0.5)],
                                              startPoint: .top, endPoint: .bottom))
                        .blendMode(.plusLighter)
                }
                .overlay {
                    // Ombre interne en bas de la face.
                    shape.stroke(.black.opacity(0.35), lineWidth: size * 0.08)
                        .blur(radius: size * 0.04)
                        .offset(y: -size * 0.03)
                        .clipShape(shape)
                }
                .overlay {
                    // Biseau : arête claire en haut, sombre en bas.
                    shape.strokeBorder(LinearGradient(colors: [.white.opacity(0.7), .white.opacity(0.08), .black.opacity(0.4)],
                                                      startPoint: .top, endPoint: .bottom),
                                       lineWidth: max(1, size * 0.028))
                }
        }
        .frame(width: size, height: size)
        .compositingGroup()
        .rotation3DEffect(.degrees(10), axis: (x: 1, y: 0, z: 0), anchor: .bottom, perspective: 0.5)
        .rotation3DEffect(.degrees(tilt), axis: (x: 0, y: 1, z: 0), perspective: 0.5)
        .overlay(alignment: .topTrailing) {
            if isMine {
                Text("Toi")
                    .font(MMFont.system(max(9, size * 0.15), .bold))
                    .foregroundStyle(.black)
                    .padding(.horizontal, size * 0.08).padding(.vertical, size * 0.03)
                    .background(Capsule().fill(MMColor.accent))
                    .overlay(Capsule().strokeBorder(.white.opacity(0.5), lineWidth: 0.5))
                    .shadow(color: MMColor.accent.opacity(0.6), radius: 6)
                    .offset(x: size * 0.16, y: -size * 0.1)
            }
        }
    }
}

// MARK: - Cartes

private struct LeaderboardNoticeCard<Footer: View>: View {
    let systemImage: String
    let title: String
    let message: String
    @ViewBuilder var footer: () -> Footer

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: systemImage).font(.system(size: 28, weight: .semibold)).foregroundStyle(LBTheme.titleSecondary).padding(.top, 4)
            Text(title).font(MMFont.system(19, .bold)).foregroundStyle(MMColor.ink).multilineTextAlignment(.center)
            Text(message).font(MMFont.system(14)).foregroundStyle(LBTheme.bodyText).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            footer()
        }
        .padding(24).frame(maxWidth: .infinity)
        .background {
            RoundedRectangle(cornerRadius: 24, style: .continuous).fill(LBTheme.cardFill)
                .overlay { RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(LBTheme.cardBorder, lineWidth: 1) }
        }
    }
}

extension LeaderboardNoticeCard where Footer == EmptyView {
    init(systemImage: String, title: String, message: String) {
        self.init(systemImage: systemImage, title: title, message: message) { EmptyView() }
    }
}

private struct LeaderboardSkeleton: View {
    @State private var isPulsing = false
    var body: some View {
        VStack(spacing: LBTheme.rowSpacing) {
            RoundedRectangle(cornerRadius: 28, style: .continuous).fill(LBTheme.cardFill).frame(height: 280).padding(.bottom, 12)
            ForEach(0..<4, id: \.self) { _ in
                RoundedRectangle(cornerRadius: LBTheme.rowCornerRadius, style: .continuous).fill(LBTheme.rowFill).frame(height: 64)
            }
        }
        .opacity(isPulsing ? 0.55 : 1)
        .animation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true), value: isPulsing)
        .onAppear { isPulsing = true }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Chargement du classement"))
    }
}

// MARK: - Fiche publique d'un business

private struct BusinessPublicSheet: View {
    let entry: LeaderboardEntry
    let currency: String

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                LeaderboardIcon(entry: entry, size: 84).padding(.top, 28)
                VStack(spacing: 6) {
                    Text(entry.name).font(MMFont.system(24, .bold))
                    if let t = entry.tagline { Text(t).font(MMFont.system(15)).foregroundStyle(MMColor.ink2).multilineTextAlignment(.center) }
                    Text("#\(entry.rank) au classement").font(MMFont.system(13, .semibold)).foregroundStyle(LBTheme.gold)
                }
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                    stat("MRR", entry.value(for: .mrr, currency: currency))
                    stat("Revenus 30 j", entry.value(for: .revenue, currency: currency))
                    stat("Croissance 30 j", entry.value(for: .growth, currency: currency))
                    stat("Abonnés actifs", entry.value(for: .subscribers, currency: currency))
                }
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.seal.fill").foregroundStyle(MMColor.accent)
                    Text("Vérifié par \(entry.sources.map { ["appstore": String(localized: "l'App Store"), "googleplay": "Google Play", "stripe": "Stripe"][$0] ?? $0 }.joined(separator: ", "))").font(MMFont.system(13)).foregroundStyle(MMColor.ink2)
                }
                if let w = entry.website, let url = URL(string: w) {
                    Link(destination: url) {
                        Label("Visiter le site", systemImage: "arrow.up.right").font(MMFont.system(15, .semibold))
                            .foregroundStyle(MMColor.ink).frame(maxWidth: .infinity).padding(.vertical, 14)
                            .mmGlass(in: Capsule(), interactive: true)
                    }
                }
            }
            .padding(.horizontal, 20).padding(.bottom, 24)
        }
        .background(MMColor.bg.ignoresSafeArea())
        .presentationBackground(MMColor.bg)
    }

    private func stat(_ title: LocalizedStringKey, _ value: String) -> some View {
        MMCard(padding: 14, radius: 20) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                Text(value).font(MMFont.number(20, .semibold)).foregroundStyle(MMColor.ink).lineLimit(1).minimumScaleFactor(0.7).mmNumeric()
            }
        }
    }
}

// MARK: - Inscription au classement

/// Un interrupteur par business, rien à saisir : le nom, l'icône, le lien (App Store,
/// Google Play ou site Stripe) et la catégorie viennent de ce que MoneyMaker sait déjà.
private struct JoinLeaderboardSheet: View {
    @ObservedObject var board: LeaderboardStore
    var onChange: () -> Void
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Active un business pour l'afficher au classement. Ses revenus viennent directement des stores ; son nom, son icône et son lien sont repris automatiquement.")
                        .font(MMFont.system(14)).foregroundStyle(MMColor.ink2)
                    ForEach(store.allProjects) { p in
                        ListingCard(project: p, entry: board.entry(for: p.projectId), currency: board.currency, onChange: onChange)
                    }
                }
                .padding(16)
            }
            .background(MMColor.bg.ignoresSafeArea())
            .navigationTitle("Classement public")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("OK") { dismiss() } } }
        }
        .tint(MMColor.accent)
    }
}

private struct ListingCard: View {
    let project: ProjectSummary
    let entry: LeaderboardEntry?
    let currency: String
    var onChange: () -> Void
    @EnvironmentObject private var store: Store
    @State private var listing: PublicListing?
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        MMCard(padding: 0) {
            VStack(spacing: 0) {
                HStack(spacing: 14) {
                    ProjectIcon(project: project, size: 40)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(project.name).font(MMFont.system(16, .semibold))
                        Text(status).font(MMFont.system(13)).foregroundStyle(statusTint).lineLimit(1)
                            .contentTransition(.opacity)
                    }
                    Spacer()
                    if listing == nil || saving { ProgressView() } else {
                        Toggle("", isOn: Binding(get: { listing?.listed ?? false }, set: { v in save { $0.listed = v } })).labelsHidden()
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 12)

                if listing?.listed == true {
                    Rectangle().fill(MMColor.hairline).frame(height: 1)
                    Toggle(isOn: Binding(get: { listing?.hideAmounts ?? false }, set: { v in save { $0.hideAmounts = v } })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Masquer les montants exacts").font(MMFont.system(15))
                            Text("Seule une tranche s'affiche, tu restes classé.").font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                        }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 10)
                }
                if let error {
                    Text(error).font(MMFont.system(13)).foregroundStyle(MMColor.red).padding(.horizontal, 16).padding(.bottom, 10)
                }
            }
        }
        .animation(.smooth, value: listing?.listed)
        .task { await reload() }
        .sensoryFeedback(.success, trigger: listing?.listed == true)
    }

    private var status: String {
        guard let listing else { return String(localized: "Chargement…") }
        guard listing.listed else { return String(localized: "Non affiché") }
        guard let e = entry else { return String(localized: "Inscrit · apparaît dans quelques secondes") }
        let v = e.value(for: .revenue, currency: currency)
        return e.revenue30dMicros == 0 && e.mrrMicros == 0 ? String(localized: "#\(e.rank) · pas encore de revenu vérifié") : String(localized: "#\(e.rank) au classement · \(v) sur 30 j")
    }
    private var statusTint: Color { listing?.listed == true ? (entry == nil ? MMColor.ink2 : MMColor.accent) : MMColor.ink3 }

    private func reload() async {
        do { listing = try await store.client.listing(projectId: project.projectId); error = nil }
        catch { listing = PublicListing(listed: false); self.error = String(localized: "Impossible de lire l'état : \(error.localizedDescription)") }
    }

    private func save(_ change: (inout PublicListing) -> Void) {
        guard var next = listing else { return }
        change(&next)
        let before = listing
        listing = next
        saving = true; error = nil
        Task {
            defer { saving = false }
            do { listing = try await store.client.setListing(projectId: project.projectId, next); onChange() }
            catch { listing = before; self.error = error.localizedDescription }
        }
    }
}
