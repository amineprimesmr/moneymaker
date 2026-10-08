import WidgetKit
import SwiftUI
import Charts

struct Entry: TimelineEntry {
    let date: Date
    let overview: Overview?
    let signedIn: Bool
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: .now, overview: .placeholder, signedIn: true) }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(Entry(date: .now, overview: MoneyMakerClient.cachedOverview ?? .placeholder, signedIn: true))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        Task {
            let client = MoneyMakerClient.stored
            let fresh = try? await client.overview(days: 30)
            let entry = Entry(date: .now, overview: fresh ?? MoneyMakerClient.cachedOverview, signedIn: client.token != nil)
            completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60))))
        }
    }
}

private let green = Color(red: 0, green: 0.82, blue: 0.52)
private let blue = Color(red: 0, green: 0.58, blue: 0.91)

struct WidgetBody: View {
    @Environment(\.widgetFamily) var family
    let entry: Entry

    var body: some View {
        if !entry.signedIn {
            VStack(spacing: 6) {
                Image(systemName: "dollarsign.circle.fill").font(.title).foregroundStyle(green)
                Text("Ouvre MoneyMaker pour te connecter").font(.caption).multilineTextAlignment(.center)
            }
        } else if let o = entry.overview {
            switch family {
            case .accessoryInline:
                Text("MRR \(o.mrrMicros.money(o.currency, compact: true))")
            case .accessoryCircular:
                VStack(spacing: 0) {
                    Image(systemName: "dollarsign").font(.caption.bold())
                    Text(o.mrrMicros.money(o.currency, compact: true)).font(.system(size: 11, weight: .bold)).minimumScaleFactor(0.5)
                }
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 1) {
                    Text("MRR").font(.caption2.weight(.semibold))
                    Text(o.mrrMicros.money(o.currency, compact: true)).font(.headline.bold())
                    Text("\(o.activeSubscriptions) abonnés · \(o.activeTrials) essais").font(.caption2)
                }
            case .systemSmall:
                VStack(alignment: .leading, spacing: 4) {
                    Label("MRR", systemImage: "dollarsign.circle.fill").font(.caption.weight(.semibold)).foregroundStyle(green)
                    Spacer(minLength: 0)
                    Text(o.mrrMicros.money(o.currency, compact: true)).font(.system(size: 30, weight: .bold, design: .rounded))
                        .minimumScaleFactor(0.5).lineLimit(1)
                    Text("\(o.activeSubscriptions) abonnés").font(.caption).foregroundStyle(.secondary)
                    Text("30 j : \(o.revenueMicros.money(o.currency, compact: true))").font(.caption2).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            default:
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("MRR").font(.caption.weight(.semibold)).foregroundStyle(green)
                            Text(o.mrrMicros.money(o.currency, compact: true)).font(.system(size: 30, weight: .bold, design: .rounded)).minimumScaleFactor(0.6)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text("30 j").font(.caption2).foregroundStyle(.secondary)
                            Text(o.revenueMicros.money(o.currency, compact: true)).font(.headline.monospacedDigit())
                            Text("\(o.activeSubscriptions) abonnés · \(o.activeTrials) essais").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    Chart(o.dailyRevenue(days: family == .systemLarge ? 30 : 14), id: \.date) { p in
                        BarMark(x: .value("Jour", p.date, unit: .day), y: .value("€", Double(p.micros) / 1e6)).foregroundStyle(blue).cornerRadius(2)
                    }
                    .chartXAxis(.hidden).chartYAxis(.hidden)
                    if family == .systemLarge {
                        ForEach(o.projects.prefix(5)) { p in
                            HStack {
                                Text(p.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                                Spacer()
                                Text("\(p.activeSubscriptions)").font(.caption).foregroundStyle(.secondary)
                                Text(p.mrrMicros.money(p.currency, compact: true)).font(.subheadline.monospacedDigit()).foregroundStyle(green)
                            }
                        }
                    }
                }
            }
        } else {
            Text("—")
        }
    }
}

struct MoneyMakerWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "MoneyMakerOverview", provider: Provider()) { entry in
            WidgetBody(entry: entry)
                .containerBackground(for: .widget) { Color(red: 0.03, green: 0.04, blue: 0.05) }
                .environment(\.colorScheme, .dark)
                .widgetURL(URL(string: "moneymaker://overview"))
        }
        .configurationDisplayName("MoneyMaker")
        .description("MRR, revenus et abonnés de tous tes business.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryInline, .accessoryCircular, .accessoryRectangular])
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
                Image(systemName: "trophy.fill").font(.title2).foregroundStyle(green)
                Text("Aucune alerte de classement").font(.caption).multilineTextAlignment(.center)
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
                Label(a.title, systemImage: a.symbol).font(.caption.weight(.semibold)).foregroundStyle(green).lineLimit(1)
                Spacer(minLength: 0)
                Text(a.rank.map { "#\($0)" } ?? "—").font(.system(size: 40, weight: .heavy, design: .rounded))
                Text("\(flagEmoji(a.cc)) \(a.chartLabel)").font(.caption).lineLimit(1)
                Text(a.appName ?? "").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Label("Classements App Store", systemImage: "trophy.fill").font(.caption.weight(.semibold)).foregroundStyle(green)
                ForEach(alerts.prefix(family == .systemLarge ? 7 : 3)) { a in
                    HStack {
                        Text(flagEmoji(a.cc))
                        VStack(alignment: .leading, spacing: 0) {
                            Text("\(a.title) · \(a.appName ?? "")").font(.caption.weight(.semibold)).lineLimit(1)
                            Text(a.chartLabel).font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(a.rank.map { "#\($0)" } ?? "—").font(.headline.monospacedDigit()).foregroundStyle(a.type == "DROP" ? .red : green)
                    }
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
                .containerBackground(for: .widget) { Color(red: 0.03, green: 0.04, blue: 0.05) }
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
        MoneyMakerWidget()
        MoneyMakerRankingsWidget()
    }
}
