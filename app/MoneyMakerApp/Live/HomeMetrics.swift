//
//  HomeMetrics.swift
//  MoneyMaker — les chiffres de l'Accueil (une carte par chiffre) et leur page de détail.
//

import SwiftUI

enum HomeMetric: String, CaseIterable, Hashable, Identifiable {
    case today, mrr, revenue, subscriptions, paying, trials, downloads, newCustomers
    var id: String { rawValue }

    var theme: MetricTheme {
        switch self {
        case .today: .rose
        case .mrr: .mint
        case .revenue: .cobalt
        case .subscriptions: .violet
        case .paying: .teal
        case .trials: .amber
        case .downloads: .sky
        case .newCustomers: .ember
        }
    }

    func title(_ o: Overview) -> String {
        switch self {
        case .today: String(localized: "Aujourd'hui")
        case .mrr: "MRR"
        case .revenue: String(localized: "Revenu \(o.periodDays) j")
        case .subscriptions: String(localized: "Abonnés actifs")
        case .paying: String(localized: "Utilisateurs payants")
        case .trials: String(localized: "Essais en cours")
        case .downloads: String(localized: "Téléchargements")
        case .newCustomers: String(localized: "Nouveaux clients")
        }
    }

    /// Les cartes affichées pour ce périmètre (celles sans donnée sont masquées).
    static func visible(_ o: Overview, today: Today?) -> [HomeMetric] {
        allCases.filter { m in
            switch m {
            case .today: today != nil
            case .trials: o.hasTrials ?? (o.activeTrials > 0)
            case .downloads: o.downloads != nil
            // Abonnés actifs : dans le détail du MRR ; nouveaux clients : dans le détail des clients.
            case .subscriptions, .newCustomers: false
            default: true
            }
        }
    }

    var isMoney: Bool { [.today, .mrr, .revenue].contains(self) }

    /// Valeur d'un business pour ce chiffre (micros pour l'argent).
    func value(_ p: ProjectSummary) -> Double {
        switch self {
        case .today, .revenue: Double(p.netRevenueMicros)
        case .mrr: Double(p.mrrMicros)
        case .subscriptions: Double(p.activeSubscriptions)
        case .paying: Double(p.payingCustomers ?? p.activeSubscriptions)
        case .trials: Double(p.activeTrials)
        case .downloads: Double(p.downloads ?? 0)
        case .newCustomers: Double(p.newCustomers)
        }
    }

    func total(_ o: Overview, today: Today?) -> Double {
        switch self {
        case .today: Double(today?.netMicros ?? 0)
        case .mrr: Double(o.mrrMicros)
        case .revenue: Double(o.revenueMicros)
        case .subscriptions: Double(o.activeSubscriptions)
        case .paying: Double(o.payingCustomers ?? o.activeSubscriptions)
        case .trials: Double(o.activeTrials)
        case .downloads: Double(o.downloads ?? 0)
        case .newCustomers: Double(o.newCustomers)
        }
    }

    func format(_ v: Double, _ o: Overview, compact: Bool = false) -> String {
        isMoney ? Int(v).money(o.currency, compact: compact) : Int(v).formatted()
    }

    func caption(_ o: Overview, today: Today?) -> String? {
        switch self {
        case .today: today.map { String(localized: "\($0.transactions) ventes · \($0.newSubscribers) nouveaux abonnés") }
        case .mrr: "ARR \((o.mrrMicros * 12).money(o.currency, compact: true))"
        case .revenue: String(localized: "\(o.projects.count) business")
        case .subscriptions: String(localized: "\(o.activeTrials) essais en plus")
        case .paying: String(localized: "\(o.projects.count) business")
        case .trials: conversion(o).map { String(localized: "Conversion \(Int(($0 * 100).rounded()))%") }
        case .downloads: String(localized: "\(o.periodDays) derniers jours")
        case .newCustomers: String(localized: "\(o.periodDays) derniers jours")
        }
    }

    private func conversion(_ o: Overview) -> Double? {
        let rates = o.projects.compactMap(\.trialConversionRate)
        return rates.isEmpty ? nil : rates.reduce(0, +) / Double(rates.count)
    }

    func delta(_ o: Overview) -> Double? {
        switch self {
        case .mrr, .revenue: halfOverHalf(dailySeries(o.mergedRevenueByDay, days: 30))
        default: nil
        }
    }

    func decoration(_ o: Overview, today: Today?) -> MetricDecoration {
        let daily = dailySeries(o.mergedRevenueByDay, days: 30).map(\.value)
        let perProject = o.projects.map(value).sorted()
        switch self {
        case .today:
            let h = (today?.hourly ?? []).map(Double.init)
            return .sparkline(h.count > 1 ? h : [0, 0])
        case .mrr:
            var run = 0.0
            return .sparkline(daily.map { run += $0; return run })
        case .revenue: return .bars(Array(daily.suffix(16)))
        case .subscriptions:
            let paying = Double(o.payingCustomers ?? o.activeSubscriptions)
            return .gauge(paying > 0 ? Double(o.activeSubscriptions) / paying : 0)
        case .trials: return .arc(conversion(o) ?? 0)
        case .downloads:
            let d = Double(o.downloads ?? 0)
            return .gauge(d > 0 ? Double(o.newCustomers) / d : 0)
        case .paying, .newCustomers:
            return .bars(perProject.count > 1 ? Array(perProject.suffix(16)) : [perProject.first ?? 0])
        }
    }

    var explanation: String {
        switch self {
        case .today: String(localized: "Revenu net encaissé depuis minuit, remboursements déduits.")
        case .mrr: String(localized: "Revenu récurrent mensuel : ce que rapportent les abonnements actifs chaque mois.")
        case .revenue: String(localized: "Revenu net encaissé sur la période, tous canaux confondus.")
        case .subscriptions: String(localized: "Abonnements en cours et renouvelés, hors essais gratuits.")
        case .paying: String(localized: "Clients qui paient en ce moment : abonnés actifs et achats encore valables. Les nouveaux clients sont ceux qui ont payé pour la première fois sur la période.")
        case .trials: String(localized: "Essais gratuits en cours, qui deviendront des abonnements s'ils sont convertis.")
        case .downloads: String(localized: "Premiers téléchargements sur la période, d'après les stores.")
        case .newCustomers: String(localized: "Clients qui ont payé pour la première fois sur la période.")
        }
    }
}

