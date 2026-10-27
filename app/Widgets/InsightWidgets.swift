//
//  InsightWidgets.swift
//  MoneyMaker — widgets « wow » : projection du mois, mini-planisphère des ventes,
//  série de jours avec vente. Tous lisent l'historique 365 j mis en cache (MMHistory,
//  rechargé au plus toutes les 3 h) : aucun calcul lourd dans les vues.
//

import WidgetKit
import SwiftUI
import AppIntents

// MARK: - Timeline commune

struct InsightEntry: TimelineEntry {
    let date: Date
    let history: MMHistory?
    let today: Today?
    var overview: Overview? = nil
    var feed: [FeedEvent] = []
    let signedIn: Bool
}

struct InsightProvider: TimelineProvider {
    /// Le planisphère a aussi besoin de l'aperçu 28 j (pays) et du flux (pays du jour).
    var wantsMap = false

    func placeholder(in context: Context) -> InsightEntry {
        InsightEntry(date: .now, history: .placeholder, today: .placeholder, overview: nil, feed: FeedEvent.samples, signedIn: true)
    }
    func getSnapshot(in context: Context, completion: @escaping (InsightEntry) -> Void) {
        if context.isPreview { completion(placeholder(in: context)); return }
        completion(InsightEntry(date: .now, history: MMShared.history ?? .placeholder, today: MMShared.cachedToday ?? .placeholder,
                                overview: MoneyMakerClient.cachedOverview, feed: MMShared.cachedFeed, signedIn: context.isPreview || MoneyMakerClient.stored.token != nil))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<InsightEntry>) -> Void) {
        Task {
            let client = MoneyMakerClient.stored
            async let h = client.history()
            async let t = try? client.today()
            let (history, today) = await (h, t)
            let entry = InsightEntry(date: .now, history: history, today: today ?? MMShared.cachedToday,
                                     overview: wantsMap ? MoneyMakerClient.cachedOverview : nil,
                                     feed: wantsMap ? MMShared.cachedFeed : [], signedIn: client.token != nil)
            let midnight = Calendar.current.startOfDay(for: .now.addingTimeInterval(86400))
            let next = min(midnight, .now.addingTimeInterval(30 * 60))
            completion(Timeline(entries: wTimelineDates(until: next).map { d in
                InsightEntry(date: d, history: entry.history, today: entry.today, overview: entry.overview, feed: entry.feed, signedIn: entry.signedIn)
            }, policy: .after(next)))
        }
    }
}

// MARK: - Projection du mois

