//
//  LiveScreens.swift
//  MoneyMaker — UI temps réel : carte « Aujourd'hui », flux des ventes,
//  réglages des notifications, de la Live Activity et des widgets.
//

import SwiftUI
import UserNotifications
import WidgetKit

// MARK: - Carte « Aujourd'hui »

struct TodayCard: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var live = LiveActivityManager.shared
    @State private var selected: Date?
    @State private var pulse = false

    var body: some View {
        let t = store.today ?? MMShared.cachedToday
        MMCard(padding: 20, glow: MMColor.accent) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    HStack(spacing: 7) {
                        Circle().fill(MMColor.accent).frame(width: 7, height: 7)
                            .shadow(color: MMColor.accent, radius: pulse ? 7 : 2)
                            .scaleEffect(pulse ? 1.25 : 0.9)
                        Text("AUJOURD'HUI").font(MMFont.system(11, .medium)).tracking(2.2).foregroundStyle(MMColor.ink3)
                    }
                    Spacer()
                    Button {
                        Task { live.isRunning ? await live.stop() : await live.start() }
                    } label: {
                        Label(live.isRunning ? "En direct" : "Suivre en direct", systemImage: live.isRunning ? "dot.radiowaves.left.and.right" : "play.circle")
                            .font(MMFont.system(12, .medium))
                            .foregroundStyle(live.isRunning ? .black : MMColor.ink)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(live.isRunning ? AnyShapeStyle(MMColor.accent) : AnyShapeStyle(Color.white.opacity(0.08)), in: Capsule())
                    }
                    .buttonStyle(MMPressStyle(scale: 0.94))
                    .sensoryFeedback(.success, trigger: live.isRunning)
                }
                if let t {
                    let pts = points(t)
                    let p = selected.flatMap { d in pts.min { abs($0.date.timeIntervalSince(d)) < abs($1.date.timeIntervalSince(d)) } }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(p.map { Int($0.value * 1e6).money(t.currency) } ?? t.netMicros.money(t.currency))
                            .font(MMFont.number(52)).tracking(-1.6).lineLimit(1).minimumScaleFactor(0.5)
                            .contentTransition(.numericText(value: p?.value ?? Double(t.netMicros)))
                            .animation(.snappy(duration: 0.3), value: p?.value ?? Double(t.netMicros))
                        Text(p.map { "à \($0.date.formatted(.dateTime.hour()))" } ?? "\(t.sales) ventes · \(t.renewals) renouvellements · \(t.trials) essais")
                            .font(MMFont.system(13)).foregroundStyle(MMColor.ink2).contentTransition(.numericText())
                    }
                    MMGlowChart(points: pts, selection: $selected).frame(height: 110)
                        .sensoryFeedback(.selection, trigger: p?.date)
                    if let l = t.last {
                        HStack(spacing: 8) {
                            Image(systemName: "arrow.up.right").font(.system(size: 10, weight: .bold)).foregroundStyle(MMColor.accent)
                            Text("+\(l.amountMicros.money(l.currency)) · \(l.projectName)").lineLimit(1)
                            Spacer()
                            Text(Date(timeIntervalSince1970: l.at / 1000), style: .relative).monospacedDigit()
                        }
                        .font(MMFont.system(12)).foregroundStyle(MMColor.ink2)
                    }
                } else {
                    Text("—").font(MMFont.number(52))
                }
            }
        }
        .onAppear { withAnimation(.easeInOut(duration: 1.6).repeatForever()) { pulse = true } }
        .onChange(of: store.liveTick) { _, _ in
            withAnimation(.spring(response: 0.3, dampingFraction: 0.5)) { pulse.toggle() }
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: store.liveTick)
    }

    private func points(_ t: Today) -> [MMPoint] {
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
                MMLabel(text: "Ventes en direct")
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
                            FeedItemRow(e: e).transition(.asymmetric(insertion: .move(edge: .top).combined(with: .opacity), removal: .opacity))
                        }
                    }
                    .animation(.spring(response: 0.45, dampingFraction: 0.85), value: store.feed.first?.id)
                }
            }
        }
    }
}

