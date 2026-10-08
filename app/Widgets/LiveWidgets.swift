//
//  LiveWidgets.swift
//  MoneyMaker — widgets temps réel : Aujourd'hui, Flux des ventes,
//  Live Activity + Dynamic Island, bouton du Centre de contrôle, push WidgetKit.
//
//  Fraîcheur : chaque vente déclenche côté serveur un push WidgetKit (iOS 26)
//  ou un push silencieux (iOS 17–18) → rechargement immédiat des timelines.
//  La timeline se rafraîchit aussi d'elle-même toutes les 15 min. Si le réseau
//  manque, on affiche le dernier cache du trousseau : jamais d'écran vide.
//

import WidgetKit
import SwiftUI
import Charts
import ActivityKit
import AppIntents

// MARK: - Push WidgetKit (iOS 26)

@available(iOS 26.0, *)
struct MMWidgetPushHandler: WidgetPushHandler {
    func pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
        let token = pushInfo.token.hex
        Task { try? await MoneyMakerClient.stored.registerDevice(["widgetPushToken": widgets.isEmpty ? NSNull() : token]) }
    }
}

// MARK: - Aujourd'hui

struct TodayEntry: TimelineEntry {
    let date: Date
    let today: Today?
    let signedIn: Bool
}

struct TodayProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayEntry { TodayEntry(date: .now, today: .placeholder, signedIn: true) }
    func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
        completion(TodayEntry(date: .now, today: context.isPreview ? .placeholder : (MMShared.cachedToday ?? .placeholder), signedIn: true))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
        Task {
            let client = MoneyMakerClient.stored
            let fresh = try? await client.today()
            let t = fresh ?? MMShared.cachedToday
            // Rafraîchissement à minuit pile pour repartir de zéro, sinon toutes les 15 min.
            let midnight = Calendar.current.startOfDay(for: .now.addingTimeInterval(86400))
            let next = min(midnight, .now.addingTimeInterval(15 * 60))
            completion(Timeline(entries: [TodayEntry(date: .now, today: t, signedIn: client.token != nil)], policy: .after(next)))
        }
    }
}

private func todayPoints(_ t: Today) -> [MMPoint] {
    let start = Date(timeIntervalSince1970: t.dayStart / 1000)
    let hour = max(1, min(24, Int(Date().timeIntervalSince(start) / 3600) + 1))
    return t.hourly.prefix(hour).enumerated().map { MMPoint(date: start.addingTimeInterval(Double($0.offset) * 3600), value: Double($0.element) / 1e6) }
}

struct TodayWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: TodayEntry

    var body: some View {
        if !entry.signedIn {
            SignedOutView()
        } else if let t = entry.today {
            switch family {
            case .accessoryInline:
                Text("Aujourd'hui \(t.netMicros.money(t.currency, compact: true)) · \(t.transactions) ventes")
            case .accessoryCircular:
                VStack(spacing: 0) {
                    Image(systemName: "dollarsign").font(.system(size: 10, weight: .bold)).widgetAccentable()
                    Text(t.netMicros.money(t.currency, compact: true)).font(.system(size: 13, weight: .semibold)).minimumScaleFactor(0.5).lineLimit(1)
                    Text("\(t.transactions)").font(.system(size: 9)).foregroundStyle(.secondary)
                }
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 1) {
                    Text("AUJOURD'HUI").font(.system(size: 10, weight: .semibold)).widgetAccentable()
                    Text(t.netMicros.money(t.currency)).font(.system(size: 18, weight: .semibold)).minimumScaleFactor(0.6).lineLimit(1)
                    Text("\(t.transactions) ventes · \(t.trials) essais").font(.system(size: 11)).foregroundStyle(.secondary)
                }
            case .systemSmall:
                VStack(alignment: .leading, spacing: 4) {
                    MMLabel(text: "Aujourd'hui")
                    Text(t.netMicros.money(t.currency, compact: true)).font(MMFont.number(30)).tracking(-0.8)
                        .minimumScaleFactor(0.5).lineLimit(1).contentTransition(.numericText(value: Double(t.netMicros)))
                    MMGlowChart(points: todayPoints(t), lineWidth: 1.8)
                    HStack(spacing: 8) {
                        Label("\(t.transactions)", systemImage: "arrow.up.right")
                        Label("\(t.trials)", systemImage: "sparkles")
                    }
                    .font(MMFont.system(11)).foregroundStyle(MMColor.ink3).labelStyle(.titleAndIcon)
                }
            default:
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            MMLabel(text: "Aujourd'hui")
                            Text(t.netMicros.money(t.currency)).font(MMFont.number(32)).tracking(-0.9).minimumScaleFactor(0.6).lineLimit(1)
                                .contentTransition(.numericText(value: Double(t.netMicros)))
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 3) {
                            StatLine(value: "\(t.sales)", label: "ventes")
                            StatLine(value: "\(t.renewals)", label: "renouv.")
                            StatLine(value: "\(t.trials)", label: "essais")
                        }
                    }
                    MMGlowChart(points: todayPoints(t))
                    if let l = t.last {
                        HStack(spacing: 6) {
                            Circle().fill(MMColor.accent).frame(width: 5, height: 5).shadow(color: MMColor.accent, radius: 3)
                            Text("Dernière : +\(l.amountMicros.money(l.currency)) · \(l.projectName)").lineLimit(1)
                            Spacer(minLength: 4)
                            Text(Date(timeIntervalSince1970: l.at / 1000), style: .relative).monospacedDigit()
                        }
                        .font(MMFont.system(11)).foregroundStyle(MMColor.ink2)
                    }
                }
            }
        } else {
            Text("—").foregroundStyle(MMColor.ink3)
        }
    }
}

