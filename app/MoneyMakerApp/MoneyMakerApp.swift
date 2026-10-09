import SwiftUI
import Charts

@main
struct MoneyMakerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var showsSplash = true
    var body: some Scene {
        WindowGroup {
            RootView()
                .overlay { if showsSplash { LaunchSplashView { showsSplash = false } } }
                .onOpenURL { Router.shared.open($0) }
                // fixed-scheme: the whole product (dashboard, widgets) is dark-only.
                .preferredColorScheme(.dark)
                .tint(MMColor.accent)
        }
    }
}

extension Color {
    static let mmGreen = MMColor.accent
    static let mmBlue = MMColor.blue
}

@MainActor
final class Store: ObservableObject {
    @Published var token: String? = MoneyMakerClient.stored.token
    @Published var overview: Overview? = MoneyMakerClient.cachedOverview
    @Published var alerts: [RankingAlert] = MoneyMakerClient.cachedAlerts
    @Published var days = 30
    @Published var error: String?
    @Published var loading = false
    @Published var today: Today? = MMShared.cachedToday
    @Published var feed: [FeedEvent] = MMShared.cachedFeed
    /// Pulsation déclenchée à chaque nouvel événement reçu en direct.
    @Published var liveTick = 0

    var client: MoneyMakerClient { MoneyMakerClient(token: token) }

    func signIn(_ raw: String) async {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("mm_pat_") else { error = "Le jeton doit commencer par mm_pat_"; return }
        token = t
        await refresh()
        if error == nil { MoneyMakerClient.save(token: t) } else { token = nil }
    }

    func signOut() {
        let old = token
        Task { await LiveActivityManager.shared.stop(); await PushManager.shared.forgetDevice(token: old) }
        MoneyMakerClient.save(token: nil); token = nil; overview = nil; today = nil; feed = []
    }

    func refresh() async {
        loading = true; defer { loading = false }
        let c = client
        async let o = Result.capture { try await c.overview(days: days) }
        async let a = try? c.alerts()
        async let t = try? c.today()
        async let f = try? c.feed()
        switch await o {
        case .success(let v): overview = v; error = nil
        case .failure(let e): self.error = e.localizedDescription
        }
        if let v = await a { alerts = v }
        await applyLive(today: t, feed: f)
    }

    /// Rafraîchissement léger (jour + flux) après un push ou un retour au premier plan.
    func refreshLive() async {
        let c = client
        async let t = try? c.today()
        async let f = try? c.feed()
        let before = feed.first?.id
        await applyLive(today: t, feed: f)
        if let id = feed.first?.id, id != before { liveTick += 1 }
    }

    private func applyLive(today t: Today?, feed f: [FeedEvent]?) async {
        withAnimation(.snappy) {
            if let t { today = t }
            if let f { feed = f }
        }
        if let t { await LiveActivityManager.shared.refresh(with: t) }
    }
}


extension Result where Failure == Error {
    static func capture(_ body: () async throws -> Success) async -> Result {
        do { return .success(try await body()) } catch { return .failure(error) }
    }
}
