//
//  RCWidgets.swift
//  MoneyMaker — widgets au format RevenueCat, habillés du design commun (WidgetStyle) :
//    • « Overview » moyen : 4 tuiles (essais, aujourd'hui, MRR, revenus) ;
//    • « Overview » grand : 6 tuiles + courbe des revenus à fond perdu ;
//    • « MRR » petit : libellé, ligne verte au milieu, montant et « now » ;
//    • « Transactions » moyen : les 3 dernières ventes, pastille de type et montant.
//  Libellés dans la langue de l'app ; une touche sur une case du grand widget change la courbe sans ouvrir l'app.
//

import WidgetKit
import SwiftUI
import AppIntents

// MARK: - Formats

private enum RC {
    /// « €2 802 » : symbole devant, espaces entre les milliers, sans décimales.
    /// Formateurs partagés et symbole mis en cache : avant, chaque montant créait un NumberFormatter
    /// et parcourait ~1 000 locales (même pour l'euro), coûteux pour la mémoire limitée d'un widget.
    private static let amountFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.groupingSeparator = "\u{202F}"
        f.maximumFractionDigits = 0
        return f
    }()
    private static var symbols: [String: String] = ["EUR": "€", "USD": "$", "GBP": "£"]
    private static func symbol(_ currency: String) -> String {
        if let s = symbols[currency] { return s }
        let s = Locale.availableIdentifiers.lazy.map(Locale.init).first { $0.currency?.identifier == currency }?.currencySymbol ?? currency
        symbols[currency] = s
        return s
    }

    static func amount(_ micros: Int, _ currency: String) -> String {
        let v = Double(micros) / 1_000_000
        return (v < 0 ? "-" : "") + symbol(currency)
            + (amountFormatter.string(from: NSNumber(value: abs(v).rounded())) ?? "0")
    }

    private static let agoFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter(); f.unitsStyle = .short; f.dateTimeStyle = .numeric; return f
    }()

    /// « 15 hr ago », « 4 days ago ».
    static func ago(_ d: Date, now: Date = .now) -> String {
        let s = max(0, Int(now.timeIntervalSince(d)))
        if s < 60 { return String(localized: "À l'instant") }
        let f = agoFormatter
        // Arrondi à l'unité inférieure (« 15 hr ago », « 4 days ago »), dans la langue de l'appareil.
        let c: DateComponents = s < 3600 ? DateComponents(minute: -(s / 60)) : s < 86_400 ? DateComponents(hour: -(s / 3600)) : DateComponents(day: -(s / 86_400))
        return f.localizedString(from: c)
    }
}

// MARK: - Tuile (carte commune à la famille de widgets)

private struct RCTile: View {
    let label: String
    let value: String
    var tone: WTone? = nil
    var selected = false

    var body: some View {
        WCard(padding: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    if let tone { Circle().fill(tone.bright).frame(width: 4, height: 4) }
                    Text(label.uppercased()).font(MMFont.system(10, .medium)).tracking(1.2)
                        .foregroundStyle(selected ? MMColor.ink : MMColor.ink3)
                        .lineLimit(1).minimumScaleFactor(0.7)
                }
                Spacer(minLength: 0)
                Text(value).font(MMFont.number(24, .regular)).foregroundStyle(MMColor.ink)
                    .lineLimit(1).minimumScaleFactor(0.5)
            }
        }
        .overlay {
            if selected {
                RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder((tone ?? .money).bright.opacity(0.45), lineWidth: 1)
            }
        }
    }
}

/// Les six données du widget Overview ; celle choisie donne la courbe du grand format.
enum RCMetric: String, CaseIterable {
    case trials, today, mrr, revenue, newCustomers, activeCustomers