extension Overview {
    /// Revenu par jour, tous business du périmètre cumulés.
    var mergedRevenueByDay: [String: Int] {
        projects.reduce(into: [:]) { acc, p in p.revenueByDay.forEach { acc[$0, default: 0] += $1 } }
    }
}

// MARK: - Carte d'Accueil

struct HomeMetricCard: View {
    let metric: HomeMetric
    let o: Overview
    let today: Today?
    var index = 0

    var body: some View {
        MetricCard(
            title: metric.title(o),
            value: metric.format(metric.total(o, today: today), o),
            delta: metric.delta(o),
            caption: metric.caption(o, today: today),
            theme: metric.theme,
            decoration: metric.decoration(o, today: today),
            index: index
        )
    }
}

// MARK: - Détail

/// Période du graphique en grand.
enum ChartRange: String, CaseIterable, Identifiable {
    case week, month, quarter, year
    var id: String { rawValue }
    var label: String {
        switch self {
        case .week: String(localized: "Semaine")
        case .month: String(localized: "Mois")
        case .quarter: String(localized: "3 mois")
        case .year: String(localized: "Année")
        }
    }
    var days: Int { switch self { case .week: 7; case .month: 30; case .quarter: 90; case .year: 365 } }
}

/// Historique long (365 j) chargé une fois pour les graphiques en grand ; l'Accueil reste sur sa période.
@MainActor
final class LongHistory: ObservableObject {
    static let shared = LongHistory()
    @Published private(set) var overview: Overview?
    @Published private(set) var feed: [FeedEvent] = []
    private var loadedAt = Date.distantPast

    func load(_ store: Store) async {
        guard Date().timeIntervalSince(loadedAt) > 300 else { return }
        loadedAt = .now
        async let o = try? store.client.overview(days: 365)
        async let f = try? store.client.feed(limit: 300, projectIds: store.scopeIds)
        let (no, nf) = await (o, f)
        if let no { overview = no }
        if let nf { feed = nf }
    }

    /// Revenu par jour des business affichés.
    func revenueByDay(_ ids: Set<String>) -> [String: Int]? {
        overview?.projects.filter { ids.contains($0.projectId) }
            .reduce(into: [:]) { acc, p in p.revenueByDay.forEach { acc[$0, default: 0] += $1 } }
    }
}

