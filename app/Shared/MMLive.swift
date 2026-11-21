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
    /// Revenu cumulé par heure locale (24 valeurs, micros). Jamais négatif une fois décodé :
    /// un remboursement en début de journée ne fait pas plonger la courbe sous zéro.
    let hourly: [Int]
    /// Téléchargements du jour, en direct (installations vues par le SDK). Absent d'un ancien serveur.
    var installs: Int? = nil
    let last: Last?
    let generatedAt: Double?

    var netMicros: Int { revenueMicros - refundsMicros }
    /// Chiffre affiché en titre : solde net du jour (ventes − remboursements), négatif si les
    /// remboursements dépassent les ventes. Le détail des remboursements reste sur une ligne à part.
    var shownMicros: Int { revenueMicros - refundsMicros }
    /// « −12 € remboursé », seulement s'il y a eu des remboursements aujourd'hui.
    var refundNote: String? {
        refundsNote(refundsMicros, currency)
    }
    var transactions: Int { sales + renewals }
    /// Données d'aujourd'hui (un cache d'hier ne doit pas passer pour la journée en cours).
    var isForToday: Bool { Calendar.current.isDateInToday(Date(timeIntervalSince1970: dayStart / 1000)) }

    /// Journée sans donnée : zéro honnête, jamais de faux chiffres hors des aperçus de la galerie.
    static func empty(currency: String? = nil) -> Today {
        Today(currency: currency ?? MoneyMakerClient.displayCurrency ?? "EUR", tz: TimeZone.current.identifier,
              dayStart: Calendar.current.startOfDay(for: Date()).timeIntervalSince1970 * 1000, revenueMicros: 0, refundsMicros: 0,
              sales: 0, renewals: 0, trials: 0, newSubscribers: 0, hourly: Array(repeating: 0, count: 24), last: nil, generatedAt: nil)
    }

    /// Faux chiffres réservés aux aperçus de la galerie de widgets (`context.isPreview`).
    static let placeholder = Today(currency: "EUR", tz: "Europe/Paris", dayStart: Date().timeIntervalSince1970 * 1000, revenueMicros: 1_284_000_000,
        refundsMicros: 0, sales: 38, renewals: 21, trials: 14, newSubscribers: 31,
        hourly: [0, 0, 9, 9, 18, 18, 40, 88, 130, 190, 260, 340, 420, 470, 560, 640, 720, 790, 880, 960, 1040, 1150, 1230, 1284].map { $0 * 1_000_000 },
        last: Last(projectName: String(localized: "Mon app"), amountMicros: 59_990_000, currency: "EUR", productId: "annual", country: "FR", at: Date().timeIntervalSince1970 * 1000),
        generatedAt: nil)
}

