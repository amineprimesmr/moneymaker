//
//  DashboardWidget.swift
//  MoneyMaker — « Tableau de bord » : revenu 28 j, MRR, payants, dernière vente.
//
//  Grand format interactif (iOS 17) : une rangée de puces (Revenu / Cumul / Aujourd'hui /
//  Business) change le graphique affiché. Le choix est gardé dans les UserDefaults de
//  l'extension (l'intention et la timeline tournent toutes deux dans l'extension), puis
//  WidgetKit recharge la timeline.
//

import WidgetKit
import SwiftUI
import AppIntents

// MARK: - Graphique choisi

enum WChart: String, CaseIterable {
    case revenue, cumulative, today, business

    static let key = "widget.dashboard.chart"
    static var current: WChart {
        get { UserDefaults.standard.string(forKey: key).flatMap(WChart.init(rawValue:)) ?? .revenue }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: key) }
    }

    var chip: String {
        switch self {
        case .revenue: return String(localized: "Revenu")
        case .cumulative: return String(localized: "Cumul")
        case .today: return String(localized: "Aujourd'hui")
        case .business: return String(localized: "Business")
        }
    }
}

struct SelectDashboardChartIntent: AppIntent {
    static var title: LocalizedStringResource = "Changer de graphique"
    static var isDiscoverable = false

    @Parameter(title: "Graphique") var chart: String

    init() {}
    init(_ chart: WChart) { self.chart = chart.rawValue }

    func perform() async throws -> some IntentResult {
        if let c = WChart(rawValue: chart) { WChart.current = c }
        return .result()
    }
}

// MARK: - Timeline

struct DashEntry: TimelineEntry {
    let date: Date
    let overview: Overview?
    let last: FeedEvent?
    var today: Today? = nil
    var chart: WChart = .revenue
    let signedIn: Bool
    /// Business suivi (bouton « suivant ») ; nil = tous.
    var projectId: String? = nil
    var record: MMRecord? = nil
    var icons: WIcons = [:]

    /// Aperçu affiché (restreint au business suivi).
    var shown: Overview? { overview?.focused(on: projectId) }
    var projectName: String? { overview?.focusName(projectId) }
}

struct DashProvider: TimelineProvider {
    func placeholder(in context: Context) -> DashEntry {
        DashEntry(date: .now, overview: .placeholderDashboard, last: FeedEvent.samples.first, today: .placeholder, signedIn: true)
    }
    func getSnapshot(in context: Context, completion: @escaping (DashEntry) -> Void) {
        completion(DashEntry(date: .now, overview: context.isPreview ? .placeholderDashboard : (MoneyMakerClient.cachedOverview ?? .placeholderDashboard),
                             last: MMShared.cachedFeed.first(where: \.isRevenue) ?? FeedEvent.samples.first,
                             today: MMShared.cachedToday ?? .placeholder, chart: WChart.current, signedIn: context.isPreview || MoneyMakerClient.stored.token != nil,
                             projectId: MMShared.widgetProjectId, record: MMRecord(today: MMShared.cachedToday, history: MMShared.history)))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<DashEntry>) -> Void) {
        Task {
            let client = MoneyMakerClient.stored
            let chart = WChart.current
            async let o = try? client.overview(days: 28)
            async let f = try? client.feed(limit: 10)
            // Le jour n'est chargé que pour le grand format quand il est affiché.
            let wantsToday = context.family == .systemLarge && chart == .today
            async let t: Today? = wantsToday ? (try? await client.today()) : nil
            async let h = client.history()
            let (overview, feed, today, history) = await (o, f, t, h)
            let pid = MMShared.widgetProjectId
            // Le record se calcule sur tous les business (l'historique est global).
            let record = pid == nil ? MMRecord(today: today ?? MMShared.cachedToday, history: history) : nil
            let last = (feed ?? MMShared.cachedFeed).first { $0.isRevenue && (pid == nil || $0.projectId == pid) }
            let ov = overview ?? MoneyMakerClient.cachedOverview
            // Logos : business suivi, dernière vente, puis (grand format) le classement par business.
            var ids: [String?] = context.family == .systemSmall ? [] : [pid, last?.projectId]
            if context.family == .systemLarge { ids += (ov?.projects ?? []).sorted { $0.netRevenueMicros > $1.netRevenueMicros }.prefix(4).map(\.projectId) }
            let icons = await WIconCache.load(ids, overview: ov)
            let next = Date.now.addingTimeInterval(15 * 60)
            completion(Timeline(entries: wTimelineDates(until: next).map {
                                    DashEntry(date: $0, overview: ov, last: last, today: today ?? MMShared.cachedToday, chart: chart,
                                              signedIn: client.token != nil, projectId: pid, record: record, icons: icons)
                                },
                                policy: .after(next)))
        }
    }
}