/// Graphique d'une carte en plein écran : la carte s'agrandit (transition zoom), menu de période
/// en verre en haut, graphique en grand, et le détail des jours à faire défiler en bas.
struct HomeMetricDetail: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var history = LongHistory.shared
    let metric: HomeMetric
    @State private var range: ChartRange = .month
    @State private var selected: Date?
    @State private var chartWidth: CGFloat = 1
    @Namespace private var ns

    var body: some View {
        let o = store.scoped
        let cur = o?.currency ?? "EUR"
        let pts = points(o)
        let idx = selected.flatMap { d in pts.indices.min { abs(pts[$0].date.timeIntervalSince(d)) < abs(pts[$1].date.timeIntervalSince(d)) } }
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                hero(o, pts: pts, idx: idx, cur: cur)
                if metric != .today { dayStrip(pts: pts, cur: cur).padding(.horizontal, -16) }
                if let o {
                    stats(o, pts: pts)
                    Text(metric.explanation).font(MMFont.system(13)).foregroundStyle(MMColor.ink3).padding(.horizontal, 4)
                    perBusiness(o)
                }
            }
            .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        // Barre du haut dessinée ici plutôt que la barre système : l'Accueil masque la sienne, et la faire
        // réapparaître pendant le zoom décalait toute la page vers le bas une fois l'animation finie.
        .safeAreaInset(edge: .top, spacing: 8) { topBar }
        .toolbar(.hidden, for: .navigationBar)
        .mmPage()
        .task { await history.load(store) }
        .sensoryFeedback(.selection, trigger: range)
        .sensoryFeedback(.selection, trigger: idx)
    }

    // MARK: Barre du haut

    @Environment(\.dismiss) private var dismiss

    private var topBar: some View {
        HStack(spacing: 10) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(MMColor.ink)
                    .frame(width: 44, height: 44)
                    .mmGlass(in: Circle(), interactive: true)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Retour"))
            if metric != .today { rangePicker.frame(maxWidth: 300) }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .safeAreaInset(edge: .bottom, spacing: 10) { businessPicker }
    }

    /// Même sélecteur qu'en haut de l'Accueil : l'éventail des logos, toucher met un business en avant.
    private var businessPicker: some View {
        HStack(spacing: 12) {
            LogoFan(projects: store.selectedProjects, focusId: store.focusId) { store.focus($0) }
            if let id = store.focusId, let p = store.selectedProjects.first(where: { $0.projectId == id }) {
                HStack(spacing: 8) {
                    PlatformMark(stores: p.stores ?? [], size: 26)
                    Text(p.name).font(MMFont.system(15, .semibold)).lineLimit(1)
                }
                .padding(.leading, 5).padding(.trailing, 14).padding(.vertical, 5)
                .mmGlass(in: Capsule())
                .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .leading)))
                .id(id)
            }
            Spacer(minLength: 0)
        }
        .animation(.snappy, value: store.focusId)
        .padding(.horizontal, 16)
    }

    // MARK: Période

    private var rangePicker: some View {
        HStack(spacing: 2) {
            ForEach(ChartRange.allCases) { r in
                Button { withAnimation(.snappy) { range = r; selected = nil } } label: {
                    Text(r.label).font(MMFont.system(13, .medium))
                        .foregroundStyle(range == r ? MMColor.inkInverse : MMColor.ink)
                        .lineLimit(1).fixedSize()
                        .padding(.horizontal, 10)
                        .frame(maxWidth: .infinity).frame(height: 30)
                        .background { if range == r { Capsule().fill(MMColor.ink).matchedGeometryEffect(id: "range", in: ns) } }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .mmGlass(in: Capsule(), interactive: true)
    }

    // MARK: En-tête et graphique néon (posé à même le fond, pleine largeur)

    private func hero(_ o: Overview?, pts: [MMPoint], idx: Int?, cur: String) -> some View {
        let point = idx.map { pts[$0] }
        let shownValue: String = {
            guard let point else { return headline(o, pts: pts) }
            if metric == .mrr { return Int(dayValue(point, pts) * 1e6).money(cur) }
            return Int(point.value * 1e6).money(cur)
        }()
        let values = pts.map(\.value)
        return VStack(alignment: .leading, spacing: 4) {
            RecoveryTileHeader(symbol: metric.symbol, title: o.map { metric.title($0) } ?? "")
            Text(shownValue)
                .font(V2Font.system(size: 40, weight: .semibold)).foregroundStyle(MMColor.ink)
                .contentTransition(.numericText()).lineLimit(1).minimumScaleFactor(0.6)
                .padding(.top, 6)
            Text(point.map { $0.date.formatted(.dateTime.weekday(.wide).day().month(.wide)) } ?? subtitle(o, pts: pts))
                .font(MMFont.system(12)).foregroundStyle(MMColor.ink3).lineLimit(1)
            ZStack {
                NeonLine(values: values, money: metric.isMoney).equatable().id(range)
                NeonSelection(values: values, selected: idx, money: metric.isMoney)
            }
            .frame(height: 220)
            .padding(.top, 14)
            .padding(.horizontal, -16)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { g in
                // Ne met à jour l'état que si le point visé change : la page ne se réévalue pas à chaque image.
                guard pts.count > 1 else { return }
                let w = max(chartWidth, 1)
                let i = Int((g.location.x / w * CGFloat(pts.count - 1)).rounded())
                let d = pts[min(max(i, 0), pts.count - 1)].date
                if selected != d { selected = d }
            })
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { chartWidth = $0 }
            HStack {
                Text(pts.first.map { $0.date.formatted(metric == .today ? .dateTime.hour() : .dateTime.day().month(.abbreviated)) } ?? "")
                Spacer()
                metric == .today ? Text("Maintenant") : Text("Aujourd'hui")
            }
            .font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
        }
        .background(alignment: .topTrailing) { HeroDots().frame(width: 190, height: 130).offset(x: 16, y: -8) }
    }

    // MARK: Chiffres propres à chaque donnée

    private func stats(_ o: Overview, pts: [MMPoint]) -> some View {
        let items = detailStats(o, pts: pts)
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible())], spacing: 10) {
            ForEach(items, id: \.0) { title, value, symbol in
                RecoveryTileSurface(dotsAnchor: nil, light: true) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 6) {
                            Image(systemName: symbol).font(.system(size: 11, weight: .semibold))
                            Text(title).font(MMFont.system(12, .medium)).lineLimit(1)
                        }
                        .foregroundStyle(MMColor.ink3)
                        Text(value).font(V2Font.system(size: 20, weight: .semibold)).foregroundStyle(MMColor.ink).mmNumeric()
                            .lineLimit(1).minimumScaleFactor(0.6)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                }
            }
        }
    }

    private func detailStats(_ o: Overview, pts: [MMPoint]) -> [(String, String, String)] {
        let cur = o.currency
        let sum = pts.reduce(0) { $0 + $1.value }
        let active = pts.filter { $0.value > 0 }
        let best = pts.max { $0.value < $1.value }
        let paying = o.payingCustomers ?? o.activeSubscriptions
        let feed = (history.feed.isEmpty ? store.feed : history.feed).filter { store.viewIds.contains($0.projectId) }
        let since = Date().addingTimeInterval(-Double(range.days) * 86_400)
        let inRange = feed.filter { $0.date >= since }
        let count = { (types: [String]) in inRange.filter { types.contains($0.type) }.count }
        let rates = o.projects.compactMap(\.trialConversionRate)
        let churns = o.projects.compactMap(\.churnRate)
        let pct = { (v: Double) in "\(Int((v * 100).rounded()))%" }
        switch metric {
        case .today:
            guard let t = store.today else { return [] }
            return [(String(localized: "Ventes"), t.sales.formatted(), "cart.fill"), (String(localized: "Renouvellements"), t.renewals.formatted(), "arrow.clockwise"),
                    (String(localized: "Nouveaux abonnés"), t.newSubscribers.formatted(), "person.badge.plus"), (String(localized: "Essais démarrés"), t.trials.formatted(), "hourglass"),
                    (String(localized: "Remboursements"), t.refundsMicros.money(t.currency), "arrow.uturn.backward"), (String(localized: "Transactions"), t.transactions.formatted(), "list.bullet")]
        case .mrr, .subscriptions:
            var out = [(String(localized: "Abonnés actifs"), o.activeSubscriptions.formatted(), "person.2.fill"),
                       ("ARR", (o.mrrMicros * 12).money(cur, compact: true), "calendar"),
                       (String(localized: "Revenu par abonné"), (o.mrrMicros / max(o.activeSubscriptions, 1)).money(cur), "person.crop.circle.badge.checkmark"),
                       (String(localized: "Essais en cours"), o.activeTrials.formatted(), "hourglass"),
                       (String(localized: "Renouvellements"), count(["RENEWAL"]).formatted(), "arrow.clockwise"),
                       (String(localized: "Annulations"), count(["CANCELLATION"]).formatted(), "xmark.circle")]
            if !churns.isEmpty { out.append((String(localized: "Désabonnement"), pct(churns.reduce(0, +) / Double(churns.count)), "arrow.uturn.down")) }
            if !rates.isEmpty { out.append((String(localized: "Conversion essais"), pct(rates.reduce(0, +) / Double(rates.count)), "checkmark.seal.fill")) }
            return out
        case .revenue:
            return [(String(localized: "Total"), Int(sum * 1e6).money(cur), "eurosign.circle.fill"),
                    (String(localized: "Moyenne / jour"), Int(sum / Double(max(pts.count, 1)) * 1e6).money(cur), "divide"),
                    (String(localized: "Meilleur jour"), best.map { Int($0.value * 1e6).money(cur) } ?? "—", "trophy.fill"),
                    (String(localized: "Jours avec vente"), "\(active.count)/\(pts.count)", "calendar"),
                    (String(localized: "Ventes"), inRange.filter(\.isRevenue).count.formatted(), "cart.fill"),
                    (String(localized: "Remboursements"), count(["REFUND"]).formatted(), "arrow.uturn.backward")]
        case .paying, .newCustomers:
            return [(String(localized: "Utilisateurs payants"), paying.formatted(), "creditcard.fill"),
                    (String(localized: "Abonnés actifs"), o.activeSubscriptions.formatted(), "person.2.fill"),
                    (String(localized: "Achats uniques"), max(paying - o.activeSubscriptions, 0).formatted(), "bag.fill"),
                    (String(localized: "Nouveaux clients"), o.newCustomers.formatted(), "sparkles"),
                    (String(localized: "Problèmes de paiement"), o.projects.reduce(0) { $0 + $1.billingIssues }.formatted(), "exclamationmark.triangle.fill"),
                    (String(localized: "Revenu par client"), Int(sum * 1e6 / Double(max(paying, 1))).money(cur), "person.crop.circle")]
        case .trials:
            var out = [(String(localized: "Essais en cours"), o.activeTrials.formatted(), "hourglass"),
                       (String(localized: "Essais démarrés"), count(["TRIAL_STARTED"]).formatted(), "play.circle"),
                       (String(localized: "Essais convertis"), count(["TRIAL_CONVERTED"]).formatted(), "checkmark.circle")]
            if !rates.isEmpty { out.append((String(localized: "Conversion"), pct(rates.reduce(0, +) / Double(rates.count)), "checkmark.seal.fill")) }
            return out
        case .downloads:
            let d = o.downloads ?? 0
            return [(String(localized: "Téléchargements"), d.formatted(), "arrow.down.app.fill"),
                    (String(localized: "Nouveaux clients"), o.newCustomers.formatted(), "sparkles"),
                    (String(localized: "Téléchargement → payant"), d > 0 ? pct(Double(o.newCustomers) / Double(d)) : "—", "arrow.right.circle"),
                    (String(localized: "Revenu par téléchargement"), d > 0 ? Int(sum * 1e6 / Double(d)).money(cur) : "—", "eurosign")]
        }
    }

    // MARK: Détail par business

    @ViewBuilder
    private func perBusiness(_ o: Overview) -> some View {
        let rows: [(ProjectSummary, Double)] = o.projects.map { ($0, metric.value($0)) }.sorted { $0.1 > $1.1 }
        let top = max(rows.first?.1 ?? 1, 1)
        if !rows.isEmpty && metric != .today && AppPrefs.perBusiness {
            VStack(alignment: .leading, spacing: 10) {
                MMLabel(text: String(localized: "Par business"), trailing: "\(rows.count)").padding(.horizontal, 4).padding(.top, 6)
                ForEach(rows, id: \.0.id) { p, v in
                    NavigationLink(value: p) {
                        RecoveryTileSurface(dotsAnchor: nil, light: true) {
                            VStack(alignment: .leading, spacing: 10) {
                                HStack(spacing: 12) {
                                    ProjectIcon(project: p, size: 36)
                                        .overlay(alignment: .bottomTrailing) { PlatformMark(stores: p.stores ?? [], size: 16).offset(x: 4, y: 4) }
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(p.name).font(MMFont.system(15, .semibold)).lineLimit(1)
                                        Text(businessCaption(p)).font(MMFont.system(12)).foregroundStyle(MMColor.ink3).lineLimit(1)
                                    }
                                    Spacer(minLength: 8)
                                    Text(metric.format(v, o)).font(V2Font.system(size: 17, weight: .semibold))
                                    Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(MMColor.ink3)
                                }
                                RecoverySliderTrack(fraction: min(max(v / top, 0.04), 1)).frame(height: 14)
                            }
                            .padding(14)
                        }
                    }
                    .buttonStyle(MMPressStyle(scale: 0.98))
                    .foregroundStyle(MMColor.ink)
                }
            }
        }
    }

    private func businessCaption(_ p: ProjectSummary) -> String {
        switch metric {
        case .mrr, .subscriptions: String(localized: "\(p.activeSubscriptions) abonnés · \(p.activeTrials) essais")
        case .revenue: "MRR \(p.mrrMicros.money(p.currency, compact: true))"
        case .paying, .newCustomers: String(localized: "\(p.newCustomers) nouveaux · \(p.billingIssues) problèmes de paiement")
        case .trials: p.trialConversionRate.map { String(localized: "Conversion \(Int(($0 * 100).rounded()))%") } ?? String(localized: "Pas encore de conversion")
        case .downloads: String(localized: "\(p.newCustomers) nouveaux clients")
        case .today: ""
        }
    }

    // MARK: Données

    private func points(_ o: Overview?) -> [MMPoint] {
        if metric == .today {
            guard let t = store.today, t.hourly.count > 1 else { return [] }
            let start = Date(timeIntervalSince1970: t.dayStart / 1000)
            return t.hourly.enumerated().map { MMPoint(date: start.addingTimeInterval(Double($0.offset) * 3600), value: Double($0.element) / 1e6) }
        }
        let byDay = history.revenueByDay(store.viewIds) ?? o?.mergedRevenueByDay ?? [:]
        let daily = dailySeries(byDay, days: range.days)
        // MRR : cumul sur la période (la tendance) ; le reste : revenu jour par jour.
        if metric == .mrr { var run = 0.0; return daily.map { run += $0.value; return MMPoint(date: $0.date, value: run) } }
        return daily
    }

    private func headline(_ o: Overview?, pts: [MMPoint]) -> String {
        guard let o else { return "" }
        switch metric {
        case .today, .mrr, .subscriptions, .paying, .trials: return metric.format(metric.total(o, today: store.today), o)
        default: return Int(pts.reduce(0) { $0 + $1.value } * 1e6).money(o.currency)
        }
    }

    private func subtitle(_ o: Overview?, pts: [MMPoint]) -> String {
        guard let o else { return "" }
        switch metric {
        case .today: return String(localized: "Cumul depuis minuit")
        case .mrr: return String(localized: "\(o.activeSubscriptions) abonnés actifs · ARR \((o.mrrMicros * 12).money(o.currency, compact: true))")
        case .paying, .subscriptions, .trials:
            let total = Int(pts.reduce(0) { $0 + $1.value } * 1e6).money(o.currency)
            return String(localized: "Encaissé sur \(range.label.lowercased()) : \(total)")
        default:
            let mid = pts.count / 2
            let a = pts[..<mid].reduce(0) { $0 + $1.value }, b = pts[mid...].reduce(0) { $0 + $1.value }
            guard a > 0 else { return String(localized: "Sur \(range.days) jours") }
            let d = Int(((b - a) / a * 100).rounded())
            let sign = d >= 0 ? "+" : ""
            return String(localized: "\(sign)\(d) % sur la seconde moitié · \(range.days) jours")
        }
    }

    // MARK: Détail des jours

    /// Bande des jours, du plus ancien (à gauche) au plus récent (à droite), bord à bord.
    /// Juste la date et le montant, en petites pastilles légères ; on arrive calé sur aujourd'hui.
    private func dayStrip(pts: [MMPoint], cur: String) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                LazyHStack(spacing: 6) {
                    ForEach(pts, id: \.date) { p in
                        let on = selected.map { Calendar.current.isDate($0, inSameDayAs: p.date) } ?? false
                        Button { withAnimation(.snappy) { selected = on ? nil : p.date } } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(Calendar.current.isDateInToday(p.date) ? String(localized: "Aujourd'hui") : p.date.formatted(.dateTime.day().month(.abbreviated)))
                                    .font(MMFont.system(12, .medium)).foregroundStyle(on ? MMColor.inkInverse.opacity(0.65) : MMColor.ink3)
                                    .lineLimit(1)
                                Text(Int((metric == .mrr ? dayValue(p, pts) : p.value) * 1e6).money(cur, compact: true)).mmNumeric()
                                    .font(MMFont.number(17, .regular)).foregroundStyle(on ? MMColor.inkInverse : MMColor.ink)
                                    .lineLimit(1).minimumScaleFactor(0.8)
                            }
                            .padding(.horizontal, 13).padding(.vertical, 10)
                            .frame(minWidth: 90, alignment: .leading)
                            .background(on ? AnyShapeStyle(MMColor.ink) : AnyShapeStyle(MMColor.fg(0.05)),
                                        in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }
                        .buttonStyle(MMPressStyle(scale: 0.95))
                        .id(p.date)
                    }
                }
            }
            .scrollIndicators(.hidden)
            .defaultScrollAnchor(.trailing)
            .frame(height: 64)
            .onAppear { if let last = pts.last { proxy.scrollTo(last.date, anchor: .trailing) } }
            .onChange(of: pts.last?.date) { _, d in if let d { proxy.scrollTo(d, anchor: .trailing) } }
            .onChange(of: selected) { _, d in
                guard let d, let p = pts.min(by: { abs($0.date.timeIntervalSince(d)) < abs($1.date.timeIntervalSince(d)) }) else { return }
                withAnimation(.snappy) { proxy.scrollTo(p.date, anchor: .center) }
            }
        }
    }

    /// MRR : le cumul est tracé, mais chaque jour affiche son propre revenu.
    private func dayValue(_ p: MMPoint, _ pts: [MMPoint]) -> Double {
        guard let i = pts.firstIndex(where: { $0.date == p.date }) else { return p.value }
        return i == 0 ? p.value : p.value - pts[i - 1].value
    }
}

