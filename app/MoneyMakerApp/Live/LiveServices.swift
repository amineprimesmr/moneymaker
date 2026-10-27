//
//  LiveServices.swift
//  MoneyMaker — notifications push, Live Activity, liens profonds.
//
//  Chemin d'une vente : store → backend (événement) → APNs → ici.
//    • alerte « cha-ching » (son cash.caf, groupée par business, time-sensitive) ;
//    • push WidgetKit (iOS 26) ou silencieux → `WidgetCenter.reloadAllTimelines()` ;
//    • mise à jour de la Live Activity directement par APNs (rien à faire ici).
//  Au premier plan, la bannière s'affiche quand même et l'écran se met à jour.
//

import SwiftUI
import UserNotifications
import ActivityKit
import WidgetKit

extension Notification.Name {
    static let mmLiveEvent = Notification.Name("mmLiveEvent")
}

/// Un push reçu au premier plan déclenche `willPresent` ET `didReceiveRemoteNotification` :
/// on ne publie qu'un `.mmLiveEvent` par rafale (5 s) pour ne pas recharger le flux deux fois.
@MainActor enum LiveEventBus {
    private static var last = Date.distantPast
    static func post() {
        let now = Date()
        guard now.timeIntervalSince(last) > 5 else { return }
        last = now
        NotificationCenter.default.post(name: .mmLiveEvent, object: nil)
    }
}

// MARK: - Navigation par lien profond

@MainActor
final class Router: ObservableObject {
    static let shared = Router()
    enum Destination: Hashable { case today, feed, globe, leaderboard, settings, project(String), charts(String?) }
    @Published var pending: Destination?
    @Published var pendingToken: String?

    func open(_ url: URL) {
        guard url.scheme == "moneymaker" else { return }
        switch url.host {
        case "auth":
            // moneymaker://auth?token=mm_pat_… : connexion directe (lien depuis le dashboard, tests UI).
            if let t = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "token" })?.value, t.hasPrefix("mm_pat_") {
                pendingToken = t
            }
        case "project": if let id = url.pathComponents.dropFirst().first { pending = .project(id) }
        case "feed": pending = .feed
        case "globe": pending = .globe
        case "leaderboard": pending = .leaderboard
        case "settings": pending = .settings
        case "pro": ProPaywall.shared.isPresented = true
        case "charts":
            // moneymaker://charts?project=ID (sans projet : le business affiché).
            pending = .charts(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "project" }?.value)
        default: pending = .today
        }
    }
}

// MARK: - Push

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let open = UNNotificationAction(identifier: "OPEN", title: String(localized: "Voir le détail"), options: [.foreground])
        let live = UNNotificationAction(identifier: "LIVE", title: String(localized: "Suivre en direct"), options: [.foreground], icon: .init(systemImageName: "dot.radiowaves.left.and.right"))
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "SALE", actions: [open, live], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: String(localized: "Nouvelle vente"), options: []),
            UNNotificationCategory(identifier: "EVENT", actions: [open], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "RANKING", actions: [open], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "SUMMARY", actions: [], intentIdentifiers: [], options: []),
        ])
        Task { @MainActor in
            await PushManager.shared.refreshAuthorization()
            if PushManager.shared.status == .authorized || PushManager.shared.status == .provisional { application.registerForRemoteNotifications() }
            LiveActivityManager.shared.observe()
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await PushManager.shared.upload(apnsToken: deviceToken.hex) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in PushManager.shared.lastError = error.localizedDescription }
    }

    /// Push silencieux (iOS 17–18) : on rafraîchit le cache puis les widgets.
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        let client = MoneyMakerClient.stored
        async let t = try? client.today()
        async let f = try? client.feed(limit: 20)
        _ = await (t, f)
        WidgetCenter.shared.reloadAllTimelines()
        await LiveEventBus.post()
        return .newData
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        await LiveEventBus.post()
        WidgetCenter.shared.reloadAllTimelines()
        return [.banner, .list, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        if response.actionIdentifier == "LIVE" {
            await MainActor.run { Task { await LiveActivityManager.shared.start() } }
        }
        if let s = info["url"] as? String, let url = URL(string: s) {
            await MainActor.run { Router.shared.open(url) }
        }
    }
}

@MainActor
final class PushManager: ObservableObject {
    static let shared = PushManager()
    @Published var status: UNAuthorizationStatus = .notDetermined
    @Published var prefs = MMShared.prefs
    @Published var lastError: String?
    @Published var testing = false

    func refreshAuthorization() async {
        let s = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        if s != status { status = s }  // pas de publication inutile (tout l'arbre observe PushManager)
    }

