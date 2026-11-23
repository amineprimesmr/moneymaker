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
    /// nil = téléchargements pas encore connus (ni chiffres Apple, ni installations vues par le SDK).
    var downloads: Int? = nil
    var hasTrials: Bool? = nil
    var revenueByCountry: [String: Int]? = nil
    /// "apple" (chiffres officiels), "live" (installations vues par le SDK, en direct), "mixed" (Apple complété en direct).
    var downloadsSource: String? = nil
    /// Téléchargements par jour (Apple, complétés en direct par les installations).
    var downloadsByDay: [String: Int]? = nil
    /// Installations vues par le SDK sur la période.
    var installs: Int? = nil
    /// Icône App Store de l'app du business (512 px), si suivie.
    var iconUrl: String? = nil
    /// Sources de revenus connectées : app_store, stripe, play_store…
    var stores: [String]? = nil
    /// "app" (app mobile), "web" (SaaS, sans téléchargements), "hybrid" (app + paiements web), nil (inconnu / ancien serveur).
    var kind: String? = nil
    /// Clients qui ont payé pour la première fois sur la période (abonnement, essai converti, achat unique).
    var newPayingCustomers: Int? = nil
    /// Ventes brutes de la période (jamais négatives) ; absent d'un ancien serveur → revenu net.
    var revenueMicros: Int? = nil
    /// Remboursements de la période (positif).
    var refundsMicros: Int? = nil
    /// Remboursements par jour, à côté de `revenueByDay` (qui ne contient plus que les ventes).
    var refundsByDay: [String: Int]? = nil
    var id: String { projectId }

    /// Business avec une app mobile : seuls ceux-là ont des téléchargements.
    var isApp: Bool {
        if let kind { return kind != "web" }
        let st = stores ?? []
        return st.contains("app_store") || st.contains("play_store") || st.contains("google_play") || downloads != nil
    }
    /// Libellé court du type : « App », « Web » ou « App + Web ».
    var kindLabel: String? {
        switch kind {
        case "app": String(localized: "App")
        case "web": String(localized: "Web")
        case "hybrid": String(localized: "App + Web")
        default: nil
        }
    }

    /// Revenu affiché en titre : solde net (ventes − remboursements), négatif si les remboursements dépassent les ventes.
    var shownRevenueMicros: Int { netRevenueMicros }
}

/// Mois calendaire : la période « 28 J » devient « depuis le 1er du mois » (réglage, mémorisé).
enum CalendarMonth {
    static var enabled: Bool {
        get { UserDefaults.standard.bool(forKey: "mm.calendarMonth") }
        set { UserDefaults.standard.set(newValue, forKey: "mm.calendarMonth") }
    }
    /// 1er du mois en cours, à minuit dans le fuseau de l'utilisateur.
    static var start: Date { Calendar.current.dateInterval(of: .month, for: Date())?.start ?? Date() }
    /// Nombre de jours écoulés, aujourd'hui compris (le 13 → 13).
    static var days: Int { Calendar.current.component(.day, from: Date()) }
    /// « novembre », dans la langue de l'app.
    static var name: String { Date().formatted(.dateTime.month(.wide)) }
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
    /// Début imposé de la période (mois calendaire), en ms ; nil = N derniers jours glissants.
    var periodStart: Double? = nil
    /// Remboursements de la période (positif) ; `revenueMicros` = ventes brutes (nouveau serveur).
    var refundsMicros: Int? = nil
    /// Ventes − remboursements.
    var netRevenueMicros: Int? = nil
    /// "apple", "live" ou "mixed" (voir ProjectSummary.downloadsSource).
    var downloadsSource: String? = nil