// MARK: - Graphique néon

/// Géométrie partagée entre la courbe et la sélection.
private enum NeonGeometry {
    static func points(_ values: [Double], in size: CGSize) -> [CGPoint] {
        let v = values.count > 1 ? values : [values.first ?? 0, values.first ?? 0]
        let lo = v.min() ?? 0, hi = v.max() ?? 1, span = hi - lo
        return v.enumerated().map { i, x in
            CGPoint(x: size.width * CGFloat(i) / CGFloat(v.count - 1),
                    y: span > 0 ? size.height * (1 - CGFloat((x - lo) / span)) * 0.86 + size.height * 0.07 : size.height * 0.5)
        }
    }
    static func curve(_ p: [CGPoint]) -> Path {
        var path = Path()
        guard let first = p.first else { return path }
        path.move(to: first)
        for i in 1..<p.count {
            let a = p[i - 1], b = p[i], mx = (a.x + b.x) / 2
            path.addCurve(to: b, control1: CGPoint(x: mx, y: a.y), control2: CGPoint(x: mx, y: b.y))
        }
        return path
    }
    static func colors(money: Bool) -> (bright: Color, deep: Color) {
        money ? (Color(red: 0.25, green: 0.92, blue: 0.52), Color(red: 0.06, green: 0.62, blue: 0.32))
              : (RecoveryTileTheme.violetBright, RecoveryTileTheme.violetDeep)
    }
}

