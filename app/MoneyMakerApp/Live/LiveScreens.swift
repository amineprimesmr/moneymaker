//
//  LiveScreens.swift
//  MoneyMaker — UI temps réel : carte « Aujourd'hui », flux des ventes,
//  réglages des notifications, de la Live Activity et des widgets.
//

import SwiftUI
import UserNotifications
import WidgetKit
import AVFoundation
import AudioToolbox
import StoreKit

// MARK: - Carte « Revenu » (période au choix, 28 jours par défaut)

struct RevenueCard: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var live = LiveActivityManager.shared
    @State private var selected: Date?
    @State private var pulse = false

    private let periods: [(Int, String)] = [(0, String(localized: "AUJ.")), (7, String(localized: "7 J")), (28, String(localized: "28 J")), (90, String(localized: "90 J")), (365, String(localized: "1 AN"))]

    var body: some View {
        let o = store.scoped
        let cur = o?.currency ?? store.today?.currency ?? "EUR"
        let isToday = store.period == 0
        let pts = isToday ? todayPoints(store.today) : dailySeries(o?.revenueByDay ?? [:], days: store.period)
        let point = selected.flatMap { d in pts.min { abs($0.date.timeIntervalSince(d)) < abs($1.date.timeIntervalSince(d)) } }
        let total: Int? = isToday ? store.today?.netMicros : o?.revenueMicros
        MMCard(padding: 20, glow: MMColor.accent) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    HStack(spacing: 7) {
                        Circle().fill(MMColor.accent).frame(width: 7, height: 7)
                            .opacity(pulse ? 1 : 0.35)
                            // Éclair à chaque vente en direct, sans toucher à la respiration continue.
                            .keyframeAnimator(initialValue: 1.0, trigger: store.liveTick) { v, k in v.scaleEffect(k) } keyframes: { _ in
                                SpringKeyframe(1.8, duration: 0.15, spring: .init(response: 0.3, dampingRatio: 0.5))
                                SpringKeyframe(1.0, duration: 0.45, spring: .init(response: 0.3, dampingRatio: 0.5))
                            }
                        Text(point == nil ? String(localized: "REVENU") : point!.date.formatted(isToday ? .dateTime.hour() : .dateTime.day().month(.abbreviated)).uppercased())
                            .font(MMFont.system(11, .medium)).tracking(2.2).foregroundStyle(MMColor.ink3)
                    }
                    Spacer()
                    Button {
                        Task { live.isRunning ? await live.stop() : await live.start() }
                    } label: {
                        Image(systemName: live.isRunning ? "dot.radiowaves.left.and.right" : "play.circle")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(live.isRunning ? .black : MMColor.ink)
                            .frame(width: 32, height: 32)
                            .background(live.isRunning ? AnyShapeStyle(MMColor.accent) : AnyShapeStyle(MMColor.fg(0.08)), in: Circle())
                    }
                    .buttonStyle(MMPressStyle(scale: 0.9))
                    .accessibilityLabel((live.isRunning ? "Arrêter le direct" : "Suivre en direct sur l'écran verrouillé") as LocalizedStringKey)
                }
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(point.map { Int($0.value * 1e6).money(cur) } ?? total.map { $0.money(cur) } ?? "—")
                        .font(MMFont.number(50, .light)).tracking(-1.6)
                        .lineLimit(1).minimumScaleFactor(0.5)
                        .contentTransition(.numericText(value: point?.value ?? Double(total ?? 0)))
                        .animation(.snappy(duration: 0.3), value: point?.value)
                    if point == nil && !isToday { MMDelta(value: halfOverHalf(pts)).transition(.opacity) }
                }
                Text(subtitle(isToday: isToday, o: o))
                    .font(MMFont.system(13)).foregroundStyle(MMColor.ink2)
                    .contentTransition(.numericText())
                MMGlowChart(points: pts, selection: $selected, showsAxis: !isToday)
                    .frame(height: 140)
                    .sensoryFeedback(.selection, trigger: point?.date)
                MMSegmented(options: periods, selection: Binding(get: { store.period }, set: { store.setPeriod($0) }))
                if isToday, let l = store.today?.last {
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.up.right").font(.system(size: 10, weight: .bold)).foregroundStyle(MMColor.accent)
                        Text("+\(l.amountMicros.money(l.currency)) · \(l.projectName)").lineLimit(1).mmNumeric()
                        Spacer()
                        Text(Date(timeIntervalSince1970: l.at / 1000), style: .relative).monospacedDigit()
                    }
                    .font(MMFont.system(12)).foregroundStyle(MMColor.ink2)
                    .transition(.opacity)
                }
            }
            .animation(.smooth(duration: 0.5), value: store.period)
        }
        .onAppear { withAnimation(.easeInOut(duration: 1.6).repeatForever()) { pulse = true } }
        .sensoryFeedback(.impact(weight: .medium), trigger: store.liveTick)
    }

    private func subtitle(isToday: Bool, o: Overview?) -> String {
        if isToday, let t = store.today {
            return String(localized: "\(t.sales) ventes · \(t.renewals) renouvellements · \(t.trials) essais")
        }
        guard let o else { return " " }
        var parts = [String(localized: "\(o.payingCustomers ?? o.activeSubscriptions) users payants"), String(localized: "\(o.newCustomers) nouveaux clients")]
        if let dl = o.downloads { parts.insert(String(localized: "\(dl.formatted()) téléchargements"), at: 0) }
        return parts.joined(separator: " · ")
    }

    private func todayPoints(_ t: Today?) -> [MMPoint] {
        guard let t else { return [] }
        let start = Date(timeIntervalSince1970: t.dayStart / 1000)
        let hour = max(2, min(24, Int(Date().timeIntervalSince(start) / 3600) + 1))
        return t.hourly.prefix(hour).enumerated().map { MMPoint(date: start.addingTimeInterval(Double($0.offset) * 3600), value: Double($0.element) / 1e6) }
    }
}

// MARK: - Invitation à activer les notifications

struct EnableAlertsCard: View {
    @ObservedObject private var push = PushManager.shared
    var body: some View {
        if push.status == .notDetermined {
            MMCard(padding: 18, radius: 24) {
                HStack(spacing: 14) {
                    Image(systemName: "bell.badge.fill").font(.system(size: 18)).foregroundStyle(MMColor.accent)
                        .frame(width: 42, height: 42).background(MMColor.accent.opacity(0.12), in: Circle())
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Sois prévenu à chaque vente").font(MMFont.system(15, .medium))
                        Text("Notification « cha-ching », revenus du jour sur l'écran verrouillé.").font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                    }
                    Spacer(minLength: 0)
                }
                Button("Activer") { NotificationPrompt.shared.show() }
                    .font(MMFont.system(14, .medium)).foregroundStyle(.black)
                    .frame(maxWidth: .infinity).padding(.vertical, 12)
                    .background(MMColor.accent, in: Capsule())
                    .buttonStyle(MMPressStyle())
                    .padding(.top, 12)
            }
            .transition(.opacity.combined(with: .scale(scale: 0.96)))
        }
    }
}

// MARK: - Flux des ventes

