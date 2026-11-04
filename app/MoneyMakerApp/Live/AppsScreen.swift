//
//  AppsScreen.swift
//  MoneyMaker — fiche App Store de chaque app, façon Toplify : planète des classements,
//  meilleures positions, score, évolution, notes et avis.
//

import SwiftUI
import Charts

/// Fiche publique de l'App Store : complète ce que le serveur n'a pas encore (logo, nom, note).
private struct StoreInfo: Codable, Hashable {
    let trackId: Int?
    let trackName: String?
    let artworkUrl512: String?
    let artistName: String?
    let averageUserRating: Double?
    let userRatingCount: Int?
    let formattedPrice: String?
    let trackViewUrl: String?

    static func fetch(_ appId: String) async -> StoreInfo? {
        struct R: Decodable { let results: [StoreInfo] }
        for country in ["fr", "us"] {
            guard let url = URL(string: "https://itunes.apple.com/lookup?id=\(appId)&country=\(country)"),
                  let (data, _) = try? await URLSession.shared.data(from: url),
                  let info = try? JSONDecoder().decode(R.self, from: data).results.first else { continue }
            return info
        }
        return nil
    }

    static func search(_ term: String) async -> [StoreInfo] {
        struct R: Decodable { let results: [StoreInfo] }
        var q = URLComponents(string: "https://itunes.apple.com/search")!
        q.queryItems = [.init(name: "term", value: term), .init(name: "entity", value: "software"),
                        .init(name: "country", value: "fr"), .init(name: "limit", value: "25")]
        guard let url = q.url, let (data, _) = try? await URLSession.shared.data(from: url) else { return [] }
        return (try? JSONDecoder().decode(R.self, from: data).results) ?? []
    }
}

private struct OwnedApp: Identifiable, Hashable {
    var project: ProjectSummary? = nil
    let app: TrackedAppSummary
    let store: StoreInfo?
    var id: String { app.appId }

    /// App trouvée par la recherche, hors de tes business.
    init?(found info: StoreInfo) {
        guard let id = info.trackId else { return nil }
        app = TrackedAppSummary(appId: String(id), name: info.trackName, icon: info.artworkUrl512, own: nil, rating: nil, ratingCount: nil,
                                countriesRanked: nil, bestRank: nil, topRankings: nil)
        store = info
    }
    init(project: ProjectSummary, app: TrackedAppSummary, store: StoreInfo?) {
        self.project = project; self.app = app; self.store = store
    }

    var name: String { app.name ?? store?.trackName ?? project?.name ?? app.appId }
    var icon: URL? { (app.icon ?? store?.artworkUrl512).flatMap(URL.init(string:)) }
    var developer: String? { app.developer ?? store?.artistName }
    var link: URL? { (app.url ?? store?.trackViewUrl).flatMap(URL.init(string:)) }
    var isOnStore: Bool { store != nil }
    /// Le serveur peut garder une note vide alors que l'App Store en a une.
    var rating: Double? { app.rating ?? store?.averageUserRating.flatMap { $0 > 0 ? $0 : nil } }
    var ratingCount: Int { max(app.ratingCount ?? 0, store?.userRatingCount ?? 0) }
}

/// Dernières recherches : un mot tapé, ou une app ouverte depuis les résultats.
private struct RecentSearch: Codable, Hashable {
    var term: String? = nil
    var app: StoreInfo? = nil

    private static let key = "mm.apps.recentSearches"
    static func load() -> [RecentSearch] {
        UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode([RecentSearch].self, from: $0) } ?? []
    }
    static func save(_ list: [RecentSearch]) {
        UserDefaults.standard.set(try? JSONEncoder().encode(list), forKey: key)
    }
}

private struct AppLogo: View {
    let item: OwnedApp
    var size: CGFloat
    var body: some View {
        Group {
            if let url = item.icon {
                CachedImage(url: url) { ProjectIcon(project: item.project, size: size) }
            } else {
                ProjectIcon(project: item.project, size: size)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous))
    }
}

struct AppsScreen: View {
    @EnvironmentObject var store: Store
    @Binding var searchActive: Bool
    @State private var apps: [OwnedApp] = []
    @State private var loaded = false