private struct StatLine: View {
    let value: String, label: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(value).font(MMFont.number(14, .regular))
            Text(label).font(MMFont.system(10)).foregroundStyle(MMColor.ink3)
        }
    }
}

struct SignedOutView: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "dollarsign").font(.system(size: 18, weight: .bold)).foregroundStyle(.black)
                .frame(width: 36, height: 36).background(MMColor.accent, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            Text("Ouvre MoneyMaker pour te connecter").font(MMFont.system(12)).foregroundStyle(MMColor.ink2).multilineTextAlignment(.center)
        }
    }
}

struct MoneyMakerTodayWidget: Widget {
    static let families: [WidgetFamily] = [.systemSmall, .systemMedium, .accessoryInline, .accessoryCircular, .accessoryRectangular]
    var body: some WidgetConfiguration { Self.configuration(kind: WidgetPushGate.kind("MoneyMakerToday"), families: WidgetPushGate.legacy(Self.families)) }
    static func configuration(kind: String, families: [WidgetFamily]) -> some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: TodayProvider()) { entry in
            TodayWidgetView(entry: entry)
                .containerBackground(for: .widget) { WidgetBackdrop() }
                .environment(\.colorScheme, .dark)
                .widgetURL(URL(string: "moneymaker://today"))
        }
        .configurationDisplayName("Aujourd'hui")
        .description("Revenus du jour en direct, mis à jour à chaque vente.")
        .supportedFamilies(families)
    }
}

// MARK: - Flux des ventes

struct FeedEntry: TimelineEntry {
    let date: Date
    let events: [FeedEvent]
    let today: Today?
    let signedIn: Bool
}

struct FeedProvider: TimelineProvider {
    func placeholder(in context: Context) -> FeedEntry { FeedEntry(date: .now, events: FeedEvent.samples, today: .placeholder, signedIn: true) }
    func getSnapshot(in context: Context, completion: @escaping (FeedEntry) -> Void) {
        let cached = MMShared.cachedFeed
        completion(FeedEntry(date: .now, events: context.isPreview || cached.isEmpty ? FeedEvent.samples : cached, today: MMShared.cachedToday ?? .placeholder, signedIn: true))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<FeedEntry>) -> Void) {
        Task {
            let client = MoneyMakerClient.stored
            async let f = try? client.feed(limit: 12)
            async let t = try? client.today()
            let (events, today) = await (f, t)
            completion(Timeline(entries: [FeedEntry(date: .now, events: events ?? MMShared.cachedFeed, today: today ?? MMShared.cachedToday, signedIn: client.token != nil)],
                                policy: .after(.now.addingTimeInterval(15 * 60))))
        }
    }
}

struct FeedWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: FeedEntry

    var body: some View {
        if !entry.signedIn { SignedOutView() } else {
            let rows = Array(entry.events.prefix(family == .systemLarge ? 7 : 3))
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    MMLabel(text: "Ventes en direct")
                    if let t = entry.today {
                        Text(t.netMicros.money(t.currency, compact: true)).font(MMFont.number(13, .regular)).foregroundStyle(MMColor.accent)
                    }
                }
                .padding(.bottom, 6)
                if rows.isEmpty {
                    Spacer()
                    Text("Ta prochaine vente apparaîtra ici.").font(MMFont.system(12)).foregroundStyle(MMColor.ink3).frame(maxWidth: .infinity)
                    Spacer()
                } else {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, e in
                        if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1) }
                        FeedRow(e: e).padding(.vertical, family == .systemLarge ? 7 : 5)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }
}