struct FeedItemRow: View {
    let e: FeedEvent
    var body: some View {
        let tint = e.type == "REFUND" || e.type == "BILLING_ISSUE" ? MMColor.red : e.isRevenue ? MMColor.accent : e.type == "CANCELLATION" || e.type == "EXPIRATION" ? MMColor.orange : MMColor.blue
        HStack(spacing: 12) {
            Image(systemName: e.symbol).font(.system(size: 12, weight: .bold)).foregroundStyle(tint)
                .frame(width: 30, height: 30).background(tint.opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(e.title).font(MMFont.system(14, .medium))
                Text([e.projectName, e.productId, e.country.map { "\(flagEmoji($0)) \($0)" }].compactMap { $0 }.joined(separator: " · "))
                    .font(MMFont.system(11)).foregroundStyle(MMColor.ink3).lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                if let a = e.amountText { Text(a).font(MMFont.number(15, .regular)).foregroundStyle(e.type == "REFUND" ? MMColor.red : MMColor.ink) }
                Text(e.date, style: .relative).font(MMFont.system(11)).foregroundStyle(MMColor.ink3).monospacedDigit()
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }
}

struct FeedScreen: View {
    @EnvironmentObject var store: Store
    @State private var events: [FeedEvent] = []
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Ventes en direct").font(MMFont.system(34, .bold)).tracking(-0.8)
                    Text(store.selectedProject?.name ?? "Tous les business").font(MMFont.system(13)).foregroundStyle(MMColor.ink3)
                }
                .padding(.top, 8).mmAppear(0)
                ForEach(Array(groups.enumerated()), id: \.element.0) { gi, group in
                    let (day, items) = group
                    MMLabel(text: day).padding(.horizontal, 4).padding(.top, 6).mmAppear(1 + gi)
                    MMCard(padding: 0) {
                        VStack(spacing: 0) {
                            ForEach(Array(items.enumerated()), id: \.element.id) { i, e in
                                if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 56) }
                                FeedItemRow(e: e)
                            }
                        }
                    }
                    .mmScrollReveal()
                    .mmAppear(1 + gi)
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        .navigationBarTitleDisplayMode(.inline)
        .mmPage()
        .refreshable { await load() }
        .task { events = store.feed; await load() }
        .onReceive(NotificationCenter.default.publisher(for: .mmLiveEvent)) { _ in Task { await load() } }
        .onChange(of: store.selectedProjectId) { _, _ in Task { await load() } }
    }

    private var groups: [(String, [FeedEvent])] {
        let cal = Calendar.current
        let byDay = Dictionary(grouping: events) { cal.startOfDay(for: $0.date) }
        return byDay.keys.sorted(by: >).map { d in
            (cal.isDateInToday(d) ? "Aujourd'hui" : cal.isDateInYesterday(d) ? "Hier" : d.formatted(.dateTime.weekday(.wide).day().month(.wide)), byDay[d]!.sorted { $0.at > $1.at })
        }
    }

    private func load() async {
        if let e = try? await store.client.feed(limit: 100, projectId: store.selectedProjectId) { withAnimation(.snappy) { events = e } }
    }
}

// MARK: - Réglages notifications & widgets