/// Courbe néon : tracé progressif (trim 0→1) une seule fois, puis image figée.
/// `Equatable` + `drawingGroup` : la sélection et le reste de la page ne la redessinent pas.
private struct NeonLine: View, Equatable {
    let values: [Double]
    let money: Bool
    @State private var shown: CGFloat = 0
    /// Intensité du néon : allumé pendant le tracé, puis s'éteint pour laisser un trait net.
    @State private var glow: Double = 1
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static func == (a: Self, b: Self) -> Bool { a.values == b.values && a.money == b.money }

    var body: some View {
        let (bright, deep) = NeonGeometry.colors(money: money)
        let light = scheme == .light
        GeometryReader { g in
            let pts = NeonGeometry.points(values, in: g.size)
            let line = NeonGeometry.curve(pts)
            ZStack {
                var area = line
                let _ = {
                    if let f = pts.first, let l = pts.last {
                        area.addLine(to: CGPoint(x: l.x, y: g.size.height)); area.addLine(to: CGPoint(x: f.x, y: g.size.height)); area.closeSubpath()
                    }
                }()
                area.fill(LinearGradient(colors: [bright.opacity(light ? 0.16 : 0.24), .clear], startPoint: .top, endPoint: .bottom))
                    .opacity(Double(shown))
                // Forme animable : `trim` est interpolé image par image (un Path calculé dans body ne l'est pas,
                // le tracé sautait directement à la fin).
                let trimmed = NeonCurve(values: values).trim(from: 0, to: shown)
                // Halo large, halo moyen, trait coloré, cœur brillant.
                trimmed.stroke(bright.opacity(light ? 0.35 : 0.55), style: StrokeStyle(lineWidth: 12, lineCap: .round, lineJoin: .round)).blur(radius: 12).opacity(glow)
                trimmed.stroke(bright.opacity(light ? 0.5 : 0.75), style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round)).blur(radius: 4).opacity(glow)
                trimmed.stroke(LinearGradient(colors: [deep.opacity(0.5), deep, bright], startPoint: .leading, endPoint: .trailing),
                               style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                trimmed.stroke(light ? bright.opacity(0.9) : Color.white.opacity(0.85), style: StrokeStyle(lineWidth: 1.1, lineCap: .round, lineJoin: .round)).opacity(glow)
                if let last = pts.last, shown >= 1 {
                    Circle().fill(bright).frame(width: 14, height: 14).blur(radius: 5).opacity(glow).position(last)
                    Circle().fill(light ? deep : .white).frame(width: 7, height: 7).position(last)
                }
            }
            .padding(30).drawingGroup().padding(-30)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear {
            guard shown == 0 else { return }
            if reduceMotion { shown = 1; glow = 0; return }
            withAnimation(.easeOut(duration: 1.1).delay(0.3)) { shown = 1 } completion: {
                withAnimation(.easeInOut(duration: 0.6)) { glow = 0 }
            }
        }
    }
}

/// Courbe néon en `Shape` pour que le tracé progressif s'anime vraiment.
private struct NeonCurve: Shape {
    let values: [Double]
    func path(in rect: CGRect) -> Path { NeonGeometry.curve(NeonGeometry.points(values, in: rect.size)) }
}

/// Seule couche redessinée pendant la sélection : trait pointillé + point.
private struct NeonSelection: View {
    let values: [Double]
    let selected: Int?
    let money: Bool

