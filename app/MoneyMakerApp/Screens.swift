import SwiftUI
import Charts

private let dashboardURL = URL(string: "https://moneymaker-io.web.app")!

struct RootView: View {
    @StateObject private var store = Store()
    var body: some View {
        ZStack {
            if store.token == nil {
                SignInView().transition(.opacity.combined(with: .scale(scale: 1.04)))
            } else {
                RootTabView().transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.45), value: store.token == nil)
        .environmentObject(store)
    }
}

// MARK: - Connexion

struct SignInView: View {
    @EnvironmentObject var store: Store
    @State private var token = ""
    @State private var pulse = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            ZStack {
                Circle().fill(MMColor.accent.opacity(0.18)).frame(width: 190, height: 190).blur(radius: 50)
                    .scaleEffect(pulse ? 1.12 : 0.9)
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .fill(LinearGradient(colors: [MMColor.accent, MMColor.accent.opacity(0.75)], startPoint: .top, endPoint: .bottom))
                    .frame(width: 84, height: 84)
                    .overlay { Image(systemName: "dollarsign").font(.system(size: 38, weight: .bold)).foregroundStyle(.black) }
                    .shadow(color: MMColor.accent.opacity(0.5), radius: 30, y: 10)
            }
            .mmAppear(0)
            .onAppear { withAnimation(.easeInOut(duration: 3).repeatForever()) { pulse = true } }

            VStack(spacing: 10) {
                Text("MoneyMaker").font(MMFont.system(36, .bold)).tracking(-0.9)
                Text("TOUS TES REVENUS, EN DIRECT").font(MMFont.system(11, .medium)).tracking(2.4).foregroundStyle(MMColor.ink3)
            }
            .padding(.top, 28).mmAppear(1)

            Spacer()

            VStack(spacing: 14) {
                HStack(spacing: 12) {
                    Image(systemName: "key.horizontal").foregroundStyle(focused ? MMColor.accent : MMColor.ink3)
                    SecureField("", text: $token, prompt: Text("mm_pat_…").foregroundStyle(MMColor.ink3))
                        .font(MMFont.system(16)).focused($focused)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                .padding(.horizontal, 20).padding(.vertical, 17)
                .mmGlass(in: Capsule())
                .overlay { Capsule().strokeBorder(focused ? MMColor.accent.opacity(0.5) : .clear, lineWidth: 1) }
                .animation(.easeOut(duration: 0.2), value: focused)

                MMPrimaryButton(title: "Connexion", loading: store.loading) { Task { await store.signIn(token) } }
                    .disabled(token.isEmpty || store.loading)
                    .opacity(token.isEmpty ? 0.45 : 1)

                if let e = store.error {
                    Text(e).font(MMFont.system(13)).foregroundStyle(MMColor.red).transition(.opacity)
                }
                Text("Crée un jeton sur le dashboard → Compte & accès.")
                    .font(MMFont.system(12)).foregroundStyle(MMColor.ink3).multilineTextAlignment(.center)
                Link("Ouvrir le dashboard", destination: dashboardURL).font(MMFont.system(13, .medium)).foregroundStyle(MMColor.ink2)
            }
            .mmAppear(2)
        }
        .padding(.horizontal, 24).padding(.bottom, 20)
        .mmPage()
        .sensoryFeedback(.error, trigger: store.error)
    }
}

// MARK: - Vue d'ensemble

struct RootTabView: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var router = Router.shared
    @Environment(\.scenePhase) private var phase
    @State private var tab = 0
    @State private var homePath = NavigationPath()

    private let items: [MMTabBar.Item] = [
        .init(tag: 0, title: "Accueil", icon: "square.grid.2x2.fill"),
        .init(tag: 1, title: "Ventes", icon: "bolt.fill"),
        .init(tag: 2, title: "Planète", icon: "globe.europe.africa.fill"),
        .init(tag: 3, title: "Réglages", icon: "gearshape.fill"),
    ]

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.ignoresSafeArea()
            // Accueil, Ventes et Réglages restent montés (scroll et état conservés) ;
            // la planète n'est rendue que visible : elle anime 60 i/s.
            OverviewView(path: $homePath).tabLayer(tab == 0)
            NavigationStack { FeedScreen().toolbar(.hidden, for: .navigationBar) }.tabLayer(tab == 1)
            if tab == 2 { NavigationStack { GlobeScreen().toolbar(.hidden, for: .navigationBar) }.transition(.opacity) }
            NavigationStack { LiveSettingsView(embedded: true).toolbar(.hidden, for: .navigationBar) }.tabLayer(tab == 3)
            MMTabBar(selection: $tab, items: items) { t in if t == 0 { withAnimation { homePath = NavigationPath() } } }
                .padding(.bottom, 4)
                .ignoresSafeArea(.keyboard)
        }
        .task { await store.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: .mmLiveEvent)) { _ in Task { await store.refreshLive() } }
        .onChange(of: phase) { _, p in if p == .active { Task { await store.refreshLive() } } }
        .onChange(of: router.pending) { _, d in route(d) }
        .onAppear { route(router.pending) }
    }

    private func route(_ d: Router.Destination?) {
        guard let d else { return }
        router.pending = nil
        withAnimation(.snappy) {
            switch d {
            case .today: tab = 0; homePath = NavigationPath()
            case .feed: tab = 1
            case .globe: tab = 2
            case .project: tab = 0; homePath = NavigationPath(); homePath.append(d)
            }
        }
    }
}

