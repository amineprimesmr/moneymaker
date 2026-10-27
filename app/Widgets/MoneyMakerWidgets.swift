import WidgetKit
import SwiftUI
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
    /// Business seul affiché (nil = tous).
    var projectId: String? = nil

    init?(_ o: Overview?, projectId: String?) {
        guard let o else { return nil }
        if let id = projectId, id != "*", let p = o.projects.first(where: { $0.projectId == id }) {
            name = p.name; currency = p.currency; mrrMicros = p.mrrMicros; revenueMicros = p.netRevenueMicros
            subscribers = p.activeSubscriptions; trials = p.activeTrials; byDay = p.revenueByDay; projects = []; self.projectId = p.projectId
        } else {
            name = String(localized: "Tous les business"); currency = o.currency; mrrMicros = o.mrrMicros; revenueMicros = o.revenueMicros
            subscribers = o.activeSubscriptions; trials = o.activeTrials; byDay = o.revenueByDay; projects = o.projects
        }
    }
}

struct Entry: TimelineEntry {
    let date: Date
    let slice: MRRSlice?
    let goal: Int?
    let signedIn: Bool
    /// Widget réglé sur « Tous » : le bouton « business suivant » choisit la tranche.
    var cyclable = false
    var icons: WIcons = [:]
}

/// Business affiché : celui du réglage, sinon celui choisi par le bouton « suivant ».
private func mrrProject(_ c: MRRWidgetIntent) -> (id: String?, cyclable: Bool) {
    if let id = c.project?.id, id != "*" { return (id, false) }
    return (MMShared.widgetProjectId, true)
}

struct Provider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: .now, slice: MRRSlice(.placeholder, projectId: nil), goal: 6000, signedIn: true) }

    func snapshot(for configuration: MRRWidgetIntent, in context: Context) async -> Entry {
        let o = context.isPreview ? .placeholder : (MoneyMakerClient.cachedOverview ?? .placeholder)
        let p = mrrProject(configuration)
        return Entry(date: .now, slice: MRRSlice(o, projectId: p.id), goal: configuration.goal ?? MMShared.mrrGoal, signedIn: context.isPreview || MoneyMakerClient.stored.token != nil, cyclable: p.cyclable)
    }

    func timeline(for configuration: MRRWidgetIntent, in context: Context) async -> Timeline<Entry> {
        let client = MoneyMakerClient.stored
        let fresh = try? await client.overview(days: 28)
        let p = mrrProject(configuration)
        let o = fresh ?? MoneyMakerClient.cachedOverview
        let slice = MRRSlice(o, projectId: p.id)
        var ids: [String?] = []
        if context.family == .systemMedium || context.family == .systemLarge { ids.append(slice?.projectId) }
        if context.family == .systemLarge { ids += (slice?.projects ?? []).prefix(4).map(\.projectId) }
        let icons = await WIconCache.load(ids, overview: o)
        let next = Date.now.addingTimeInterval(15 * 60)
        let entries = wTimelineDates(until: next).map {
            Entry(date: $0, slice: slice, goal: configuration.goal ?? MMShared.mrrGoal, signedIn: client.token != nil, cyclable: p.cyclable, icons: icons)
        }
        return Timeline(entries: entries, policy: .after(next))
    }
}

struct WidgetBody: View {
    @Environment(\.widgetFamily) var family
    let entry: Entry