    var body: some View {
        if let i = selected {
            GeometryReader { g in
                let pts = NeonGeometry.points(values, in: g.size)
                if pts.indices.contains(i) {
                    let bright = NeonGeometry.colors(money: money).bright
                    Path { $0.move(to: CGPoint(x: pts[i].x, y: 0)); $0.addLine(to: CGPoint(x: pts[i].x, y: g.size.height)) }
                        .stroke(MMColor.fg(0.35), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    Circle().fill(MMColor.ink).frame(width: 12, height: 12)
                        .shadow(color: bright, radius: 6)
                        .position(pts[i])
                }
            }
            .allowsHitTesting(false)
        }
    }
}

/// Petits carrés animés en haut à droite : phase calculée à 10 images/s, en pause hors écran.
private struct HeroDots: View {
    @State private var visible = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.1, paused: !visible || reduceMotion)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            RecoveryDotMatrix(anchor: .topTrailing, reach: 0.95, maxOpacity: 0.32, animated: false,
                              pulse: reduceMotion ? 0 : (sin(t * .pi / 1.6) + 1) / 2)
        }
        .mask(LinearGradient(colors: [.black, .clear], startPoint: .topTrailing, endPoint: .bottomLeading))
        .allowsHitTesting(false)
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .modifier(DotsVisibility(visible: $visible))
    }
}

private struct DotsVisibility: ViewModifier {
    @Binding var visible: Bool
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollVisibilityChange(threshold: 0.05) { visible = $0 }
        } else {
            content
        }
    }
}

// MARK: - Tuiles de l'Accueil (même grille que la page Effort de V2)

/// Ouvre la page entonnoir PostHog.
struct PosthogRoute: Hashable {}

struct HomeTiles: View {
    @ObservedObject private var ph = PosthogStore.shared
    let o: Overview
    let today: Today?

    private let columns = [GridItem(.flexible(), spacing: RecoveryTileTheme.gridSpacing), GridItem(.flexible())]

    var body: some View {
        let metrics = HomeMetric.visible(o, today: today)
        let big = metrics.filter(\.isBigTile)
        let mini = metrics.filter { !$0.isBigTile }
        VStack(spacing: RecoveryTileTheme.gridSpacing) {
            VStack(spacing: RecoveryTileTheme.gridSpacing) {
                ForEach(Array(big.enumerated()), id: \.element) { i, m in
                    NavigationLink(value: m) { HomeTile(metric: m, o: o, today: today).equatable().modifier(ZoomSource(id: m)) }
                        .buttonStyle(MMPressStyle(scale: 0.97))
                        .recoveryTileEntrance(i)
                }
            }
            VStack(spacing: RecoveryTileTheme.gridSpacing) {
                ForEach(Array(mini.enumerated()), id: \.element) { i, m in
                    NavigationLink(value: m) { HomeTile(metric: m, o: o, today: today).equatable().modifier(ZoomSource(id: m)) }
                        .buttonStyle(MMPressStyle(scale: 0.97))
                        .recoveryTileEntrance(big.count + i)
                }
            }
            // PostHog : conversion du paywall et installation → payant, juste sous les cartes principales.
            if let p = posthog {
                ForEach(Array(PosthogTiles.headline(p).enumerated()), id: \.element.title) { i, e in
                    NavigationLink(value: PosthogRoute()) { e.tile }
                        .buttonStyle(MMPressStyle(scale: 0.97))
                        .environment(\.recoveryDotSeed, 40 + i)
                }
            }
            if showMore {
                if let p = posthog {
                    ForEach(Array(PosthogTiles.extras(p).enumerated()), id: \.element.title) { i, e in
                        NavigationLink(value: PosthogRoute()) { e.tile }
                            .buttonStyle(MMPressStyle(scale: 0.97))
                            .environment(\.recoveryDotSeed, 50 + i)
                            .transition(.cascade(i))
                    }
                } else {
                    NavigationLink(value: PosthogRoute()) {
                        ExtraStat(symbol: "chart.bar.xaxis", title: String(localized: "Brancher PostHog"), value: String(localized: "Paywall, entonnoir…"), ratio: 0.04).tile
                    }
                    .buttonStyle(MMPressStyle(scale: 0.97))
                    .transition(.cascade(0))
                }

                ForEach(Array(extras.enumerated()), id: \.element.title) { i, e in
                    Group {
                        if let m = e.metric {
                            NavigationLink(value: m) { e.tile.modifier(ZoomSource(id: m)) }.buttonStyle(MMPressStyle(scale: 0.97))
                        } else {
                            e.tile
                        }
                    }
                    .environment(\.recoveryDotSeed, 20 + i)
                    .transition(.cascade(i + 2))
                }
            }
            Button {
                withAnimation(.spring(response: 0.42, dampingFraction: 0.9)) { showMore.toggle() }
            } label: {
                HStack(spacing: 6) {
                    showMore ? Text("Afficher moins") : Text("Afficher plus de données")
                    Image(systemName: "chevron.down").rotationEffect(.degrees(showMore ? 180 : 0))
                }
                .font(V2Font.system(size: 13, weight: .medium))
                .foregroundStyle(MMColor.ink.opacity(0.9))
                .padding(.horizontal, 14).frame(height: 32)
                .mmGlass(in: Capsule(), interactive: true)
            }
            .buttonStyle(MMPressStyle(scale: 0.96))
            .padding(.top, 4)
            .sensoryFeedback(.selection, trigger: showMore)
        }
    }