extension Today {
    /// Décodage tolérant : courbe horaire bornée à zéro, champs facultatifs absents acceptés.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        currency = try c.decode(String.self, forKey: .currency)
        tz = try c.decodeIfPresent(String.self, forKey: .tz) ?? TimeZone.current.identifier
        dayStart = try c.decode(Double.self, forKey: .dayStart)
        revenueMicros = try c.decodeIfPresent(Int.self, forKey: .revenueMicros) ?? 0
        refundsMicros = try c.decodeIfPresent(Int.self, forKey: .refundsMicros) ?? 0
        sales = try c.decodeIfPresent(Int.self, forKey: .sales) ?? 0
        renewals = try c.decodeIfPresent(Int.self, forKey: .renewals) ?? 0
        trials = try c.decodeIfPresent(Int.self, forKey: .trials) ?? 0
        newSubscribers = try c.decodeIfPresent(Int.self, forKey: .newSubscribers) ?? 0
        hourly = (try c.decodeIfPresent([Int].self, forKey: .hourly) ?? []).map { max(0, $0) }
        installs = try c.decodeIfPresent(Int.self, forKey: .installs)
        last = try c.decodeIfPresent(Last.self, forKey: .last)
        generatedAt = try c.decodeIfPresent(Double.self, forKey: .generatedAt)
    }
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
    /// Client et achat (fiche transaction, historique de l'abonné).
    var appUserId: String? = nil
    var purchaseId: String? = nil
    var expiresAt: Double? = nil
    var displayMicros: Int? = nil
    var displayCurrency: String? = nil
    /// Nom lisible du produit (ex. nom du produit Stripe), envoyé par le serveur quand il le connaît.
    var productName: String? = nil

    var date: Date { Date(timeIntervalSince1970: at / 1000) }
    var isRevenue: Bool { ["INITIAL_PURCHASE", "NON_RENEWING_PURCHASE", "TRIAL_CONVERTED", "RENEWAL"].contains(type) && isTrial != true && (priceMicros ?? 0) > 0 }
    /// Produit à afficher : son nom lisible s'il existe, sinon son identifiant.
    var productLabel: String? { productName.flatMap { $0.isEmpty ? nil : $0 } ?? productId }
    var title: String { Self.label(type, isTrial: isTrial) }
    /// Mauvaise nouvelle (remboursement, échec de paiement, résiliation) : affichée en rouge.
    var isNegative: Bool { Self.negativeTypes.contains(type) }
    static let negativeTypes: Set<String> = ["REFUND", "REVOKED", "REFUND_REQUESTED", "BILLING_ISSUE", "CANCELLATION", "EXPIRATION"]

    /// Libellé d'un type d'événement, dans la langue de l'app. Un type inconnu reste lisible.
    static func label(_ type: String, isTrial: Bool? = nil) -> String {
        switch type {
        case "INITIAL_PURCHASE": return String(localized: "Nouvel abonné")
        case "RENEWAL": return String(localized: "Renouvellement")
        case "TRIAL_STARTED": return String(localized: "Essai démarré")
        case "TRIAL_CONVERTED": return String(localized: "Essai converti")
        case "CANCELLATION": return isTrial == true ? String(localized: "Essai annulé") : String(localized: "Annulation")
        case "UNCANCELLATION": return String(localized: "Réabonné")
        case "EXPIRATION": return String(localized: "Expiration")
        case "BILLING_ISSUE": return String(localized: "Problème de paiement")
        case "BILLING_RECOVERED": return String(localized: "Paiement récupéré")
        case "REFUND": return String(localized: "Remboursement")
        case "REFUND_REQUESTED": return String(localized: "Demande de remboursement")
        case "REFUND_DECLINED": return String(localized: "Remboursement refusé")
        case "REFUND_REVERSED": return String(localized: "Remboursement annulé")
        case "PRODUCT_CHANGE": return String(localized: "Changement d'offre")
        case "NON_RENEWING_PURCHASE": return String(localized: "Achat")
        case "GRANT": return String(localized: "Accès offert")
        case "REVOKED": return String(localized: "Révoqué")
        case "PAUSED": return String(localized: "En pause")
        case "TEST": return String(localized: "Test")
        default: return type.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
    var symbol: String {
        switch type {
        case "INITIAL_PURCHASE", "TRIAL_CONVERTED", "NON_RENEWING_PURCHASE": return "arrow.up.right"
        case "RENEWAL", "BILLING_RECOVERED", "UNCANCELLATION": return "arrow.clockwise"
        case "TRIAL_STARTED": return "sparkles"
        case "REFUND", "REVOKED": return "arrow.uturn.backward"
        case "REFUND_REQUESTED": return "exclamationmark.bubble"
        case "REFUND_DECLINED", "REFUND_REVERSED": return "checkmark.shield"
        case "BILLING_ISSUE": return "exclamationmark.triangle"
        case "CANCELLATION": return "xmark.circle"
        case "EXPIRATION": return "clock.badge.xmark"
        case "PRODUCT_CHANGE": return "arrow.left.arrow.right"
        case "PAUSED": return "pause.circle"
        default: return "circle"
        }
    }
    /// Montant dans la devise d'affichage (converti par le serveur), sinon d'origine.
    var shownMicros: Int? { displayMicros ?? priceMicros }
    var shownCurrency: String? { displayCurrency ?? currency }

    var amountText: String? {
        guard let m0 = priceMicros, m0 > 0, let c0 = currency, isTrial != true else { return nil }
        // Converti dans la devise d'affichage quand le serveur l'a fait.
        let m = displayMicros ?? m0, c = displayCurrency ?? c0
        return (type == "REFUND" ? -m : m).money(c)
    }

    /// Faux événements réservés aux aperçus de la galerie de widgets (`context.isPreview`).
    static let samples: [FeedEvent] = [
        .init(id: "1", projectId: "p", projectName: String(localized: "Mon app"), type: "INITIAL_PURCHASE", productId: "annual", priceMicros: 59_990_000, currency: "EUR", country: "FR", store: "app_store", isSandbox: false, isTrial: false, periodMonths: 12, at: Date().timeIntervalSince1970 * 1000 - 60_000),
        .init(id: "2", projectId: "p", projectName: String(localized: "Mon app"), type: "RENEWAL", productId: "monthly", priceMicros: 9_990_000, currency: "USD", country: "US", store: "app_store", isSandbox: false, isTrial: false, periodMonths: 1, at: Date().timeIntervalSince1970 * 1000 - 600_000),
        .init(id: "3", projectId: "p", projectName: String(localized: "Autre app"), type: "TRIAL_STARTED", productId: "annual", priceMicros: 0, currency: "EUR", country: "DE", store: "play_store", isSandbox: false, isTrial: true, periodMonths: 12, at: Date().timeIntervalSince1970 * 1000 - 1_800_000),
        .init(id: "4", projectId: "p", projectName: String(localized: "Mon app"), type: "TRIAL_CONVERTED", productId: "weekly", priceMicros: 4_990_000, currency: "GBP", country: "GB", store: "app_store", isSandbox: false, isTrial: false, periodMonths: 0.25, at: Date().timeIntervalSince1970 * 1000 - 3_600_000),
    ]
}

struct PushPrefs: Codable, Hashable {
    var sales = true, renewals = true, trials = true, churn = true, billing = true, refunds = true, rankings = true
    var insights = true
    var dailySummary = true, sandbox = false, sound = true, liveActivityAuto = true
    /// Son des ventes : cash | levelup | none (default : ancien réglage « son système »).
    var saleSound = "cash" { didSet { sound = saleSound != "none" } }
    var mutedProjects: [String] = []
    /// 2 : « Résiliations et expirations » a son propre réglage, activé par défaut.
    var version = 2

    init() {}

    /// Tolérant : une préférence ajoutée plus tard garde sa valeur par défaut au lieu de tout réinitialiser.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = PushPrefs.defaults
        sales = try c.decodeIfPresent(Bool.self, forKey: .sales) ?? d.sales
        renewals = try c.decodeIfPresent(Bool.self, forKey: .renewals) ?? d.renewals
        trials = try c.decodeIfPresent(Bool.self, forKey: .trials) ?? d.trials
        churn = try c.decodeIfPresent(Bool.self, forKey: .churn) ?? d.churn
        billing = try c.decodeIfPresent(Bool.self, forKey: .billing) ?? d.billing
        refunds = try c.decodeIfPresent(Bool.self, forKey: .refunds) ?? d.refunds
        rankings = try c.decodeIfPresent(Bool.self, forKey: .rankings) ?? d.rankings
        insights = try c.decodeIfPresent(Bool.self, forKey: .insights) ?? d.insights
        dailySummary = try c.decodeIfPresent(Bool.self, forKey: .dailySummary) ?? d.dailySummary
        sandbox = try c.decodeIfPresent(Bool.self, forKey: .sandbox) ?? d.sandbox
        sound = try c.decodeIfPresent(Bool.self, forKey: .sound) ?? d.sound
        liveActivityAuto = try c.decodeIfPresent(Bool.self, forKey: .liveActivityAuto) ?? d.liveActivityAuto
        let stored = try c.decodeIfPresent(String.self, forKey: .saleSound) ?? (sound ? d.saleSound : "default")
        // Pièce, Carillon et Pop ont été retirés : ceux qui les avaient choisis passent au cha-ching.
        saleSound = ["coin", "chime", "pop"].contains(stored) ? "cash" : stored
        mutedProjects = try c.decodeIfPresent([String].self, forKey: .mutedProjects) ?? d.mutedProjects
        // Avant la version 2, les résiliations étaient éteintes par défaut et partageaient l'interrupteur
        // des paiements : sans refus explicite (paiements et remboursements actifs), on les active.
        let storedVersion = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        if storedVersion < 2, !churn, billing, refunds { churn = true }
        version = 2
    }

    private static let defaults = PushPrefs()
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

    /// Le jour en cache s'il date bien d'aujourd'hui, sinon une journée à zéro.
    static var todayOrEmpty: Today {
        cachedToday.flatMap { $0.isForToday ? $0 : nil } ?? .empty()
    }

    /// Déconnexion ou sortie de la démo : plus rien de l'ancien compte dans le trousseau partagé
    /// avec les widgets (jeton, chiffres, flux, alertes, historique, objectifs, business suivi).
    /// L'identifiant de l'appareil, la devise et les réglages des notifications restent.
    static func clearAccountData() {
        for key in ["pat", "overview", "today", "feed", "alerts", "history365", "liveExtras", "widgetProject", "mrrGoal", "dailyGoal", "liveRunning"] {
            MM.write(key, nil)
        }
        WidgetCenter.shared.reloadAllTimelines()
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
        guard let token, !token.isEmpty else { throw APIError(message: String(localized: "Ajoute ton jeton personnel (mm_pat_…).")) }
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
            throw APIError.server(data, status: (res as? HTTPURLResponse)?.statusCode ?? 0)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Revenus du jour dans le fuseau de l'appareil. Mis en cache pour les widgets.
    /// Revenus du jour (tous les business, ou un seul). Seule la vue « tous » alimente le cache des widgets.
    func today(projectIds: [String]? = nil) async throws -> Today {
        let tz = TimeZone.current.identifier.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "UTC"
        let t: Today = try await get("today?tz=\(tz)" + (MoneyMakerClient.displayCurrency.map { "&currency=\($0)" } ?? "") + (projectIds.map { "&projectIds=\($0.joined(separator: ","))" } ?? ""))
        if projectIds == nil, ownsSharedCache, let data = try? JSONEncoder().encode(t) { MM.write("today", data) }
        return t
    }

    func feed(limit: Int = 30, projectIds: [String]? = nil) async throws -> [FeedEvent] {
        struct R: Decodable { let events: [FeedEvent] }
        let r: R = try await get("feed?limit=\(limit)" + (MoneyMakerClient.displayCurrency.map { "&currency=\($0)" } ?? "") + (projectIds.map { "&projectIds=\($0.joined(separator: ","))" } ?? ""))
        if projectIds == nil, ownsSharedCache, let data = try? JSONEncoder().encode(Array(r.events.prefix(20))) { MM.write("feed", data) }
        return r.events
    }

    /// Fiche d'un client : achats, total dépensé et tout son historique d'événements.
    func customer(projectId: String, appUserId: String) async throws -> CustomerDetail {
        let id = appUserId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? appUserId
        return try await get("projects/\(projectId)/customers/\(id)")
    }

    struct Ack: Decodable {}

    /// Enregistre / met à jour l'appareil. Seuls les champs fournis changent côté serveur.
    func registerDevice(_ fields: [String: Any]) async throws {
        var body = fields
        body["tz"] = TimeZone.current.identifier
        body["env"] = MMShared.apnsEnvironment
        body["lang"] = MMLang.isFrench ? "fr" : "en"
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
        /// Pays de la dernière vente (facultatif : absent des anciens pushs).
        var lastCountry: String? = nil
        /// Heure de la dernière vente (s, epoch) — effet « tiroir-caisse ».
        var lastSaleAt: Int? = nil

        init(today t: Today) {
            // Ventes brutes du jour, comme le serveur (jamais un total négatif sur l'écran verrouillé).
            revenueMicros = t.shownMicros; currency = t.currency; sales = t.transactions; trials = t.trials
            lastProject = t.last?.projectName; lastAmountMicros = t.last?.amountMicros ?? 0; lastCurrency = t.last?.currency ?? t.currency; lastCountry = t.last?.country
            lastSaleAt = t.last.map { Int($0.at / 1000) }
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
    static let all = ProjectEntity(id: "*", name: String(localized: "Tous les business"))
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


struct CustomerDetail: Decodable {
    struct Purchase: Decodable, Identifiable, Hashable {
        let id: String
        let store: String?
        let productId: String?
        let status: String?
        let active: Bool?
        let purchasedAt: Double?
        let expiresAt: Double?
        let willRenew: Bool?
        let isTrial: Bool?
        let isSandbox: Bool?
        let billingIssue: Bool?
    }
    let appUserId: String
    let purchases: [Purchase]
    let activeEntitlements: [String]?
    let firstSeenAt: Double?
    let lastSeenAt: Double?
    let country: String?
    let totalSpentMicros: Int?
    let isPaying: Bool?
    let currency: String?
    let events: [FeedEvent]
}

/// Texte serveur bilingue : la variante anglaise quand l'app tourne en anglais.
enum MMLang {
    static let isFrench = Bundle.main.preferredLocalizations.first?.hasPrefix("fr") ?? true
    static func pick(_ fr: String?, _ en: String?) -> String? { isFrench ? fr : (en ?? fr) }
}