    @State private var query = ""
    @State private var results: [OwnedApp] = []
    @State private var searching = false
    @State private var recents = RecentSearch.load()
    @FocusState private var searchFocused: Bool

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isSearching: Bool { searchFocused || !trimmed.isEmpty }
    private var own: [OwnedApp] { apps.filter { $0.app.own != false } }
    private var untracked: [ProjectSummary] {
        (store.overview?.projects ?? []).filter { p in !apps.contains { $0.project?.projectId == p.projectId && $0.app.own != false } }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Mes apps").font(MMFont.system(34, .bold)).tracking(-0.8).padding(.top, 8).mmAppear(0)
                searchBar.mmAppear(0)
                if !trimmed.isEmpty {
                    if searching && results.isEmpty {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    } else if results.isEmpty {
                        MMCard { Text("Aucune app trouvée.").font(MMFont.system(14)).foregroundStyle(MMColor.ink2) }
                    }
                    ForEach(results) { item in
                        link(item).simultaneousGesture(TapGesture().onEnded {
                            if let info = item.store { remember(RecentSearch(app: info)) }
                        })
                    }
                } else if searchFocused {
                    searchHome
                } else if !loaded {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                } else {
                    ForEach(own) { link($0) }
                    ForEach(untracked) { p in
                        MMCard(padding: 14, radius: 22) {
                            HStack(spacing: 12) {
                                ProjectIcon(project: p, size: 52)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(p.name).font(MMFont.system(16, .semibold)).lineLimit(1)
                                    Text("Aucune app App Store suivie").font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                                }
                                Spacer(minLength: 0)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 110)
        }
        .scrollIndicators(.hidden)
        .mmPage()
        .navigationDestination(for: OwnedApp.self) { AppDetailView(item: $0) }
        .scrollDismissesKeyboard(.interactively)
        .task(id: store.overview?.projects.map(\.projectId)) { await load() }
        .task(id: trimmed) { await runSearch() }
        .onChange(of: isSearching) { _, s in
            // Disparaît d'un coup, avant que le clavier ne monte ; revient en fondu.
            if s { searchActive = true } else { withAnimation(.easeOut(duration: 0.25)) { searchActive = false } }
        }
        .onAppear { searchActive = isSearching }
        .onDisappear { searchActive = false }
    }

    /// Barre touchée, rien de tapé : tes apps, puis tes dernières recherches.
    private var searchHome: some View {
        VStack(alignment: .leading, spacing: 22) {
            if !own.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    sectionTitle("Mes apps")
                    ForEach(own) { item in
                        NavigationLink(value: item) { compactRow(item) }.buttonStyle(MMPressStyle())
                    }
                }
            }
            if !recents.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        sectionTitle("Recherches récentes")
                        Spacer()
                        Button("Effacer") { recents = []; RecentSearch.save([]) }
                            .font(MMFont.system(13)).foregroundStyle(MMColor.ink3)
                    }
                    ForEach(recents, id: \.self) { recentRow($0) }
                }
            }
        }
        .padding(.top, 10)
    }

    private func sectionTitle(_ title: LocalizedStringKey) -> some View {
        Text(title).font(MMFont.system(13, .semibold)).foregroundStyle(MMColor.ink3).padding(.bottom, 4)
    }

    private func compactRow(_ item: OwnedApp) -> some View {
        HStack(spacing: 12) {
            AppLogo(item: item, size: 38)
            Text(item.name).font(MMFont.system(15)).foregroundStyle(MMColor.ink).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5).contentShape(Rectangle())
    }

    @ViewBuilder
    private func recentRow(_ recent: RecentSearch) -> some View {
        if let info = recent.app, let item = OwnedApp(found: info) {
            NavigationLink(value: item) { compactRow(item) }.buttonStyle(MMPressStyle())
        } else if let term = recent.term {
            Button { query = term } label: {
                HStack(spacing: 12) {
                    Image(systemName: "clock").font(.system(size: 15)).foregroundStyle(MMColor.ink3).frame(width: 38, height: 38)
                    Text(verbatim: term).font(MMFont.system(15)).foregroundStyle(MMColor.ink).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 5).contentShape(Rectangle())
            }
            .buttonStyle(MMPressStyle())
        }
    }

    private func remember(_ recent: RecentSearch) {
        var list = recents
        // Une même app garde une seule ligne, même si sa fiche a changé depuis.
        list.removeAll { $0 == recent || ($0.app != nil && $0.app?.trackId == recent.app?.trackId) }
        list.insert(recent, at: 0)
        recents = Array(list.prefix(8))
        RecentSearch.save(recents)
    }

    private var searchBar: some View {
        HStack(spacing: 12) {
            searchField
            if isSearching {
                Button("Annuler") { query = ""; searchFocused = false }
                    .font(MMFont.system(15)).foregroundStyle(MMColor.ink)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: isSearching)
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").font(.system(size: 15, weight: .medium)).foregroundStyle(MMColor.ink3)
            TextField("", text: $query, prompt: Text("Chercher une app de l'App Store").foregroundStyle(MMColor.ink3))
                .font(MMFont.system(15)).focused($searchFocused).submitLabel(.search).autocorrectionDisabled()
                .onSubmit { if !trimmed.isEmpty { remember(RecentSearch(term: trimmed)) } }
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(MMColor.ink3)
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 13)
        .mmGlass(in: Capsule())
    }

    private func runSearch() async {
        guard !trimmed.isEmpty else { results = []; searching = false; return }
        searching = true
        try? await Task.sleep(for: .milliseconds(350))
        if Task.isCancelled { return }
        let found = await StoreInfo.search(trimmed)
        if Task.isCancelled { return }
        withAnimation(.easeOut(duration: 0.2)) { results = found.compactMap { OwnedApp(found: $0) } }
        searching = false
    }

    private func link(_ item: OwnedApp) -> some View {
        NavigationLink(value: item) { row(item) }.buttonStyle(MMPressStyle())
    }

    private func row(_ item: OwnedApp) -> some View {
        MMCard(padding: 14, radius: 22) {
            HStack(spacing: 12) {
                AppLogo(item: item, size: 52)
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.name).font(MMFont.system(16, .semibold)).foregroundStyle(MMColor.ink).lineLimit(1)
                    if let r = item.rating {
                        HStack(spacing: 4) {
                            Stars(value: r)
                            Text("\(r.formatted(.number.precision(.fractionLength(1)))) · \(item.ratingCount.formatted())")
                                .font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                        }
                    } else {
                        Text(item.isOnStore ? "Pas encore de notes" : "Introuvable sur l'App Store").font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                    }
                    if let n = item.app.countriesRanked, n > 0 {
                        Text("Classée dans \(n) pays").font(MMFont.system(12)).foregroundStyle(MMColor.ink2)
                    }
                }
                Spacer(minLength: 8)
                if let best = item.app.bestRank {
                    Text("#\(best)").font(MMFont.number(15, .semibold)).foregroundStyle(MMColor.accent)
                }
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(MMColor.ink3)
            }
        }
    }

    private func load() async {
        let projects = store.overview?.projects ?? []
        guard !projects.isEmpty else { return }
        let client = store.client
        var found: [OwnedApp] = []
        await withTaskGroup(of: [OwnedApp].self) { g in
            for p in projects {
                g.addTask {
                    let list = (try? await client.trackedApps(projectId: p.projectId)) ?? []
                    var out: [OwnedApp] = []
                    for a in list { out.append(OwnedApp(project: p, app: a, store: await StoreInfo.fetch(a.appId))) }
                    return out
                }
            }
            for await list in g { found += list }
        }
        withAnimation(.easeOut(duration: 0.3)) {
            apps = found.sorted { $0.ratingCount > $1.ratingCount }
            loaded = true
        }
    }
}