    @State private var showMore = false

    private var posthog: PosthogSummary? { ph.combined(o.projects.map(\.projectId)) }

    /// Toutes les autres données disponibles, chacune dans sa carte.
    private var extras: [ExtraStat] {
        let paying = Double(max(o.payingCustomers ?? o.activeSubscriptions, 1))
        let shown = Set(HomeMetric.visible(o, today: today))
        var out: [ExtraStat] = HomeMetric.allCases.filter { !shown.contains($0) && $0 != .newCustomers && $0.isAvailable(o) }.map { m in
            ExtraStat(symbol: m.symbol, title: m.title(o), value: m.format(m.total(o, today: today), o), ratio: m.ratio(o), metric: m)
        }
        out.append(ExtraStat(symbol: "calendar", title: "ARR", value: (o.mrrMicros * 12).money(o.currency), ratio: 0.5))
        if o.activeSubscriptions > 0 {
            out.append(ExtraStat(symbol: "person.crop.circle.badge.checkmark", title: String(localized: "Revenu par abonné"), value: (o.mrrMicros / o.activeSubscriptions).money(o.currency), ratio: 0.5))
        }
        let churns = o.projects.compactMap(\.churnRate)
        if !churns.isEmpty {
            let c = churns.reduce(0, +) / Double(churns.count)
            out.append(ExtraStat(symbol: "arrow.uturn.down", title: String(localized: "Désabonnement"), value: c.formatted(.percent.precision(.fractionLength(1))), ratio: c))
        }
        let conv = o.projects.compactMap(\.trialConversionRate)
        if !conv.isEmpty {
            let c = conv.reduce(0, +) / Double(conv.count)
            out.append(ExtraStat(symbol: "checkmark.seal.fill", title: String(localized: "Conversion des essais"), value: c.formatted(.percent.precision(.fractionLength(0))), ratio: c))
        }
        let issues = o.projects.reduce(0) { $0 + $1.billingIssues }
        out.append(ExtraStat(symbol: "exclamationmark.triangle.fill", title: String(localized: "Problèmes de paiement"), value: issues.formatted(), ratio: Double(issues) / paying))
        if let t = today {
            out.append(ExtraStat(symbol: "arrow.clockwise", title: String(localized: "Renouvellements aujourd'hui"), value: t.renewals.formatted(), ratio: 0.5))
            out.append(ExtraStat(symbol: "hourglass.bottomhalf.filled", title: String(localized: "Essais démarrés aujourd'hui"), value: t.trials.formatted(), ratio: 0.5))
            out.append(ExtraStat(symbol: "person.badge.plus", title: String(localized: "Nouveaux abonnés aujourd'hui"), value: t.newSubscribers.formatted(), ratio: 0.5))
            if t.refundsMicros > 0 {
                out.append(ExtraStat(symbol: "arrow.uturn.backward.circle", title: String(localized: "Remboursements aujourd'hui"), value: t.refundsMicros.money(t.currency), ratio: Double(t.refundsMicros) / Double(max(t.revenueMicros, 1))))
            }
        }
        return out
    }
}

/// Une donnée secondaire, dans la même carte que les autres.
struct ExtraStat {
    let symbol: String
    let title: String
    let value: String
    let ratio: Double
    var metric: HomeMetric? = nil

    var tile: some View {
        RecoveryWideTile(symbol: symbol, title: title, value: value, footerLead: "", footerStrong: "") {
            RecoverySliderTrack(fraction: min(max(ratio, 0.04), 1)).frame(height: 18)
        }
    }
}

extension HomeMetric {
    /// La donnée existe pour ce périmètre.
    func isAvailable(_ o: Overview) -> Bool {
        switch self {
        case .downloads: o.downloads != nil
        case .trials: o.hasTrials ?? (o.activeTrials > 0)
        case .today: false
        default: true
        }
    }
}

extension HomeMetric {
    /// Part affichée par le curseur des petites tuiles.
    func ratio(_ o: Overview) -> Double {
        let paying = Double(max(o.payingCustomers ?? o.activeSubscriptions, 1))
        let r: Double = switch self {
        case .paying: Double(o.activeSubscriptions) / paying
        case .trials: o.projects.compactMap(\.trialConversionRate).max() ?? Double(o.activeTrials) / (Double(o.activeTrials) + paying)
        case .downloads: o.downloads.map { $0 > 0 ? Double(o.newCustomers) / Double($0) : 0 } ?? 0
        case .newCustomers: Double(o.newCustomers) / paying
        default: 0.5
        }
        return min(max(r, 0.04), 1)
    }

    var isBigTile: Bool { [.today, .mrr, .revenue, .subscriptions].contains(self) }

    var symbol: String {
        switch self {
        case .today: "bolt.fill"
        case .mrr: "arrow.triangle.2.circlepath"
        case .revenue: "eurosign.circle.fill"
        case .subscriptions: "person.2.fill"
        case .paying: "creditcard.fill"
        case .trials: "hourglass"
        case .downloads: "arrow.down.app.fill"
        case .newCustomers: "sparkles"
        }
    }

