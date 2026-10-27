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
    var record: MMRecord? = nil
    var goalMicros: Int? = nil
    var liveOn = false
    var icons: WIcons = [:]
    var lastProjectId: String? = nil

    init(date: Date, today: Today?, signedIn: Bool, history: MMHistory? = nil) {
        self.date = date; self.today = today; self.signedIn = signedIn
        record = MMRecord(today: today, history: history)
        goalMicros = MMShared.dailyGoalMicros(history)
        liveOn = MMShared.liveRunning
    }

    var goalProgress: Double? {
        guard let g = goalMicros, g > 0, let t = today else { return nil }
        return Double(t.netMicros) / Double(g)
    }
}

struct TodayProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayEntry { TodayEntry(date: .now, today: .placeholder, signedIn: true, history: .placeholder) }
    func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
        completion(TodayEntry(date: .now, today: context.isPreview ? .placeholder : (MMShared.cachedToday ?? .placeholder), signedIn: context.isPreview || MoneyMakerClient.stored.token != nil,
                              history: context.isPreview ? .placeholder : MMShared.history))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
        Task {
            let client = MoneyMakerClient.stored
            async let f = try? client.today()
            async let h = client.history()
            let (fresh, history) = await (f, h)
            let t = fresh ?? MMShared.cachedToday
            // Rafraîchissement à minuit pile pour repartir de zéro, sinon toutes les 15 min.
            let midnight = Calendar.current.startOfDay(for: .now.addingTimeInterval(86400))
            let next = min(midnight, .now.addingTimeInterval(15 * 60))
            let o = MoneyMakerClient.cachedOverview
            let pid = o?.projectId(named: t?.last?.projectName)
            let icons = context.family == .systemMedium ? await WIconCache.load([pid], overview: o) : [:]
            let entries = wTimelineDates(until: next).map { d -> TodayEntry in
                var e = TodayEntry(date: d, today: t, signedIn: client.token != nil, history: history)
                e.icons = icons; e.lastProjectId = pid
                return e
            }
            completion(Timeline(entries: entries, policy: .after(next)))
        }
    }
}

/// Bouton du direct (Live Activity) : lance ou arrête, exécuté par l'app.
struct WLiveToggle: View {
    let on: Bool
    var body: some View {
        Button(intent: ToggleLiveActivityIntent()) {
            WIconButtonLabel(symbol: on ? "stop.fill" : "dot.radiowaves.left.and.right", on: on)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(on ? Text("Arrêter le direct") : Text("Lancer le direct"))
    }
}

struct TodayWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: TodayEntry

    private var isRecord: Bool { entry.record?.isRecord == true }

