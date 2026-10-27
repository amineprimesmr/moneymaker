//
//  MMInsights.swift
//  MoneyMaker — calculs partagés par l'app, les widgets et la Live Activity :
//  historique 365 j (record, série, projection du mois, carte), objectif du jour,
//  business affiché par les widgets, bouton « direct ».
//
//  Tout est rangé dans le trousseau partagé (MM.read / MM.write), le seul conteneur commun
//  à l'app et à l'extension (pas d'App Group). Les valeurs lues par les vues de la Live
//  Activity sont minuscules (`MMLiveExtras`) : aucun décodage lourd au rendu.
//

import Foundation
import ActivityKit
import AppIntents
import WidgetKit

// MARK: - Historique (365 jours, tous les business)

struct MMHistory: Codable, Hashable {
    let currency: String
    /// Revenu net par jour `yyyy-MM-dd` (UTC), micros.
    let byDay: [String: Int]
    /// Revenu par pays (ISO alpha-2) sur la période de l'aperçu, micros.
    let byCountry: [String: Int]
    let fetchedAt: Double

    init(_ o: Overview) {
        currency = o.currency
        byDay = o.revenueByDay
        byCountry = o.projects.reduce(into: [:]) { acc, p in p.revenueByCountry?.forEach { acc[$0.key.uppercased(), default: 0] += $0.value } }
        fetchedAt = Date().timeIntervalSince1970
    }

    init(currency: String, byDay: [String: Int], byCountry: [String: Int]) {
        self.currency = currency; self.byDay = byDay; self.byCountry = byCountry; fetchedAt = Date().timeIntervalSince1970
    }

    var todayKey: String { DayKeys.last(1).first?.0 ?? "" }

    /// Meilleur jour AVANT aujourd'hui (micros).
    var bestPreviousDay: Int {
        let t = todayKey
        return byDay.reduce(0) { $1.key == t ? $0 : max($0, $1.value) }
    }

    /// Moyenne des `days` derniers jours complets (hors aujourd'hui), micros.
    func average(days: Int) -> Int {
        let keys = DayKeys.last(days + 1).dropLast()
        return keys.reduce(0) { $0 + (byDay[$1.0] ?? 0) } / max(days, 1)
    }

    static let placeholder: MMHistory = {
        let keys = DayKeys.last(120)
        var d: [String: Int] = [:]
        for (i, k) in keys.enumerated() where i % 9 != 4 { d[k.0] = (30 + (i * 37) % 60 + i / 2) * 1_000_000 }
        return MMHistory(currency: "EUR", byDay: d, byCountry: ["US": 900_000_000, "FR": 620_000_000, "DE": 310_000_000, "GB": 240_000_000, "JP": 120_000_000, "BR": 80_000_000])
    }()
}

extension MMShared {
    static var history: MMHistory? {
        get { MM.read("history365").flatMap { try? JSONDecoder().decode(MMHistory.self, from: $0) } }
        set {
            MM.write("history365", newValue.flatMap { try? JSONEncoder().encode($0) })
            if let h = newValue { updateLiveExtras(history: h) }
        }
    }
}

extension MoneyMakerClient {
    /// Historique 365 j mis en cache ; rechargé au plus toutes les `maxAge` secondes.
    func history(maxAge: TimeInterval = 3 * 3600) async -> MMHistory? {
        let cached = MMShared.history
        if let c = cached, Date().timeIntervalSince1970 - c.fetchedAt < maxAge { return c }
        guard let o = try? await overview(days: 365) else { return cached }
        let h = MMHistory(o)
        MMShared.history = h
        return h
    }
}

// MARK: - Record du jour

struct MMRecord: Hashable {
    let previousBest: Int
    let today: Int
    var isRecord: Bool { previousBest > 0 && today > previousBest }
    /// +x % vs ancien record.
    var gain: Double { previousBest > 0 ? Double(today - previousBest) / Double(previousBest) : 0 }

    init(today: Int, previousBest: Int) { self.today = today; self.previousBest = previousBest }
    init?(today t: Today?, history h: MMHistory?) {
        guard let t, let h else { return nil }
        self.init(today: t.netMicros, previousBest: h.bestPreviousDay)
    }
}

// MARK: - Série (jours consécutifs avec au moins une vente)

struct MMStreak: Hashable {
    let current: Int
    let best: Int
    /// 14 derniers jours, du plus ancien à aujourd'hui.
    let last14: [Bool]
    let todayDone: Bool