    /// Variation affichée sous la valeur des petites tuiles (« +12 % »).
    func deltaText(_ o: Overview) -> String? {
        switch self {
        case .trials:
            let rates = o.projects.compactMap(\.trialConversionRate)
            guard !rates.isEmpty else { return nil }
            let pct = Int((rates.reduce(0, +) / Double(rates.count) * 100).rounded())
            return String(localized: "+\(pct) % conv.")
        case .downloads:
            guard let d = o.downloads, d > 0 else { return nil }
            let pct = Int((Double(o.newCustomers) / Double(d) * 100).rounded())
            return String(localized: "+\(pct) % clients")
        default:
            guard let d = halfOverHalf(dailySeries(o.mergedRevenueByDay, days: 30)), [.paying, .newCustomers].contains(self) else { return nil }
            return "\(d >= 0 ? "+" : "")\(Int((d * 100).rounded())) %"
        }
    }
}

/// `Equatable` sans Store observé : une tuile ne se recalcule (séries, cumuls, formatage)
/// que si sa donnée change, pas à chaque publication du Store (flux en direct, focus…).
struct HomeTile: View, Equatable {
    let metric: HomeMetric
    let o: Overview
    let today: Today?

    var body: some View {
        tile.environment(\.recoveryDotSeed, HomeMetric.allCases.firstIndex(of: metric) ?? 0)
    }

    @ViewBuilder
    private var tile: some View {
        let title = metric.title(o)
        let value = metric.format(metric.total(o, today: today), o)
        switch metric {
        case .today:
            // Ventes par tranche de 3 h (le cumul horaire est différencié).
            let h = today?.hourly ?? []
            let perHour = h.enumerated().map { i, v in Double(v - (i > 0 ? h[i - 1] : 0)) }
            let buckets = stride(from: 0, to: perHour.count, by: 3).map { perHour[$0..<min($0 + 3, perHour.count)].reduce(0, +) }
            RecoveryWideTile(symbol: metric.symbol, title: title, value: value,
                             footerLead: String(localized: "Ventes"), footerStrong: String(localized: "\(today?.transactions ?? 0) aujourd'hui")) {
                RecoveryVioletLine(values: h.map(Double.init), money: true)
            }
        case .mrr:
            RecoveryWideTile(symbol: metric.symbol, title: title, value: o.mrrMicros.money(o.currency, compact: true),
                             footerLead: "ARR", footerStrong: (o.mrrMicros * 12).money(o.currency, compact: true), dotsAnchor: .bottomTrailing) {
                RecoveryVioletLine(values: { var run = 0.0; return dailySeries(o.mergedRevenueByDay, days: 30).map { run += $0.value; return run } }(), money: true)
            }
        case .revenue:
            let daily = dailySeries(o.mergedRevenueByDay, days: 14).map(\.value)
            let yesterday = daily.dropLast().last ?? 0
            RecoveryWideTile(symbol: metric.symbol, title: title, value: o.revenueMicros.money(o.currency, compact: true),
                             footerLead: String(localized: "Hier"), footerStrong: Int(yesterday * 1e6).money(o.currency, compact: true), dotsAnchor: .topTrailing) {
                RecoveryVioletLine(values: daily, money: true)
            }
        case .subscriptions:
            let paying = max(o.payingCustomers ?? o.activeSubscriptions, 1)
            RecoveryWideTile(symbol: metric.symbol, title: title, value: o.activeSubscriptions.formatted(),
                             footerLead: String(localized: "Sur"), footerStrong: String(localized: "\(paying) clients payants"), dotsAnchor: .bottomTrailing) {
                RecoverySliderTrack(fraction: min(Double(o.activeSubscriptions) / Double(paying), 1)).frame(height: 18)
            }
        case .paying:
            // Pas d'historique du nombre de payants : la courbe montre les paiements des 30 derniers jours.
            RecoveryWideTile(symbol: metric.symbol, title: title, value: value, footerLead: "", footerStrong: "") {
                RecoveryVioletLine(values: dailySeries(o.mergedRevenueByDay, days: 30).map(\.value))
            }
        default:
            // Même taille que les grandes cartes.
            RecoveryWideTile(symbol: metric.symbol, title: title, value: value, footerLead: "", footerStrong: "") {
                RecoverySliderTrack(fraction: metric.ratio(o)).frame(height: 18)
            }
        }
    }
}

private extension Array where Element == Double {
    var nonEmpty: [Double] { isEmpty ? [0] : self }
}


// MARK: - Animations

extension AnyTransition {
    /// Apparition en cascade des cartes supplémentaires : fondu, légère montée et mise à l'échelle,
    /// décalées de 35 ms ; la disparition est un simple fondu rapide, sans cascade.
    static func cascade(_ i: Int) -> AnyTransition {
        .asymmetric(
            insertion: .opacity.combined(with: .offset(y: 14)).combined(with: .scale(scale: 0.97, anchor: .top))
                .animation(.spring(response: 0.46, dampingFraction: 0.88).delay(Double(min(i, 10)) * 0.035)),
            removal: .opacity.animation(.easeOut(duration: 0.16))
        )
    }
}

// MARK: - Zoom carte → graphique plein écran

private struct HomeZoomKey: EnvironmentKey { static let defaultValue: Namespace.ID? = nil }
extension EnvironmentValues {
    var homeZoom: Namespace.ID? {
        get { self[HomeZoomKey.self] }
        set { self[HomeZoomKey.self] = newValue }
    }
}

/// La carte est la source du zoom : en la touchant, elle s'agrandit jusqu'au plein écran.
struct ZoomSource: ViewModifier {
    let id: HomeMetric
    @Environment(\.homeZoom) private var ns
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *), let ns { content.matchedTransitionSource(id: id, in: ns) } else { content }
    }
}

struct ZoomDestination: ViewModifier {
    let id: HomeMetric
    let ns: Namespace.ID
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) { content.navigationTransition(.zoom(sourceID: id, in: ns)) } else { content }
    }
}
