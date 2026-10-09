import Foundation
import Security
import WidgetKit

enum MM {
    static let baseURL = URL(string: "https://moneymaker-io.web.app/v1")!
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
        ["NEW_COUNTRY": "Nouveau pays", "TOP_100": "Retour dans le top 100", "TOP_10": "Top 10", "TOP_1": "Numéro 1",
         "JUMP": "Forte hausse", "DROP": "Forte baisse", "LEFT_CHART": "Sortie du classement"][type] ?? type
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
    var chartLabel: String { (["free": "Gratuites", "paid": "Payantes", "grossing": "Revenus"][chart] ?? chart) + (scope == "genre" ? " · catégorie" : "") }
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

struct APIError: LocalizedError { let message: String; var errorDescription: String? { message } }

struct MoneyMakerClient {
    var token: String?

    static var stored: MoneyMakerClient { MoneyMakerClient(token: MM.read("pat").flatMap { String(data: $0, encoding: .utf8) }) }

    static func save(token: String?) {
        MM.write("pat", token.map { Data($0.utf8) })
        if token == nil { MM.write("overview", nil) }
        WidgetCenter.shared.reloadAllTimelines()
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        guard let token, !token.isEmpty else { throw APIError(message: "Ajoute ton jeton personnel (mm_pat_…).") }
        var req = URLRequest(url: URL(string: "\(MM.baseURL.absoluteString)/\(path)")!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 20
        let (data, res) = try await URLSession.shared.data(for: req)
        guard let http = res as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            throw APIError(message: msg ?? "Erreur \((res as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func overview(days: Int = 28) async throws -> Overview {
        let o: Overview = try await get("overview?days=\(days)")
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

extension Int {
    func money(_ currency: String, compact: Bool = false) -> String {
        let value = Double(self) / 1_000_000
        if compact && abs(value) >= 10_000 {
            let sym = Locale.current.currencySymbol.flatMap { _ in
                let f = NumberFormatter(); f.numberStyle = .currency; f.currencyCode = currency; return f.currencySymbol } ?? currency
            let (v, suffix) = abs(value) >= 1_000_000 ? (value / 1_000_000, " M") : (value / 1000, " k")
            return "\(v.formatted(.number.precision(.fractionLength(0...1))))\(suffix) \(sym)"
        }
        return value.formatted(.currency(code: currency).precision(.fractionLength(abs(value) >= 1000 ? 0 : 2)))
    }
}