    /// Demande l'autorisation (time-sensitive incluses) puis enregistre l'appareil.
    func requestAuthorization() async {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge, .timeSensitive])) ?? false
        await refreshAuthorization()
        if granted { UIApplication.shared.registerForRemoteNotifications() }
    }

    func upload(apnsToken: String) async {
        let obj = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(MMShared.prefs))) ?? [:]
        do { try await MoneyMakerClient.stored.registerDevice(["apnsToken": apnsToken, "prefs": obj, "currency": MoneyMakerClient.cachedOverview?.currency ?? "EUR"]) }
        catch { lastError = error.localizedDescription }
    }

    func update(_ change: (inout PushPrefs) -> Void) {
        change(&prefs)
        MMShared.prefs = prefs
        let snapshot = prefs
        Task {
            do { try await MoneyMakerClient.stored.savePrefs(snapshot); if lastError != nil { lastError = nil } }
            catch { lastError = error.localizedDescription }
        }
    }

    func sendTest() async {
        testing = true; defer { testing = false }
        do { try await MoneyMakerClient.stored.testPush(); if lastError != nil { lastError = nil } }
        catch { lastError = error.localizedDescription }
    }

    /// À la déconnexion : le serveur oublie cet appareil.
    func forgetDevice(token: String?) async {
        guard let token else { return }
        struct Ack: Decodable {}
        let _: Ack? = try? await MoneyMakerClient(token: token).send("DELETE", "devices/\(MMShared.deviceId)")
    }
}

// MARK: - Live Activity

@MainActor
final class LiveActivityManager: ObservableObject {
    static let shared = LiveActivityManager()
    @Published private(set) var isRunning = !Activity<RevenueActivityAttributes>.activities.isEmpty
    var enabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }
    private var observing = false

    /// Jetons push-to-start (le serveur peut lancer l'activité à la première vente) et jetons de mise à jour.
    func observe() {
        guard !observing else { return }
        observing = true
        if #available(iOS 17.2, *) {
            Task {
                for await token in Activity<RevenueActivityAttributes>.pushToStartTokenUpdates {
                    try? await MoneyMakerClient.stored.registerDevice(["liveActivity": ["pushToStartToken": token.hex]])
                }
            }
        }
        Task {
            for await activity in Activity<RevenueActivityAttributes>.activityUpdates {
                if !isRunning { isRunning = true }
                track(activity)
            }
        }
        Activity<RevenueActivityAttributes>.activities.forEach(track)
        MMShared.liveRunning = !Activity<RevenueActivityAttributes>.activities.isEmpty
    }

    private func track(_ activity: Activity<RevenueActivityAttributes>) {
        Task {
            for await token in activity.pushTokenUpdates {
                try? await MoneyMakerClient.stored.registerDevice(["liveActivity": ["updateToken": token.hex]])
            }
        }
        Task {
            for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
                let running = Activity<RevenueActivityAttributes>.activities.contains { $0.activityState == .active }
                if running != isRunning { isRunning = running }
                if MMShared.liveRunning != running { MMShared.liveRunning = running; WidgetCenter.shared.reloadTimelines(ofKind: "MoneyMakerToday") }
                if !running { try? await MoneyMakerClient.stored.registerDevice(["liveActivity": ["updateToken": NSNull()]]) }
            }
        }
    }

    func start() async {
        guard enabled else { return }
        let today = (try? await MoneyMakerClient.stored.today()) ?? MMShared.cachedToday ?? .placeholder
        let state = RevenueActivityAttributes.ContentState(today: today)
        if let current = Activity<RevenueActivityAttributes>.activities.first {
            await current.update(ActivityContent(state: state, staleDate: .now.addingTimeInterval(3 * 3600)))
            return
        }
        do {
            let activity = try Activity.request(attributes: RevenueActivityAttributes(title: String(localized: "Aujourd'hui")),
                                                content: ActivityContent(state: state, staleDate: .now.addingTimeInterval(3 * 3600), relevanceScore: 100),
                                                pushType: .token)
            isRunning = true
            MMShared.liveRunning = true
            WidgetCenter.shared.reloadTimelines(ofKind: "MoneyMakerToday")
            track(activity)
        } catch {
            PushManager.shared.lastError = error.localizedDescription
        }
    }

    func stop() async {
        for a in Activity<RevenueActivityAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) }
        isRunning = false
        MMShared.liveRunning = false
        WidgetCenter.shared.reloadTimelines(ofKind: "MoneyMakerToday")
        try? await MoneyMakerClient.stored.registerDevice(["liveActivity": ["updateToken": NSNull()]])
    }

    /// Mise à jour locale quand l'app est ouverte (le serveur s'en charge sinon).
    func refresh(with today: Today) async {
        for a in Activity<RevenueActivityAttributes>.activities {
            await a.update(ActivityContent(state: .init(today: today), staleDate: .now.addingTimeInterval(3 * 3600)))
        }
    }
}