private extension View {
    func tabLayer(_ visible: Bool) -> some View {
        opacity(visible ? 1 : 0).allowsHitTesting(visible).accessibilityHidden(!visible)
    }
}

struct OverviewView: View {
    @EnvironmentObject var store: Store
    @Binding var path: NavigationPath
    @State private var selected: Date?

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    header.mmAppear(0)
                    EnableAlertsCard().mmAppear(1)
                    if store.today != nil { TodayCard().mmAppear(1) }
                    if let o = store.overview {
                        hero(o).mmAppear(2)
                        stats(o).mmAppear(3)
                        if !store.alerts.isEmpty { alerts.mmAppear(4) }
                        businesses(o).mmAppear(5)
                        Text("Mis à jour \(Date(timeIntervalSince1970: o.generatedAt / 1000).formatted(.relative(presentation: .named)))")
                            .font(MMFont.system(11)).foregroundStyle(MMColor.ink3).frame(maxWidth: .infinity).padding(.top, 6)
                    } else {
                        skeleton
                    }
                    if let e = store.error {
                        Label(e, systemImage: "exclamationmark.triangle").font(MMFont.system(13)).foregroundStyle(MMColor.red)
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
            .refreshable { await store.refresh() }
            .navigationDestination(for: ProjectSummary.self) { ProjectView(p: $0) }
            .navigationDestination(for: Router.Destination.self) { d in
                if case .project(let id) = d, let p = store.overview?.projects.first(where: { $0.projectId == id }) { ProjectView(p: p) }
            }
            .toolbar(.hidden, for: .navigationBar)
            .mmPage()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image("Logo")
                .resizable().scaledToFit()
                .frame(height: 40)
                .frame(maxWidth: .infinity)
                .shadow(color: .white.opacity(0.18), radius: 10)
                .accessibilityLabel("MoneyMaker")
                .padding(.bottom, 14)
            Text(Date().formatted(.dateTime.weekday(.wide).day().month(.wide)).uppercased())
                .font(MMFont.system(11, .medium)).tracking(2.2).foregroundStyle(MMColor.ink3)
            Text("Revenus").font(MMFont.system(34, .bold)).tracking(-0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
    }

    private func hero(_ o: Overview) -> some View {
        let pts = dailySeries(o.revenueByDay, days: min(o.periodDays, 90))
        let point = selected.flatMap { d in pts.min { abs($0.date.timeIntervalSince(d)) < abs($1.date.timeIntervalSince(d)) } }
        return MMCard(padding: 20, glow: MMColor.accent) {
            VStack(alignment: .leading, spacing: 16) {
                MMLabel(text: point == nil ? "MRR" : "Revenu du jour",
                        trailing: point.map { $0.date.formatted(.dateTime.day().month(.abbreviated)) } ?? "ARR \((o.mrrMicros * 12).money(o.currency, compact: true))")
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(point.map { Int($0.value * 1e6).money(o.currency) } ?? o.mrrMicros.money(o.currency))
                        .font(MMFont.number(52, .light)).tracking(-1.6)
                        .lineLimit(1).minimumScaleFactor(0.5)
                        .contentTransition(.numericText(value: point?.value ?? Double(o.mrrMicros)))
                        .animation(.snappy(duration: 0.25), value: point?.value)
                    if point == nil { MMDelta(value: halfOverHalf(pts)) }
                }
                MMGlowChart(points: pts, selection: $selected, showsAxis: true)
                    .frame(height: 170)
                    .sensoryFeedback(.selection, trigger: point?.date)
                MMSegmented(options: [(7, "7 J"), (30, "30 J"), (90, "90 J"), (365, "1 AN")], selection: $store.days)
                    .onChange(of: store.days) { _, _ in Task { await store.refresh() } }
            }
        }
    }

