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

    static let placeholder = Overview(currency: "EUR", periodDays: 30, mrrMicros: 4_280_000_000, revenueMicros: 4_910_000_000,
        activeSubscriptions: 612, activeTrials: 48, newCustomers: 1_204, projects: [], generatedAt: Date().timeIntervalSince1970 * 1000)

    /// Daily revenue across every business, oldest first, for the last `days` days.
    func dailyRevenue(days: Int = 30) -> [(date: Date, micros: Int)] {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "UTC")
        return (0..<days).reversed().map { i in
            let d = Date().addingTimeInterval(Double(-i) * 86400)
            let key = f.string(from: d)
            return (d, projects.reduce(0) { $0 + ($1.revenueByDay[key] ?? 0) })
        }
    }
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

    func overview(days: Int = 30) async throws -> Overview {
        let o: Overview = try await get("overview?days=\(days)")
        if days == 30, let data = try? JSONEncoder().encode(o) {
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
