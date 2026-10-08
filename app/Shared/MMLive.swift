//
//  MMLive.swift
//  MoneyMaker — temps réel partagé par l'app et l'extension widgets :
//  revenus du jour, flux des ventes, appareil (push), Live Activity, objectif MRR,
//  choix du business pour les widgets configurables.
//

import Foundation
import ActivityKit
import AppIntents
import WidgetKit

// MARK: - Modèles

struct Today: Codable, Hashable {
    struct Last: Codable, Hashable {
        let projectName: String
        let amountMicros: Int
        let currency: String
        let productId: String?
        let country: String?
        let at: Double
    }
    let currency: String
    let tz: String
    let dayStart: Double
    let revenueMicros: Int
    let refundsMicros: Int
    let sales: Int
    let renewals: Int
    let trials: Int
    let newSubscribers: Int
    /// Revenu net cumulé par heure locale (24 valeurs, micros).
    let hourly: [Int]
    let last: Last?
    let generatedAt: Double?

    var netMicros: Int { revenueMicros - refundsMicros }
    var transactions: Int { sales + renewals }

    static let placeholder = Today(currency: "EUR", tz: "Europe/Paris", dayStart: Date().timeIntervalSince1970 * 1000, revenueMicros: 1_284_000_000,
        refundsMicros: 0, sales: 38, renewals: 21, trials: 14, newSubscribers: 31,
        hourly: [0, 0, 9, 9, 18, 18, 40, 88, 130, 190, 260, 340, 420, 470, 560, 640, 720, 790, 880, 960, 1040, 1150, 1230, 1284].map { $0 * 1_000_000 },
        last: Last(projectName: "Mon app", amountMicros: 59_990_000, currency: "EUR", productId: "annual", country: "FR", at: Date().timeIntervalSince1970 * 1000),
        generatedAt: nil)
}

struct FeedEvent: Codable, Identifiable, Hashable {
    let id: String
    let projectId: String
    let projectName: String?
    let type: String
    let productId: String?
    let priceMicros: Int?
    let currency: String?
    let country: String?
    let store: String?
    let isSandbox: Bool?
    let isTrial: Bool?
    let periodMonths: Double?
    let at: Double

    var date: Date { Date(timeIntervalSince1970: at / 1000) }
    var isRevenue: Bool { ["INITIAL_PURCHASE", "NON_RENEWING_PURCHASE", "TRIAL_CONVERTED", "RENEWAL"].contains(type) && isTrial != true && (priceMicros ?? 0) > 0 }
    var title: String {
        ["INITIAL_PURCHASE": "Nouvel abonné", "RENEWAL": "Renouvellement", "TRIAL_STARTED": "Essai démarré", "TRIAL_CONVERTED": "Essai converti",
         "CANCELLATION": "Annulation", "UNCANCELLATION": "Réactivation", "EXPIRATION": "Expiration", "BILLING_ISSUE": "Problème de paiement",
         "BILLING_RECOVERED": "Paiement récupéré", "REFUND": "Remboursement", "PRODUCT_CHANGE": "Changement d'offre",
         "NON_RENEWING_PURCHASE": "Achat", "GRANT": "Accès offert", "REVOKED": "Révoqué", "PAUSED": "En pause"][type] ?? type
    }
    var symbol: String {
        switch type {
        case "INITIAL_PURCHASE", "TRIAL_CONVERTED", "NON_RENEWING_PURCHASE": return "arrow.up.right"
        case "RENEWAL", "BILLING_RECOVERED", "UNCANCELLATION": return "arrow.clockwise"
        case "TRIAL_STARTED": return "sparkles"
        case "REFUND", "REVOKED": return "arrow.uturn.backward"
        case "BILLING_ISSUE": return "exclamationmark.triangle"
        default: return "circle"
        }
    }
    var amountText: String? {
        guard let m = priceMicros, m > 0, let c = currency, isTrial != true else { return nil }
        return (type == "REFUND" ? -m : m).money(c)
    }

    static let samples: [FeedEvent] = [
        .init(id: "1", projectId: "p", projectName: "Mon app", type: "INITIAL_PURCHASE", productId: "annual", priceMicros: 59_990_000, currency: "EUR", country: "FR", store: "app_store", isSandbox: false, isTrial: false, periodMonths: 12, at: Date().timeIntervalSince1970 * 1000 - 60_000),
        .init(id: "2", projectId: "p", projectName: "Mon app", type: "RENEWAL", productId: "monthly", priceMicros: 9_990_000, currency: "USD", country: "US", store: "app_store", isSandbox: false, isTrial: false, periodMonths: 1, at: Date().timeIntervalSince1970 * 1000 - 600_000),
        .init(id: "3", projectId: "p", projectName: "Autre app", type: "TRIAL_STARTED", productId: "annual", priceMicros: 0, currency: "EUR", country: "DE", store: "play_store", isSandbox: false, isTrial: true, periodMonths: 12, at: Date().timeIntervalSince1970 * 1000 - 1_800_000),
        .init(id: "4", projectId: "p", projectName: "Mon app", type: "TRIAL_CONVERTED", productId: "weekly", priceMicros: 4_990_000, currency: "GBP", country: "GB", store: "app_store", isSandbox: false, isTrial: false, periodMonths: 0.25, at: Date().timeIntervalSince1970 * 1000 - 3_600_000),
    ]
}

