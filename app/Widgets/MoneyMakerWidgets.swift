import WidgetKit
import SwiftUI
import Charts
import AppIntents

// MARK: - MRR (configurable : business + objectif)

/// Tranche affichée : tous les business ou un seul.
struct MRRSlice: Hashable {
    let name: String
    let currency: String
    let mrrMicros: Int
    let revenueMicros: Int
    let subscribers: Int
    let trials: Int
    let byDay: [String: Int]
    let projects: [ProjectSummary]

    init?(_ o: Overview?, projectId: String?) {
        guard let o else { return nil }
        if let id = projectId, id != "*", let p = o.projects.first(where: { $0.projectId == id }) {
            name = p.name; currency = p.currency; mrrMicros = p.mrrMicros; revenueMicros = p.netRevenueMicros
            subscribers = p.activeSubscriptions; trials = p.activeTrials; byDay = p.revenueByDay; projects = []
        } else {
            name = "Tous les business"; currency = o.currency; mrrMicros = o.mrrMicros; revenueMicros = o.revenueMicros
            subscribers = o.activeSubscriptions; trials = o.activeTrials; byDay = o.revenueByDay; projects = o.projects
        }
    }
}

struct Entry: TimelineEntry {
    let date: Date
    let slice: MRRSlice?
    let goal: Int?
    let signedIn: Bool
}

struct Provider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: .now, slice: MRRSlice(.placeholder, projectId: nil), goal: 6000, signedIn: true) }

    func snapshot(for configuration: MRRWidgetIntent, in context: Context) async -> Entry {
        let o = context.isPreview ? .placeholder : (MoneyMakerClient.cachedOverview ?? .placeholder)
        return Entry(date: .now, slice: MRRSlice(o, projectId: configuration.project?.id), goal: configuration.goal ?? MMShared.mrrGoal, signedIn: true)
    }

    func timeline(for configuration: MRRWidgetIntent, in context: Context) async -> Timeline<Entry> {
        let client = MoneyMakerClient.stored
        let fresh = try? await client.overview(days: 30)
        let entry = Entry(date: .now, slice: MRRSlice(fresh ?? MoneyMakerClient.cachedOverview, projectId: configuration.project?.id),
                          goal: configuration.goal ?? MMShared.mrrGoal, signedIn: client.token != nil)
        return Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60)))
    }
}

private let green = MMColor.accent

/// Fond des widgets : noir pur, comme l'app.
struct WidgetBackdrop: View {
    var body: some View {
        Color.black
    }
}

/// Barre d'objectif fine et lumineuse.
struct GoalBar: View {
    let progress: Double
    let label: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.08))
                    Capsule().fill(MMColor.chartGradient).frame(width: max(4, g.size.width * min(1, progress)))
                        .shadow(color: MMColor.accent.opacity(0.6), radius: 4)
                }
            }
            .frame(height: 4)
            Text(label).font(MMFont.system(10)).foregroundStyle(MMColor.ink3).lineLimit(1)
        }
    }
}

struct WidgetBody: View {
    @Environment(\.widgetFamily) var family
    let entry: Entry