struct FeedRow: View {
    let e: FeedEvent
    var body: some View {
        let tint = e.type == "REFUND" || e.type == "BILLING_ISSUE" ? MMColor.red : e.isRevenue ? MMColor.accent : MMColor.blue
        HStack(spacing: 10) {
            Image(systemName: e.symbol).font(.system(size: 10, weight: .bold)).foregroundStyle(tint)
                .frame(width: 22, height: 22).background(tint.opacity(0.14), in: Circle())
            VStack(alignment: .leading, spacing: 1) {
                Text(e.title).font(MMFont.system(12, .medium)).lineLimit(1)
                Text([e.projectName, e.country.map { "\(flagEmoji($0)) \($0)" }].compactMap { $0 }.joined(separator: " · "))
                    .font(MMFont.system(10)).foregroundStyle(MMColor.ink3).lineLimit(1)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 1) {
                if let a = e.amountText { Text(a).font(MMFont.number(13, .regular)).foregroundStyle(e.type == "REFUND" ? MMColor.red : MMColor.ink) }
                Text(e.date, style: .relative).font(MMFont.system(10)).foregroundStyle(MMColor.ink3).monospacedDigit().lineLimit(1)
            }
        }
    }
}

struct MoneyMakerFeedWidget: Widget {
    static let families: [WidgetFamily] = [.systemMedium, .systemLarge]
    var body: some WidgetConfiguration { Self.configuration(kind: WidgetPushGate.kind("MoneyMakerFeed"), families: WidgetPushGate.legacy(Self.families)) }
    static func configuration(kind: String, families: [WidgetFamily]) -> some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: FeedProvider()) { entry in
            FeedWidgetView(entry: entry)
                .containerBackground(for: .widget) { WidgetBackdrop() }
                .environment(\.colorScheme, .dark)
                .widgetURL(URL(string: "moneymaker://feed"))
        }
        .configurationDisplayName("Ventes en direct")
        .description("Chaque vente, essai et remboursement, dès qu'il arrive.")
        .supportedFamilies(families)
    }
}

// MARK: - Live Activity + Dynamic Island

struct RevenueLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RevenueActivityAttributes.self) { context in
            LiveLockScreen(state: context.state)
                .activityBackgroundTint(Color.black.opacity(0.82))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "moneymaker://today"))
        } dynamicIsland: { context in
            let s = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("AUJOURD'HUI").font(MMFont.system(10, .medium)).tracking(1.6).foregroundStyle(MMColor.ink3)
                        Text(s.revenueMicros.money(s.currency)).font(MMFont.number(24)).tracking(-0.6).foregroundStyle(.white)
                            .contentTransition(.numericText(value: Double(s.revenueMicros))).minimumScaleFactor(0.6).lineLimit(1)
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("\(s.sales)").font(MMFont.number(24)).foregroundStyle(MMColor.accent).contentTransition(.numericText(value: Double(s.sales)))
                        Text("ventes").font(MMFont.system(10)).foregroundStyle(MMColor.ink3)
                    }
                    .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 6) {
                        LiveCurve(values: s.hourly).frame(height: 34)
                        if let p = s.lastProject, s.lastAmountMicros > 0 {
                            HStack {
                                Text("Dernière vente · \(p)").lineLimit(1)
                                Spacer()
                                Text("+\(s.lastAmountMicros.money(s.lastCurrency))").foregroundStyle(MMColor.accent)
                            }
                            .font(MMFont.system(11)).foregroundStyle(MMColor.ink2)
                        }
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                Image(systemName: "dollarsign.circle.fill").foregroundStyle(MMColor.accent)
            } compactTrailing: {
                Text(s.revenueMicros.money(s.currency, compact: true)).font(.system(size: 13, weight: .semibold)).monospacedDigit()
                    .foregroundStyle(MMColor.accent).contentTransition(.numericText(value: Double(s.revenueMicros)))
                    .frame(maxWidth: 70)
            } minimal: {
                Image(systemName: "dollarsign").font(.system(size: 12, weight: .bold)).foregroundStyle(MMColor.accent)
            }
            .keylineTint(MMColor.accent)
            .widgetURL(URL(string: "moneymaker://today"))
        }
    }
}