extension Overview {
    static let placeholderDashboard: Overview = {
        let days = DayKeys.last(28)
        let shape: [Double] = [3, 4, 3, 5, 4, 6, 5, 4, 6, 7, 6, 8, 7, 6, 9, 8, 10, 9, 8, 11, 10, 12, 11, 13, 12, 14, 13, 16]
        let byDay = Dictionary(uniqueKeysWithValues: days.enumerated().map { ($0.element.0, Int(shape[$0.offset] * 9_000_000)) })
        let names = ["Mon app", "Studio", "Pro"]
        let projects = names.enumerated().map { i, n in
            ProjectSummary(projectId: "p\(i)", name: n, currency: "EUR", mrrMicros: [110, 38, 13][i] * 1_000_000, netRevenueMicros: [1_740, 610, 264][i] * 1_000_000,
                           activeSubscriptions: [12, 5, 2][i], activeTrials: 0, newCustomers: 0, trialConversionRate: nil, churnRate: nil, billingIssues: 0,
                           revenueByDay: i == 0 ? byDay : [:])
        }
        return Overview(currency: "EUR", periodDays: 28, mrrMicros: 161_000_000, revenueMicros: 2_614_000_000, activeSubscriptions: 19, activeTrials: 0,
                        newCustomers: 844, projects: projects, generatedAt: Date().timeIntervalSince1970 * 1000, payingCustomers: 41, downloads: 906, hasTrials: false)
    }()
}

func todayValues(_ t: Today, now: Date = .now) -> [Double] {
    let start = Date(timeIntervalSince1970: t.dayStart / 1000)
    let hour = max(2, min(24, Int(now.timeIntervalSince(start) / 3600) + 1))
    return t.hourly.prefix(hour).map { Double($0) / 1e6 }
}

private func lastSaleText(_ l: FeedEvent?) -> String {
    guard let l, let a = l.amountText else { return "—" }
    return [a, l.country.map(flagEmoji)].compactMap { $0 }.joined(separator: " ")
}

// MARK: - Vue