    var body: some View {
        if !entry.signedIn {
            SignedOutView()
        } else if let o = entry.slice {
            let pts = dailySeries(o.byDay, days: family == .systemLarge ? 30 : 14)
            let goalMicros = entry.goal.map { $0 * 1_000_000 }
            let progress = goalMicros.map { Double(o.mrrMicros) / Double(max($0, 1)) }
            switch family {
            case .accessoryInline:
                Text("MRR \(o.mrrMicros.money(o.currency, compact: true))")
            case .accessoryCircular:
                Gauge(value: min(1, progress ?? 1)) {
                    Image(systemName: "dollarsign")
                } currentValueLabel: {
                    Text(o.mrrMicros.money(o.currency, compact: true)).minimumScaleFactor(0.5)
                }
                .gaugeStyle(.accessoryCircularCapacity)
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 1) {
                    Text("MRR").font(.caption2.weight(.semibold)).widgetAccentable()
                    Text(o.mrrMicros.money(o.currency, compact: true)).font(.headline.bold())
                    if let progress { ProgressView(value: min(1, progress)).tint(.white) }
                    else { Text("\(o.subscribers) abonnés · \(o.trials) essais").font(.caption2) }
                }
            case .systemSmall:
                VStack(alignment: .leading, spacing: 6) {
                    MMLabel(text: "MRR")
                    Text(o.mrrMicros.money(o.currency, compact: true)).font(MMFont.number(30)).tracking(-0.8)
                        .minimumScaleFactor(0.5).lineLimit(1)
                    MMGlowChart(points: pts, lineWidth: 1.8)
                    if let progress, let g = goalMicros {
                        GoalBar(progress: progress, label: "\(Int(progress * 100)) % de \(g.money(o.currency, compact: true))")
                    } else {
                        Text("\(o.subscribers) abonnés").font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                    }
                }
            default:
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            MMLabel(text: o.projects.isEmpty ? "MRR · \(o.name)" : "MRR")
                            Text(o.mrrMicros.money(o.currency, compact: true)).font(MMFont.number(32)).tracking(-0.9).minimumScaleFactor(0.6)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 4) {
                            MMDelta(value: halfOverHalf(pts))
                            Text("30 j · \(o.revenueMicros.money(o.currency, compact: true))").font(MMFont.system(11)).foregroundStyle(MMColor.ink2)
                            Text("\(o.subscribers) abonnés").font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                        }
                    }
                    MMGlowChart(points: pts)
                    if let progress, let g = goalMicros {
                        GoalBar(progress: progress, label: "Objectif \(g.money(o.currency, compact: true)) · \(Int(progress * 100)) %")
                    }
                    if family == .systemLarge {
                        VStack(spacing: 0) {
                            ForEach(Array(o.projects.prefix(5).enumerated()), id: \.element.id) { i, p in
                                if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1) }
                                HStack {
                                    Text(p.name).font(MMFont.system(13, .medium)).lineLimit(1)
                                    Spacer()
                                    Text("\(p.activeSubscriptions)").font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                                    Text(p.mrrMicros.money(p.currency, compact: true)).font(MMFont.number(13, .regular))
                                        .frame(minWidth: 56, alignment: .trailing)
                                }
                                .padding(.vertical, 7)
                            }
                        }
                    }
                }
            }
        } else {
            Text("—").foregroundStyle(MMColor.ink3)
        }
    }
}

struct MoneyMakerWidget: Widget {
    static let families: [WidgetFamily] = [.systemSmall, .systemMedium, .systemLarge, .accessoryInline, .accessoryCircular, .accessoryRectangular]
    var body: some WidgetConfiguration { Self.configuration(kind: WidgetPushGate.kind("MoneyMakerOverview"), families: WidgetPushGate.legacy(Self.families)) }
    static func configuration(kind: String, families: [WidgetFamily]) -> some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: MRRWidgetIntent.self, provider: Provider()) { entry in
            WidgetBody(entry: entry)
                .containerBackground(for: .widget) { WidgetBackdrop() }
                .environment(\.colorScheme, .dark)
                .widgetURL(URL(string: "moneymaker://overview"))
        }
        .configurationDisplayName("MRR")
        .description("MRR, revenus et abonnés — tous tes business ou un seul, avec ton objectif.")
        .supportedFamilies(families)
    }
}

// MARK: - App Store rankings widget

struct RankEntry: TimelineEntry {
    let date: Date
    let alerts: [RankingAlert]
}

struct RankProvider: TimelineProvider {
    static let sample = [RankingAlert(id: "1", type: "TOP_1", appName: "Mon app", appIcon: nil, cc: "FR", chart: "free", scope: "genre", rank: 1, prevRank: 3, own: true, projectName: nil, at: Date().timeIntervalSince1970 * 1000),
                         RankingAlert(id: "2", type: "NEW_COUNTRY", appName: "Mon app", appIcon: nil, cc: "JP", chart: "free", scope: "genre", rank: 18, prevRank: nil, own: true, projectName: nil, at: Date().timeIntervalSince1970 * 1000)]
    func placeholder(in context: Context) -> RankEntry { RankEntry(date: .now, alerts: Self.sample) }
    func getSnapshot(in context: Context, completion: @escaping (RankEntry) -> Void) {
        let cached = MoneyMakerClient.cachedAlerts
        completion(RankEntry(date: .now, alerts: cached.isEmpty ? Self.sample : cached))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<RankEntry>) -> Void) {
        Task {
            let fresh = try? await MoneyMakerClient.stored.alerts()
            completion(Timeline(entries: [RankEntry(date: .now, alerts: fresh ?? MoneyMakerClient.cachedAlerts)], policy: .after(.now.addingTimeInterval(30 * 60))))
        }
    }
}