    var body: some View {
        if !entry.signedIn {
            SignedOutView()
        } else if let t = entry.today {
            let net = t.netMicros.money(t.currency, compact: true)
            let curve = todayValues(t, now: entry.date)
            switch family {
            case .accessoryInline:
                Text(isRecord ? "🏆 \(net) · record" : "Aujourd'hui \(net) · \(t.transactions) ventes")
            case .accessoryCircular:
                if let p = entry.goalProgress {
                    Gauge(value: min(1, p)) { Text("Jour") } currentValueLabel: { Text(net).minimumScaleFactor(0.5) }
                        .gaugeStyle(.accessoryCircularCapacity)
                        .widgetAccentable()
                } else {
                    VStack(spacing: 0) {
                        Text(net).font(.system(size: 14, weight: .medium)).minimumScaleFactor(0.5).lineLimit(1)
                        Text("\(t.transactions)").font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                    .padding(4)
                    .background(AccessoryWidgetBackground().clipShape(Circle()))
                    .widgetAccentable()
                }
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 1) {
                    Image(systemName: isRecord ? "trophy.fill" : "sun.max.fill").font(.system(size: 11, weight: .semibold)).widgetAccentable()
                    Text(t.netMicros.money(t.currency)).font(.system(size: 19, weight: .medium)).minimumScaleFactor(0.6).lineLimit(1)
                    HStack(spacing: 6) {
                        Text("\(t.transactions) ventes").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize()
                        if let p = entry.goalProgress { ProgressView(value: min(1, p)).widgetAccentable() }
                        else { WLine(values: curve, lineWidth: 1.4, area: false, endDot: false).frame(height: 11) }
                    }
                }
            case .systemSmall:
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .center, spacing: 4) {
                        WHeader(live: true)
                        WLiveToggle(on: entry.liveOn).padding(.top, -4)
                    }
                    HStack(alignment: .center, spacing: 6) {
                        WValue(text: net, size: 30, numeric: Double(t.netMicros))
                        if let p = entry.goalProgress { Spacer(minLength: 0); WRing(progress: p, lineWidth: 2.6).frame(width: 20, height: 20) }
                    }
                    .padding(.top, 4)
                    if let r = entry.record, r.isRecord { WRecordBadge(record: r, compact: true).padding(.top, 3) }
                    WLine(values: curve, tone: .money, lineWidth: 1.8).padding(.vertical, 6)
                    HStack(spacing: 4) {
                        Text("\(t.transactions)").foregroundStyle(MMColor.ink2)
                        Text("ventes").foregroundStyle(MMColor.ink3)
                        Spacer(minLength: 2)
                        if let p = entry.goalProgress {
                            Text(min(9.99, p).formatted(.percent.precision(.fractionLength(0)))).foregroundStyle(p >= 1 ? WTone.gold : MMColor.ink2)
                            Text("obj.").foregroundStyle(MMColor.ink3)
                        } else {
                            Text("\(t.trials)").foregroundStyle(MMColor.ink2)
                            Text("essais").foregroundStyle(MMColor.ink3)
                        }
                    }
                    .font(MMFont.system(12, .medium)).lineLimit(1)
                }
                .background(alignment: .topTrailing) { if isRecord { RadialGradient(colors: [WTone.gold.opacity(0.12), .clear], center: .topTrailing, startRadius: 0, endRadius: 130).padding(-16) } }
            default:
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .center, spacing: 8) {
                        if let r = entry.record, r.isRecord {
                            Circle().fill(WTone.moneyBright).frame(width: 6, height: 6)
                            WRecordBadge(record: r)
                            Spacer(minLength: 0)
                        } else {
                            WHeader(trailing: entry.date.formatted(date: .omitted, time: .shortened), live: true)
                        }
                        WLiveToggle(on: entry.liveOn)
                    }
                    HStack(alignment: .bottom, spacing: 12) {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .center, spacing: 8) {
                                if let p = entry.goalProgress, let g = entry.goalMicros {
                                    ZStack {
                                        WRing(progress: p, lineWidth: 3)
                                        Text(min(9.99, p).formatted(.percent.precision(.fractionLength(0)))).font(MMFont.system(8, .semibold)).foregroundStyle(MMColor.ink2).minimumScaleFactor(0.6)
                                    }
                                    .frame(width: 30, height: 30)
                                    .accessibilityLabel(Text("Objectif \(g.money(t.currency, compact: true))"))
                                }
                                WValue(text: t.netMicros.money(t.currency), size: 32, numeric: Double(t.netMicros))
                            }
                            HStack(spacing: 14) {
                                WStat(label: String(localized: "ventes"), value: "\(t.sales)", size: 15)
                                WStat(label: String(localized: "renouv."), value: "\(t.renewals)", size: 15)
                                if let g = entry.goalMicros { WStat(label: String(localized: "objectif"), value: g.money(t.currency, compact: true), size: 15) }
                                else { WStat(label: String(localized: "essais"), value: "\(t.trials)", size: 15) }
                            }
                        }
                        .fixedSize()
                        WLine(values: curve, lineWidth: 1.8)
                    }
                    .padding(.top, 6)
                    .frame(maxHeight: .infinity)
                    if let l = t.last {
                        WHairline().padding(.vertical, 8)
                        HStack(spacing: 6) {
                            WBizIcon(data: entry.lastProjectId.flatMap { entry.icons[$0] }, name: l.projectName, size: 18)
                            Text("+\(l.amountMicros.money(l.currency))").foregroundStyle(MMColor.ink)
                            if let c = l.country { Text(flagEmoji(c)) }
                            Spacer(minLength: 4)
                            WAgo(date: Date(timeIntervalSince1970: l.at / 1000)).foregroundStyle(MMColor.ink3).monospacedDigit().lineLimit(1)
                        }
                        .font(MMFont.system(12))
                    }
                }
            }
        } else {
            Text("—").foregroundStyle(MMColor.ink3)
        }
    }
}