struct MonthWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: InsightEntry

    var body: some View {
        if !entry.signedIn { SignedOutView() } else if let h = entry.history {
            let m = MMMonthProjection(history: h, today: entry.today, now: entry.date)
            let month = entry.date.formatted(.dateTime.month(.wide))
            let chart = WProjectionChart(actual: m.actual, projected: m.projected, total: m.daysInMonth,
                                         reference: m.lastMonthMicros > 0 ? Double(m.lastMonthMicros) / 1e6 : nil)
            switch family {
            case .systemSmall:
                VStack(alignment: .leading, spacing: 0) {
                    WValue(text: m.projectedMicros.money(m.currency, compact: true), size: 30, numeric: Double(m.projectedMicros))
                    HStack(spacing: 4) {
                        WDelta(value: m.vsLastMonth)
                        if m.vsLastMonth != nil { Text("vs mois dernier").font(MMFont.system(10)).foregroundStyle(MMColor.ink3).lineLimit(1) }
                    }
                    chart.padding(.vertical, 6)
                    HStack(spacing: 4) {
                        Text(m.soFarMicros.money(m.currency, compact: true)).foregroundStyle(MMColor.ink2)
                        Text("déjà").foregroundStyle(MMColor.ink3)
                    }
                    .font(MMFont.system(11, .medium)).lineLimit(1)
                }
            default:
                VStack(alignment: .leading, spacing: 0) {
                    WHeader(trailing: "\(month) · " + String(localized: "jour \(m.actual.count)/\(m.daysInMonth)"))
                    HStack(alignment: .bottom, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Fin du mois estimée").font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                            WValue(text: m.projectedMicros.money(m.currency, compact: true), size: 32, numeric: Double(m.projectedMicros))
                            HStack(spacing: 4) {
                                WDelta(value: m.vsLastMonth)
                                if m.vsLastMonth != nil { Text("vs mois dernier").font(MMFont.system(10)).foregroundStyle(MMColor.ink3) }
                            }
                        }
                        .fixedSize()
                        if family == .systemMedium { chart }
                    }
                    .padding(.top, 6)
                    .frame(maxHeight: family == .systemLarge ? nil : .infinity)
                    if family == .systemLarge {
                        chart.frame(maxHeight: .infinity).padding(.vertical, 12)
                        legend.padding(.bottom, 8)
                    }
                    WHairline().padding(.vertical, 8)
                    HStack(alignment: .top) {
                        WStat(label: String(localized: "Ce mois-ci"), value: m.soFarMicros.money(m.currency, compact: true), size: 16)
                        Spacer(minLength: 6)
                        WStat(label: String(localized: "Rythme / jour"), value: (m.daysInMonth > m.actual.count ? (m.projectedMicros - m.soFarMicros) / max(1, m.daysInMonth - m.actual.count + 1) : m.soFarMicros / max(1, m.daysInMonth)).money(m.currency, compact: true), size: 16)
                        Spacer(minLength: 6)
                        WStat(label: String(localized: "Mois dernier"), value: m.lastMonthMicros > 0 ? m.lastMonthMicros.money(m.currency, compact: true) : "—", alignment: .trailing, size: 16)
                    }
                }
            }
        } else {
            Text("—").foregroundStyle(MMColor.ink3)
        }
    }

    private var legend: some View {
        HStack(spacing: 14) {
            HStack(spacing: 5) { Capsule().fill(WTone.moneyBright).frame(width: 14, height: 2); Text("Réel") }
            HStack(spacing: 5) {
                HStack(spacing: 2) { ForEach(0..<3, id: \.self) { _ in Circle().fill(WTone.moneyBright.opacity(0.7)).frame(width: 2, height: 2) } }
                Text("Au rythme actuel")
            }
            HStack(spacing: 5) {
                Rectangle().fill(MMColor.fg(0.3)).frame(width: 12, height: 0.75)
                Text("Mois dernier")
            }
            Spacer(minLength: 0)
        }
        .font(MMFont.system(10)).foregroundStyle(MMColor.ink3)
    }
}

struct MoneyMakerMonthWidget: Widget {
    static let families: [WidgetFamily] = [.systemSmall, .systemMedium, .systemLarge]
    var body: some WidgetConfiguration { Self.configuration(kind: WidgetPushGate.kind("MoneyMakerMonth"), families: WidgetPushGate.legacy(Self.families)) }
    static func configuration(kind: String, families: [WidgetFamily]) -> some WidgetConfiguration {
            StaticConfiguration(kind: kind, provider: InsightProvider()) { entry in
                MonthWidgetView(entry: entry)
                    .containerBackground(for: .widget) { WidgetBackdrop(date: entry.date) }
                    .widgetURL(URL(string: "moneymaker://charts"))
            }
            .configurationDisplayName("Projection du mois")
            .description("Ton revenu du mois et où il finira au rythme actuel.")
            .supportedFamilies(families)
    }
}

@available(iOS 26.0, *)
struct MoneyMakerMonthWidgetPush: Widget {
    var body: some WidgetConfiguration { MoneyMakerMonthWidget.configuration(kind: "MoneyMakerMonth", families: MoneyMakerMonthWidget.families).pushHandler(MMWidgetPushHandler.self) }
}

// MARK: - Mini-planisphère en points

/// Grille de terre décodée une seule fois (≈ 620 cases) ; pays → cases voisines de leur centre.
enum WGlobe {
    static let land: [(c: Int, r: Int)] = {
        var out: [(Int, Int)] = []
        for (r, row) in WGlobeData.grid.enumerated() { for (c, ch) in row.enumerated() where ch == "#" { out.append((c, r)) } }
        return out
    }()
    private static let landSet: Set<Int> = Set(land.map { $0.r * WGlobeData.cols + $0.c })