struct LiveFeedSection: View {
    @EnvironmentObject var store: Store
    var limit = 6
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                MMLabel(text: String(localized: "Ventes en direct"))
                NavigationLink(value: Router.Destination.feed) {
                    Text("Tout voir").font(MMFont.system(12, .medium)).foregroundStyle(MMColor.ink2)
                }
            }
            .padding(.horizontal, 4).padding(.top, 8)
            if store.feed.isEmpty {
                MMCard { Text("Ta prochaine vente apparaîtra ici en direct.").font(MMFont.system(14)).foregroundStyle(MMColor.ink2) }
            } else {
                MMCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(Array(store.feed.prefix(limit).enumerated()), id: \.element.id) { i, e in
                            if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 56) }
                            FeedItemRow(e: e, project: store.project(for: e.projectId)).transition(.asymmetric(insertion: .move(edge: .top).combined(with: .opacity), removal: .opacity))
                        }
                    }
                    .animation(.spring(response: 0.45, dampingFraction: 0.85), value: store.feed.first?.id)
                }
            }
        }
    }
}

/// Ligne de vente façon RevenueCat : icône de l'app + drapeau, produit, heure · boutique,
/// montant (ou « Gratuit ») et badge du type de transaction.
struct FeedItemRow: View {
    let e: FeedEvent
    /// Résolu par le parent : la ligne n'observe pas tout le Store (sinon chaque publication
    /// du Store redessine les 100 lignes du flux).
    let project: ProjectSummary?
    var body: some View {
        HStack(spacing: 12) {
            ZStack(alignment: .bottomLeading) {
                Group {
                    if let project { ProjectIcon(project: project, size: 42) }
                    else { RoundedRectangle(cornerRadius: 10, style: .continuous).fill(MMColor.fg(0.08)).frame(width: 42, height: 42) }
                }
                if let cc = e.country { Text(flagEmoji(cc)).font(.system(size: 15)).offset(x: -5, y: 5) }
            }
            .frame(width: 46, height: 46)
            VStack(alignment: .leading, spacing: 3) {
                Text(e.productId ?? e.projectName ?? e.title).font(MMFont.system(15, .medium)).lineLimit(1).truncationMode(.head)
                Text([timeText, e.storeName].compactMap { $0 }.joined(separator: " · "))
                    .font(MMFont.system(12)).foregroundStyle(MMColor.ink3).lineLimit(1)
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 5) {
                Text(e.amountText ?? (e.badge.free ? String(localized: "Gratuit") : ""))
                    .font(MMFont.number(15, .regular))
                    .foregroundStyle(e.type == "REFUND" ? MMColor.red : e.amountText == nil ? MMColor.ink3 : MMColor.ink)
                TransactionBadge(kind: e.badge)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    private var timeText: String {
        Calendar.current.isDateInToday(e.date) || Date().timeIntervalSince(e.date) < 86_400 * 2
            ? e.date.mmFormatted(.dateTime.hour().minute())
            : e.date.mmFormatted(.dateTime.day().month(.abbreviated).hour().minute())
    }
}

extension Store {
    func project(for id: String) -> ProjectSummary? { overview?.projects.first { $0.projectId == id } }
}

extension FeedEvent {
    var storeName: String? { Self.storeLabel(store) }
}

struct FeedScreen: View {
    @EnvironmentObject var store: Store
    @State private var events: [FeedEvent] = []
    /// Groupes par jour précalculés (regroupement + tris + totaux) : recalculés seulement
    /// quand le flux ou la devise change, pas à chaque publication du Store.
    @State private var groups: [FeedDayGroup] = []
    var body: some View {
        let projects = Dictionary((store.overview?.projects ?? []).map { ($0.projectId, $0) }, uniquingKeysWith: { a, _ in a })
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Ventes en direct").font(MMFont.system(34, .bold)).tracking(-0.8)
                    Text(store.scopeLabel).font(MMFont.system(13)).foregroundStyle(MMColor.ink3)
                }
                .padding(.top, 8).mmAppear(0)
                ForEach(Array(groups.enumerated()), id: \.element.id) { gi, group in
                    HStack {
                        Text(group.title).font(MMFont.system(17, .semibold)).foregroundStyle(MMColor.ink2)
                        Spacer()
                        Text(group.total).font(MMFont.number(17, .regular)).foregroundStyle(MMColor.ink2)
                    }
                    .padding(.horizontal, 6).padding(.top, 10).mmAppear(1 + min(gi, 6))
                    MMCard(padding: 0) {
                        VStack(spacing: 0) {
                            ForEach(Array(group.items.enumerated()), id: \.element.id) { i, e in
                                if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 74) }
                                Group {
                                    if AppPrefs.openAsCustomer, let user = e.appUserId {
                                        NavigationLink(value: CustomerRoute(projectId: e.projectId, appUserId: user)) { FeedItemRow(e: e, project: projects[e.projectId]).contentShape(Rectangle()) }
                                    } else {
                                        NavigationLink(value: e) { FeedItemRow(e: e, project: projects[e.projectId]).contentShape(Rectangle()) }
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .mmScrollReveal()
                    .mmAppear(1 + min(gi, 6))
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 40)
        }
        .scrollIndicators(.hidden).igShrinksTabBar()
        .islandRefreshable(.home) { await load(); return true }
        .navigationDestination(for: FeedEvent.self) { TransactionDetailView(e: $0) }
        .navigationDestination(for: CustomerRoute.self) { CustomerHistoryView(route: $0) }
        .navigationBarTitleDisplayMode(.inline)
        .mmPage()
        .task {
            if events.isEmpty { events = store.feed; regroup() }
            await load()
        }
        .onChange(of: events) { _, _ in regroup() }
        .onChange(of: store.overview?.currency) { _, _ in regroup() }
        .onReceive(NotificationCenter.default.publisher(for: .mmLiveEvent)) { _ in Task { await load() } }
        .onChange(of: store.viewIds) { _, _ in Task { await load() } }
    }

    private func regroup() {
        groups = FeedDayGroup.build(events, currency: store.overview?.currency)
    }

    private func load() async {
        if let e = try? await store.client.feed(limit: 100, projectIds: store.scopeIds), e != events { withAnimation(.snappy) { events = e } }
    }
}

/// Un jour du flux des ventes, avec son titre et son total déjà formatés.
struct FeedDayGroup: Identifiable {
    let id: Date
    let title: String
    let total: String
    let items: [FeedEvent]

    static func build(_ events: [FeedEvent], currency: String?) -> [FeedDayGroup] {
        let cal = Calendar.current
        let byDay = Dictionary(grouping: events) { cal.startOfDay(for: $0.date) }
        return byDay.keys.sorted(by: >).map { d in
            let items = byDay[d]!.sorted { $0.at > $1.at }
            let title = cal.isDateInToday(d) ? String(localized: "Aujourd'hui") : cal.isDateInYesterday(d) ? String(localized: "Hier") : d.formatted(.dateTime.weekday(.wide).day().month(.wide))
            return FeedDayGroup(id: d, title: title, total: dayTotal(items, currency: currency), items: items)
        }
    }

    /// Total encaissé du jour (remboursements déduits), dans la devise de l'Accueil.
    private static func dayTotal(_ items: [FeedEvent], currency: String?) -> String {
        let cur = currency ?? items.first?.shownCurrency ?? "EUR"
        let total = items.reduce(0) { acc, e in
            guard let m = e.shownMicros, e.isTrial != true, e.shownCurrency == cur else { return acc }
            return e.isRevenue ? acc + m : e.type == "REFUND" ? acc - m : acc
        }
        return total.money(cur)
    }
}

// MARK: - Réglages (ouverts depuis le menu latéral)

/// Sons proposés pour les ventes. Le fichier `<id>.caf` est embarqué dans l'app (APNs le joue).
struct SaleSound: Identifiable, Hashable {
    let id: String, title: String, icon: String
    static let all: [SaleSound] = [
        .init(id: "cash", title: String(localized: "Cha-ching"), icon: "dollarsign.circle.fill"),
        .init(id: "coin", title: String(localized: "Pièce"), icon: "circle.circle.fill"),
        .init(id: "chime", title: String(localized: "Carillon"), icon: "bell.fill"),
        .init(id: "levelup", title: String(localized: "Level up"), icon: "arrow.up.forward.circle.fill"),
        .init(id: "pop", title: String(localized: "Pop"), icon: "bubble.fill"),
        .init(id: "none", title: String(localized: "Silencieux"), icon: "speaker.slash.fill"),
    ]
}

@MainActor
private enum SoundPreview {
    static var player: AVAudioPlayer?
    static func play(_ id: String) {
        switch id {
        case "none": return
        case "default": AudioServicesPlayAlertSound(1007)
        default:
            guard let url = Bundle.main.url(forResource: id, withExtension: "caf") else { return }
            try? AVAudioSession.sharedInstance().setCategory(.ambient)
            player = try? AVAudioPlayer(contentsOf: url)
            player?.play()
        }
    }
}

/// Notifications, son des ventes, Live Activity et objectif (sous-page des Réglages).
struct NotificationSettingsPage: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var push = PushManager.shared
    @ObservedObject private var live = LiveActivityManager.shared
    @State private var goal = MMShared.mrrGoal.map(String.init) ?? ""
    @State private var dailyGoal = MMShared.dailyGoal.map(String.init) ?? ""
    @State private var confirmDelete = false
    @State private var deleting = false

    private var denied: Bool { push.status == .denied }

    var body: some View {
        ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    statusCard.mmAppear(0)
                    section("Me notifier pour", footer: "Toutes les notifications sont groupées par business.") {
                        toggle("Ventes et renouvellements", "eurosign.circle.fill", MMColor.accent,
                               get: { $0.sales || $0.renewals }, set: { $0.sales = $1; $0.renewals = $1 })
                        divider
                        toggle("Essais gratuits", "sparkles", MMColor.blue,
                               get: { $0.trials }, set: { $0.trials = $1 })
                        divider
                        toggle("Paiements, remboursements, annulations", "exclamationmark.triangle.fill", .orange,
                               get: { $0.billing || $0.refunds || $0.churn }, set: { $0.billing = $1; $0.refunds = $1; $0.churn = $1 })
                        divider
                        toggle("Classements et alertes intelligentes", "trophy.fill", .yellow,
                               get: { $0.rankings || $0.insights }, set: { $0.rankings = $1; $0.insights = $1 })
                        divider
                        toggle("Récap du soir · 21 h", "moon.stars.fill", .purple,
                               get: { $0.dailySummary }, set: { $0.dailySummary = $1 })
                        if let projects = store.overview?.projects, projects.count > 1 {
                            divider
                            NavigationLink { MutedProjectsView(projects: projects) } label: {
                                row("Business notifiés", "square.stack.3d.up.fill", MMColor.ink2,
                                    value: "\(projects.count - projects.filter { push.prefs.mutedProjects.contains($0.projectId) }.count)/\(projects.count)")
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .disabled(denied).opacity(denied ? 0.5 : 1)
                    .mmAppear(1)

                    soundSection.disabled(denied).opacity(denied ? 0.5 : 1).mmAppear(2)

                    section("Live Activity et widgets") {
                        toggle("Live Activity à la 1re vente du jour", "dot.radiowaves.left.and.right", .red,
                               get: { $0.liveActivityAuto }, set: { $0.liveActivityAuto = $1 })
                        divider
                        Button { Task { live.isRunning ? await live.stop() : await live.start() } } label: {
                            row(live.isRunning ? "Arrêter le direct" : "Lancer le direct maintenant", "play.circle.fill", MMColor.ink2)
                        }
                        .buttonStyle(.plain)
                        divider
                        HStack(spacing: 14) {
                            icon("target", MMColor.accent)
                            Text("Objectif de MRR").font(MMFont.system(15))
                            Spacer()
                            TextField("10000", text: $goal).keyboardType(.numberPad).multilineTextAlignment(.trailing)
                                .font(MMFont.number(16, .regular)).frame(width: 90)
                                .onChange(of: goal) { _, v in
                                    MMShared.mrrGoal = Int(v.filter(\.isNumber))
                                    WidgetCenter.shared.reloadTimelines(ofKind: "MoneyMakerOverview")
                                }
                            Text(store.overview?.currency ?? "EUR").font(MMFont.system(13)).foregroundStyle(MMColor.ink3)
                        }
                        .padding(.horizontal, 16).padding(.vertical, 11)
                        divider
                        HStack(spacing: 14) {
                            icon("circle.dashed", MMColor.accent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Objectif du jour").font(MMFont.system(15))
                                Text(dailyGoal.isEmpty ? String(localized: "Auto : moyenne 30 j + 20 %") : String(localized: "Anneau des widgets et du direct"))
                                    .font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                            }
                            Spacer()
                            TextField(MMShared.autoDailyGoal(MMShared.history).map(String.init) ?? "100", text: $dailyGoal).keyboardType(.numberPad).multilineTextAlignment(.trailing)
                                .font(MMFont.number(16, .regular)).frame(width: 80)
                                .onChange(of: dailyGoal) { _, v in
                                    MMShared.dailyGoal = Int(v.filter(\.isNumber)).flatMap { $0 > 0 ? $0 : nil }
                                    WidgetCenter.shared.reloadAllTimelines()
                                }
                            Text(store.overview?.currency ?? "EUR").font(MMFont.system(13)).foregroundStyle(MMColor.ink3)
                        }
                        .padding(.horizontal, 16).padding(.vertical, 11)
                    }
                    .mmAppear(3)

                    if let e = push.lastError {
                        Text(e).font(MMFont.system(12)).foregroundStyle(MMColor.red).padding(.horizontal, 4)
                    }
                }
                .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 40)
                .tint(MMColor.accent)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .background(MMColor.bg.ignoresSafeArea())
            .navigationTitle("Notifications")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            .task { await push.refreshAuthorization() }
    }

    // MARK: Carte d'état

    private var statusCard: some View {
        let on = push.status == .authorized
        return MMCard(padding: 18, radius: 24, glow: on ? MMColor.accent : nil) {
            HStack(spacing: 14) {
                Image(systemName: on ? "bell.badge.fill" : "bell.slash.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(on ? MMColor.accent : MMColor.ink3)
                    .frame(width: 44, height: 44).background(MMColor.fg(0.06), in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text((on ? "Notifications actives" : denied ? "Notifications bloquées" : "Notifications éteintes") as LocalizedStringKey)
                        .font(MMFont.system(16, .semibold))
                    Text((on ? "Chaque vente, en direct." : denied ? "À réactiver dans Réglages iOS." : "Active-les pour chaque vente.") as LocalizedStringKey)
                        .font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                }
                Spacer(minLength: 8)
                Button {
                    if denied { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) }
                    else if !on { NotificationPrompt.shared.show() }
                    else { Task { await push.sendTest() } }
                } label: {
                    Text((denied ? "Ouvrir" : !on ? "Activer" : push.testing ? "Envoi…" : "Tester") as LocalizedStringKey)
                        .font(MMFont.system(13, .semibold)).foregroundStyle(.black)
                        .padding(.horizontal, 16).padding(.vertical, 9)
                        .background(MMColor.accent, in: Capsule())
                }
                .buttonStyle(MMPressStyle())
            }
        }
    }

    // MARK: Son des ventes

    private var soundSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            MMLabel(text: String(localized: "Son des ventes")).padding(.horizontal, 4)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                ForEach(SaleSound.all) { s in
                    let selected = push.prefs.saleSound == s.id
                    Button {
                        SoundPreview.play(s.id)
                        guard !selected else { return }
                        push.update { $0.saleSound = s.id }
                    } label: {
                        VStack(spacing: 8) {
                            Image(systemName: s.icon).font(.system(size: 20, weight: .semibold))
                                .foregroundStyle(selected ? .black : MMColor.ink2)
                                .symbolEffect(.bounce, value: selected)
                            Text(s.title).font(MMFont.system(12, .medium))
                                .foregroundStyle(selected ? .black : MMColor.ink)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(selected ? AnyShapeStyle(MMColor.accent) : AnyShapeStyle(MMColor.fg(0.06)),
                                    in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .strokeBorder(MMColor.fg(selected ? 0 : 0.08), lineWidth: 1))
                    }
                    .buttonStyle(MMPressStyle())
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            .sensoryFeedback(.selection, trigger: push.prefs.saleSound)
            Text("Touche un son pour l'écouter. Les alertes de paiement gardent le son du système.")
                .font(MMFont.system(12)).foregroundStyle(MMColor.ink3).padding(.horizontal, 4)
        }
    }

    // MARK: Briques

    private var divider: some View {
        Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 58)
    }

    private func section<C: View>(_ title: LocalizedStringResource, footer: LocalizedStringResource? = nil, @ViewBuilder _ rows: () -> C) -> some View {
        let content = rows()
        return VStack(alignment: .leading, spacing: 10) {
            MMLabel(text: String(localized: title)).padding(.horizontal, 4)
            MMCard(padding: 0) { VStack(spacing: 0) { content } }
            if let footer { Text(footer).font(MMFont.system(12)).foregroundStyle(MMColor.ink3).padding(.horizontal, 4) }
        }
    }

    private func icon(_ name: String, _ color: Color) -> some View {
        Image(systemName: name).font(.system(size: 13, weight: .semibold)).foregroundStyle(color)
            .frame(width: 30, height: 30).background(color.opacity(0.15), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    private func row(_ title: LocalizedStringResource, _ name: String, _ color: Color, value: String? = nil) -> some View {
        HStack(spacing: 14) {
            icon(name, color)
            Text(title).font(MMFont.system(15)).foregroundStyle(MMColor.ink)
            Spacer()
            if let value { Text(value).font(MMFont.system(14)).foregroundStyle(MMColor.ink3) }
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(MMColor.ink3)
        }
        .padding(.horizontal, 16).padding(.vertical, 11)
        .contentShape(.rect)
    }

    private func link(_ title: LocalizedStringResource, _ name: String, _ url: String) -> some View {
        Link(destination: URL(string: url)!) {
            HStack(spacing: 14) {
                icon(name, MMColor.ink2)
                Text(title).font(MMFont.system(15)).foregroundStyle(MMColor.ink)
                Spacer()
                Image(systemName: "arrow.up.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(MMColor.ink3)
            }
            .padding(.horizontal, 16).padding(.vertical, 11)
        }
    }

    private func toggle(_ title: LocalizedStringResource, _ name: String, _ color: Color,
                        get: @escaping (PushPrefs) -> Bool, set: @escaping (inout PushPrefs, Bool) -> Void) -> some View {
        Toggle(isOn: Binding(get: { get(push.prefs) }, set: { v in push.update { set(&$0, v) } })) {
            HStack(spacing: 14) {
                icon(name, color)
                Text(title).font(MMFont.system(15)).lineLimit(2)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 9)
        .sensoryFeedback(.selection, trigger: get(push.prefs))
    }
}

/// Choix des business qui envoient des notifications.
private struct MutedProjectsView: View {
    let projects: [ProjectSummary]
    @ObservedObject private var push = PushManager.shared

    var body: some View {
        ScrollView {
            MMCard(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(projects.enumerated()), id: \.element.id) { i, p in
                        if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 62) }
                        Toggle(isOn: Binding(get: { !push.prefs.mutedProjects.contains(p.projectId) },
                                             set: { on in push.update { $0.mutedProjects.removeAll { $0 == p.projectId }; if !on { $0.mutedProjects.append(p.projectId) } } })) {
                            HStack(spacing: 14) {
                                ProjectIcon(project: p, size: 32)
                                Text(p.name).font(MMFont.system(15))
                            }
                        }
                        .padding(.horizontal, 16).padding(.vertical, 10)
                    }
                }
            }
            .padding(16)
            .tint(MMColor.accent)
        }
        .background(MMColor.bg.ignoresSafeArea())
        .navigationTitle("Business notifiés")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Fiche transaction (façon RevenueCat)

/// Détail d'une transaction : en-tête aux couleurs du pays, produit, revenu, client,
/// date, pays, boutique, type, identifiants ; toucher le client ouvre tout son historique.
struct TransactionDetailView: View {
    let e: FeedEvent
    @EnvironmentObject var store: Store

    var body: some View {
        let project = store.overview?.projects.first { $0.projectId == e.projectId }
        ScrollView {
            VStack(spacing: 16) {
                header(project)
                section {
                    row("square.dashed", "Produit", e.productId ?? "—", stacked: (e.productId ?? "").count > 22)
                    divider
                    row("dollarsign.circle", "Revenu", e.amountText ?? (e.badge.free ? String(localized: "Gratuit") : "—"))
                    if let user = e.appUserId {
                        divider
                        NavigationLink(value: CustomerRoute(projectId: e.projectId, appUserId: user)) {
                            HStack(spacing: 14) {
                                icon("person")
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("Client").font(MMFont.system(16))
                                    Text(masked(user)).font(MMFont.system(14)).foregroundStyle(MMColor.ink3).lineLimit(1)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(MMColor.ink3)
                            }
                            .padding(.horizontal, 16).padding(.vertical, 13).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                section {
                    row("calendar", "Date", e.date.mmFormatted(.dateTime.day().month(.wide).year().hour().minute()) + (AppPrefs.utc ? " UTC" : ""))
                    divider
                    row("globe.europe.africa", "Pays", e.country.map { "\(flagEmoji($0)) \(GlobeData.name($0))" } ?? String(localized: "Inconnu"))
                    divider
                    row("storefront", "Boutique", e.storeName ?? "—")
                    divider
                    HStack(spacing: 14) {
                        icon("tag")
                        Text("Type").font(MMFont.system(16))
                        Spacer()
                        TransactionBadge(kind: e.badge)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 13)
                    if let exp = e.expiresAt {
                        divider
                        row("clock.arrow.circlepath", exp > Date().timeIntervalSince1970 * 1000 ? "Expire le" : "Expiré le",
                            Date(timeIntervalSince1970: exp / 1000).formatted(.dateTime.day().month(.abbreviated).year()))
                    }
                    if let m = e.periodMonths, m > 0 {
                        divider
                        row("repeat", "Période", m < 1 ? String(localized: "Semaine") : m == 1 ? String(localized: "Mois") : m == 12 ? String(localized: "Année") : String(localized: "\(Int(m)) mois"))
                    }
                    if e.isSandbox == true { divider; row("hammer", "Environnement", String(localized: "Test (sandbox)")) }
                }
                section {
                    row("number", "Transaction", e.purchaseId ?? e.id, stacked: true, mono: true)
                    divider
                    row("square.grid.3x3", "Projet", e.projectName ?? project?.name ?? "—")
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        .background(alignment: .top) { flagGlow.ignoresSafeArea() }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .mmPage()
    }

    // MARK: En-tête

    private func header(_ project: ProjectSummary?) -> some View {
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let project { ProjectIcon(project: project, size: 110) }
                else { RoundedRectangle(cornerRadius: 26, style: .continuous).fill(MMColor.fg(0.1)).frame(width: 110, height: 110) }
            }
            Text(flagEmoji(e.country ?? "")).font(.system(size: 44)).offset(x: 14, y: 10)
        }
        .padding(.top, 24).padding(.bottom, 12)
    }

    /// Halo aux couleurs du drapeau : l'emoji agrandi et très flouté, comme RevenueCat.
    private var flagGlow: some View { FlagGlow(country: e.country ?? "").equatable() }
}

/// Vue à part et Equatable : le gros flou n'est redessiné que si le pays change,
/// pas à chaque publication du Store qui invalide la fiche.
private struct FlagGlow: View, Equatable {
    let country: String
    var body: some View {
        Text(flagEmoji(country))
            .font(.system(size: 260))
            .scaleEffect(x: 2.6, y: 1.4)
            .blur(radius: 60)
            .opacity(0.55)
            .frame(height: 380)
            .frame(maxWidth: .infinity)
            .mask(LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom))
            .drawingGroup()
            .allowsHitTesting(false)
    }
}

extension TransactionDetailView {
    // MARK: Briques

    private func section<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        VStack(spacing: 0, content: c)
            .background(MMColor.fg(0.07), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private var divider: some View { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 56) }

    private func icon(_ s: String) -> some View {
        Image(systemName: s).font(.system(size: 18)).foregroundStyle(Color(red: 0.55, green: 0.6, blue: 1)).frame(width: 26)
    }

    private func row(_ symbol: String, _ title: LocalizedStringResource, _ value: String, stacked: Bool = false, mono: Bool = false) -> some View {
        HStack(alignment: stacked ? .top : .center, spacing: 14) {
            icon(symbol)
            if stacked {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(MMFont.system(16))
                    Text(value).font(mono ? .system(size: 14, design: .monospaced) : MMFont.system(14)).foregroundStyle(MMColor.ink3)
                        .textSelection(.enabled).lineLimit(2)
                }
                Spacer(minLength: 0)
            } else {
                Text(title).font(MMFont.system(16))
                Spacer(minLength: 12)
                Text(value).font(MMFont.system(15)).foregroundStyle(MMColor.ink2).lineLimit(1).truncationMode(.middle)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 13)
    }

    private func masked(_ id: String) -> String {
        id.count > 10 ? "\(id.prefix(4))••••\(id.suffix(4))" : id
    }
}

struct CustomerRoute: Hashable { let projectId: String; let appUserId: String }

// MARK: - Historique d'un abonné

/// Toute la vie d'un client, du plus récent au plus ancien : achats, renouvellements, essais,
/// annulations, problèmes de paiement… plus « vu pour la première / dernière fois ».
struct CustomerHistoryView: View {
    let route: CustomerRoute
    @EnvironmentObject var store: Store
    @State private var detail: CustomerDetail?
    @State private var failed = false
    /// Frise et achats triés une seule fois au chargement (pas à chaque publication du Store).
    @State private var items: [Item] = []
    @State private var sortedPurchases: [CustomerDetail.Purchase] = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let d = detail {
                    summary(d)
                    if !d.purchases.isEmpty { purchases(d) }
                    MMLabel(text: String(localized: "Historique"), trailing: String(localized: "\(d.events.count) événements")).padding(.horizontal, 4)
                    timeline(d)
                } else if failed {
                    MMCard { Text("Impossible de charger ce client.").font(MMFont.system(14)).foregroundStyle(MMColor.ink2) }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(40)
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        .navigationTitle("Client")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .mmPage()
        .task {
            // Retour depuis le détail d'une transaction : déjà chargé, pas de nouveau réseau.
            guard detail == nil else { return }
            do {
                let d = try await store.client.customer(projectId: route.projectId, appUserId: route.appUserId)
                sortedPurchases = d.purchases.sorted { ($0.purchasedAt ?? 0) > ($1.purchasedAt ?? 0) }
                items = Self.timelineItems(d)
                detail = d
            }
            catch { failed = true }
        }
    }

    private func summary(_ d: CustomerDetail) -> some View {
        let cur = d.currency ?? "EUR"
        let active = d.purchases.contains { $0.active == true && $0.isTrial != true }
        let trial = d.purchases.contains { $0.active == true && $0.isTrial == true }
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Text(flagEmoji(d.country ?? "")).font(.system(size: 34))
                VStack(alignment: .leading, spacing: 3) {
                    Text(d.appUserId).font(.system(size: 14, design: .monospaced)).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                    Text(d.country.map(GlobeData.name) ?? String(localized: "Pays inconnu")).font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                }
                Spacer()
                TransactionBadge(kind: active ? .init(label: String(localized: "ACTIF"), color: Color(red: 0.2, green: 0.85, blue: 0.5))
                                 : trial ? .init(label: String(localized: "ESSAI"), color: Color(red: 0.3, green: 0.8, blue: 0.85))
                                 : .init(label: String(localized: "INACTIF"), color: MMColor.fg(0.6)))
            }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible())], spacing: 10) {
                stat("Total dépensé", (d.totalSpentMicros ?? 0).money(cur))
                stat("Achats", d.purchases.filter { $0.isSandbox != true }.count.formatted())
                stat("Vu la 1re fois", d.firstSeenAt.map { Date(timeIntervalSince1970: $0 / 1000).formatted(.dateTime.day().month(.abbreviated).year()) } ?? "—")
                stat("Vu la dernière fois", d.lastSeenAt.map { Date(timeIntervalSince1970: $0 / 1000).formatted(.relative(presentation: .named)) } ?? "—")
            }
            if let ents = d.activeEntitlements, !ents.isEmpty {
                Text("Accès actifs : \(ents.joined(separator: ", "))").font(MMFont.system(12)).foregroundStyle(MMColor.ink2)
            }
        }
        .padding(16)
        .background(MMColor.fg(0.07), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private func stat(_ t: LocalizedStringResource, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(t).font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
            Text(v).font(MMFont.number(17, .regular)).lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(MMColor.fg(0.05), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func purchases(_ d: CustomerDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            MMLabel(text: String(localized: "Abonnements et achats"), trailing: "\(d.purchases.count)").padding(.horizontal, 4)
            VStack(spacing: 0) {
                ForEach(Array(sortedPurchases.enumerated()), id: \.element.id) { i, p in
                    if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 16) }
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(p.productId ?? p.id).font(MMFont.system(15, .medium)).lineLimit(1)
                            Text(purchaseCaption(p)).font(MMFont.system(12)).foregroundStyle(MMColor.ink3).lineLimit(1)
                        }
                        Spacer()
                        TransactionBadge(kind: purchaseBadge(p))
                    }
                    .padding(.horizontal, 16).padding(.vertical, 12)
                }
            }
            .background(MMColor.fg(0.07), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
    }

    private func purchaseCaption(_ p: CustomerDetail.Purchase) -> String {
        let store = FeedEvent.storeLabel(p.store)
        guard let exp = p.expiresAt else { return [store, String(localized: "Sans expiration")].compactMap { $0 }.joined(separator: " · ") }
        let d = Date(timeIntervalSince1970: exp / 1000).formatted(.dateTime.day().month(.abbreviated).year())
        let when = p.active == true ? (p.willRenew == true ? String(localized: "Se renouvelle le \(d)") : String(localized: "Expire le \(d)")) : String(localized: "Expiré le \(d)")
        return [store, when].compactMap { $0 }.joined(separator: " · ")
    }

    private func purchaseBadge(_ p: CustomerDetail.Purchase) -> FeedEvent.Badge {
        if p.billingIssue == true { return .init(label: String(localized: "BILLING ISSUE"), color: Color(red: 1, green: 0.62, blue: 0.25)) }
        if p.status == "refunded" || p.status == "revoked" { return .init(label: String(localized: "REFUND"), color: Color(red: 1, green: 0.38, blue: 0.38)) }
        if p.active == true && p.isTrial == true { return .init(label: String(localized: "TRIAL"), color: Color(red: 0.3, green: 0.8, blue: 0.85)) }
        if p.active == true { return .init(label: p.willRenew == false && p.expiresAt != nil ? String(localized: "CANCELLED") : String(localized: "ACTIVE"),
                                           color: p.willRenew == false && p.expiresAt != nil ? Color(red: 1, green: 0.62, blue: 0.25) : Color(red: 0.2, green: 0.85, blue: 0.5)) }
        return .init(label: String(localized: "EXPIRED"), color: MMColor.fg(0.6))
    }

    // MARK: Frise

    private enum Item: Identifiable {
        case event(FeedEvent), seen(String, Date, String)
        var id: String { switch self { case .event(let e): e.id; case .seen(let t, _, _): t } }
        var date: Date { switch self { case .event(let e): e.date; case .seen(_, let d, _): d } }
    }

    private static func timelineItems(_ d: CustomerDetail) -> [Item] {
        var items = d.events.filter { $0.type != "TEST" }.map(Item.event)
        if let f = d.firstSeenAt { items.append(.seen(String(localized: "Vu pour la première fois"), Date(timeIntervalSince1970: f / 1000), "star.fill")) }
        if let l = d.lastSeenAt, l != d.firstSeenAt { items.append(.seen(String(localized: "Vu pour la dernière fois dans l'app"), Date(timeIntervalSince1970: l / 1000), "arrow.up.right.square.fill")) }
        return items.sorted { $0.date > $1.date }
    }

    private func timeline(_ d: CustomerDetail) -> some View {
        let sorted = items
        return VStack(spacing: 0) {
            ForEach(Array(sorted.enumerated()), id: \.element.id) { i, item in
                HStack(alignment: .top, spacing: 14) {
                    VStack(spacing: 0) {
                        Rectangle().fill(i == 0 ? .clear : MMColor.fg(0.15)).frame(width: 1.5, height: 14)
                        dot(item)
                        Rectangle().fill(i == sorted.count - 1 ? .clear : MMColor.fg(0.15)).frame(width: 1.5).frame(maxHeight: .infinity)
                    }
                    .frame(width: 30)
                    content(item).padding(.vertical, 12)
                    Spacer(minLength: 0)
                }
                .overlay(alignment: .bottom) { if i < sorted.count - 1 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 44) } }
            }
        }
        .padding(.horizontal, 12)
        .background(MMColor.fg(0.07), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    @ViewBuilder private func dot(_ item: Item) -> some View {
        switch item {
        case .event(let e):
            Image(systemName: e.timelineSymbol).font(.system(size: 15, weight: .semibold)).foregroundStyle(e.badge.color).frame(height: 24)
        case .seen(_, _, let s):
            Image(systemName: s).font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                .frame(width: 22, height: 22).background(Color(red: 0.4, green: 0.45, blue: 1), in: RoundedRectangle(cornerRadius: 6))
        }
    }

    @ViewBuilder private func content(_ item: Item) -> some View {
        switch item {
        case .event(let e):
            NavigationLink(value: e) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(e.timelineTitle).font(MMFont.system(15, .medium)).multilineTextAlignment(.leading)
                        Text([e.date.formatted(.dateTime.day().month(.abbreviated).year().hour().minute()), e.storeName].compactMap { $0 }.joined(separator: " · "))
                            .font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                    }
                    Spacer(minLength: 6)
                    Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(MMColor.ink3)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        case .seen(let t, let d, _):
            VStack(alignment: .leading, spacing: 3) {
                Text(t).font(MMFont.system(15, .medium))
                Text(d.formatted(.dateTime.day().month(.abbreviated).year())).font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
            }
        }
    }
}

extension FeedEvent {
    static func storeLabel(_ s: String?) -> String? {
        switch s {
        case "app_store": "App Store"
        case "stripe": "Stripe"
        case "play_store": "Google Play"
        case "amazon": "Amazon"
        case "promotional": String(localized: "Promo")
        case .some(let s): s.capitalized
        case .none: nil
        }
    }

    /// Phrase de la frise, comme RevenueCat (« Renouvelé Weekly », « Abonnement démarré à … pour 2,99€ »).
    var timelineTitle: String {
        let product = productId ?? String(localized: "le produit")
        let price = amountText.map { String(localized: " pour \($0)") } ?? ""
        switch type {
        case "INITIAL_PURCHASE": return isTrial == true ? String(localized: "Essai démarré : \(product)") : String(localized: "Abonnement démarré : \(product)\(price)")
        case "TRIAL_STARTED": return String(localized: "Essai démarré : \(product)")
        case "TRIAL_CONVERTED": return String(localized: "Essai converti : \(product)\(price)")
        case "RENEWAL": return String(localized: "Renouvelé : \(product)\(price)")
        case "NON_RENEWING_PURCHASE": return String(localized: "Achat unique : \(product)\(price)")
        case "CANCELLATION": return String(localized: "Renouvellement automatique désactivé : \(product)")
        case "UNCANCELLATION": return String(localized: "Renouvellement automatique réactivé : \(product)")
        case "EXPIRATION": return String(localized: "Expiré : \(product)")
        case "BILLING_ISSUE": return String(localized: "Problème de paiement : \(product)")
        case "BILLING_RECOVERED": return String(localized: "Paiement récupéré : \(product)")
        case "REFUND": return String(localized: "Remboursé : \(product)\(price)")
        case "REVOKED": return String(localized: "Accès révoqué : \(product)")
        case "PRODUCT_CHANGE": return String(localized: "Changement d'offre : \(product)")
        case "PAUSED": return String(localized: "Abonnement en pause : \(product)")
        case "GRANT": return String(localized: "Accès offert : \(product)")
        default: return String(localized: "\(title) : \(product)")
        }
    }

    var timelineSymbol: String {
        switch type {
        case "INITIAL_PURCHASE", "NON_RENEWING_PURCHASE": return "cart.fill.badge.plus"
        case "RENEWAL", "UNCANCELLATION", "BILLING_RECOVERED": return "arrow.clockwise"
        case "TRIAL_STARTED": return "hourglass"
        case "TRIAL_CONVERTED": return "checkmark.seal.fill"
        case "CANCELLATION": return "xmark.circle"
        case "EXPIRATION": return "clock.badge.xmark"
        case "BILLING_ISSUE": return "exclamationmark.triangle.fill"
        case "REFUND", "REVOKED": return "arrow.uturn.backward.circle.fill"
        case "PRODUCT_CHANGE": return "arrow.left.arrow.right"
        case "PAUSED": return "pause.circle"
        case "GRANT": return "gift.fill"
        default: return "circle.fill"
        }
    }
}

// MARK: - Réglages (design de V2)

/// Hub des Réglages, même design que V2 : compte, récompenses, notifications, date et région,
/// transactions, données, finances, assistance, déconnexion et version.
struct LiveSettingsView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.requestReview) private var requestReview
    @ObservedObject private var push = PushManager.shared
    @AppStorage(AppPrefs.currencyKey) private var currency = ""
    @AppStorage(AppPrefs.utcKey) private var utc = false
    @AppStorage(AppPrefs.openAsKey) private var openAs = "transaction"
    @AppStorage(AppPrefs.perBusinessKey) private var perBusiness = true
    @AppStorage(AppPrefs.hapticsKey) private var haptics = true
    @AppStorage(AppTheme.storageKey) private var themeRaw = AppTheme.system.rawValue
    @State private var language = AppLanguage.current
    @State private var languageChanged = false
    @State private var confirmDelete = false
    @State private var deleting = false

    var body: some View {
        NavigationStack {
            let trophies = Rewards.trophies(store)
            let fresh = Rewards.newlyUnlocked(trophies).count
            let lvl = Rewards.level(trophies)
            SettingsScrollPage(title: String(localized: "Réglages")) {
                account(lvl)
                    .padding(.top, 8)

                ProSettingsSection()

                SettingsSectionTitle(title: String(localized: "Apparence"))
                SettingsCard {
                    ThemePicker(value: Binding(get: { AppTheme(rawValue: themeRaw) ?? .system }, set: { themeRaw = $0.rawValue }))
                        .padding(14)
                }

                SettingsSectionTitle(title: String(localized: "Récompenses"))
                SettingsCard {
                    NavigationLink { RewardsView() } label: {
                        SettingsRow(icon: "trophy.fill", title: String(localized: "Trophées"),
                                    trailing: fresh > 0 ? .badge(fresh > 1 ? String(localized: "\(fresh) NOUVEAUX") : String(localized: "\(fresh) NOUVEAU"), Color(red: 1, green: 0.8, blue: 0.3))
                                                        : .status("\(trophies.filter(\.unlocked).count)/\(trophies.count)"))
                    }.settingsRowButton()
                    SettingsRowDivider()
                    NavigationLink { AppIconPickerView() } label: {
                        SettingsRow(icon: "app.badge.fill", title: String(localized: "Icône de l'app"), trailing: .status(currentIconTitle))
                    }.settingsRowButton()
                }

                SettingsSectionTitle(title: String(localized: "Alertes"))
                SettingsCard {
                    NavigationLink { NotificationSettingsPage() } label: {
                        SettingsRow(icon: "bell.badge.fill", title: String(localized: "Notifications et sons"),
                                    trailing: .status(push.status == .authorized ? String(localized: "Activées") : String(localized: "Désactivées")))
                    }.settingsRowButton()
                }

                SettingsSectionTitle(title: String(localized: "Date et région"))
                SettingsCard {
                    SettingsMenuRow(icon: "globe", title: String(localized: "Langue"), options: AppLanguage.options, selection: $language)
                        .onChange(of: language) { _, v in AppLanguage.set(v); languageChanged = true }
                    SettingsRowDivider()
                    SettingsMenuRow(icon: "eurosign.circle", title: String(localized: "Devise d'affichage"), options: AppPrefs.currencies, selection: $currency)
                    SettingsRowDivider()
                    SettingsMenuRow(icon: "clock", title: String(localized: "Heures en"), options: [(false, String(localized: "Heure locale"), nil), (true, "UTC", nil)], selection: $utc)
                }
                SettingsFootnote(text: String(localized: "La devise sert à afficher tous les montants. Les heures en UTC correspondent au dashboard web ; les jours restent groupés dans ton fuseau."))

                SettingsSectionTitle(title: String(localized: "Transactions"))
                SettingsCard {
                    SettingsMenuRow(icon: "arrow.left.arrow.right", title: String(localized: "Ouvrir une vente"), options: [("transaction", String(localized: "Transaction"), nil), ("customer", String(localized: "Client"), nil)], selection: $openAs)
                }
                SettingsFootnote(text: openAs == "customer" ? String(localized: "Toucher une vente ouvre tout l'historique du client.") : String(localized: "Toucher une vente affiche le détail de la transaction."))

                SettingsSectionTitle(title: String(localized: "Données"))
                SettingsCard {
                    SettingsToggleRow(icon: "hammer.fill", title: String(localized: "Inclure les achats sandbox"),
                                      isOn: Binding(get: { push.prefs.sandbox }, set: { v in push.update { $0.sandbox = v } }))
                    SettingsRowDivider()
                    SettingsToggleRow(icon: "chart.bar.fill", title: String(localized: "Détail par business"), isOn: $perBusiness)
                    SettingsRowDivider()
                    SettingsToggleRow(icon: "iphone.radiowaves.left.and.right", title: String(localized: "Retours haptiques"), isOn: $haptics)
                }
                SettingsFootnote(text: String(localized: "Le détail par business s'affiche sous chaque graphique quand plusieurs business sont suivis."))

                if !store.isDemo {
                    SettingsSectionTitle(title: String(localized: "Finances"))
                    SettingsCard {
                        NavigationLink {
                            ScrollView { FinanceSettingsSection().padding(16) }
                                .background(MMColor.bg.ignoresSafeArea())
                                .navigationTitle("Finances").navigationBarTitleDisplayMode(.inline)
                                .toolbar(.visible, for: .navigationBar)
                        } label: {
                            SettingsRow(icon: "building.columns.fill", title: String(localized: "Banque, dépenses et impôts"))
                        }.settingsRowButton()
                    }
                }

                SettingsSectionTitle(title: String(localized: "Assistance"))
                SettingsCard {
                    link("Envoyer un avis…", "exclamationmark.bubble.fill", "mailto:amine.ennasri.pro@gmail.com?subject=MoneyMaker%20-%20avis")
                    SettingsRowDivider()
                    Button { requestReview() } label: { SettingsRow(icon: "star.fill", title: String(localized: "Noter l'app"), trailing: .external) }.settingsRowButton()
                    SettingsRowDivider()
                    link("Dashboard web", "safari.fill", "https://usemoneymaker.com")
                }
                .padding(.bottom, 14)
                SettingsCard {
                    link("Aide et contact", "lifepreserver.fill", "https://usemoneymaker.com/support")
                    SettingsRowDivider()
                    link("Conditions d'utilisation", "doc.text.fill", "https://usemoneymaker.com/terms")
                    SettingsRowDivider()
                    link("Confidentialité", "hand.raised.fill", "https://usemoneymaker.com/privacy")
                }

                VStack(spacing: 14) {
                    SettingsDestructiveButton(title: store.isDemo ? String(localized: "Quitter la démo") : String(localized: "Se déconnecter"), icon: "rectangle.portrait.and.arrow.right") {
                        dismiss(); store.signOut()
                    }
                    if !store.isDemo {
                        Button { confirmDelete = true } label: {
                            Text((deleting ? "Suppression…" : "Supprimer mon compte") as LocalizedStringKey).font(V2Font.system(size: 14)).foregroundStyle(SettingsTheme.valueTint)
                        }
                        .disabled(deleting)
                    }
                }
                .padding(.top, 28)

                SettingsVersionFooter(suffix: store.isDemo ? String(localized: " · démo") : "")
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Fermer")
                }
            }
            .alert("Langue modifiée", isPresented: $languageChanged) {
                Button("Relancer maintenant") { exit(0) }
                Button("Plus tard", role: .cancel) {}
            } message: {
                Text("MoneyMaker doit redémarrer pour passer toute l'app dans la nouvelle langue.")
            }
            .task { await push.refreshAuthorization() }
            .onChange(of: currency) { _, _ in Task { await store.reformat() } }
            .mmSettingFeedback(currency)
            .mmSettingFeedback(utc)
            .mmSettingFeedback(openAs)
            .mmSettingFeedback(perBusiness)
            .mmSettingFeedback(themeRaw)
            .animation(MMMotion.snappy, value: currency)
            .animation(MMMotion.snappy, value: utc)
            .animation(MMMotion.snappy, value: openAs)
            .animation(MMMotion.snappy, value: perBusiness)
            .onChange(of: push.prefs.sandbox) { _, _ in Task { await store.refresh() } }
        }
        .presentationBackground(MMColor.bg)
        .presentationDragIndicator(.visible)
        .alert("Supprimer ton compte ?", isPresented: $confirmDelete) {
            Button("Supprimer définitivement", role: .destructive) {
                deleting = true
                Task {
                    struct R: Decodable { let ok: Bool }
                    let r: R? = try? await store.client.send("DELETE", "account", body: ["confirm": "SUPPRIMER"])
                    deleting = false
                    if r?.ok == true { dismiss(); store.signOut() } else { push.lastError = String(localized: "La suppression a échoué, réessaie.") }
                }
            }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Ton compte, tes jetons et les business dont tu es le seul membre (données de ventes, clés, réglages) seront supprimés. C'est irréversible.")
        }
    }

