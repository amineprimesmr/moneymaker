import Foundation
import Security
import WidgetKit

enum MM {
    static let baseURL = URL(string: "https://usemoneymaker.com/v1")!
    /// Shared with the widget extension through a keychain access group (no App Group needed).
    static let accessGroup = "F2CJGJ69XU.io.moneymaker.shared"

    static func read(_ key: String) -> Data? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "io.moneymaker",
                                kSecAttrAccount as String: key, kSecAttrAccessGroup as String: accessGroup, kSecReturnData as String: true]
        var out: AnyObject?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    static func write(_ key: String, _ data: Data?) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "io.moneymaker",
                                kSecAttrAccount as String: key, kSecAttrAccessGroup as String: accessGroup]
        SecItemDelete(q as CFDictionary)
        guard let data else { return }
        var add = q
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}

struct ProjectSummary: Codable, Identifiable, Hashable {
    let projectId: String
    let name: String
    let currency: String
    let mrrMicros: Int
    let netRevenueMicros: Int
    let activeSubscriptions: Int
    let activeTrials: Int
    let newCustomers: Int
    let trialConversionRate: Double?
    let churnRate: Double?
    let billingIssues: Int
    let revenueByDay: [String: Int]
    var payingCustomers: Int? = nil
    /// nil = téléchargements non disponibles (numéro de fournisseur Apple non renseigné).
    var downloads: Int? = nil
    var hasTrials: Bool? = nil
    var revenueByCountry: [String: Int]? = nil
    /// Icône App Store de l'app du business (512 px), si suivie.
    var iconUrl: String? = nil
    /// Sources de revenus connectées : app_store, stripe, play_store…
    var stores: [String]? = nil
    var id: String { projectId }
}

struct Overview: Codable, Hashable {
    let currency: String
    let periodDays: Int
    let mrrMicros: Int
    let revenueMicros: Int
    let activeSubscriptions: Int
    let activeTrials: Int
    let newCustomers: Int
    let projects: [ProjectSummary]
    let generatedAt: Double
    var payingCustomers: Int? = nil
    var downloads: Int? = nil
    var hasTrials: Bool? = nil

    static let placeholder = Overview(currency: "EUR", periodDays: 30, mrrMicros: 4_280_000_000, revenueMicros: 4_910_000_000,
        activeSubscriptions: 612, activeTrials: 48, newCustomers: 1_204, projects: [], generatedAt: Date().timeIntervalSince1970 * 1000)

    /// Daily revenue across every business, oldest first, for the last `days` days.
    func dailyRevenue(days: Int = 30) -> [(date: Date, micros: Int)] {
        DayKeys.last(days).map { key, d in (d, projects.reduce(0) { $0 + ($1.revenueByDay[key] ?? 0) }) }
    }
}

struct RankingAlert: Codable, Identifiable, Hashable {
    let id: String
    let type: String
    let appName: String?
    let appIcon: String?
    let cc: String
    let chart: String
    let scope: String?
    let rank: Int?
    let prevRank: Int?
    let own: Bool?
    let projectName: String?
    let at: Double
    var projectId: String? = nil

    var title: String {
        ["NEW_COUNTRY": String(localized: "Nouveau pays"), "TOP_100": String(localized: "Retour dans le top 100"), "TOP_10": String(localized: "Top 10"), "TOP_1": String(localized: "Numéro 1"),
         "JUMP": String(localized: "Forte hausse"), "DROP": String(localized: "Forte baisse"), "LEFT_CHART": String(localized: "Sortie du classement")][type] ?? type
    }
    var symbol: String {
        switch type {
        case "TOP_1": return "crown.fill"
        case "TOP_10": return "trophy.fill"
        case "NEW_COUNTRY": return "globe.europe.africa.fill"
        case "JUMP": return "arrow.up.right"
        case "DROP": return "arrow.down.right"
        default: return "chart.line.uptrend.xyaxis"
        }
    }
    var chartLabel: String { (["free": String(localized: "Gratuites"), "paid": String(localized: "Payantes"), "grossing": String(localized: "Revenus")][chart] ?? chart) + (scope == "genre" ? String(localized: " · catégorie") : "") }
}