    static func cell(lat: Double, lng: Double) -> (c: Double, r: Double) {
        ((lng + 180) / 360 * Double(WGlobeData.cols), (WGlobeData.top - lat) / (WGlobeData.top - WGlobeData.bottom) * Double(WGlobeData.rows))
    }

    /// Intensité (0…1) par case allumée, à partir du revenu par pays.
    static func lit(_ byCountry: [String: Int]) -> [Int: Double] {
        let hi = Double(byCountry.values.max() ?? 0)
        guard hi > 0 else { return [:] }
        var out: [Int: Double] = [:]
        for (cc, v) in byCountry where v > 0 {
            guard let (lat, lng) = WGlobeData.centroids[cc.uppercased()] else { continue }
            let (fc, fr) = cell(lat: lat, lng: lng)
            let k = 0.35 + 0.65 * sqrt(Double(v) / hi)
            for dr in -1...1 { for dc in -2...2 {
                let c = Int(fc) + dc, r = Int(fr) + dr
                guard r >= 0, r < WGlobeData.rows else { continue }
                let cw = (c + WGlobeData.cols) % WGlobeData.cols
                let d = hypot(Double(cw) + 0.5 - fc, Double(r) + 0.5 - fr)
                guard d < 1.9 else { continue }
                let key = r * WGlobeData.cols + cw
                // Les très petits pays (hors grille de terre) gardent au moins leur case centrale.
                guard landSet.contains(key) || (dc == 0 && dr == 0) else { continue }
                out[key] = max(out[key] ?? 0, k * (1 - d / 2.4))
            } }
        }
        return out
    }
}

struct WGlobeView: View {
    let lit: [Int: Double]
    /// Pays de la vente du jour : point blanc.
    var spark: (c: Double, r: Double)? = nil

    var body: some View {
        Canvas { ctx, s in
            let cols = CGFloat(WGlobeData.cols), rows = CGFloat(WGlobeData.rows)
            let step = min(s.width / cols, s.height / rows)
            let ox = (s.width - step * cols) / 2, oy = (s.height - step * rows) / 2
            let d = step * 0.62
            var base = Path()
            for p in WGlobe.land where lit[p.r * WGlobeData.cols + p.c] == nil {
                base.addRect(CGRect(x: ox + CGFloat(p.c) * step + (step - d) / 2, y: oy + CGFloat(p.r) * step + (step - d) / 2, width: d, height: d))
            }
            ctx.fill(base, with: .color(MMColor.fg(0.13)))
            for (key, k) in lit {
                let c = key % WGlobeData.cols, r = key / WGlobeData.cols
                let rect = CGRect(x: ox + CGFloat(c) * step + (step - d) / 2, y: oy + CGFloat(r) * step + (step - d) / 2, width: d, height: d)
                ctx.fill(Path(rect), with: .color(WTone.moneyBright.opacity(0.25 + 0.75 * k)))
            }
            if let sp = spark {
                let x = ox + CGFloat(sp.c) * step, y = oy + CGFloat(sp.r) * step
                ctx.stroke(Path(ellipseIn: CGRect(x: x - step * 1.3, y: y - step * 1.3, width: step * 2.6, height: step * 2.6)), with: .color(MMColor.ink.opacity(0.5)), lineWidth: 0.75)
                ctx.fill(Path(ellipseIn: CGRect(x: x - d * 0.6, y: y - d * 0.6, width: d * 1.2, height: d * 1.2)), with: .color(MMColor.ink))
            }
        }
        .accessibilityHidden(true)
    }
}