    /// Carte de compte : icône actuelle, niveau de maker et business suivis.
    private func account(_ lvl: (level: Int, points: Int, into: Int, next: Int)) -> some View {
        SettingsCard {
            NavigationLink { RewardsView() } label: {
                HStack(spacing: 14) {
                    Image("IconPreview-\(Rewards.icons.first { $0.alternateName == UIApplication.shared.alternateIconName }?.id ?? "Classic")")
                        .resizable().frame(width: 56, height: 56)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(Rewards.title(for: lvl.level)) · niveau \(lvl.level)").font(V2Font.system(size: 18, weight: .semibold)).foregroundStyle(MMColor.ink)
                        Text("\(store.overview?.projects.count ?? 0) business suivis · \(lvl.points) points")
                            .font(V2Font.system(size: 14)).foregroundStyle(SettingsTheme.valueTint)
                        GeometryReader { g in
                            Capsule().fill(MMColor.fg(0.08))
                                .overlay(alignment: .leading) {
                                    Capsule().fill(LinearGradient(colors: [RecoveryTileTheme.violetDeep, RecoveryTileTheme.violetBright], startPoint: .leading, endPoint: .trailing))
                                        .frame(width: max(4, g.size.width * Double(lvl.into) / Double(max(lvl.next, 1))))
                                }
                        }
                        .frame(height: 5).padding(.top, 2)
                    }
                    Image(systemName: "chevron.right").font(V2Font.system(size: 13, weight: .semibold)).foregroundStyle(SettingsTheme.chevronTint)
                }
                .padding(.horizontal, 16).padding(.vertical, 14)
                .contentShape(Rectangle())
            }
            .settingsRowButton()
        }
    }

    private var currentIconTitle: String {
        Rewards.icons.first { $0.alternateName == UIApplication.shared.alternateIconName }?.title ?? String(localized: "Classique")
    }

    private func link(_ title: LocalizedStringResource, _ icon: String, _ url: String) -> some View {
        Link(destination: URL(string: url)!) { SettingsRow(icon: icon, title: String(localized: title), trailing: .external) }
            .buttonStyle(SettingsRowPressStyle())
    }
}