struct RankWidgetBody: View {
    @Environment(\.widgetFamily) var family
    let entry: RankEntry
    var body: some View {
        let alerts = entry.alerts.filter { $0.type != "LEFT_CHART" }
        if alerts.isEmpty {
            VStack(spacing: 6) {
                Image(systemName: "trophy").font(.system(size: 20, weight: .light)).foregroundStyle(green)
                Text("Aucune alerte de classement").font(MMFont.system(12)).foregroundStyle(MMColor.ink2).multilineTextAlignment(.center)
            }
        } else if family == .accessoryRectangular || family == .accessoryInline {
            let a = alerts[0]
            if family == .accessoryInline { Text("\(a.rank.map { "#\($0)" } ?? "") \(a.cc) · \(a.appName ?? "")") }
            else {
                VStack(alignment: .leading, spacing: 1) {
                    Text(a.title).font(.caption2.weight(.semibold))
                    Text("\(a.rank.map { "#\($0)" } ?? "—") \(flagEmoji(a.cc))").font(.headline.bold())
                    Text(a.appName ?? "").font(.caption2).lineLimit(1)
                }
            }
        } else if family == .systemSmall {
            let a = alerts[0]
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Image(systemName: a.symbol).font(.system(size: 11, weight: .semibold)).foregroundStyle(a.type == "DROP" ? MMColor.red : green)
                        .frame(width: 24, height: 24).background((a.type == "DROP" ? MMColor.red : green).opacity(0.14), in: Circle())
                    Spacer()
                    Text(flagEmoji(a.cc)).font(.system(size: 18))
                }
                Spacer(minLength: 0)
                Text(a.rank.map { "#\($0)" } ?? "—").font(MMFont.number(42)).tracking(-1.2)
                Text(a.title).font(MMFont.system(12, .medium)).lineLimit(1)
                Text("\(a.appName ?? "") · \(a.chartLabel)").font(MMFont.system(10)).foregroundStyle(MMColor.ink3).lineLimit(1)
            }
        } else {
            VStack(alignment: .leading, spacing: 0) {
                MMLabel(text: "Classements App Store").padding(.bottom, 8)
                ForEach(Array(alerts.prefix(family == .systemLarge ? 7 : 3).enumerated()), id: \.element.id) { i, a in
                    if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1) }
                    HStack(spacing: 10) {
                        Text(flagEmoji(a.cc)).font(.system(size: 16))
                        VStack(alignment: .leading, spacing: 1) {
                            Text("\(a.title) · \(a.appName ?? "")").font(MMFont.system(12, .medium)).lineLimit(1)
                            Text(a.chartLabel).font(MMFont.system(10)).foregroundStyle(MMColor.ink3)
                        }
                        Spacer()
                        Text(a.rank.map { "#\($0)" } ?? "—").font(MMFont.number(18, .regular))
                            .foregroundStyle(a.type == "DROP" ? MMColor.red : MMColor.ink)
                    }
                    .padding(.vertical, 6)
                }
                Spacer(minLength: 0)
            }
        }
    }
}

struct MoneyMakerRankingsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "MoneyMakerRankings", provider: RankProvider()) { entry in
            RankWidgetBody(entry: entry)
                .containerBackground(for: .widget) { WidgetBackdrop() }
                .environment(\.colorScheme, .dark)
        }
        .configurationDisplayName("Classements App Store")
        .description("Tes dernières victoires dans les classements, pays par pays.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryInline, .accessoryRectangular])
    }
}

@main
struct MoneyMakerWidgetBundle: WidgetBundle {
    var body: some Widget {
        if #available(iOS 26.0, *) {
            MoneyMakerDashboardWidgetPush()
            MoneyMakerTodayWidgetPush()
            MoneyMakerWidgetPush()
            MoneyMakerFeedWidgetPush()
        }
        MoneyMakerDashboardWidget()
        MoneyMakerTodayWidget()
        MoneyMakerWidget()
        MoneyMakerFeedWidget()
        MoneyMakerRankingsWidget()
        RevenueLiveActivity()
        if #available(iOS 18.0, *) { MoneyMakerTodayControl() }
    }
}