    /// Revenu affiché en titre : solde net (ventes − remboursements), peut être négatif.
    var shownRevenueMicros: Int { netRevenueMicros ?? (revenueMicros - (refundsMicros ?? 0)) }
    /// Téléchargements comptés en direct (au moins un business suit les installations par le SDK).
    var downloadsLive: Bool { downloadsSource == "live" || downloadsSource == "mixed" || projects.contains { $0.downloadsSource == "live" || $0.downloadsSource == "mixed" } }
    /// Téléchargements par jour, tous business confondus.
    var mergedDownloadsByDay: [String: Int] {
        projects.reduce(into: [:]) { acc, p in for (d, n) in p.downloadsByDay ?? [:] { acc[d, default: 0] += n } }
    }

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
    var developer: String? = nil
    var url: String? = nil
    var rankedAt: Double? = nil
    let own: Bool?
    let rating: Double?
    let ratingCount: Int?
    let countriesRanked: Int?
    let bestRank: Int?
    let topRankings: [Top]?
    var id: String { appId }
}

struct AppSheet: Decodable {
    let scanning: Bool
    let ranks: [AppRank]
    let ratings: [AppRating]
    let reviews: [AppReview]
}

struct AppRank: Codable, Hashable {
    struct Point: Codable, Hashable { let t: Double; let r: Int? }
    let cc: String
    let chart: String
    let scope: String
    let rank: Int?
    let prevRank: Int?
    let bestRank: Int?
    let bestAt: Double?
    let firstRankedAt: Double?
    let history: [Point]?
}

struct AppRating: Codable, Hashable {
    let cc: String
    let average: Double
    let count: Int
}

struct AppReview: Codable, Identifiable, Hashable {
    let id: String
    let country: String
    let rating: Int
    let title: String
    let content: String
    let author: String
    let at: Double
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
    var isTrial: Bool? = nil
    /// Nom lisible du produit (ex. nom du produit Stripe), quand le serveur le connaît.
    var productName: String? = nil
}

struct APIError: LocalizedError {
    let message: String; var status: Int = 0; var errorDescription: String? { message }