    static let key = "widget.rc.metric"
    static var current: RCMetric {
        get { UserDefaults.standard.string(forKey: key).flatMap(RCMetric.init(rawValue:)) ?? .revenue }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: key) }
    }

    var label: String {
        switch self {
        case .trials: return String(localized: "Essais actifs")
        case .today: return String(localized: "Aujourd'hui")
        case .mrr: return "MRR"
        case .revenue: return String(localized: "Revenus")
        case .newCustomers: return String(localized: "Nouveaux clients")
        case .activeCustomers: return String(localized: "Clients actifs")
        }
    }
    var tone: WTone? {
        switch self {
        case .today, .mrr, .revenue: return .money
        case .newCustomers, .activeCustomers: return .violet
        default: return nil
        }
    }
    /// Graphique serveur (/v1/projects/:pid/charts/:name) ; nil = revenus déjà présents dans l'aperçu.
    var chartName: String? {
        switch self {
        case .trials: return "active_trials"
        case .activeCustomers: return "active_subscriptions"
        case .mrr: return "mrr"
        case .newCustomers: return "new_customers"
        case .revenue, .today: return nil
        }
    }
    func value(_ o: Overview, today t: Today?) -> String {
        switch self {
        case .trials: return o.activeTrials.formatted()
        case .today: return (t?.netMicros ?? 0).money(t?.currency ?? o.currency)
        case .mrr: return o.mrrMicros.money(o.currency)
        case .revenue: return o.revenueMicros.money(o.currency)
        case .newCustomers: return o.newCustomers.formatted()
        case .activeCustomers: return (o.payingCustomers ?? o.activeSubscriptions).formatted()
        }
    }

    /// Série quotidienne sur 28 jours, sommée sur les business de l'aperçu.
    func series(_ o: Overview, client: MoneyMakerClient) async -> [Double]? {
        guard let name = chartName else { return nil }
        struct P: Decodable { let value: Double? }
        struct R: Decodable { let series: [P] }
        var total: [Double] = []
        for p in o.projects {
            guard let r: R = try? await client.get("projects/\(p.projectId)/charts/\(name)?days=28") else { continue }
            let v = r.series.map { $0.value ?? 0 }
            if total.isEmpty { total = v } else { for i in 0..<min(total.count, v.count) { total[i] += v[i] } }
        }
        return total.isEmpty ? nil : total
    }
}

/// Courbes des six données, chargées ensemble toutes les 15 minutes pour qu'un changement soit instantané.
enum RCSeriesCache {
    private static let d = UserDefaults.standard
    static var fetchedAt: Date { Date(timeIntervalSince1970: d.double(forKey: "widget.rc.fetchedAt")) }
    static func series(_ m: RCMetric) -> [Double]? { m.chartName.flatMap { d.array(forKey: "widget.rc.s.\($0)") as? [Double] } }
    static func refresh(_ o: Overview, client: MoneyMakerClient) async {
        await withTaskGroup(of: (String, [Double]?).self) { g in
            for m in RCMetric.allCases { if let n = m.chartName { g.addTask { (n, await m.series(o, client: client)) } } }
            for await (n, v) in g { if let v { d.set(v, forKey: "widget.rc.s.\(n)") } }
        }
        d.set(Date.now.timeIntervalSince1970, forKey: "widget.rc.fetchedAt")
    }
}

struct SelectRCMetricIntent: AppIntent {
    static var title: LocalizedStringResource = "Changer de courbe"
    static var isDiscoverable = false

    @Parameter(title: "Donnée") var metric: String

    init() {}
    init(_ m: RCMetric) { metric = m.rawValue }

    func perform() async throws -> some IntentResult {
        if let m = RCMetric(rawValue: metric) { RCMetric.current = m }
        UserDefaults.standard.set(Date.now.timeIntervalSince1970, forKey: "widget.rc.tapAt")
        return .result()
    }
}

// MARK: - Overview (moyen + grand)

struct RCOverviewEntry: TimelineEntry { let date: Date; let overview: Overview?; let signedIn: Bool; var metric: RCMetric = .revenue; var series: [Double]? = nil; var today: Today? = nil }