struct LiveSettingsView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var push = PushManager.shared
    @ObservedObject private var live = LiveActivityManager.shared
    @State private var goal = MMShared.mrrGoal.map(String.init) ?? ""
    var embedded = false

    var body: some View {
        if embedded { content } else {
            NavigationStack {
                content
                    .navigationTitle("Notifications")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("OK") { dismiss() } } }
            }
            .presentationBackground(Color.black)
        }
    }

    private var content: some View {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if embedded {
                        Text("Réglages").font(MMFont.system(34, .bold)).tracking(-0.8).padding(.top, 8).mmAppear(0)
                    }
                    statusCard.mmAppear(1)
                    group("Ventes", [
                        toggle("Nouveaux abonnés & achats", "arrow.up.right", \.sales),
                        toggle("Renouvellements", "arrow.clockwise", \.renewals),
                        toggle("Essais démarrés", "sparkles", \.trials),
                    ]).mmAppear(2)
                    group("Risques", [
                        toggle("Problèmes de paiement", "exclamationmark.triangle", \.billing),
                        toggle("Remboursements", "arrow.uturn.backward", \.refunds),
                        toggle("Annulations & expirations", "xmark.circle", \.churn),
                    ]).mmAppear(3)
                    group("App Store & récap", [
                        toggle("Classements App Store", "trophy", \.rankings),
                        toggle("Récap du soir (21 h)", "moon.stars", \.dailySummary),
                    ]).mmAppear(4)
                    group("Expérience", [
                        toggle("Son « cha-ching »", "speaker.wave.2", \.sound),
                        toggle("Live Activity automatique à la 1re vente", "dot.radiowaves.left.and.right", \.liveActivityAuto),
                        toggle("Inclure les achats sandbox", "hammer", \.sandbox),
                    ]).mmAppear(5)
                    if let projects = store.overview?.projects, projects.count > 1 {
                        MMLabel(text: "Business notifiés").padding(.horizontal, 4).padding(.top, 8)
                        MMCard(padding: 0) {
                            VStack(spacing: 0) {
                                ForEach(Array(projects.enumerated()), id: \.element.id) { i, p in
                                    if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 18) }
                                    Toggle(isOn: Binding(get: { !push.prefs.mutedProjects.contains(p.projectId) },
                                                         set: { on in push.update { $0.mutedProjects.removeAll { $0 == p.projectId }; if !on { $0.mutedProjects.append(p.projectId) } } })) {
                                        Text(p.name).font(MMFont.system(15))
                                    }
                                    .padding(.horizontal, 18).padding(.vertical, 12)
                                }
                            }
                        }
                    }
                    widgetsCard.mmAppear(6)
                    if embedded { accountCard.mmAppear(7) }
                    if let e = push.lastError {
                        Text(e).font(MMFont.system(12)).foregroundStyle(MMColor.red).padding(.horizontal, 4)
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 40)
                .tint(MMColor.accent)
            }
            .scrollIndicators(.hidden)
            .mmPage()
            .task { await push.refreshAuthorization() }
    }

    private var accountCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            MMLabel(text: "Compte").padding(.horizontal, 4).padding(.top, 8)
            MMCard(padding: 0) {
                VStack(spacing: 0) {
                    Link(destination: URL(string: "https://moneymaker-io.web.app")!) {
                        HStack(spacing: 14) {
                            Image(systemName: "safari").font(.system(size: 13, weight: .semibold)).foregroundStyle(MMColor.ink2).frame(width: 20)
                            Text("Ouvrir le dashboard web").font(MMFont.system(15))
                            Spacer()
                            Image(systemName: "arrow.up.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(MMColor.ink3)
                        }
                        .foregroundStyle(MMColor.ink)
                        .padding(.horizontal, 16).padding(.vertical, 14)
                    }
                    Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 52)
                    Button(role: .destructive) { store.signOut() } label: {
                        HStack(spacing: 14) {
                            Image(systemName: "rectangle.portrait.and.arrow.right").font(.system(size: 13, weight: .semibold)).frame(width: 20)
                            Text("Déconnexion").font(MMFont.system(15))
                            Spacer()
                        }
                        .foregroundStyle(MMColor.red)
                        .padding(.horizontal, 16).padding(.vertical, 14)
                    }
                }
            }
        }
    }

    private var statusCard: some View {
        MMCard(padding: 18, radius: 24, glow: push.status == .authorized ? MMColor.accent : nil) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Image(systemName: push.status == .authorized ? "bell.badge.fill" : "bell.slash")
                        .foregroundStyle(push.status == .authorized ? MMColor.accent : MMColor.ink3)
                        .frame(width: 38, height: 38).background(Color.white.opacity(0.06), in: Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text(push.status == .authorized ? "Notifications actives" : push.status == .denied ? "Notifications désactivées" : "Notifications à activer")
                            .font(MMFont.system(15, .medium))
                        Text(push.status == .denied ? "Réactive-les dans Réglages → MoneyMaker." : "Instantanées, groupées par business.")
                            .font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                    }
                    Spacer()
                }
                HStack(spacing: 10) {
                    if push.status == .denied {
                        pill("Ouvrir Réglages", filled: true) { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) }
                    } else if push.status != .authorized {
                        pill("Activer", filled: true) { NotificationPrompt.shared.show() }
                    } else {
                        pill(push.testing ? "Envoi…" : "Envoyer un test", filled: true) { Task { await push.sendTest() } }
                    }
                    pill(live.isRunning ? "Arrêter le direct" : "Live Activity", filled: false) {
                        Task { live.isRunning ? await live.stop() : await live.start() }
                    }
                }
            }
        }
    }

    private var widgetsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            MMLabel(text: "Widgets").padding(.horizontal, 4).padding(.top, 8)
            MMCard(padding: 18, radius: 24) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("Objectif de MRR").font(MMFont.system(15))
                        Spacer()
                        TextField("10000", text: $goal).keyboardType(.numberPad).multilineTextAlignment(.trailing)
                            .font(MMFont.number(17, .regular)).frame(width: 110)
                            .onChange(of: goal) { _, v in
                                MMShared.mrrGoal = Int(v.filter(\.isNumber))
                                WidgetCenter.shared.reloadTimelines(ofKind: "MoneyMakerOverview")
                            }
                        Text(store.overview?.currency ?? "EUR").font(MMFont.system(13)).foregroundStyle(MMColor.ink3)
                    }
                    Rectangle().fill(MMColor.hairline).frame(height: 1)
                    Text("Ajoute les widgets depuis l'écran d'accueil : Aujourd'hui, Ventes en direct, MRR (par business, avec objectif), Classements. Sur l'écran verrouillé et dans le Centre de contrôle aussi.")
                        .font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                }
            }
        }
    }

    private func pill(_ title: String, filled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(MMFont.system(13, .medium)).foregroundStyle(filled ? .black : MMColor.ink)
                .frame(maxWidth: .infinity).padding(.vertical, 11)
                .background(filled ? AnyShapeStyle(MMColor.accent) : AnyShapeStyle(Color.white.opacity(0.08)), in: Capsule())
        }
        .buttonStyle(MMPressStyle())
    }

    private func group(_ title: String, _ rows: [AnyView]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            MMLabel(text: title).padding(.horizontal, 4).padding(.top, 8)
            MMCard(padding: 0) {
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
                        if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 52) }
                        r
                    }
                }
            }
            .disabled(push.status == .denied)
            .opacity(push.status == .denied ? 0.5 : 1)
        }
    }

    private func toggle(_ title: String, _ icon: String, _ key: WritableKeyPath<PushPrefs, Bool>) -> AnyView {
        AnyView(
            Toggle(isOn: Binding(get: { push.prefs[keyPath: key] }, set: { v in push.update { $0[keyPath: key] = v } })) {
                HStack(spacing: 14) {
                    Image(systemName: icon).font(.system(size: 13, weight: .semibold)).foregroundStyle(MMColor.ink2).frame(width: 20)
                    Text(title).font(MMFont.system(15))
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .sensoryFeedback(.selection, trigger: push.prefs[keyPath: key])
        )
    }
}