struct GlobeWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: InsightEntry

    var body: some View {
        if !entry.signedIn { SignedOutView() } else {
            let byCountry = countries
            let lit = WGlobe.lit(byCountry)
            let top = byCountry.sorted { $0.value > $1.value }.prefix(3)
            let total = byCountry.values.reduce(0, +)
            let cur = entry.overview?.currency ?? entry.history?.currency ?? "EUR"
            let todayCC = entry.today?.last?.country ?? entry.feed.first(where: \.isRevenue)?.country
            let spark = todayCC.flatMap { WGlobeData.centroids[$0.uppercased()] }.map { WGlobe.cell(lat: $0.0, lng: $0.1) }
            if family == .systemSmall {
                VStack(alignment: .leading, spacing: 0) {
                    WHeader(trailing: "28 j")
                    WGlobeView(lit: lit, spark: spark).frame(maxHeight: .infinity).padding(.vertical, 6)
                    HStack(spacing: 4) {
                        Text("\(byCountry.count)").foregroundStyle(MMColor.ink2)
                        Text("pays").foregroundStyle(MMColor.ink3)
                        Spacer(minLength: 2)
                        if let f = top.first { Text(flagEmoji(f.key)) }
                    }
                    .font(MMFont.system(11, .medium)).lineLimit(1)
                }
            } else {
                HStack(spacing: 8) {
                    WGlobeView(lit: lit, spark: spark).frame(maxWidth: .infinity, maxHeight: .infinity)
                    // Top 3 discret : drapeau et part, sans titre.
                    VStack(alignment: .leading, spacing: 9) {
                        Spacer(minLength: 0)
                        ForEach(Array(top), id: \.key) { kv in
                            HStack(spacing: 5) {
                                Text(flagEmoji(kv.key)).font(.system(size: 12))
                                VStack(alignment: .leading, spacing: 0) {
                                    Text(kv.value.money(cur, compact: true)).font(MMFont.number(11, .regular)).foregroundStyle(MMColor.ink2).lineLimit(1)
                                    if total > 0 {
                                        Text((Double(kv.value) / Double(total)).formatted(.percent.precision(.fractionLength(0))))
                                            .font(MMFont.system(8)).foregroundStyle(MMColor.ink3)
                                    }
                                }
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(width: 62, alignment: .leading)
                }
            }
        }
    }

    /// Revenu par pays des 28 derniers jours (aperçu), sinon de l'historique, plus le pays du jour.
    private var countries: [String: Int] {
        var out: [String: Int] = (entry.overview?.projects ?? []).reduce(into: [:]) { acc, p in
            p.revenueByCountry?.forEach { acc[$0.key.uppercased(), default: 0] += $0.value }
        }
        if out.isEmpty { out = entry.history?.byCountry ?? [:] }
        if let l = entry.today?.last, let cc = l.country?.uppercased(), out[cc] == nil { out[cc] = l.amountMicros }
        return out
    }
}

struct MoneyMakerGlobeWidget: Widget {
    static let families: [WidgetFamily] = [.systemSmall, .systemMedium]
    var body: some WidgetConfiguration { Self.configuration(kind: WidgetPushGate.kind("MoneyMakerGlobe"), families: WidgetPushGate.legacy(Self.families)) }
    static func configuration(kind: String, families: [WidgetFamily]) -> some WidgetConfiguration {
            StaticConfiguration(kind: kind, provider: InsightProvider(wantsMap: true)) { entry in
                GlobeWidgetView(entry: entry)
                    .containerBackground(for: .widget) { WidgetBackdrop(dots: nil) }
                    .widgetURL(URL(string: "moneymaker://globe"))
            }
            .configurationDisplayName("Ventes dans le monde")
            .description("Les pays où tu vends s'allument, avec ton top 3.")
            .supportedFamilies(families)
    }
}

@available(iOS 26.0, *)
struct MoneyMakerGlobeWidgetPush: Widget {
    var body: some WidgetConfiguration { MoneyMakerGlobeWidget.configuration(kind: "MoneyMakerGlobe", families: MoneyMakerGlobeWidget.families).pushHandler(MMWidgetPushHandler.self) }
}

// MARK: - Série

struct StreakWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: InsightEntry

    var body: some View {
        if !entry.signedIn { SignedOutView() } else {
            let s = entry.history.map { MMStreak(history: $0, today: entry.today) } ?? .placeholder
            switch family {
            case .accessoryCircular:
                VStack(spacing: 0) {
                    Image(systemName: "flame.fill").font(.system(size: 12, weight: .semibold)).widgetAccentable()
                    Text("\(s.current)").font(.system(size: 18, weight: .semibold)).minimumScaleFactor(0.6)
                    Text("jours").font(.system(size: 8)).foregroundStyle(.secondary)
                }
                .padding(4)
                .background(AccessoryWidgetBackground().clipShape(Circle()))
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 3) {
                        Image(systemName: "flame.fill").font(.system(size: 10, weight: .semibold))
                        Text("SÉRIE").font(.system(size: 10, weight: .semibold)).tracking(1.2)
                    }
                    .widgetAccentable()
                    Text("\(s.current) jours").font(.system(size: 19, weight: .medium)).lineLimit(1).minimumScaleFactor(0.6)
                    dots(s, size: 5, spacing: 2.5, accessory: true)
                }
            default:
                VStack(alignment: .leading, spacing: 0) {
                    WHeader(trailing: s.todayDone ? "✓" : nil)
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Image(systemName: "flame.fill").font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(LinearGradient(colors: [WTone.gold, Color(red: 0.98, green: 0.45, blue: 0.22)], startPoint: .top, endPoint: .bottom))
                            .opacity(s.current > 0 ? 1 : 0.3)
                        WValue(text: "\(s.current)", size: 38, numeric: Double(s.current))
                        Text(s.current > 1 ? "jours" : "jour").font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                    }
                    .padding(.top, 6)
                    Text(s.todayDone ? String(localized: "avec au moins une vente") : String(localized: "en attente de la vente du jour"))
                        .font(MMFont.system(10)).foregroundStyle(MMColor.ink3).lineLimit(1)
                    Spacer(minLength: 6)
                    dots(s, size: 6, spacing: 3.2, accessory: false)
                    HStack(spacing: 4) {
                        Text("Record").foregroundStyle(MMColor.ink3)
                        Text("\(s.best) j").foregroundStyle(s.current >= s.best && s.best > 0 ? WTone.gold : MMColor.ink2)
                    }
                    .font(MMFont.system(11, .medium)).padding(.top, 6)
                }
            }
        }
    }

    /// 14 derniers jours : carré plein = au moins une vente ; aujourd'hui cerclé.
    private func dots(_ s: MMStreak, size: CGFloat, spacing: CGFloat, accessory: Bool) -> some View {
        HStack(spacing: spacing) {
            ForEach(Array(s.last14.enumerated()), id: \.offset) { i, on in
                let isToday = i == s.last14.count - 1
                RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
                    .fill(on ? (accessory ? AnyShapeStyle(.primary) : AnyShapeStyle(WTone.moneyBright)) : (accessory ? AnyShapeStyle(.primary.opacity(0.25)) : AnyShapeStyle(MMColor.fg(0.12))))
                    .frame(width: size, height: size)
                    .overlay(isToday && !on ? RoundedRectangle(cornerRadius: size * 0.3, style: .continuous).strokeBorder(accessory ? AnyShapeStyle(.primary) : AnyShapeStyle(MMColor.ink2), lineWidth: 0.75) : nil)
            }
        }
    }
}

struct MoneyMakerStreakWidget: Widget {
    static let families: [WidgetFamily] = [.systemSmall, .accessoryRectangular, .accessoryCircular]
    var body: some WidgetConfiguration { Self.configuration(kind: WidgetPushGate.kind("MoneyMakerStreak"), families: WidgetPushGate.legacy(Self.families)) }
    static func configuration(kind: String, families: [WidgetFamily]) -> some WidgetConfiguration {
            StaticConfiguration(kind: kind, provider: InsightProvider()) { entry in
                StreakWidgetView(entry: entry)
                    .containerBackground(for: .widget) { WidgetBackdrop(dots: .bottomTrailing, reach: 0.5, date: entry.date) }
                    .widgetURL(URL(string: "moneymaker://today"))
            }
            .configurationDisplayName("Série de ventes")
            .description("Jours d'affilée avec au moins une vente, ton record et les 14 derniers jours.")
            .supportedFamilies(families)
    }
}

@available(iOS 26.0, *)
struct MoneyMakerStreakWidgetPush: Widget {
    var body: some WidgetConfiguration { MoneyMakerStreakWidget.configuration(kind: "MoneyMakerStreak", families: MoneyMakerStreakWidget.families).pushHandler(MMWidgetPushHandler.self) }
}