    /// Le serveur écrit ses messages en français : l'app les affiche dans la langue de l'appareil, d'après leur code.
    /// Un code brut (« route_not_found ») n'est jamais montré : message lisible selon le statut HTTP.
    static func server(_ data: Data, status: Int) -> APIError {
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let code = body?["error"] as? String
        let raw = (body?["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        // Message du serveur (déjà traduit d'après Accept-Language) gardé s'il est rédigé, pas un identifiant
        // technique ; sinon, texte générique traduit.
        let readable = raw.flatMap { m -> String? in
            guard !m.isEmpty, m != code, m.range(of: "^[a-z0-9_.:-]+$", options: .regularExpression) == nil else { return nil }
            return m
        }
        return APIError(message: localized(code: code) ?? readable ?? generic(status), status: status)
    }

    /// Message lisible quand le code n'est pas connu de l'app.
    static func generic(_ status: Int) -> String {
        switch status {
        case 401: return String(localized: "Ta session a expiré. Reconnecte-toi.")
        case 403: return String(localized: "Tu n'as pas accès à cette action.")
        case 404: return String(localized: "Cette fonction n'est pas encore disponible. Mets l'app à jour ou réessaie plus tard.")
        case 408, 504: return String(localized: "Le serveur met trop de temps à répondre. Réessaie dans un instant.")
        case 429: return String(localized: "Trop de requêtes, réessaie dans une minute.")
        case 500...599: return String(localized: "Le serveur a rencontré un problème. Réessaie dans un instant.")
        default: return String(localized: "Une erreur est survenue (code \(status)). Réessaie dans un instant.")
        }
    }

    private static func localized(code: String?) -> String? {
        switch code {
        case "invalid_token": return String(localized: "Ta session a expiré. Reconnecte-toi.")
        case "route_not_found": return String(localized: "Cette fonction n'est pas encore disponible. Mets l'app à jour ou réessaie plus tard.")
        case "internal_error": return String(localized: "Le serveur a rencontré un problème. Réessaie dans un instant.")
        case "forbidden": return String(localized: "Tu n'as pas accès à cette action.")
        case "project_not_found": return String(localized: "Business introuvable. Il a peut-être été supprimé.")
        case "too_many", "too_many_attempts": return String(localized: "Trop de requêtes, réessaie dans une minute.")
        case "message_required": return String(localized: "Écris d'abord ton message.")
        case "confirmation_required": return String(localized: "Confirmation requise pour cette action.")
        case "not_supported": return String(localized: "Cette action n'est pas prise en charge.")
        case "demo_read_only": return String(localized: "Mode démo : lecture seule. Cette action est désactivée.")
        case "pro_required": return String(localized: "Le plan gratuit inclut 1 business. MoneyMaker Pro les débloque tous.")
        case "rate_limited": return String(localized: "Trop de requêtes, réessaie dans une minute.")
        case "purchase_other_account": return String(localized: "Cet achat est rattaché à un autre compte MoneyMaker.")
        case "invalid_transaction": return String(localized: "Transaction App Store invalide.")
        case "billing_unavailable": return String(localized: "Le paiement n'est pas disponible pour le moment.")
        case "apns_not_configured": return String(localized: "Les notifications ne sont pas encore disponibles.")
        case "no_device": return String(localized: "Connecte-toi dans l'app et autorise les notifications.")
        case "insufficient_role": return String(localized: "Ton rôle ne permet pas cette action.")
        case "insufficient_scope": return String(localized: "Cette connexion est en lecture seule.")
        case "missing_key": return String(localized: "Colle ta clé personnelle PostHog.")
        case "invalid_key": return String(localized: "La clé personnelle PostHog commence par phx_.")
        case "invalid_host": return String(localized: "Serveur PostHog invalide.")
        case "invalid_project_id": return String(localized: "L'identifiant du projet PostHog est un nombre.")
        case "posthog_unauthorized": return String(localized: "Clé PostHog refusée : il faut une clé personnelle avec le droit Query.")
        case "posthog_project_not_found": return String(localized: "Projet PostHog introuvable.")
        case "posthog_error": return String(localized: "PostHog ne répond pas, réessaie.")
        case "invalid_website": return String(localized: "L'adresse doit commencer par https://.")
        case "invalid_image": return String(localized: "Image introuvable ou illisible à cette adresse.")
        case "invite_not_found": return String(localized: "Invitation introuvable ou déjà utilisée.")
        case "invite_expired": return String(localized: "Invitation expirée.")
        case "last_owner": return String(localized: "Le dernier propriétaire ne peut pas quitter le projet.")
        default: return nil
        }
    }
}

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

    /// Ce client parle pour le compte enregistré : seul lui peut écrire les caches partagés avec les
    /// widgets (une réponse arrivée après une déconnexion ou un changement de compte est ignorée).
    var ownsSharedCache: Bool { token != nil && token == MoneyMakerClient.stored.token }

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
            throw APIError.server(data, status: (res as? HTTPURLResponse)?.statusCode ?? 0)
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

    func overview(days: Int = 28, since: Date? = nil) async throws -> Overview {
        // Devise d'affichage choisie dans les Réglages (sinon celle du compte).
        let cur = MoneyMakerClient.displayCurrency.map { "&currency=\($0)" } ?? ""
        let start = since.map { "&since=\(Int($0.timeIntervalSince1970 * 1000))" } ?? ""
        let o: Overview = try await get("overview?days=\(days)\(cur)\(start)")
        // Le cache des widgets reste sur 28 jours glissants.
        if days == 28, since == nil, ownsSharedCache, let data = try? JSONEncoder().encode(o) {
            MM.write("overview", data)
            // Un widget charge aussi cet aperçu : s'il relançait les widgets, ils se relanceraient sans fin.
            if !Bundle.main.bundlePath.hasSuffix(".appex") { WidgetCenter.shared.reloadAllTimelines() }
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
        if ownsSharedCache, let data = try? JSONEncoder().encode(Array(r.alerts.prefix(10))) { MM.write("alerts", data) }
        return r.alerts
    }

    func trackedApps(projectId: String) async throws -> [TrackedAppSummary] {
        struct R: Decodable { let apps: [TrackedAppSummary] }
        let r: R = try await get("projects/\(projectId)/appstore")
        return r.apps
    }

    func appSheet(appId: String) async throws -> AppSheet {
        try await get("appstore/\(appId)/sheet")
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