struct RCOverviewProvider: TimelineProvider {
    func placeholder(in context: Context) -> RCOverviewEntry { RCOverviewEntry(date: .now, overview: .rcSample, signedIn: true) }
    func getSnapshot(in context: Context, completion: @escaping (RCOverviewEntry) -> Void) {
        completion(RCOverviewEntry(date: .now, overview: context.isPreview ? .rcSample : MoneyMakerClient.cachedOverview, signedIn: context.isPreview || MoneyMakerClient.stored.token != nil))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<RCOverviewEntry>) -> Void) {
        Task {
            let client = MoneyMakerClient.stored
            // Après une touche sur une case : tout vient du cache, rien n'attend le réseau.
            // Une vente (push) ou l'échéance recharge toujours les chiffres ; seule une touche récente s'en passe.
            let tapped = Date.now.timeIntervalSince1970 - UserDefaults.standard.double(forKey: "widget.rc.tapAt") < 5
            async let fetched = tapped ? nil : try? client.overview(days: 28)
            async let fetchedToday = tapped ? nil : try? client.today()
            let o = await fetched ?? MoneyMakerClient.cachedOverview
            let today = await fetchedToday ?? MMShared.cachedToday
            let metric = context.family == .systemLarge ? RCMetric.current : .revenue
            if !tapped, context.family == .systemLarge, let o { await RCSeriesCache.refresh(o, client: client) }
            let series = RCSeriesCache.series(metric)
            let next = Date.now.addingTimeInterval(15 * 60)
            completion(Timeline(entries: wTimelineDates(until: next).map {
                RCOverviewEntry(date: $0, overview: o, signedIn: client.token != nil, metric: metric, series: series, today: today)
            },
                                policy: .after(next)))
        }
    }
}

extension Overview {
    /// Les valeurs exactes des maquettes.
    static let rcSample: Overview = {
        let days = DayKeys.last(28)
        let shape: [Double] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0.92, 0.42, 0.66, 0.02, 0.1, 0.03, 0.03, 0.03, 0.17, 0.04, 0.04, 0.2, 0.05, 0.05, 0.1, 0.12]
        let byDay = Dictionary(uniqueKeysWithValues: days.enumerated().map { ($0.element.0, Int(shape[$0.offset] * 900_000_000)) })
        let p = ProjectSummary(projectId: "sample", name: "10K Design", currency: "EUR", mrrMicros: 29_000_000, netRevenueMicros: 2_802_000_000,
                               activeSubscriptions: 2, activeTrials: 0, newCustomers: 87, trialConversionRate: nil, churnRate: nil, billingIssues: 0,
                               revenueByDay: byDay)
        return Overview(currency: "EUR", periodDays: 28, mrrMicros: 29_000_000, revenueMicros: 2_802_000_000, activeSubscriptions: 2, activeTrials: 0,
                        newCustomers: 87, projects: [p], generatedAt: Date().timeIntervalSince1970 * 1000, payingCustomers: 66, downloads: nil, hasTrials: false)
    }()
}

struct RCOverviewView: View {
    @Environment(\.widgetFamily) var family
    let entry: RCOverviewEntry

    var body: some View {
        if !entry.signedIn { SignedOutView() } else if let o = entry.overview {
            if family == .systemMedium {
                Grid(horizontalSpacing: 8, verticalSpacing: 8) {
                    GridRow { tile(.trials, o); tile(.today, o) }
                    GridRow { tile(.mrr, o); tile(.revenue, o) }
                }
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    Grid(horizontalSpacing: 8, verticalSpacing: 8) {
                        GridRow { button(.trials, o); button(.today, o) }
                        GridRow { button(.mrr, o); button(.revenue, o) }
                        GridRow { button(.newCustomers, o); button(.activeCustomers, o) }
                    }
                    .frame(height: 190)
                    WLine(values: entry.series ?? dailySeries(o.revenueByDay, days: 28).values,
                          tone: entry.metric.tone ?? .money, lineWidth: 1.8, zeroBased: entry.metric.tone == .money)
                        .padding(.top, 16)
                        .id(entry.metric)
                        .transition(.opacity)
                }
            }
        }
    }

    private func tile(_ m: RCMetric, _ o: Overview, selected: Bool = false) -> RCTile {
        RCTile(label: m.label, value: m.value(o, today: entry.today), tone: m.tone, selected: selected)
    }
    private func button(_ m: RCMetric, _ o: Overview) -> some View {
        Button(intent: SelectRCMetricIntent(m)) { tile(m, o, selected: m == entry.metric) }.buttonStyle(.plain)
    }
}