    private func stats(_ o: Overview) -> some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible())], spacing: 12) {
            StatTile(icon: "eurosign", title: "Revenu \(o.periodDays) j", value: o.revenueMicros.money(o.currency, compact: true))
            StatTile(icon: "creditcard", title: "Users payants", value: (o.payingCustomers ?? o.activeSubscriptions).formatted())
            if let dl = o.downloads { StatTile(icon: "arrow.down.app", title: "Téléchargements", value: dl.formatted()) }
            if o.hasTrials ?? (o.activeTrials > 0) { StatTile(icon: "hourglass", title: "Essais", value: o.activeTrials.formatted()) }
            StatTile(icon: "arrow.triangle.2.circlepath", title: "Abonnés actifs", value: o.activeSubscriptions.formatted())
            if o.downloads == nil && !(o.hasTrials ?? (o.activeTrials > 0)) { StatTile(icon: "sparkle", title: "Nouveaux", value: o.newCustomers.formatted()) }
        }
    }

    private var alerts: some View {
        VStack(alignment: .leading, spacing: 10) {
            MMLabel(text: "Classements App Store").padding(.horizontal, 4).padding(.top, 8)
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    ForEach(store.alerts.prefix(8)) { AlertCard(a: $0) }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollIndicators(.hidden)
            .scrollClipDisabled()
        }
    }

    private func businesses(_ o: Overview) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            MMLabel(text: "Business", trailing: "\(o.projects.count)").padding(.horizontal, 4).padding(.top, 8)
            if o.projects.isEmpty {
                MMCard { Text("Aucun business. Crée-en un sur le dashboard.").font(MMFont.system(14)).foregroundStyle(MMColor.ink2) }
            } else {
                MMCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(Array(o.projects.enumerated()), id: \.element.id) { i, p in
                            if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 18) }
                            NavigationLink(value: p) { ProjectRow(p: p) }.buttonStyle(MMPressStyle(scale: 0.98))
                        }
                    }
                }
            }
        }
    }

    private var skeleton: some View {
        VStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 28, style: .continuous).fill(MMColor.cardFill).frame(height: 340)
            HStack(spacing: 12) {
                ForEach(0..<2, id: \.self) { _ in RoundedRectangle(cornerRadius: 22, style: .continuous).fill(MMColor.cardFill).frame(height: 96) }
            }
        }
        .modifier(MMShimmer())
    }
}

struct StatTile: View {
    let icon: String, title: String, value: String
    var body: some View {
        MMCard(padding: 16, radius: 22) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(title.uppercased()).font(MMFont.system(10, .medium)).tracking(1.6).foregroundStyle(MMColor.ink3).lineLimit(1)
                    Spacer()
                    Image(systemName: icon).font(.system(size: 11, weight: .semibold)).foregroundStyle(MMColor.ink3)
                }
                Text(value).font(MMFont.number(26)).tracking(-0.6).lineLimit(1).minimumScaleFactor(0.6)
                    .contentTransition(.numericText())
            }
        }
    }
}

struct ProjectRow: View {
    let p: ProjectSummary
    var body: some View {
        HStack(spacing: 14) {
            Text(String(p.name.prefix(1)).uppercased())
                .font(MMFont.system(15, .medium)).foregroundStyle(MMColor.ink)
                .frame(width: 38, height: 38)
                .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(p.name).font(MMFont.system(15, .medium)).foregroundStyle(MMColor.ink).lineLimit(1)
                Text("\(p.activeSubscriptions) abonnés · \(p.activeTrials) essais").font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
            }
            Spacer(minLength: 8)
            MMSparkline(values: dailySeries(p.revenueByDay, days: 30).map(\.value)).frame(width: 54, height: 24)
            Text(p.mrrMicros.money(p.currency, compact: true)).font(MMFont.number(15, .regular)).foregroundStyle(MMColor.ink)
                .frame(minWidth: 64, alignment: .trailing)
        }
        .padding(.horizontal, 18).padding(.vertical, 14)
        .contentShape(Rectangle())
    }
}