struct DashboardWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: DashEntry

    var body: some View {
        if !entry.signedIn { SignedOutView() } else if let o = entry.shown {
            let pts = dailySeries(o.revenueByDay, days: 28)
            switch family {
            case .systemSmall:
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top, spacing: 4) {
                        WValue(text: o.revenueMicros.money(o.currency, compact: true), size: 30)
                        if let r = entry.record, r.isRecord { Spacer(minLength: 0); Image(systemName: "trophy.fill").font(.system(size: 11, weight: .semibold)).foregroundStyle(WTone.gold) }
                    }
                    WDelta(value: halfOverHalf(pts)).padding(.top, 1)
                    WLine(values: pts.values, lineWidth: 1.8).padding(.vertical, 6)
                    HStack(spacing: 4) {
                        Text("MRR").foregroundStyle(MMColor.ink3)
                        Text(o.mrrMicros.money(o.currency, compact: true)).foregroundStyle(MMColor.ink2)
                    }
                    .font(MMFont.system(12, .medium))
                }
            case .systemMedium:
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 6) {
                        if let r = entry.record, r.isRecord { WRecordBadge(record: r, compact: true) }
                        Spacer(minLength: 0)
                        WProjectSwitch(name: entry.projectName, icon: entry.projectId.flatMap { entry.icons[$0] })
                    }
                    HStack(alignment: .bottom, spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            WValue(text: o.revenueMicros.money(o.currency, compact: true), size: 32)
                            WDelta(value: halfOverHalf(pts))
                        }
                        .fixedSize()
                        WLine(values: pts.values, lineWidth: 1.8)
                    }
                    .padding(.top, 6)
                    .frame(maxHeight: .infinity)
                    WHairline().padding(.vertical, 8)
                    stats(o)
                }
            default:
                large(o, pts: pts)
            }
        } else {
            Text("—").foregroundStyle(MMColor.ink3)
        }
    }

    private func stats(_ o: Overview) -> some View {
        HStack(alignment: .top) {
            WStat(label: "MRR", value: o.mrrMicros.money(o.currency, compact: true), size: 16)
            Spacer(minLength: 6)
            WStat(label: String(localized: "Payants"), value: (o.payingCustomers ?? o.activeSubscriptions).formatted(), size: 16)
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 2) {
                Text("Dernière vente").font(MMFont.system(11)).foregroundStyle(MMColor.ink3).lineLimit(1)
                HStack(spacing: 5) {
                    if let l = entry.last { WBizIcon(data: entry.icons[l.projectId], name: l.projectName, size: 16) }
                    Text(lastSaleText(entry.last)).font(MMFont.number(16, .regular)).foregroundStyle(MMColor.ink).lineLimit(1).minimumScaleFactor(0.6)
                }
            }
        }
    }

    @ViewBuilder
    private func large(_ o: Overview, pts: [MMPoint]) -> some View {
        let chart = entry.chart
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Spacer(minLength: 0)
                WProjectSwitch(name: entry.projectName, icon: entry.projectId.flatMap { entry.icons[$0] })
            }
            if let r = entry.record, r.isRecord, let t = entry.today {
                HStack(spacing: 6) {
                    WRecordBadge(record: r)
                    Text("\(t.netMicros.money(t.currency, compact: true)) aujourd'hui").font(MMFont.system(11)).foregroundStyle(MMColor.ink3).lineLimit(1)
                }
                .padding(.top, 6)
            }
            HStack(alignment: .lastTextBaseline) {
                WValue(text: headline(chart, o), size: 36)
                Spacer(minLength: 8)
                if chart == .revenue || chart == .cumulative { WDelta(value: halfOverHalf(pts)) }
            }
            .padding(.top, 8)
            chips.padding(.top, 10)
            Group {
                switch chart {
                case .revenue: WLine(values: pts.values)
                case .cumulative: WLine(values: pts.cumulative)
                case .today: WLine(values: entry.today.map { todayValues($0, now: entry.date) } ?? [0, 0])
                case .business: business(o)
                }
            }
            .frame(maxHeight: .infinity)
            .padding(.vertical, 12)
            WHairline().padding(.bottom, 10)
            stats(o)
        }
    }

    private var chips: some View {
        HStack(spacing: 6) {
            ForEach(WChart.allCases, id: \.self) { c in
                let on = c == entry.chart
                Button(intent: SelectDashboardChartIntent(c)) {
                    Text(c.chip)
                        .font(MMFont.system(12, .medium))
                        .foregroundStyle(on ? MMColor.ink : MMColor.ink3)
                        .lineLimit(1).minimumScaleFactor(0.8)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Capsule().fill(on ? MMColor.fg(0.12) : .clear))
                        .overlay(Capsule().strokeBorder(on ? .clear : MMColor.hairline, lineWidth: 0.75))
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
    }

    private func headline(_ c: WChart, _ o: Overview) -> String {
        if c == .today, let t = entry.today { return t.netMicros.money(t.currency, compact: true) }
        return o.revenueMicros.money(o.currency, compact: true)
    }

    /// Répartition par business : barres violettes fines, nom + montant.
    private func business(_ o: Overview) -> some View {
        let rows = Array(o.projects.sorted { $0.netRevenueMicros > $1.netRevenueMicros }.prefix(4))
        let hi = Double(max(rows.first?.netRevenueMicros ?? 1, 1))
        return VStack(alignment: .leading, spacing: 9) {
            if rows.isEmpty { Text("—").foregroundStyle(MMColor.ink3) }
            ForEach(rows, id: \.projectId) { p in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        WBizIcon(data: entry.icons[p.projectId], name: p.name, size: 18)
                        Text(p.name).font(MMFont.system(13, .medium)).foregroundStyle(MMColor.ink).lineLimit(1)
                        Spacer()
                        Text(p.netRevenueMicros.money(p.currency, compact: true)).font(MMFont.number(13, .regular)).foregroundStyle(MMColor.ink2)
                    }
                    WProgress(value: Double(p.netRevenueMicros) / hi, tone: .violet)
                }
            }
            Spacer(minLength: 0)
        }
    }
}

struct MoneyMakerDashboardWidget: Widget {
    static let families: [WidgetFamily] = [.systemSmall, .systemMedium, .systemLarge]
    var body: some WidgetConfiguration { Self.configuration(kind: WidgetPushGate.kind("MoneyMakerDashboard"), families: WidgetPushGate.legacy(Self.families)) }
    static func configuration(kind: String, families: [WidgetFamily]) -> some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: DashProvider()) { entry in
            DashboardWidgetView(entry: entry)
                .containerBackground(for: .widget) { WidgetBackdrop(date: entry.date) }
                .widgetURL(URL(string: "moneymaker://overview"))
        }
        .configurationDisplayName("Tableau de bord")
        .description("Revenu, MRR, payants et dernière vente. En grand, choisis le graphique d'un geste.")
        .supportedFamilies(families)
    }
}

@available(iOS 26.0, *)
struct MoneyMakerDashboardWidgetPush: Widget {
    var body: some WidgetConfiguration {
        MoneyMakerDashboardWidget.configuration(kind: "MoneyMakerDashboard", families: MoneyMakerDashboardWidget.families).pushHandler(MMWidgetPushHandler.self)
    }
}