struct MoneyMakerTodayWidget: Widget {
    static let families: [WidgetFamily] = [.systemSmall, .systemMedium, .accessoryInline, .accessoryCircular, .accessoryRectangular]
    var body: some WidgetConfiguration { Self.configuration(kind: WidgetPushGate.kind("MoneyMakerToday"), families: WidgetPushGate.legacy(Self.families)) }
    static func configuration(kind: String, families: [WidgetFamily]) -> some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: TodayProvider()) { entry in
            TodayWidgetView(entry: entry)
                .containerBackground(for: .widget) { WidgetBackdrop(date: entry.date) }
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
    var icons: WIcons = [:]
}

struct FeedProvider: TimelineProvider {
    func placeholder(in context: Context) -> FeedEntry { FeedEntry(date: .now, events: FeedEvent.samples, today: .placeholder, signedIn: true) }
    func getSnapshot(in context: Context, completion: @escaping (FeedEntry) -> Void) {
        let cached = MMShared.cachedFeed
        completion(FeedEntry(date: .now, events: context.isPreview ? FeedEvent.samples : cached, today: MMShared.cachedToday ?? .placeholder, signedIn: context.isPreview || MoneyMakerClient.stored.token != nil))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<FeedEntry>) -> Void) {
        Task {
            let client = MoneyMakerClient.stored
            async let f = try? client.feed(limit: 12)
            async let t = try? client.today()
            let (fresh, today) = await (f, t)
            let events = fresh ?? MMShared.cachedFeed
            let icons = await WIconCache.load(events.prefix(context.family == .systemLarge ? 7 : 3).map(\.projectId), overview: MoneyMakerClient.cachedOverview)
            let next = Date.now.addingTimeInterval(15 * 60)
            completion(Timeline(entries: wTimelineDates(until: next).map { FeedEntry(date: $0, events: events, today: today ?? MMShared.cachedToday, signedIn: client.token != nil, icons: icons) },
                                policy: .after(next)))
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
                WHeader(trailing: entry.today.map { $0.netMicros.money($0.currency, compact: true) }, live: true)
                    .padding(.bottom, 4)
                if rows.isEmpty {
                    Spacer()
                    Text("Ta prochaine vente apparaîtra ici.").font(MMFont.system(13)).foregroundStyle(MMColor.ink3).frame(maxWidth: .infinity)
                    Spacer()
                } else {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, e in
                        if i > 0 { WHairline() }
                        FeedRow(e: e, icon: entry.icons[e.projectId]).padding(.vertical, family == .systemLarge ? 6 : 4).frame(maxHeight: .infinity)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }
}

struct FeedRow: View {
    let e: FeedEvent
    var icon: Data? = nil
    var body: some View {
        let negative = e.type == "REFUND" || e.type == "BILLING_ISSUE"
        HStack(spacing: 10) {
            WBizIcon(data: icon, name: e.projectName, size: 26)
            VStack(alignment: .leading, spacing: 3) {
                Text(e.title).font(MMFont.system(13, .medium)).foregroundStyle(negative ? MMColor.red : MMColor.ink).lineLimit(1)
                HStack(spacing: 5) {
                    TransactionBadge(kind: e.badge, size: 9)
                    if let c = e.country { Text(flagEmoji(c)).font(.system(size: 11)) }
                }
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 2) {
                if let a = e.amountText {
                    Text((e.isRevenue ? "+" : "") + a).font(MMFont.number(15, .regular)).foregroundStyle(negative ? MMColor.red : MMColor.ink)
                        .lineLimit(1).minimumScaleFactor(0.7)
                }
                WAgo(date: e.date).font(MMFont.system(11)).foregroundStyle(MMColor.ink3).monospacedDigit().lineLimit(1)
                    .multilineTextAlignment(.trailing).frame(maxWidth: 90, alignment: .trailing)
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
                .containerBackground(for: .widget) { WidgetBackdrop(date: entry.date) }
                .widgetURL(URL(string: "moneymaker://feed"))
        }
        .configurationDisplayName("Ventes en direct")
        .description("Chaque vente, essai et remboursement, dès qu'il arrive.")
        .supportedFamilies(families)
    }
}

// MARK: - Live Activity + Dynamic Island
//
// Minimaliste, comme l'app : pas de liseré coloré, pas de logo « $ ». Un point blanc
// discret (le « direct »), des chiffres blancs fins, une courbe verte sobre.

/// Contexte d'affichage d'une mise à jour : objectif, record, vente toute fraîche.
struct LiveMoment {
    let goalProgress: Double?
    let record: MMRecord?
    /// Vente arrivée il y a moins de 8 s au moment du rendu (rendu = réception du push).
    let freshSale: Bool
    let saleDate: Date?

    init(_ s: RevenueActivityAttributes.ContentState, now: Date = .now) {
        let x = MMLiveExtras.current
        let sameDay = x?.dayKey == DayKeys.last(1).first?.0
        goalProgress = x?.goalMicros.flatMap { $0 > 0 ? Double(s.revenueMicros) / Double($0) : nil }
        record = (sameDay && (x?.bestDayMicros ?? 0) > 0) ? MMRecord(today: s.revenueMicros, previousBest: x!.bestDayMicros) : nil
        saleDate = s.lastSaleAt.map { Date(timeIntervalSince1970: Double($0)) }
        freshSale = s.lastAmountMicros > 0 && (saleDate.map { now.timeIntervalSince($0) < 8 } ?? false)
    }
    var isRecord: Bool { record?.isRecord == true }
}

struct RevenueLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RevenueActivityAttributes.self) { context in
            LiveLockScreen(state: context.state)
                .environment(\.colorScheme, .dark) // fixed-scheme: teinte noire de la Live Activity
                .activityBackgroundTint(Color.black.opacity(0.88))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "moneymaker://today"))
        } dynamicIsland: { context in
            let s = context.state
            let m = LiveMoment(s)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 3) {
                        if m.isRecord {
                            HStack(spacing: 3) {
                                Image(systemName: "trophy.fill").font(.system(size: 8, weight: .semibold))
                                Text("RECORD DU JOUR").font(MMFont.system(9, .medium)).tracking(1.4)
                            }
                            .foregroundStyle(WTone.gold)
                        } else {
                            Text("AUJOURD'HUI").font(MMFont.system(9, .medium)).tracking(1.6).foregroundStyle(.white.opacity(0.4))
                        }
                        Text(s.revenueMicros.money(s.currency)).font(MMFont.number(26)).tracking(-0.7).foregroundStyle(.white)
                            .contentTransition(.numericText(value: Double(s.revenueMicros))).minimumScaleFactor(0.6).lineLimit(1)
                    }
                    .padding(.leading, 6).padding(.top, 2)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 3) {
                        Text("VENTES").font(MMFont.system(9, .medium)).tracking(1.6).foregroundStyle(.white.opacity(0.4))
                        HStack(spacing: 7) {
                            if let p = m.goalProgress {
                                WRing(progress: p, lineWidth: 2.4, track: .white.opacity(0.14)).frame(width: 18, height: 18)
                            }
                            Text("\(s.sales)").font(MMFont.number(26)).foregroundStyle(.white).contentTransition(.numericText(value: Double(s.sales)))
                        }
                    }
                    .padding(.trailing, 6).padding(.top, 2)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 8) {
                        LiveCurve(values: s.hourly).frame(height: m.freshSale ? 24 : 30)
                        LiveSaleLine(state: s, moment: m, emphasized: true)
                    }
                    .padding(.horizontal, 6)
                }
            } compactLeading: {
                if let p = m.goalProgress {
                    WRing(progress: p, lineWidth: 2.2, track: .white.opacity(0.18)).frame(width: 14, height: 14).padding(.leading, 2)
                } else {
                    LiveDot()
                }
            } compactTrailing: {
                Text(s.revenueMicros.money(s.currency, compact: true))
                    .font(MMFont.number(14, .regular)).foregroundStyle(m.isRecord ? WTone.gold : .white)
                    .contentTransition(.numericText(value: Double(s.revenueMicros)))
                    .lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: 72)
            } minimal: {
                Text(s.revenueMicros.money(s.currency, compact: true))
                    .font(MMFont.number(11, .regular)).foregroundStyle(.white)
                    .lineLimit(1).minimumScaleFactor(0.5)
                    .contentTransition(.numericText(value: Double(s.revenueMicros)))
            }
            .keylineTint(.clear)
            .widgetURL(URL(string: "moneymaker://today"))
        }
    }
}

