//
//  WidgetShotsApp.swift
//  Outil de captures App Store (simulateur uniquement) : rend les vrais widgets MoneyMaker,
//  avec les vraies données du compte (jeton MM_UI_TEST_TOKEN), en PNG transparents dans Documents/widgets.
//

import SwiftUI
import WidgetKit

@main
struct WidgetShotsApp: App {
    var body: some Scene { WindowGroup { ShotsView() } }
}

private struct ShotsView: View {
    @State private var status = "Rendu…"
    var body: some View {
        Text(status).task { status = await render() }
    }

    @MainActor
    private func render() async -> String {
        guard let t = ProcessInfo.processInfo.environment["MM_UI_TEST_TOKEN"] else { return "Jeton manquant" }
        MoneyMakerClient.save(token: t)
        let c = MoneyMakerClient.stored
        let o = try? await c.overview(days: 28)
        let today = try? await c.today()
        let feed = ((try? await c.feed(limit: 30)) ?? [])
        let sales = feed.filter(\.isRevenue)
        let history = await c.history()
        let icons = await WIconCache.load(sales.prefix(3).map(\.projectId), overview: o)
        let now = Date.now

        let small = CGSize(width: 170, height: 170), medium = CGSize(width: 364, height: 170), large = CGSize(width: 364, height: 382)
        var todayEntry = TodayEntry(date: now, today: today, signedIn: true, history: history)
        todayEntry.icons = icons
        save("overview-large", large, .systemLarge, RCOverviewView(entry: RCOverviewEntry(date: now, overview: o, signedIn: true, today: today)), now)
        save("overview-medium", medium, .systemMedium, RCOverviewView(entry: RCOverviewEntry(date: now, overview: o, signedIn: true, today: today)), now)
        save("transactions", medium, .systemMedium, RCTransactionsView(entry: RCTransactionsEntry(date: now, events: sales, signedIn: true, icons: icons)), now)
        save("today-small", small, .systemSmall, TodayWidgetView(entry: todayEntry), now)
        save("today-medium", medium, .systemMedium, TodayWidgetView(entry: todayEntry), now)
        save("globe", medium, .systemMedium, GlobeWidgetView(entry: InsightEntry(date: now, history: history, today: today, overview: o, feed: feed, signedIn: true)), now)
        save("mrr-small", small, .systemSmall, RCMRRView(entry: RCOverviewEntry(date: now, overview: o, signedIn: true)), now)
        return "OK"
    }

    @MainActor
    private func save<V: View>(_ name: String, _ size: CGSize, _ family: WidgetFamily, _ view: V, _ date: Date) {
        let shape = RoundedRectangle(cornerRadius: 22, style: .continuous)
        let card = view
            .padding(16)
            .frame(width: size.width, height: size.height)
            .background(WidgetBackdrop(date: date))
            .clipShape(shape)
            .overlay(shape.strokeBorder(.white.opacity(0.16), lineWidth: 0.75))
            .environment(\.colorScheme, .dark)
        WShotFamily.override = family
        defer { WShotFamily.override = nil }
        let r = ImageRenderer(content: card)
        r.scale = 4
        guard let img = r.uiImage, let data = img.pngData() else { return }
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("widgets")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? data.write(to: dir.appendingPathComponent("\(name).png"))
    }
}