// MARK: - Fiche

private struct AppDetailView: View {
    @EnvironmentObject var store: Store
    let item: OwnedApp
    @State private var ranks: [AppRank] = []
    @State private var ratings: [AppRating] = []
    @State private var reviews: [AppReview] = []
    @State private var showAll = false
    @ObservedObject private var paywall = ProPaywall.shared

    /// Une ligne par pays : sa meilleure position, tous classements confondus.
    private var countries: [AppRank] {
        Dictionary(grouping: ranks.filter { $0.bestRank != nil }, by: \.cc).values
            .compactMap { $0.min { $0.bestRank! < $1.bestRank! } }
            .sorted { $0.bestRank! < $1.bestRank! }
    }
    private var trackedDays: Int {
        let first = ranks.compactMap(\.firstRankedAt).min() ?? Date().timeIntervalSince1970 * 1000
        return max(1, Int((Date().timeIntervalSince1970 * 1000 - first) / 86_400_000))
    }
    /// Score maison sur 100 : chaque pays compte d'autant plus que l'app y est haut.
    private var score: Double {
        let live = Dictionary(grouping: ranks.filter { $0.rank != nil }, by: \.cc).values.compactMap { $0.compactMap(\.rank).min() }
        return min(100, live.reduce(0) { $0 + Double(201 - min($1, 200)) / 100 })
    }
    private var timeline: [(day: Date, count: Int)] {
        var days: [Date: Set<String>] = [:]
        let cal = Calendar.current
        for r in ranks { for h in r.history ?? [] where h.r != nil {
            days[cal.startOfDay(for: Date(timeIntervalSince1970: h.t / 1000)), default: []].insert(r.cc)
        } }
        return days.map { (day: $0.key, count: $0.value.count) }.sorted { $0.day < $1.day }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                // Seul le bas de la planète dépasse sous le haut de l'écran ; elle rétrécit au défilement.
                Color.clear.frame(height: 390)
                    .overlay(alignment: .bottom) { GlobeView(spots: []).frame(width: 620, height: 620) }
                    .visualEffect { content, proxy in
                        content.scaleEffect(max(0.68, 1 + min(0, proxy.frame(in: .scrollView).minY) / 520), anchor: .bottom)
                    }
                storeLine
                header.mmAppear(1)
                positions.mmAppear(2)
                VStack(alignment: .leading, spacing: 14) {
                    if timeline.count > 1 { evolution }
                    if !countries.isEmpty { scoreCard }
                    if let p = item.project { PosthogAppSection(project: p) }
                    ratingCard
                    if !ratings.isEmpty { ratingsByCountry }
                }
                .proLocked("Score, évolution, notes et avis")
                if let at = item.app.rankedAt {
                    Text("Mis à jour le \(Date(timeIntervalSince1970: at / 1000).formatted(date: .abbreviated, time: .shortened))")
                        .font(MMFont.system(12)).foregroundStyle(MMColor.ink3).frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 110)
        }
        .scrollIndicators(.hidden)
        .ignoresSafeArea(edges: .top)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let url = item.link {
                ToolbarItem(placement: .topBarTrailing) { ShareLink(item: url) { Image(systemName: "square.and.arrow.up") } }
            }
        }
        .mmPage()
        .task { await load() }
    }

    private var storeLine: some View {
        HStack {
            if let price = item.store?.formattedPrice {
                Label { Text(price) } icon: { Circle().frame(width: 7, height: 7) }
                    .font(MMFont.system(13, .medium)).foregroundStyle(MMColor.ink2)
            }
            Spacer()
            if let url = item.link {
                Link(destination: url) {
                    Label("Ouvrir dans l'App Store", systemImage: "arrow.up.right").labelStyle(TrailingIconLabel())
                        .font(MMFont.system(13, .medium)).foregroundStyle(MMColor.ink2)
                }
            }
        }
        .padding(.horizontal, 6)
    }

    private var header: some View {
        MMCard(padding: 14, radius: 22) {
            HStack(spacing: 12) {
                AppLogo(item: item, size: 58)
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.name).font(MMFont.system(16, .semibold)).lineLimit(2)
                    if let d = item.developer { Text(d).font(MMFont.system(13)).foregroundStyle(MMColor.ink3).lineLimit(1) }
                }
                Spacer(minLength: 8)
                Rectangle().fill(MMColor.hairline).frame(width: 1, height: 48)
                VStack(spacing: 3) {
                    Text("\(countries.count)").font(MMFont.number(18, .semibold))
                        .frame(width: 40, height: 40).background(MMColor.fg(0.10), in: Circle())
                    Text("Pays").font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                }
            }
        }
    }

    private var positions: some View {
        MMCard(padding: 18, radius: 22) {
            VStack(alignment: .leading, spacing: 12) {
                Text("HISTORIQUE ET MEILLEURES POSITIONS").font(MMFont.system(11, .semibold)).tracking(1).foregroundStyle(MMColor.ink3)
                if countries.isEmpty {
                    Text("Pas encore classée dans un top.").font(MMFont.system(20, .semibold))
                } else {
                    Text("Sur les \(trackedDays) derniers jours, classée dans \(countries.count) pays.").font(MMFont.system(20, .semibold))
                    VStack(spacing: 0) {
                        ForEach(Array((showAll ? countries : Array(countries.prefix(paywall.locksContent ? 3 : 8))).enumerated()), id: \.element.cc) { i, r in
                            if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 42) }
                            rankRow(r)
                        }
                    }
                    if countries.count > (paywall.locksContent ? 3 : 8) {
                        Button {
                            if paywall.locksContent { paywall.isPresented = true } else { withAnimation(.smooth) { showAll.toggle() } }
                        } label: {
                            HStack {
                                Text(showAll ? "Réduire" : "Voir les \(countries.count) pays").font(MMFont.system(14, .semibold))
                                Spacer()
                                Image(systemName: showAll ? "chevron.up" : "chevron.down").font(.system(size: 12, weight: .semibold))
                            }
                            .foregroundStyle(MMColor.ink)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func rankRow(_ r: AppRank) -> some View {
        HStack(spacing: 12) {
            Text(flagEmoji(r.cc)).font(.system(size: 22)).frame(width: 30)
            VStack(alignment: .leading, spacing: 1) {
                Text(GlobeData.name(r.cc)).font(MMFont.system(14, .medium)).lineLimit(1)
                if let at = r.bestAt {
                    Text(Date(timeIntervalSince1970: at / 1000).formatted(.dateTime.day().month(.abbreviated)))
                        .font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                }
            }
            Spacer()
            if let now = r.rank, now != r.bestRank {
                Text("Actuel \(now)").font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
            }
            if let prev = r.prevRank, let now = r.rank, prev != now {
                Image(systemName: now < prev ? "arrow.up" : "arrow.down").font(.system(size: 10, weight: .bold))
                    .foregroundStyle(now < prev ? MMColor.accent : MMColor.ink3)
            }
            Text("\(r.bestRank ?? 0)").font(MMFont.number(14, .semibold)).monospacedDigit()
                .frame(minWidth: 36).padding(.vertical, 6)
                .background(MMColor.fg(0.10), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .padding(.vertical, 9)
    }

    private var evolution: some View {
        MMCard(padding: 18, radius: 22) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Pays classés par jour").font(MMFont.system(15, .semibold))
                Chart(timeline, id: \.day) { p in
                    AreaMark(x: .value("Jour", p.day), y: .value("Pays", p.count))
                        .foregroundStyle(MMColor.accent.opacity(0.15)).interpolationMethod(.monotone)
                    LineMark(x: .value("Jour", p.day), y: .value("Pays", p.count))
                        .foregroundStyle(MMColor.accent).interpolationMethod(.monotone)
                }
                .frame(height: 130)
            }
        }
    }

    private var scoreCard: some View {
        MMCard(padding: 18, radius: 22) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Score").font(MMFont.system(15, .semibold))
                    Spacer()
                    Text(score.formatted(.number.precision(.fractionLength(1)))).font(MMFont.number(22, .semibold))
                }
                HStack(spacing: 3) {
                    ForEach(0..<20, id: \.self) { i in
                        RoundedRectangle(cornerRadius: 3).fill(Double(i) * 5 < score ? MMColor.accent : MMColor.fg(0.10)).frame(height: 18)
                    }
                }
                Text(score < 20 ? "Présence émergente" : score < 60 ? "Présence solide" : "Présence mondiale")
                    .font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
            }
        }
    }

    private var ratingCard: some View {
        MMCard(padding: 18, radius: 22) {
            VStack(alignment: .leading, spacing: 14) {
                if let r = item.rating {
                    HStack(spacing: 14) {
                        Text(r.formatted(.number.precision(.fractionLength(1)))).font(MMFont.number(40, .semibold))
                        VStack(alignment: .leading, spacing: 4) {
                            Stars(value: r).scaleEffect(1.3, anchor: .leading)
                            Text("Basé sur \(item.ratingCount.formatted()) notes").font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                        }
                    }
                } else {
                    Text("Pas encore de notes").font(MMFont.system(15, .semibold))
                }
                Rectangle().fill(MMColor.hairline).frame(height: 1)
                NavigationLink { AppReviewsView(name: item.name, reviews: reviews) } label: {
                    HStack {
                        Label("Avis écrits", systemImage: "text.bubble.fill").font(MMFont.system(14, .medium))
                        Spacer()
                        Text("\(reviews.count)").font(MMFont.system(13)).foregroundStyle(MMColor.ink3)
                        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(MMColor.ink3)
                    }
                    .foregroundStyle(MMColor.ink)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var ratingsByCountry: some View {
        VStack(alignment: .leading, spacing: 10) {
            MMLabel(text: String(localized: "Notes par pays"), trailing: "\(ratings.count)").padding(.horizontal, 4).padding(.top, 6)
            MMCard(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(ratings.prefix(15).enumerated()), id: \.element.cc) { i, r in
                        if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 52) }
                        HStack(spacing: 12) {
                            Text(flagEmoji(r.cc)).font(.system(size: 20)).frame(width: 26)
                            Text(GlobeData.name(r.cc)).font(MMFont.system(14, .medium)).lineLimit(1)
                            Spacer()
                            Stars(value: r.average)
                            Text(r.average.formatted(.number.precision(.fractionLength(1)))).font(MMFont.number(14, .medium))
                            Text(r.count.formatted()).font(MMFont.number(12, .regular)).foregroundStyle(MMColor.ink3).frame(minWidth: 34, alignment: .trailing)
                        }
                        .padding(.horizontal, 16).padding(.vertical, 11)
                    }
                }
            }
        }
    }

    private func load() async {
        // Premier passage sur une app : le scan du serveur prend quelques dizaines de secondes.
        for attempt in 0..<4 {
            guard let sheet = try? await store.client.appSheet(appId: item.app.appId) else { return }
            withAnimation(.easeOut(duration: 0.3)) {
                ranks = sheet.ranks
                ratings = sheet.ratings
                reviews = sheet.reviews
            }
            guard sheet.scanning || (attempt > 0 && ranks.isEmpty) else { return }
            try? await Task.sleep(for: .seconds(20))
            if Task.isCancelled { return }
        }
    }
}