struct LiveLockScreen: View {
    let state: RevenueActivityAttributes.ContentState
    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Circle().fill(MMColor.accent).frame(width: 6, height: 6).shadow(color: MMColor.accent, radius: 4)
                    Text("REVENUS DU JOUR").font(MMFont.system(10, .medium)).tracking(1.8).foregroundStyle(MMColor.ink3)
                }
                Text(state.revenueMicros.money(state.currency)).font(MMFont.number(34)).tracking(-1).foregroundStyle(.white)
                    .contentTransition(.numericText(value: Double(state.revenueMicros))).minimumScaleFactor(0.6).lineLimit(1)
                Text("\(state.sales) ventes · \(state.trials) essais").font(MMFont.system(12)).foregroundStyle(MMColor.ink2)
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 6) {
                LiveCurve(values: state.hourly).frame(width: 120, height: 44)
                if let p = state.lastProject, state.lastAmountMicros > 0 {
                    Text("+\(state.lastAmountMicros.money(state.lastCurrency)) · \(p)").font(MMFont.system(11)).foregroundStyle(MMColor.accent).lineLimit(1)
                }
            }
        }
        .padding(18)
    }
}

/// Courbe cumulée de la journée, jusqu'à l'heure courante (pas de Charts : léger et sûr en Live Activity).
struct LiveCurve: View {
    let values: [Double]
    var body: some View {
        let hour = min(values.count, max(2, Calendar.current.component(.hour, from: .now) + 1))
        let v = Array(values.prefix(hour))
        let maxV = max(v.max() ?? 1, 0.0001)
        GeometryReader { g in
            let pts = v.enumerated().map { CGPoint(x: g.size.width * CGFloat($0.offset) / CGFloat(max(v.count - 1, 1)), y: g.size.height * (1 - CGFloat($0.element / maxV) * 0.9)) }
            ZStack {
                Path { p in
                    guard let f = pts.first else { return }
                    p.move(to: CGPoint(x: f.x, y: g.size.height)); pts.forEach { p.addLine(to: $0) }; p.addLine(to: CGPoint(x: pts.last!.x, y: g.size.height))
                }
                .fill(LinearGradient(colors: [MMColor.accent.opacity(0.3), .clear], startPoint: .top, endPoint: .bottom))
                Path { p in p.addLines(pts) }
                    .stroke(MMColor.chartGradient, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    .shadow(color: MMColor.accent.opacity(0.6), radius: 4)
            }
        }
    }
}

// MARK: - Centre de contrôle (iOS 18)

@available(iOS 18.0, *)
struct MoneyMakerTodayControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "MoneyMakerTodayControl") {
            ControlWidgetButton(action: OpenURLIntent(URL(string: "moneymaker://today")!)) {
                Label("Revenus du jour", systemImage: "dollarsign.circle.fill")
            }
        }
        .displayName("Revenus du jour")
        .description("Ouvre tes revenus du jour en un geste.")
    }
}

/// Sous iOS 26 les variantes « Push » portent les vrais identifiants ; les variantes classiques
/// passent sur un identifiant secondaire sans aucune taille, donc invisibles dans la galerie.
enum WidgetPushGate {
    static var active: Bool { if #available(iOS 26.0, *) { return true } else { return false } }
    static func kind(_ k: String) -> String { active ? "\(k).legacy" : k }
    static func legacy(_ f: [WidgetFamily]) -> [WidgetFamily] { active ? [] : f }
}

// MARK: - Variantes iOS 26 : mêmes widgets + push WidgetKit (rechargement instantané)

@available(iOS 26.0, *)
struct MoneyMakerTodayWidgetPush: Widget {
    var body: some WidgetConfiguration { MoneyMakerTodayWidget.configuration(kind: "MoneyMakerToday", families: MoneyMakerTodayWidget.families).pushHandler(MMWidgetPushHandler.self) }
}

@available(iOS 26.0, *)
struct MoneyMakerFeedWidgetPush: Widget {
    var body: some WidgetConfiguration { MoneyMakerFeedWidget.configuration(kind: "MoneyMakerFeed", families: MoneyMakerFeedWidget.families).pushHandler(MMWidgetPushHandler.self) }
}

@available(iOS 26.0, *)
struct MoneyMakerWidgetPush: Widget {
    var body: some WidgetConfiguration { MoneyMakerWidget.configuration(kind: "MoneyMakerOverview", families: MoneyMakerWidget.families).pushHandler(MMWidgetPushHandler.self) }
}