struct RCOverviewWidget: Widget {
    static let families: [WidgetFamily] = [.systemMedium, .systemLarge]
    var body: some WidgetConfiguration { Self.configuration(kind: WidgetPushGate.kind("MoneyMakerRCOverview"), families: WidgetPushGate.legacy(Self.families)) }
    static func configuration(kind: String, families: [WidgetFamily]) -> some WidgetConfiguration {
            StaticConfiguration(kind: kind, provider: RCOverviewProvider()) { entry in
                RCOverviewView(entry: entry)
                    .containerBackground(for: .widget) { WidgetBackdrop(date: entry.date) }
                    .widgetURL(URL(string: "moneymaker://overview"))
            }
            .configurationDisplayName("Overview")
            .description("Essais, abonnements, MRR, revenu et clients, avec la courbe des revenus.")
            .supportedFamilies(families)
    }
}

@available(iOS 26.0, *)
struct RCOverviewWidgetPush: Widget {
    var body: some WidgetConfiguration { RCOverviewWidget.configuration(kind: "MoneyMakerRCOverview", families: RCOverviewWidget.families).pushHandler(MMWidgetPushHandler.self) }
}

// MARK: - MRR (petit)

struct RCMRRView: View {
    let entry: RCOverviewEntry
    var body: some View {
        if !entry.signedIn { SignedOutView() } else if let o = entry.overview {
            VStack(alignment: .leading, spacing: 0) {
                WLine(values: dailySeries(o.revenueByDay, days: 28).cumulative, lineWidth: 1.8)
                    .padding(.bottom, 8)
                WValue(text: o.mrrMicros.money(o.currency), size: 36)
            }
        }
    }
}

struct RCMRRWidget: Widget {
    static let families: [WidgetFamily] = [.systemSmall]
    var body: some WidgetConfiguration { Self.configuration(kind: WidgetPushGate.kind("MoneyMakerRCMRR"), families: WidgetPushGate.legacy(Self.families)) }
    static func configuration(kind: String, families: [WidgetFamily]) -> some WidgetConfiguration {
            StaticConfiguration(kind: kind, provider: RCOverviewProvider()) { entry in
                RCMRRView(entry: entry)
                    .containerBackground(for: .widget) { WidgetBackdrop(date: entry.date) }
                    .widgetURL(URL(string: "moneymaker://overview"))
            }
            .configurationDisplayName("MRR")
            .description("Ton MRR, en grand.")
            .supportedFamilies(families)
    }
}

@available(iOS 26.0, *)
struct RCMRRWidgetPush: Widget {
    var body: some WidgetConfiguration { RCMRRWidget.configuration(kind: "MoneyMakerRCMRR", families: RCMRRWidget.families).pushHandler(MMWidgetPushHandler.self) }
}

// MARK: - Transactions (moyen)

struct RCTransactionsEntry: TimelineEntry { let date: Date; let events: [FeedEvent]; let signedIn: Bool; var icons: WIcons = [:] }

struct RCTransactionsProvider: TimelineProvider {
    func placeholder(in context: Context) -> RCTransactionsEntry { RCTransactionsEntry(date: .now, events: FeedEvent.rcSamples, signedIn: true) }
    func getSnapshot(in context: Context, completion: @escaping (RCTransactionsEntry) -> Void) {
        let cached = MMShared.cachedFeed.filter(\.isRevenue)
        completion(RCTransactionsEntry(date: .now, events: context.isPreview ? FeedEvent.rcSamples : cached, signedIn: context.isPreview || MoneyMakerClient.stored.token != nil))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<RCTransactionsEntry>) -> Void) {
        Task {
            let client = MoneyMakerClient.stored
            let events = ((try? await client.feed(limit: 20)) ?? MMShared.cachedFeed).filter(\.isRevenue)
            let icons = await WIconCache.load(events.prefix(3).map(\.projectId), overview: MoneyMakerClient.cachedOverview)
            let next = Date.now.addingTimeInterval(15 * 60)
            completion(Timeline(entries: wTimelineDates(until: next).map { RCTransactionsEntry(date: $0, events: events, signedIn: client.token != nil, icons: icons) },
                                policy: .after(next)))
        }
    }
}