private struct TrailingIconLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) { configuration.title; configuration.icon }
    }
}

// MARK: - Avis

private struct AppReviewsView: View {
    let name: String
    let reviews: [AppReview]
    @State private var stars: Int?

    private var shown: [AppReview] { stars.map { s in reviews.filter { $0.rating == s } } ?? reviews }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Avis écrits").font(MMFont.system(28, .bold)).tracking(-0.6)
                Text(name).font(MMFont.system(13)).foregroundStyle(MMColor.ink3)
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        chip(String(localized: "Tous"), nil)
                        ForEach([5, 4, 3, 2, 1], id: \.self) { chip("\($0) ★", $0) }
                    }
                }
                .scrollIndicators(.hidden)
                if shown.isEmpty {
                    MMCard { Text("Aucun avis pour l'instant.").font(MMFont.system(14)).foregroundStyle(MMColor.ink2) }
                }
                ForEach(shown) { card($0) }
            }
            .padding(.horizontal, 16).padding(.bottom, 110)
        }
        .scrollIndicators(.hidden)
        .navigationBarTitleDisplayMode(.inline)
        .mmPage()
    }

    private func chip(_ title: String, _ value: Int?) -> some View {
        Button { withAnimation(.snappy) { stars = value } } label: {
            Text(title).font(MMFont.system(13, .medium))
                .foregroundStyle(stars == value ? Color.black : MMColor.ink)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(stars == value ? Color.white : MMColor.fg(0.08), in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private func card(_ r: AppReview) -> some View {
        MMCard(padding: 16, radius: 22) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Stars(value: Double(r.rating))
                    Text(flagEmoji(r.country)).font(.system(size: 13))
                    Spacer()
                    Text(Date(timeIntervalSince1970: r.at / 1000).formatted(.dateTime.day().month(.abbreviated).year()))
                        .font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                }
                if !r.title.isEmpty { Text(r.title).font(MMFont.system(15, .semibold)) }
                Text(r.content).font(MMFont.system(14)).foregroundStyle(MMColor.ink2).fixedSize(horizontal: false, vertical: true)
                if !r.author.isEmpty { Text(r.author).font(MMFont.system(12)).foregroundStyle(MMColor.ink3) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