/// Ligne « tiroir-caisse » : la dernière vente. Fraîche (< 8 s au rendu, c.-à-d. le push qui
/// fait s'ouvrir l'île), elle passe au premier plan : « +9,99 € » vert, grand, transition numérique.
/// Ensuite elle redevient discrète, avec l'ancienneté qui défile seule (`Text(date, style:)`).
struct LiveSaleLine: View {
    let state: RevenueActivityAttributes.ContentState
    let moment: LiveMoment
    var emphasized = false

    var body: some View {
        let s = state
        VStack(alignment: .leading, spacing: 4) {
            if s.lastAmountMicros > 0 {
                let fresh = emphasized && moment.freshSale
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if fresh { Image(systemName: "plus").font(.system(size: 11, weight: .bold)).foregroundStyle(WTone.moneyBright) }
                    Text((fresh ? "" : "+") + s.lastAmountMicros.money(s.lastCurrency))
                        .font(fresh ? MMFont.number(19) : MMFont.system(12))
                        .foregroundStyle(fresh ? WTone.moneyBright : .white)
                        .contentTransition(.numericText(value: Double(s.lastAmountMicros)))
                    Text(s.lastCountry.map { flagEmoji($0) } ?? "").font(MMFont.system(12)).foregroundStyle(.white.opacity(0.55)).lineLimit(1)
                    Spacer(minLength: 0)
                    if let d = moment.saleDate {
                        WAgo(date: d, live: true).font(MMFont.system(10)).foregroundStyle(.white.opacity(0.35)).monospacedDigit().lineLimit(1)
                            .frame(maxWidth: 70, alignment: .trailing)
                    }
                }
                .transition(.push(from: .bottom))
                .id(s.lastSaleAt ?? s.updatedAt)
            }
            if let r = moment.record, r.isRecord {
                Text("+\(r.gain.formatted(.percent.precision(.fractionLength(0)))) vs ancien record (\(r.previousBest.money(s.currency, compact: true)))")
                    .font(MMFont.system(10, .medium)).foregroundStyle(WTone.gold.opacity(0.85)).lineLimit(1)
            }
        }
    }
}