    var body: some View {
        if !entry.signedIn {
            SignedOutView()
        } else if let o = entry.slice {
            let pts = dailySeries(o.byDay, days: 28)
            let goalMicros = entry.goal.map { $0 * 1_000_000 }
            let progress = goalMicros.map { Double(o.mrrMicros) / Double(max($0, 1)) }
            let mrr = o.mrrMicros.money(o.currency, compact: true)
            switch family {
            case .accessoryInline:
                Text("MRR \(mrr)")
            case .accessoryCircular:
                Gauge(value: min(1, progress ?? 1)) {
                    Text("MRR")
                } currentValueLabel: {
                    Text(mrr).minimumScaleFactor(0.5)
                }
                .gaugeStyle(.accessoryCircularCapacity)
                .widgetAccentable()
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 1) {
                    Text("MRR").font(.system(size: 10, weight: .semibold)).tracking(1.2).widgetAccentable()
                    Text(mrr).font(.system(size: 19, weight: .medium)).minimumScaleFactor(0.6).lineLimit(1)
                    if let progress { ProgressView(value: min(1, progress)).widgetAccentable() }
                    else { WLine(values: pts.values, lineWidth: 1.4, area: false, endDot: false).frame(height: 12) }
                }
            case .systemSmall:
                VStack(alignment: .leading, spacing: 0) {
                    WValue(text: mrr, size: 32)
                    WLine(values: pts.cumulative, lineWidth: 1.8).padding(.vertical, 6)
                    if let progress, let g = goalMicros {
                        WProgress(value: progress)
                        Text("\(Int(progress * 100)) % de \(g.money(o.currency, compact: true))")
                            .font(MMFont.system(11)).foregroundStyle(MMColor.ink3).padding(.top, 4).lineLimit(1)
                    } else {
                        Text("\(o.subscribers) abonnés").font(MMFont.system(12, .medium)).foregroundStyle(MMColor.ink3)
                    }
                }
            default:
                VStack(alignment: .leading, spacing: 0) {
                    if entry.cyclable {
                        HStack(spacing: 6) {
                            Spacer(minLength: 0)
                            WProjectSwitch(name: o.projects.isEmpty ? o.name : nil, icon: o.projectId.flatMap { entry.icons[$0] })
                        }
                    } else if let id = o.projectId {
                        HStack(spacing: 6) {
                            WBizIcon(data: entry.icons[id], name: o.name, size: 18)
                            WHeader(trailing: entry.date.formatted(date: .omitted, time: .shortened))
                        }
                    } else {
                        WHeader(trailing: entry.date.formatted(date: .omitted, time: .shortened))
                    }
                    HStack(alignment: .bottom, spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            WValue(text: mrr, size: 32)
                            WDelta(value: halfOverHalf(pts))
                        }
                        .fixedSize()
                        WLine(values: pts.cumulative, lineWidth: 1.8)
                    }
                    .padding(.top, 6)
                    .frame(maxHeight: family == .systemLarge ? 110 : .infinity)
                    if let progress, let g = goalMicros {
                        HStack {
                            Text("Objectif \(g.money(o.currency, compact: true))")
                            Spacer()
                            Text("\(Int(progress * 100)) %").foregroundStyle(MMColor.ink2)
                        }
                        .font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                        .padding(.top, 8).padding(.bottom, 4)
                        WProgress(value: progress)
                    }
                    WHairline().padding(.vertical, 8)
                    HStack(alignment: .top) {
                        WStat(label: String(localized: "Revenu 28 j"), value: o.revenueMicros.money(o.currency, compact: true), size: 16)
                        Spacer(minLength: 6)
                        WStat(label: String(localized: "Abonnés"), value: o.subscribers.formatted(), size: 16)
                        Spacer(minLength: 6)
                        WStat(label: String(localized: "Essais"), value: o.trials.formatted(), alignment: .trailing, size: 16)
                    }
                    if family == .systemLarge {
                        VStack(spacing: 0) {
                            ForEach(Array(o.projects.prefix(4).enumerated()), id: \.element.id) { i, p in
                                WHairline()
                                HStack(spacing: 8) {
                                    WBizIcon(data: entry.icons[p.projectId], name: p.name, size: 20)
                                    Text(p.name).font(MMFont.system(14, .medium)).foregroundStyle(MMColor.ink).lineLimit(1)
                                    Spacer()
                                    Text("\(p.activeSubscriptions)").font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                                    Text(p.mrrMicros.money(p.currency, compact: true)).font(MMFont.number(14, .regular)).foregroundStyle(MMColor.ink)
                                        .frame(minWidth: 56, alignment: .trailing)
                                }
                                .padding(.vertical, 7)
                            }
                        }
                        .padding(.top, 10)
                        Spacer(minLength: 0)
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
                .containerBackground(for: .widget) { WidgetBackdrop(date: entry.date) }
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
    static let sample = [RankingAlert(id: "1", type: "TOP_1", appName: String(localized: "Mon app"), appIcon: nil, cc: "FR", chart: "free", scope: "genre", rank: 1, prevRank: 3, own: true, projectName: nil, at: Date().timeIntervalSince1970 * 1000),
                         RankingAlert(id: "2", type: "NEW_COUNTRY", appName: String(localized: "Mon app"), appIcon: nil, cc: "JP", chart: "free", scope: "genre", rank: 18, prevRank: nil, own: true, projectName: nil, at: Date().timeIntervalSince1970 * 1000)]
    func placeholder(in context: Context) -> RankEntry { RankEntry(date: .now, alerts: Self.sample) }
    func getSnapshot(in context: Context, completion: @escaping (RankEntry) -> Void) {
        let cached = MoneyMakerClient.cachedAlerts
        completion(RankEntry(date: .now, alerts: context.isPreview ? Self.sample : cached))
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
            VStack(alignment: .leading, spacing: 6) {
                Spacer(minLength: 0)
                Text("Aucune alerte de classement").font(MMFont.system(13)).foregroundStyle(MMColor.ink2)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else if family == .accessoryRectangular || family == .accessoryInline {
            let a = alerts[0]
            if family == .accessoryInline { Text("\(a.rank.map { "#\($0)" } ?? "") \(a.cc) · \(a.appName ?? "")") }
            else {
                VStack(alignment: .leading, spacing: 1) {
                    Text(a.title.uppercased()).font(.system(size: 10, weight: .semibold)).tracking(1.2).widgetAccentable().lineLimit(1)
                    Text("\(a.rank.map { "#\($0)" } ?? "—") \(flagEmoji(a.cc))").font(.system(size: 19, weight: .medium))
                    Text(a.appName ?? "").font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        } else if family == .systemSmall {
            let a = alerts[0]
            VStack(alignment: .leading, spacing: 0) {
                WHeader(trailing: flagEmoji(a.cc))
                Spacer(minLength: 0)
                WValue(text: a.rank.map { "#\($0)" } ?? "—", size: 44)
                HStack(spacing: 4) {
                    Text(a.title).font(MMFont.system(13, .medium)).foregroundStyle(a.type == "DROP" ? MMColor.red : MMColor.ink).lineLimit(1)
                    if let prev = a.prevRank, let r = a.rank, prev != r {
                        Text(prev > r ? "↑\(prev - r)" : "↓\(r - prev)").font(MMFont.system(11, .medium))
                            .foregroundStyle(prev > r ? WTone.moneyBright : MMColor.red)
                    }
                }
                Text("\(a.appName ?? "") · \(a.chartLabel)").font(MMFont.system(11)).foregroundStyle(MMColor.ink3).lineLimit(1).padding(.top, 2)
            }
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(alerts.prefix(family == .systemLarge ? 8 : 3).enumerated()), id: \.element.id) { i, a in
                    if i > 0 { WHairline() }
                    HStack(spacing: 10) {
                        Text(flagEmoji(a.cc)).font(.system(size: 15))
                        VStack(alignment: .leading, spacing: 1) {
                            Text("\(a.title) · \(a.appName ?? "")").font(MMFont.system(13, .medium)).foregroundStyle(MMColor.ink).lineLimit(1)
                            Text(a.chartLabel).font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
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
                .containerBackground(for: .widget) { WidgetBackdrop(date: entry.date) }
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
            RCOverviewWidgetPush()
            RCMRRWidgetPush()
            RCTransactionsWidgetPush()
            MoneyMakerGlobeWidgetPush()
        }
        MoneyMakerDashboardWidget()
        MoneyMakerTodayWidget()
        MoneyMakerWidget()
        MoneyMakerFeedWidget()
        RCOverviewWidget()
        RCMRRWidget()
        RCTransactionsWidget()
        MoneyMakerGlobeWidget()
        RevenueLiveActivity()
        if #available(iOS 18.0, *) { MoneyMakerTodayControl() }
    }
}