// MARK: - MoneyMaker Pro (29 €, une fois, payé avec Stripe)

struct BillingStatus: Decodable { let pro: Bool; let ownedProjects: Int; let freeProjects: Int; let available: Bool }

extension MoneyMakerClient {
    func billing() async throws -> BillingStatus { try await get("billing") }
    func proCheckoutURL() async throws -> URL {
        struct R: Decodable { let url: URL }
        let r: R = try await send("POST", "billing/checkout", body: ["returnUrl": "https://usemoneymaker.com/"])
        return r.url
    }
}

/// Licence Pro : statut, et achat via Stripe Checkout dans Safari. Là où Apple l'exige (UE avec le
/// droit External Purchase), la fiche d'information d'Apple s'affiche avant de quitter l'app.
struct ProSettingsSection: View {
    @EnvironmentObject var store: Store
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var phase
    @State private var status: BillingStatus?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        if let status, status.available || status.pro {
            SettingsSectionTitle(title: "MoneyMaker Pro")
            SettingsCard {
                if status.pro {
                    SettingsRow(icon: "checkmark.seal.fill", title: String(localized: "Pro à vie"), trailing: .status(String(localized: "Actif")))
                } else {
                    Button { Task { await buy() } } label: {
                        SettingsRow(icon: "crown.fill", title: String(localized: "Business illimités"),
                                    trailing: busy ? .status("…") : .badge(String(localized: "29 € À VIE"), MMColor.accent))
                    }.settingsRowButton().disabled(busy)
                }
            }
            SettingsFootnote(text: error ?? (status.pro
                ? String(localized: "Merci ! Tous tes business sont débloqués, pour toujours.")
                : String(localized: "Le plan gratuit inclut \(status.freeProjects) business. Paiement unique et sécurisé avec Stripe, sans abonnement.")))
        }
        Color.clear.frame(height: 0)
            .task { await load() }
            .onChange(of: phase) { _, p in if p == .active { Task { await load() } } }
    }

    private func load() async { status = try? await store.client.billing() }

    private func buy() async {
        busy = true; error = nil; defer { busy = false }
        do {
            let url = try await store.client.proCheckoutURL()
            if #available(iOS 17.4, *), await ExternalPurchase.canPresent {
                if case .cancelled = try await ExternalPurchase.presentNoticeSheet() { return }
            }
            openURL(url)
        } catch { self.error = error.localizedDescription }
    }
}