/// Le « direct » : un point blanc, un fin anneau autour. Rien d'autre.
struct LiveDot: View {
    var body: some View {
        Circle().fill(.white).frame(width: 6, height: 6)
            .padding(3)
            .overlay(Circle().strokeBorder(.white.opacity(0.22), lineWidth: 1))
            .padding(.leading, 2)
    }
}

struct LiveLockScreen: View {
    let state: RevenueActivityAttributes.ContentState
    var body: some View {
        let m = LiveMoment(state)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Circle().fill(.white).frame(width: 5, height: 5).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                Text("REVENUS DU JOUR").font(MMFont.system(10, .medium)).tracking(1.6).foregroundStyle(.white.opacity(0.4))
                if m.isRecord {
                    Image(systemName: "trophy.fill").font(.system(size: 9, weight: .semibold)).foregroundStyle(WTone.gold)
                }
                Spacer()
                Text("MoneyMaker").font(MMFont.system(10, .medium)).foregroundStyle(.white.opacity(0.3))
            }
            HStack(alignment: .bottom, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .center, spacing: 8) {
                        Text(state.revenueMicros.money(state.currency)).font(MMFont.number(34)).tracking(-1).foregroundStyle(.white)
                            .contentTransition(.numericText(value: Double(state.revenueMicros))).minimumScaleFactor(0.6).lineLimit(1)
                        if let p = m.goalProgress { WRing(progress: p, lineWidth: 2.6, track: .white.opacity(0.14)).frame(width: 20, height: 20) }
                    }
                    Text("\(state.sales) ventes · \(state.trials) essais").font(MMFont.system(12)).foregroundStyle(.white.opacity(0.55))
                }
                .fixedSize()
                LiveCurve(values: state.hourly).frame(height: 44)
            }
            if state.lastProject != nil, state.lastAmountMicros > 0 {
                Rectangle().fill(.white.opacity(0.08)).frame(height: 0.75)
                LiveSaleLine(state: state, moment: m, emphasized: true)
            }
        }
        .padding(16)
        .background(alignment: .topTrailing) { WDots(anchor: .topTrailing, reach: 0.5, maxOpacity: 0.16).environment(\.colorScheme, .dark) }
    }
}

/// Courbe cumulée de la journée jusqu'à l'heure courante — même tracé que les widgets.
struct LiveCurve: View {
    let values: [Double]
    var body: some View {
        let hour = min(values.count, max(2, Calendar.current.component(.hour, from: .now) + 1))
        WLine(values: Array(values.prefix(hour)), lineWidth: 1.8)
    }
}

// MARK: - Centre de contrôle (iOS 18)

@available(iOS 18.0, *)
struct MoneyMakerTodayControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "MoneyMakerTodayControl") {
            ControlWidgetButton(action: OpenURLIntent(URL(string: "moneymaker://today")!)) {
                Label("Revenus du jour", systemImage: "chart.line.uptrend.xyaxis")
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