struct AlertCard: View {
    let a: RankingAlert
    var body: some View {
        let down = a.type == "DROP" || a.type == "LEFT_CHART"
        MMCard(padding: 16, radius: 22) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Image(systemName: a.symbol).font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(down ? MMColor.red : MMColor.accent)
                        .frame(width: 28, height: 28)
                        .background((down ? MMColor.red : MMColor.accent).opacity(0.12), in: Circle())
                    Spacer()
                    Text(flagEmoji(a.cc)).font(.system(size: 18))
                }
                Text(a.rank.map { "#\($0)" } ?? "—").font(MMFont.number(32)).tracking(-0.8)
                VStack(alignment: .leading, spacing: 2) {
                    Text(a.title).font(MMFont.system(13, .medium)).lineLimit(1)
                    Text("\(a.appName ?? "") · \(a.chartLabel)").font(MMFont.system(11)).foregroundStyle(MMColor.ink3).lineLimit(1)
                }
            }
        }
        .frame(width: 168)
    }
}

// MARK: - Business

struct ProjectView: View {
    @EnvironmentObject var store: Store
    let p: ProjectSummary
    @State private var events: [EventItem] = []
    @State private var apps: [TrackedAppSummary] = []
    @State private var selected: Date?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(p.name).font(MMFont.system(34, .bold)).tracking(-0.8).lineLimit(2).mmAppear(0)
                hero.mmAppear(1)
                rates.mmAppear(2)
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible())], spacing: 12) {
                    StatTile(icon: "eurosign", title: "Revenu", value: p.netRevenueMicros.money(p.currency, compact: true))
                    StatTile(icon: "person.2", title: "Abonnés", value: "\(p.activeSubscriptions)")
                    StatTile(icon: "hourglass", title: "Essais", value: "\(p.activeTrials)")
                    StatTile(icon: "sparkle", title: "Nouveaux", value: "\(p.newCustomers)")
                }
                .mmAppear(3)
                if p.billingIssues > 0 {
                    MMCard(padding: 16, radius: 22, glow: MMColor.orange) {
                        Label("\(p.billingIssues) problème(s) de paiement en cours", systemImage: "exclamationmark.triangle.fill")
                            .font(MMFont.system(14, .medium)).foregroundStyle(MMColor.orange)
                    }
                }
                if !apps.isEmpty {
                    MMLabel(text: "App Store").padding(.horizontal, 4).padding(.top, 8)
                    ForEach(apps) { TrackedAppCard(app: $0).mmScrollReveal() }
                }
                MMLabel(text: "Activité", trailing: events.isEmpty ? nil : "\(events.count)").padding(.horizontal, 4).padding(.top, 8)
                if events.isEmpty {
                    MMCard { Text("Aucun événement pour l'instant.").font(MMFont.system(14)).foregroundStyle(MMColor.ink2) }
                } else {
                    MMCard(padding: 0) {
                        VStack(spacing: 0) {
                            ForEach(Array(events.enumerated()), id: \.element.id) { i, e in
                                EventRow(e: e, isLast: i == events.count - 1)
                            }
                        }
                        .padding(.vertical, 8)
                    }
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        .navigationBarTitleDisplayMode(.inline)
        .mmPage()
        .refreshable { await load() }
        .task { await load() }
    }

    private var hero: some View {
        let pts = dailySeries(p.revenueByDay, days: 30)
        let point = selected.flatMap { d in pts.min { abs($0.date.timeIntervalSince(d)) < abs($1.date.timeIntervalSince(d)) } }
        return MMCard(padding: 20, glow: MMColor.accent) {
            VStack(alignment: .leading, spacing: 16) {
                MMLabel(text: point == nil ? "MRR" : "Revenu du jour",
                        trailing: point.map { $0.date.formatted(.dateTime.day().month(.abbreviated)) } ?? "30 jours")
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(point.map { Int($0.value * 1e6).money(p.currency) } ?? p.mrrMicros.money(p.currency))
                        .font(MMFont.number(48)).tracking(-1.4).lineLimit(1).minimumScaleFactor(0.5)
                        .contentTransition(.numericText(value: point?.value ?? Double(p.mrrMicros)))
                        .animation(.snappy(duration: 0.25), value: point?.value)
                    if point == nil { MMDelta(value: halfOverHalf(pts)) }
                }
                MMGlowChart(points: pts, selection: $selected, showsAxis: true).frame(height: 150)
                    .sensoryFeedback(.selection, trigger: point?.date)
            }
        }
    }

    private var rates: some View {
        HStack(spacing: 12) {
            RateTile(title: "Conversion essai", value: p.trialConversionRate, color: MMColor.accent)
            RateTile(title: "Churn", value: p.churnRate, color: MMColor.red)
        }
    }

    func load() async {
        async let e = try? store.client.events(projectId: p.projectId)
        async let a = try? store.client.trackedApps(projectId: p.projectId)
        let (ne, na) = await (e, a)
        withAnimation(.easeOut(duration: 0.35)) {
            events = ne ?? events
            apps = na ?? apps
        }
    }
}

