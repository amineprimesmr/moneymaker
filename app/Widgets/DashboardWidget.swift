//
//  DashboardWidget.swift
//  MoneyMaker — « Tableau de bord » : l'équivalent du widget RevenueCat, en mieux.
//
//  Ne montre que ce qui a du sens pour TON offre :
//    • essais gratuits seulement si l'offre en a (ou en a eu récemment) ;
//    • téléchargements seulement si Apple nous les fournit (numéro de fournisseur) ;
//    • toujours : MRR, revenu 30 j, utilisateurs payants, dernière vente (montant, pays, il y a…).
//  La courbe des 30 derniers jours occupe le bas, à fond perdu, comme sur RevenueCat.
//

import WidgetKit
import SwiftUI
import Charts

struct DashEntry: TimelineEntry {
    let date: Date
    let overview: Overview?
    let last: FeedEvent?
    let signedIn: Bool
}

struct DashProvider: TimelineProvider {
    func placeholder(in context: Context) -> DashEntry {
        DashEntry(date: .now, overview: .placeholderDashboard, last: FeedEvent.samples.first, signedIn: true)
    }
    func getSnapshot(in context: Context, completion: @escaping (DashEntry) -> Void) {
        completion(DashEntry(date: .now, overview: context.isPreview ? .placeholderDashboard : (MoneyMakerClient.cachedOverview ?? .placeholderDashboard),
                             last: MMShared.cachedFeed.first(where: \.isRevenue) ?? FeedEvent.samples.first, signedIn: true))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<DashEntry>) -> Void) {
        Task {
            let client = MoneyMakerClient.stored
            async let o = try? client.overview(days: 30)
            async let f = try? client.feed(limit: 10)
            let (overview, feed) = await (o, f)
            let last = (feed ?? MMShared.cachedFeed).first(where: \.isRevenue)
            completion(Timeline(entries: [DashEntry(date: .now, overview: overview ?? MoneyMakerClient.cachedOverview, last: last, signedIn: client.token != nil)],
                                policy: .after(.now.addingTimeInterval(15 * 60))))
        }
    }
}

extension Overview {
    static let placeholderDashboard = Overview(currency: "EUR", periodDays: 30, mrrMicros: 161_000_000, revenueMicros: 2_614_000_000,
        activeSubscriptions: 19, activeTrials: 0, newCustomers: 844, projects: [], generatedAt: Date().timeIntervalSince1970 * 1000,
        payingCustomers: 41, downloads: 906, hasTrials: false)
}

// MARK: - Tuiles

private struct DashTile: Identifiable {
    let id: String
    let icon: String
    let label: String
    let value: String
    var sub: String? = nil
    let tint: Color
    var highlighted = false
}

private let violet = MMColor.hex(0x9B7BFF)

private func tiles(_ o: Overview, last: FeedEvent?, max: Int) -> [DashTile] {
    var t: [DashTile] = [
        DashTile(id: "mrr", icon: "arrow.triangle.2.circlepath", label: "MRR", value: o.mrrMicros.money(o.currency, compact: true), tint: MMColor.accent),
        DashTile(id: "rev", icon: "eurosign", label: "Revenu 30 j", value: o.revenueMicros.money(o.currency, compact: true), tint: MMColor.accent, highlighted: true),
        DashTile(id: "pay", icon: "creditcard", label: "Users payants", value: (o.payingCustomers ?? o.activeSubscriptions).formatted(), tint: MMColor.blue),
    ]
    if let dl = o.downloads { t.append(DashTile(id: "dl", icon: "arrow.down.app", label: "Téléchargements", value: dl.formatted(), tint: violet)) }
    if o.hasTrials ?? (o.activeTrials > 0) { t.append(DashTile(id: "trial", icon: "hourglass", label: "Essais", value: o.activeTrials.formatted(), tint: MMColor.orange)) }
    if t.count < max - 1 { t.append(DashTile(id: "subs", icon: "person.2", label: "Abonnés actifs", value: o.activeSubscriptions.formatted(), tint: MMColor.blue)) }
    if t.count < max - 1 { t.append(DashTile(id: "new", icon: "sparkle", label: "Nouveaux clients", value: o.newCustomers.formatted(), tint: violet)) }
    if let l = last, let a = l.amountText {
        t = Array(t.prefix(max - 1))
        t.append(DashTile(id: "last", icon: "bolt.fill", label: "Dernière vente", value: a,
                          sub: [l.country.map { flagEmoji($0) }, l.date.formatted(.relative(presentation: .numeric, unitsStyle: .narrow))].compactMap { $0 }.joined(separator: " "),
                          tint: MMColor.accent))
    }
    return Array(t.prefix(max))
}

private struct TileView: View {
    let tile: DashTile
    var compact = false
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: compact ? 14 : 18, style: .continuous)
        VStack(alignment: .leading, spacing: compact ? 2 : 4) {
            HStack(spacing: 5) {
                Image(systemName: tile.icon).font(.system(size: compact ? 9 : 11, weight: .semibold))
                Text(tile.label).font(MMFont.system(compact ? 11 : 13, .medium)).lineLimit(1).minimumScaleFactor(0.8)
            }
            .foregroundStyle(tile.tint)
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(tile.value).font(MMFont.number(compact ? 20 : 26, .regular)).tracking(-0.6).foregroundStyle(.white)
                    .lineLimit(1).minimumScaleFactor(0.55)
                if let sub = tile.sub { Text(sub).font(MMFont.system(10)).foregroundStyle(MMColor.ink3).lineLimit(1) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, compact ? 10 : 13).padding(.vertical, compact ? 8 : 11)
        .background(shape.fill(tile.tint.opacity(0.13)))
        .overlay(shape.strokeBorder(tile.highlighted ? tile.tint.opacity(0.85) : Color.white.opacity(0.05), lineWidth: tile.highlighted ? 1.5 : 1))
    }
}