struct PushPrefs: Codable, Hashable {
    var sales = true, renewals = true, trials = true, churn = false, billing = true, refunds = true, rankings = true
    var dailySummary = true, sandbox = false, sound = true, liveActivityAuto = true
    var mutedProjects: [String] = []
}

// MARK: - Préférences locales partagées (trousseau)

enum MMShared {
    /// Identifiant stable de l'appareil pour /v1/devices, partagé avec les widgets.
    static var deviceId: String {
        if let d = MM.read("deviceId").flatMap({ String(data: $0, encoding: .utf8) }) { return d }
        let id = UUID().uuidString
        MM.write("deviceId", Data(id.utf8))
        return id
    }

    /// Objectif de MRR mensuel (unités, pas micros) — jauge des widgets.
    static var mrrGoal: Int? {
        get { MM.read("mrrGoal").flatMap { String(data: $0, encoding: .utf8) }.flatMap(Int.init) }
        set { MM.write("mrrGoal", newValue.map { Data(String($0).utf8) }) }
    }

    static var prefs: PushPrefs {
        get { MM.read("prefs").flatMap { try? JSONDecoder().decode(PushPrefs.self, from: $0) } ?? PushPrefs() }
        set { MM.write("prefs", try? JSONEncoder().encode(newValue)) }
    }

    static var cachedToday: Today? {
        MM.read("today").flatMap { try? JSONDecoder().decode(Today.self, from: $0) }
    }

    static var cachedFeed: [FeedEvent] {
        MM.read("feed").flatMap { try? JSONDecoder().decode([FeedEvent].self, from: $0) } ?? []
    }

    static var apnsEnvironment: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }
}

// MARK: - API temps réel

extension MoneyMakerClient {
    func send<T: Decodable>(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> T {
        guard let token, !token.isEmpty else { throw APIError(message: "Ajoute ton jeton personnel (mm_pat_…).") }
        var req = URLRequest(url: URL(string: "\(MM.baseURL.absoluteString)/\(path)")!)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 20
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, res) = try await URLSession.shared.data(for: req)
        guard let http = res as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            throw APIError(message: msg ?? "Erreur \((res as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Revenus du jour dans le fuseau de l'appareil. Mis en cache pour les widgets.
    func today() async throws -> Today {
        let tz = TimeZone.current.identifier.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "UTC"
        let t: Today = try await get("today?tz=\(tz)")
        if let data = try? JSONEncoder().encode(t) { MM.write("today", data) }
        return t
    }

    func feed(limit: Int = 30) async throws -> [FeedEvent] {
        struct R: Decodable { let events: [FeedEvent] }
        let r: R = try await get("feed?limit=\(limit)")
        if let data = try? JSONEncoder().encode(Array(r.events.prefix(20))) { MM.write("feed", data) }
        return r.events
    }

    struct Ack: Decodable {}

    /// Enregistre / met à jour l'appareil. Seuls les champs fournis changent côté serveur.
    func registerDevice(_ fields: [String: Any]) async throws {
        var body = fields
        body["tz"] = TimeZone.current.identifier
        body["env"] = MMShared.apnsEnvironment
        let _: Ack = try await send("PUT", "devices/\(MMShared.deviceId)", body: body)
    }

    func savePrefs(_ prefs: PushPrefs) async throws {
        let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(prefs))
        try await registerDevice(["prefs": obj])
    }

    func testPush() async throws {
        let _: Ack = try await send("POST", "devices/\(MMShared.deviceId)/test")
    }
}

extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}

// MARK: - Live Activity

/// Doit rester aligné avec `liveActivityState()` dans backend/functions/src/push.ts.
struct RevenueActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var revenueMicros: Int
        var currency: String
        var sales: Int
        var trials: Int
        var lastProject: String?
        var lastAmountMicros: Int
        var lastCurrency: String
        var hourly: [Double]
        var updatedAt: Int

        init(today t: Today) {
            revenueMicros = t.netMicros; currency = t.currency; sales = t.transactions; trials = t.trials
            lastProject = t.last?.projectName; lastAmountMicros = t.last?.amountMicros ?? 0; lastCurrency = t.last?.currency ?? t.currency
            hourly = t.hourly.map { Double($0) / 1e6 }; updatedAt = Int(Date().timeIntervalSince1970)
        }
    }
    var title: String
}

// MARK: - Configuration des widgets (choix du business, objectif)

struct ProjectEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Business"
    static var defaultQuery = ProjectQuery()
    let id: String
    let name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
    static let all = ProjectEntity(id: "*", name: "Tous les business")
}

struct ProjectQuery: EntityQuery {
    private func everything() -> [ProjectEntity] {
        [.all] + (MoneyMakerClient.cachedOverview?.projects ?? []).map { ProjectEntity(id: $0.projectId, name: $0.name) }
    }
    func entities(for identifiers: [String]) async throws -> [ProjectEntity] { everything().filter { identifiers.contains($0.id) } }
    func suggestedEntities() async throws -> [ProjectEntity] { everything() }
    func defaultResult() async -> ProjectEntity? { .all }
}

struct MRRWidgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "MRR"
    static var description = IntentDescription("Ton MRR, pour tous tes business ou un seul, avec un objectif.")
    @Parameter(title: "Business") var project: ProjectEntity?
    @Parameter(title: "Objectif de MRR", description: "En unités de ta devise, ex. 10000") var goal: Int?
    init() {}
}