    init(history h: MMHistory, today: Today?) {
        let keys = DayKeys.last(365)
        var days = keys.map { (h.byDay[$0.0] ?? 0) > 0 }
        if let t = today, t.transactions > 0 || t.netMicros > 0 { days[days.count - 1] = true }
        todayDone = days.last ?? false
        // Série en cours : aujourd'hui compte s'il y a déjà une vente, sinon on part d'hier (pas encore cassée).
        var c = 0
        for v in days.dropLast(todayDone ? 0 : 1).reversed() { if v { c += 1 } else { break } }
        current = c
        var b = 0, run = 0
        for v in days { run = v ? run + 1 : 0; b = max(b, run) }
        best = max(b, c)
        last14 = Array(days.suffix(14))
    }

    static let placeholder = MMStreak(current: 12, best: 31, last14: [true, false, true, true, true, true, true, true, true, true, true, true, true, true], todayDone: true)
    private init(current: Int, best: Int, last14: [Bool], todayDone: Bool) { self.current = current; self.best = best; self.last14 = last14; self.todayDone = todayDone }
}

// MARK: - Projection du mois

struct MMMonthProjection: Hashable {
    let currency: String
    /// Cumul réel jour par jour (unités) jusqu'à aujourd'hui inclus.
    let actual: [Double]
    /// Cumul projeté du jour courant à la fin du mois (commence à la dernière valeur réelle).
    let projected: [Double]
    let daysInMonth: Int
    let soFarMicros: Int
    let projectedMicros: Int
    let lastMonthMicros: Int
    var vsLastMonth: Double? { lastMonthMicros > 0 ? Double(projectedMicros - lastMonthMicros) / Double(lastMonthMicros) : nil }

    init(history h: MMHistory, today: Today?, now: Date = .now) {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = cal.timeZone; f.locale = Locale(identifier: "en_US_POSIX")
        let start = cal.date(from: cal.dateComponents([.year, .month], from: now))!
        let dim = cal.range(of: .day, in: .month, for: now)?.count ?? 30
        let dayIndex = cal.component(.day, from: now) // 1…dim
        var daily: [Int] = (0..<dayIndex).map { h.byDay[f.string(from: start.addingTimeInterval(Double($0) * 86400))] ?? 0 }
        if let t = today { daily[daily.count - 1] = max(daily[daily.count - 1], t.netMicros) }
        let soFar = daily.reduce(0, +)
        // Rythme : moyenne du mois pondérée avec les 7 derniers jours complets (60 % récents).
        let complete = Array(daily.dropLast())
        let monthAvg = complete.isEmpty ? Double(daily.last ?? 0) : Double(complete.reduce(0, +)) / Double(complete.count)
        let recentAvg = Double(h.average(days: 7))
        let pace = complete.count >= 3 ? 0.4 * monthAvg + 0.6 * recentAvg : max(monthAvg, recentAvg)
        // Le jour courant est compté au maximum entre ce qui est déjà fait et le rythme.
        let todayRest = max(0, pace - Double(daily.last ?? 0))
        let remaining = Double(dim - dayIndex) * pace + todayRest
        currency = h.currency
        daysInMonth = dim
        soFarMicros = soFar
        projectedMicros = soFar + Int(remaining)
        var acc = 0.0
        actual = daily.map { acc += Double($0) / 1e6; return acc }
        var p = acc
        projected = [acc] + (0..<(dim - dayIndex)).map { i in p += (pace + (i == 0 ? todayRest : 0)) / 1e6; return p }
        // Mois précédent complet.
        let prevStart = cal.date(byAdding: .month, value: -1, to: start)!
        let prevDim = cal.range(of: .day, in: .month, for: prevStart)?.count ?? 30
        lastMonthMicros = (0..<prevDim).reduce(0) { $0 + (h.byDay[f.string(from: prevStart.addingTimeInterval(Double($1) * 86400))] ?? 0) }
    }
}

// MARK: - Objectif du jour

extension MMShared {
    /// Objectif quotidien choisi (unités). nil = automatique.
    static var dailyGoal: Int? {
        get { MM.read("dailyGoal").flatMap { String(data: $0, encoding: .utf8) }.flatMap(Int.init) }
        set {
            MM.write("dailyGoal", newValue.map { Data(String($0).utf8) })
            if let h = history { updateLiveExtras(history: h) } else { updateLiveExtras(history: nil) }
        }
    }

    /// Objectif auto : moyenne des 30 derniers jours × 1,2, arrondie à un chiffre « rond ».
    static func autoDailyGoal(_ h: MMHistory?) -> Int? {
        guard let h else { return nil }
        let units = Double(h.average(days: 30)) / 1e6 * 1.2
        guard units >= 1 else { return nil }
        let step: Double = units < 20 ? 1 : units < 100 ? 5 : units < 1000 ? 10 : 50
        return Int((units / step).rounded(.up) * step)
    }

    /// Objectif effectif en micros (choisi, sinon automatique).
    static func dailyGoalMicros(_ h: MMHistory?) -> Int? {
        (dailyGoal ?? autoDailyGoal(h)).map { $0 * 1_000_000 }
    }
}