struct TrackedAppSummary: Codable, Identifiable, Hashable {
    struct Top: Codable, Hashable { let cc: String; let chart: String; let scope: String; let rank: Int; let prevRank: Int? }
    let appId: String
    let name: String?
    let icon: String?
    let own: Bool?
    let rating: Double?
    let ratingCount: Int?
    let countriesRanked: Int?
    let bestRank: Int?
    let topRankings: [Top]?
    var id: String { appId }
}

/// Emoji flag from an ISO alpha-2 code.
func flagEmoji(_ cc: String) -> String {
    guard cc.count == 2 else { return "🌐" }
    return String(String.UnicodeScalarView(cc.uppercased().unicodeScalars.compactMap { UnicodeScalar(127397 + $0.value) }))
}

struct EventItem: Codable, Identifiable, Hashable {
    let id: String
    let type: String
    let appUserId: String?
    let productId: String?
    let store: String?
    let priceMicros: Int?
    let currency: String?
    let at: Double
    let isSandbox: Bool?
}

struct APIError: LocalizedError { let message: String; var status: Int = 0; var errorDescription: String? { message } }

struct MoneyMakerClient {
    var token: String?

    /// Jeton mis en cache dans l'app (le trousseau était relu à chaque appel). Les extensions
    /// (widgets) relisent toujours : l'app peut changer le jeton depuis un autre processus.
    private static let tokenLock = NSLock()
    private static var cachedToken: String??
    private static let cachesToken = !Bundle.main.bundlePath.hasSuffix(".appex")

    static var stored: MoneyMakerClient {
        func load() -> String? { MM.read("pat").flatMap { String(data: $0, encoding: .utf8) } }
        guard cachesToken else { return MoneyMakerClient(token: load()) }
        tokenLock.lock(); defer { tokenLock.unlock() }
        if let t = cachedToken { return MoneyMakerClient(token: t) }
        let t = load()
        cachedToken = .some(t)
        return MoneyMakerClient(token: t)
    }