struct RateTile: View {
    let title: String, value: Double?, color: Color
    var body: some View {
        MMCard(padding: 16, radius: 22) {
            HStack(spacing: 14) {
                ZStack {
                    MMRing(value: value ?? 0, color: color, lineWidth: 5)
                }
                .frame(width: 42, height: 42)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title.uppercased()).font(MMFont.system(10, .medium)).tracking(1.4).foregroundStyle(MMColor.ink3).lineLimit(1)
                    Text(value.map { $0.formatted(.percent.precision(.fractionLength(1))) } ?? "—").font(MMFont.number(22))
                }
            }
        }
    }
}

struct EventRow: View {
    let e: EventItem
    let isLast: Bool
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(spacing: 0) {
                Circle().fill(color).frame(width: 8, height: 8).shadow(color: color.opacity(0.7), radius: 4).padding(.top, 6)
                if !isLast { Rectangle().fill(MMColor.hairline).frame(width: 1).frame(maxHeight: .infinity) }
            }
            .frame(width: 10)
            VStack(alignment: .leading, spacing: 3) {
                Text(label).font(MMFont.system(14, .medium))
                Text([e.productId, e.appUserId].compactMap { $0 }.joined(separator: " · "))
                    .font(MMFont.system(11)).foregroundStyle(MMColor.ink3).lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                if let m = e.priceMicros, m > 0, let c = e.currency {
                    Text(m.money(c)).font(MMFont.number(14, .regular)).foregroundStyle(MMColor.ink)
                }
                Text(Date(timeIntervalSince1970: e.at / 1000).formatted(.relative(presentation: .numeric)))
                    .font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
            }
        }
        .padding(.horizontal, 18).padding(.vertical, 8)
    }

    private var label: String {
        ["INITIAL_PURCHASE": "Nouvel abonné", "RENEWAL": "Renouvellement", "TRIAL_STARTED": "Essai démarré", "TRIAL_CONVERTED": "Essai converti",
         "CANCELLATION": "Annulation", "UNCANCELLATION": "Réactivation", "EXPIRATION": "Expiration", "BILLING_ISSUE": "Problème de paiement",
         "BILLING_RECOVERED": "Paiement récupéré", "REFUND": "Remboursement", "PRODUCT_CHANGE": "Changement d'offre",
         "NON_RENEWING_PURCHASE": "Achat", "GRANT": "Accès offert", "REVOKED": "Révoqué", "PAUSED": "En pause", "TEST": "Test"][e.type] ?? e.type
    }
    private var color: Color {
        switch e.type {
        case "INITIAL_PURCHASE", "TRIAL_CONVERTED", "RENEWAL", "NON_RENEWING_PURCHASE", "BILLING_RECOVERED": return MMColor.accent
        case "TRIAL_STARTED", "UNCANCELLATION", "GRANT": return MMColor.blue
        case "BILLING_ISSUE", "CANCELLATION": return MMColor.orange
        default: return MMColor.red
        }
    }
}

struct TrackedAppCard: View {
    let app: TrackedAppSummary
    var body: some View {
        MMCard(padding: 16, radius: 22) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    AsyncImage(url: app.icon.flatMap(URL.init(string:))) { $0.resizable() } placeholder: { MMColor.cardFill }
                        .frame(width: 46, height: 46).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                        .overlay { RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(MMColor.hairline) }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(app.name ?? app.appId).font(MMFont.system(15, .medium)).lineLimit(1)
                        Text(app.rating.map { "★ \($0.formatted(.number.precision(.fractionLength(2)))) · \((app.ratingCount ?? 0).formatted()) notes" } ?? "Pas encore de notes")
                            .font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(app.bestRank.map { "#\($0)" } ?? "—").font(MMFont.number(24)).foregroundStyle(MMColor.accent)
                        Text("\(app.countriesRanked ?? 0) pays").font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                    }
                }
                if let top = app.topRankings, !top.isEmpty {
                    ScrollView(.horizontal) {
                        HStack(spacing: 6) {
                            ForEach(top, id: \.self) { r in
                                Text("\(flagEmoji(r.cc)) #\(r.rank)\(r.scope == "genre" ? " cat." : "")")
                                    .font(MMFont.system(12, .medium)).monospacedDigit()
                                    .padding(.horizontal, 10).padding(.vertical, 6)
                                    .background(Color.white.opacity(0.06), in: Capsule())
                                    .overlay { Capsule().strokeBorder(MMColor.hairline) }
                            }
                        }
                    }
                    .scrollIndicators(.hidden)
                }
            }
        }
    }
}