/// Petites valeurs lues directement par les vues de la Live Activity (le push serveur
/// remplace tout le content-state : l'objectif et le record vivent donc ici).
struct MMLiveExtras: Codable, Hashable {
    var goalMicros: Int?
    var bestDayMicros: Int
    var dayKey: String

    static var current: MMLiveExtras? {
        MM.read("liveExtras").flatMap { try? JSONDecoder().decode(MMLiveExtras.self, from: $0) }
    }
}

extension MMShared {
    static func updateLiveExtras(history h: MMHistory?) {
        let e = MMLiveExtras(goalMicros: dailyGoalMicros(h), bestDayMicros: h?.bestPreviousDay ?? 0, dayKey: DayKeys.last(1).first?.0 ?? "")
        MM.write("liveExtras", try? JSONEncoder().encode(e))
    }
}

// MARK: - Business affiché par les widgets (bouton « suivant »)

extension MMShared {
    /// Identifiant du business affiché ; nil = tous.
    static var widgetProjectId: String? {
        get { MM.read("widgetProject").flatMap { String(data: $0, encoding: .utf8) } }
        set { MM.write("widgetProject", newValue.map { Data($0.utf8) }) }
    }
}

extension Overview {
    /// Aperçu restreint à un seul business (les agrégats sont recalculés depuis ce business).
    func focused(on id: String?) -> Overview {
        guard let id, let p = projects.first(where: { $0.projectId == id }) else { return self }
        return Overview(currency: p.currency, periodDays: periodDays, mrrMicros: p.mrrMicros, revenueMicros: p.netRevenueMicros,
                        activeSubscriptions: p.activeSubscriptions, activeTrials: p.activeTrials, newCustomers: p.newCustomers,
                        projects: [p], generatedAt: generatedAt, payingCustomers: p.payingCustomers ?? p.activeSubscriptions,
                        downloads: p.downloads, hasTrials: p.hasTrials)
    }

    /// Nom du business suivi (nil = tous).
    func focusName(_ id: String?) -> String? { id.flatMap { i in projects.first { $0.projectId == i }?.name } }
}

struct CycleProjectIntent: AppIntent {
    static var title: LocalizedStringResource = "Business suivant"
    static var isDiscoverable = false

    init() {}

    func perform() async throws -> some IntentResult {
        let ids = (MoneyMakerClient.cachedOverview?.projects ?? []).map(\.projectId)
        let order: [String?] = [nil] + ids
        let i = order.firstIndex(where: { $0 == MMShared.widgetProjectId }) ?? 0
        MMShared.widgetProjectId = order[(i + 1) % order.count]
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}

// MARK: - Bouton « direct » (Live Activity) depuis un widget

extension MMShared {
    /// Dernier état connu du direct (l'extension ne voit pas toujours les activités de l'app).
    static var liveRunning: Bool {
        get { MM.read("liveRunning").map { $0.first == 1 } ?? false }
        set { MM.write("liveRunning", Data([newValue ? 1 : 0])) }
    }
}

/// `LiveActivityIntent` : exécuté dans le processus de l'app (même lancée en arrière-plan),
/// seul autorisé à démarrer une Live Activity. Le type est compilé dans les deux cibles.
struct ToggleLiveActivityIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Direct des revenus"
    static var isDiscoverable = false

    init() {}

    func perform() async throws -> some IntentResult {
        let running = Activity<RevenueActivityAttributes>.activities.contains { $0.activityState == .active || $0.activityState == .stale }
        if running {
            for a in Activity<RevenueActivityAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) }
            MMShared.liveRunning = false
            try? await MoneyMakerClient.stored.registerDevice(["liveActivity": ["updateToken": NSNull()]])
        } else if ActivityAuthorizationInfo().areActivitiesEnabled {
            let t = (try? await MoneyMakerClient.stored.today()) ?? MMShared.cachedToday ?? .placeholder
            let activity = try Activity.request(attributes: RevenueActivityAttributes(title: String(localized: "Aujourd'hui")),
                                                content: ActivityContent(state: .init(today: t), staleDate: .now.addingTimeInterval(3 * 3600), relevanceScore: 100),
                                                pushType: .token)
            MMShared.liveRunning = true
            // Jeton de mise à jour : l'app n'est peut-être pas au premier plan pour l'observer.
            await withTaskGroup(of: Void.self) { g in
                g.addTask {
                    for await token in activity.pushTokenUpdates {
                        try? await MoneyMakerClient.stored.registerDevice(["liveActivity": ["updateToken": token.hex]])
                        break
                    }
                }
                g.addTask { try? await Task.sleep(nanoseconds: 8_000_000_000) }
                await g.next()
                g.cancelAll()
            }
        }
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