    static func save(token: String?) {
        MM.write("pat", token.map { Data($0.utf8) })
        tokenLock.lock(); cachedToken = .some(token); tokenLock.unlock()
        if token == nil { MM.write("overview", nil) }
        WidgetCenter.shared.reloadAllTimelines()
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        guard let token, !token.isEmpty else { throw APIError(message: String(localized: "Ajoute ton jeton personnel (mm_pat_…).")) }
        var req = URLRequest(url: URL(string: "\(MM.baseURL.absoluteString)/\(path)")!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 20
        let (data, res) = try await URLSession.shared.data(for: req)
        guard let http = res as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            throw APIError(message: msg ?? String(localized: "Erreur \((res as? HTTPURLResponse)?.statusCode ?? 0)"), status: (res as? HTTPURLResponse)?.statusCode ?? 0)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Devise d'affichage choisie dans les Réglages. Les widgets n'ont pas accès aux préférences de l'app :
    /// l'app la recopie dans le trousseau partagé à chaque lecture, les widgets la lisent là.
    static var displayCurrency: String? {
        let isApp = Bundle.main.bundleURL.pathExtension == "app"
        if isApp {
            let v = UserDefaults.standard.string(forKey: "mm.currency") ?? ""
            let stored = MM.read("currency").flatMap { String(data: $0, encoding: .utf8) } ?? ""
            if v != stored { MM.write("currency", v.isEmpty ? nil : Data(v.utf8)) }
            return v.isEmpty ? deviceCurrency : v
        }
        return MM.read("currency").flatMap { String(data: $0, encoding: .utf8) }.flatMap { $0.isEmpty ? nil : $0 } ?? deviceCurrency
    }
    /// « Auto » = devise de l'iPhone (€ en France), jamais celle d'un business pris au hasard.
    private static var deviceCurrency: String? {
        let c = Locale.current.currency?.identifier ?? "EUR"
        return ["EUR", "USD", "GBP", "CHF", "CAD", "AUD", "JPY"].contains(c) ? c : "USD"
    }

    func overview(days: Int = 28) async throws -> Overview {
        // Devise d'affichage choisie dans les Réglages (sinon celle du compte).
        let cur = MoneyMakerClient.displayCurrency.map { "&currency=\($0)" } ?? ""
        let o: Overview = try await get("overview?days=\(days)\(cur)")
        if days == 28, let data = try? JSONEncoder().encode(o) {
            MM.write("overview", data)
            WidgetCenter.shared.reloadAllTimelines()
        }
        return o
    }

    func events(projectId: String) async throws -> [EventItem] {
        struct R: Decodable { let events: [EventItem] }
        let r: R = try await get("projects/\(projectId)/events?limit=50")
        return r.events
    }

    func alerts() async throws -> [RankingAlert] {
        struct R: Decodable { let alerts: [RankingAlert] }
        let r: R = try await get("alerts")
        if let data = try? JSONEncoder().encode(Array(r.alerts.prefix(10))) { MM.write("alerts", data) }
        return r.alerts
    }

    func trackedApps(projectId: String) async throws -> [TrackedAppSummary] {
        struct R: Decodable { let apps: [TrackedAppSummary] }
        let r: R = try await get("projects/\(projectId)/appstore")
        return r.apps
    }

    static var cachedAlerts: [RankingAlert] {
        MM.read("alerts").flatMap { try? JSONDecoder().decode([RankingAlert].self, from: $0) } ?? []
    }

    static var cachedOverview: Overview? {
        MM.read("overview").flatMap { try? JSONDecoder().decode(Overview.self, from: $0) }
    }
}

/// Caches de `money` : appelé pour chaque ligne, chaque libellé de graphique et chaque tuile à
/// chaque rendu. La regex compilée et le résultat formaté sont réutilisés (NSCache est thread-safe,
/// le widget et les tâches de fond peuvent aussi formater).
private enum MoneyCache {
    static let results: NSCache<NSString, NSString> = { let c = NSCache<NSString, NSString>(); c.countLimit = 2000; return c }()
    static let symbolGap = try! NSRegularExpression(pattern: "[\\s\u{00A0}\u{202F}]+(?=\\D+$)")
    static let symbols: NSCache<NSString, NSString> = NSCache()
    static func symbol(_ currency: String) -> String {
        if let s = symbols.object(forKey: currency as NSString) { return s as String }
        let f = NumberFormatter(); f.numberStyle = .currency; f.currencyCode = currency
        let s = f.currencySymbol ?? currency
        symbols.setObject(s as NSString, forKey: currency as NSString)
        return s
    }
}

extension Int {
    func money(_ currency: String, compact: Bool = false) -> String {
        let key = "\(self)|\(currency)|\(compact ? 1 : 0)" as NSString
        if let hit = MoneyCache.results.object(forKey: key) { return hit as String }
        let out = formatMoney(currency, compact: compact)
        MoneyCache.results.setObject(out as NSString, forKey: key)
        return out
    }

    private func formatMoney(_ currency: String, compact: Bool) -> String {
        let value = Double(self) / 1_000_000
        if compact && abs(value) >= 10_000 {
            let sym = Locale.current.currencySymbol.flatMap { _ in MoneyCache.symbol(currency) } ?? currency
            let (v, suffix) = abs(value) >= 1_000_000 ? (value / 1_000_000, String(localized: " M", comment: "Suffixe compact des millions")) : (value / 1000, String(localized: " k", comment: "Suffixe compact des milliers"))
            return "\(v.formatted(.number.locale(Locale.current).precision(.fractionLength(0...1))))\(suffix)\(sym)"
        }
        // Toujours à la française (« 1 234 € », « 9,99 € ») et jamais de « ,00 » inutile.
        let whole = abs(value) >= 1000 || value.rounded() == value
        let text = value.formatted(.currency(code: currency).locale(Locale.current).precision(.fractionLength(whole ? 0 : 2)))
        // Symbole collé au montant : « 12€ » (les espaces des milliers restent).
        return MoneyCache.symbolGap.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "")
    }
}