extension FeedEvent {
    static let rcSamples: [FeedEvent] = [15 * 3600.0, 4 * 86_400.0, 5 * 86_400.0].enumerated().map { i, ago in
        FeedEvent(id: "rc\(i)", projectId: "p", projectName: "10K Design", type: "NON_RENEWING_PURCHASE", productId: nil, priceMicros: 59_000_000,
                  currency: "EUR", country: "FR", store: "stripe", isSandbox: false, isTrial: false, periodMonths: nil,
                  at: (Date().timeIntervalSince1970 - ago) * 1000)
    }

    /// « 10K Design EUR 59.00 one-time ».
    var rcTitle: String {
        let price = String(format: "%.2f", Double(priceMicros ?? 0) / 1_000_000)
        let period: String
        switch periodMonths {
        case nil, 0?: period = String(localized: "one-time")
        case 12?: period = String(localized: "yearly")
        case 1?: period = String(localized: "monthly")
        case 3?: period = String(localized: "quarterly")
        case let m?: period = String(localized: "\(Int(m)) months")
        }
        return "\(currency ?? "") \(price) \(type == "NON_RENEWING_PURCHASE" ? String(localized: "one-time") : period)"
    }
}

struct RCTransactionsView: View {
    let entry: RCTransactionsEntry
    var body: some View {
        if !entry.signedIn { SignedOutView() } else {
            let rows = Array(entry.events.prefix(3))
            VStack(alignment: .leading, spacing: 0) {
                if rows.isEmpty {
                    Text("Aucune vente pour l'instant").font(MMFont.system(14)).foregroundStyle(MMColor.ink3).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                ForEach(Array(rows.enumerated()), id: \.element.id) { i, e in
                    if i > 0 { WHairline() }
                    HStack(spacing: 10) {
                        WBizIcon(data: entry.icons[e.projectId], name: e.projectName, size: 28)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                TransactionBadge(kind: e.badge, size: 10)
                                if let c = e.country { Text(flagEmoji(c)).font(.system(size: 12)) }
                            }
                            WAgo(date: e.date).font(MMFont.system(11)).foregroundStyle(MMColor.ink3).lineLimit(1)
                        }
                        Spacer(minLength: 6)
                        Text("+" + (e.amountText ?? "")).font(MMFont.number(16, .regular)).foregroundStyle(MMColor.ink)
                            .lineLimit(1).minimumScaleFactor(0.7)
                    }
                    .padding(.vertical, 4)
                    .frame(maxHeight: .infinity)
                }
                Spacer(minLength: 0)
            }
        }
    }
}

struct RCTransactionsWidget: Widget {
    static let families: [WidgetFamily] = [.systemMedium]
    var body: some WidgetConfiguration { Self.configuration(kind: WidgetPushGate.kind("MoneyMakerRCTransactions"), families: WidgetPushGate.legacy(Self.families)) }
    static func configuration(kind: String, families: [WidgetFamily]) -> some WidgetConfiguration {
            StaticConfiguration(kind: kind, provider: RCTransactionsProvider()) { entry in
                RCTransactionsView(entry: entry)
                    .containerBackground(for: .widget) { WidgetBackdrop(date: entry.date) }
                    .widgetURL(URL(string: "moneymaker://feed"))
            }
            .configurationDisplayName("Transactions")
            .description("Tes 3 dernières ventes.")
            .supportedFamilies(families)
    }
}

@available(iOS 26.0, *)
struct RCTransactionsWidgetPush: Widget {
    var body: some WidgetConfiguration { RCTransactionsWidget.configuration(kind: "MoneyMakerRCTransactions", families: RCTransactionsWidget.families).pushHandler(MMWidgetPushHandler.self) }
}