// MARK: - Vue

struct DashboardWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: DashEntry

    var body: some View {
        if !entry.signedIn { SignedOutView().padding() } else if let o = entry.overview {
            let pts = dailySeries(o.revenueByDay, days: 30)
            switch family {
            case .systemSmall:
                VStack(alignment: .leading, spacing: 6) {
                    TileView(tile: tiles(o, last: nil, max: 1)[0], compact: true)
                    if let l = entry.last, let a = l.amountText {
                        HStack(spacing: 4) {
                            Image(systemName: "bolt.fill").font(.system(size: 9)).foregroundStyle(MMColor.accent)
                            Text(a).font(MMFont.number(13, .regular))
                            Text(l.country.map { flagEmoji($0) } ?? "")
                            Spacer(minLength: 0)
                            Text(l.date, style: .relative).font(MMFont.system(9)).foregroundStyle(MMColor.ink3).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(12)
                .background(alignment: .bottom) { BleedChart(points: pts).frame(height: 56) }
            case .systemMedium:
                let t = tiles(o, last: entry.last, max: 4)
                Grid(horizontalSpacing: 8, verticalSpacing: 8) {
                    GridRow { TileView(tile: t[0], compact: true); TileView(tile: t[1], compact: true) }
                    if t.count > 2 { GridRow { TileView(tile: t[2], compact: true); if t.count > 3 { TileView(tile: t[3], compact: true) } else { Color.clear } } }
                }
                .padding(12)
                .frame(maxHeight: .infinity, alignment: .top)
                .background(alignment: .bottom) { BleedChart(points: pts).frame(height: 44).opacity(0.7) }
            default:
                let t = tiles(o, last: entry.last, max: 6)
                VStack(spacing: 0) {
                    Grid(horizontalSpacing: 10, verticalSpacing: 10) {
                        ForEach(0..<Int((Double(t.count) / 2).rounded(.up)), id: \.self) { r in
                            GridRow {
                                TileView(tile: t[r * 2])
                                if r * 2 + 1 < t.count { TileView(tile: t[r * 2 + 1]) } else { Color.clear }
                            }
                        }
                    }
                    .padding(16)
                    Spacer(minLength: 0)
                    BleedChart(points: pts).frame(height: 120)
                }
            }
        } else {
            Text("—").foregroundStyle(MMColor.ink3)
        }
    }
}

/// Courbe à fond perdu : aire en dégradé + ligne lumineuse, sans axes.
private struct BleedChart: View {
    let points: [MMPoint]
    var body: some View {
        let maxV = max(points.map(\.value).max() ?? 1, 0.0001)
        Chart(points) { p in
            AreaMark(x: .value("j", p.date), y: .value("v", p.value))
                .interpolationMethod(.monotone)
                .foregroundStyle(LinearGradient(colors: [MMColor.accent.opacity(0.45), MMColor.accent.opacity(0.04)], startPoint: .top, endPoint: .bottom))
            LineMark(x: .value("j", p.date), y: .value("v", p.value))
                .interpolationMethod(.monotone)
                .lineStyle(StrokeStyle(lineWidth: 1.8, lineCap: .round))
                .foregroundStyle(MMColor.accent)
        }
        .chartYScale(domain: 0...maxV * 1.1)
        .chartXAxis(.hidden).chartYAxis(.hidden).chartLegend(.hidden)
        .chartPlotStyle { $0.frame(maxWidth: .infinity, maxHeight: .infinity) }
    }
}

struct MoneyMakerDashboardWidget: Widget {
    static let families: [WidgetFamily] = [.systemSmall, .systemMedium, .systemLarge]
    var body: some WidgetConfiguration { Self.configuration(kind: WidgetPushGate.kind("MoneyMakerDashboard"), families: WidgetPushGate.legacy(Self.families)) }
    static func configuration(kind: String, families: [WidgetFamily]) -> some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: DashProvider()) { entry in
            DashboardWidgetView(entry: entry)
                .containerBackground(for: .widget) { WidgetBackdrop() }
                .environment(\.colorScheme, .dark)
                .widgetURL(URL(string: "moneymaker://overview"))
        }
        .configurationDisplayName("Tableau de bord")
        .description("MRR, revenu, utilisateurs payants, téléchargements et dernière vente — seulement ce qui compte pour ton offre.")
        .supportedFamilies(families)
        .contentMarginsDisabled()
    }
}

@available(iOS 26.0, *)
struct MoneyMakerDashboardWidgetPush: Widget {
    var body: some WidgetConfiguration {
        MoneyMakerDashboardWidget.configuration(kind: "MoneyMakerDashboard", families: MoneyMakerDashboardWidget.families).pushHandler(MMWidgetPushHandler.self)
    }
}
