import SwiftUI
import Charts

@main
struct MoneyMakerApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
                // fixed-scheme: the whole product (dashboard, widgets) is dark-only.
                .preferredColorScheme(.dark)
                .tint(.mmGreen)
        }
    }
}

extension Color {
    static let mmGreen = Color(red: 0, green: 0.82, blue: 0.52)
    static let mmBlue = Color(red: 0, green: 0.58, blue: 0.91)
    static let mmCard = Color.white.opacity(0.06)
}

@MainActor
final class Store: ObservableObject {
    @Published var token: String? = MoneyMakerClient.stored.token
    @Published var overview: Overview? = MoneyMakerClient.cachedOverview
    @Published var days = 30
    @Published var error: String?
    @Published var loading = false

    var client: MoneyMakerClient { MoneyMakerClient(token: token) }

    func signIn(_ raw: String) async {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("mm_pat_") else { error = "Le jeton doit commencer par mm_pat_"; return }
        token = t
        await refresh()
        if error == nil { MoneyMakerClient.save(token: t) } else { token = nil }
    }

    func signOut() { MoneyMakerClient.save(token: nil); token = nil; overview = nil }

    func refresh() async {
        loading = true; defer { loading = false }
        do { overview = try await client.overview(days: days); error = nil }
        catch { self.error = error.localizedDescription }
    }
}

struct RootView: View {
    @StateObject private var store = Store()
    var body: some View {
        Group {
            if store.token == nil { SignInView() } else { OverviewView() }
        }
        .environmentObject(store)
    }
}

struct SignInView: View {
    @EnvironmentObject var store: Store
    @State private var token = ""
    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            Image(systemName: "dollarsign")
                .font(.system(size: 44, weight: .black)).foregroundStyle(.black)
                .frame(width: 88, height: 88).background(Color.mmGreen, in: RoundedRectangle(cornerRadius: 22))
            VStack(spacing: 6) {
                Text("MoneyMaker").font(.largeTitle.bold())
                Text("Tous tes revenus d'abonnement, en direct.").foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 8) {
                SecureField("mm_pat_…", text: $token)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding(14).background(Color.mmCard, in: RoundedRectangle(cornerRadius: 14))
                Text("Crée un jeton sur moneymaker-io.web.app → Compte & accès.").font(.footnote).foregroundStyle(.secondary)
            }
            Button {
                Task { await store.signIn(token) }
            } label: {
                HStack { if store.loading { ProgressView().tint(.black) }; Text("Connexion").bold() }
                    .frame(maxWidth: .infinity).padding(.vertical, 15)
                    .background(Color.mmGreen, in: RoundedRectangle(cornerRadius: 14)).foregroundStyle(.black)
            }
            .disabled(token.isEmpty || store.loading)
            if let e = store.error { Text(e).font(.footnote).foregroundStyle(.red) }
            Link("Ouvrir le dashboard", destination: URL(string: "https://moneymaker-io.web.app")!).font(.footnote)
            Spacer()
        }
        .padding(24)
    }
}

struct OverviewView: View {
    @EnvironmentObject var store: Store
    var body: some View {
        NavigationStack {
            ScrollView {
                if let o = store.overview {
                    VStack(alignment: .leading, spacing: 16) {
                        Picker("Période", selection: $store.days) {
                            Text("7 j").tag(7); Text("30 j").tag(30); Text("90 j").tag(90); Text("1 an").tag(365)
                        }
                        .pickerStyle(.segmented)
                        .onChange(of: store.days) { _, _ in Task { await store.refresh() } }

                        VStack(alignment: .leading, spacing: 4) {
                            Text("MRR").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                            Text(o.mrrMicros.money(o.currency)).font(.system(size: 44, weight: .bold, design: .rounded)).foregroundStyle(Color.mmGreen)
                                .contentTransition(.numericText())
                            Text("ARR \((o.mrrMicros * 12).money(o.currency, compact: true))").font(.footnote).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading).padding(18).background(Color.mmCard, in: RoundedRectangle(cornerRadius: 20))

                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                            Tile(title: "Revenu \(o.periodDays) j", value: o.revenueMicros.money(o.currency, compact: true))
                            Tile(title: "Abonnés", value: o.activeSubscriptions.formatted())
                            Tile(title: "Essais", value: o.activeTrials.formatted())
                            Tile(title: "Nouveaux clients", value: o.newCustomers.formatted())
                        }

                        VStack(alignment: .leading, spacing: 10) {
                            Text("Revenu par jour").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                            Chart(o.dailyRevenue(days: min(o.periodDays, 90)), id: \.date) { p in
                                BarMark(x: .value("Jour", p.date, unit: .day), y: .value("Revenu", Double(p.micros) / 1e6))
                                    .foregroundStyle(Color.mmBlue).cornerRadius(2)
                            }
                            .chartYAxis { AxisMarks(position: .trailing) }
                            .frame(height: 170)
                        }
                        .padding(18).background(Color.mmCard, in: RoundedRectangle(cornerRadius: 20))

                        Text("Business").font(.title3.bold()).padding(.top, 4)
                        ForEach(o.projects) { p in
                            NavigationLink(value: p) { ProjectRow(p: p) }.buttonStyle(.plain)
                        }
                        if o.projects.isEmpty {
                            Text("Aucun business. Crée-en un sur le dashboard.").foregroundStyle(.secondary)
                        }
                        Text("Mis à jour \(Date(timeIntervalSince1970: o.generatedAt / 1000).formatted(.relative(presentation: .named)))")
                            .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                    }
                    .padding(16)
                } else {
                    ProgressView().padding(.top, 120)
                }
                if let e = store.error { Text(e).font(.footnote).foregroundStyle(.red).padding() }
            }
            .refreshable { await store.refresh() }
            .navigationTitle("MoneyMaker")
            .navigationDestination(for: ProjectSummary.self) { ProjectView(p: $0) }
            .toolbar {
                Menu {
                    Link("Ouvrir le dashboard", destination: URL(string: "https://moneymaker-io.web.app")!)
                    Button("Déconnexion", role: .destructive) { store.signOut() }
                } label: { Image(systemName: "ellipsis.circle") }
            }
            .task { await store.refresh() }
        }
    }
}

struct Tile: View {
    let title: String, value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(value).font(.title2.bold().monospacedDigit()).lineLimit(1).minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(14).background(Color.mmCard, in: RoundedRectangle(cornerRadius: 16))
    }
}

struct ProjectRow: View {
    let p: ProjectSummary
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(p.name).font(.headline)
                Text("\(p.activeSubscriptions) abonnés · \(p.activeTrials) essais").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text(p.mrrMicros.money(p.currency)).font(.headline.monospacedDigit()).foregroundStyle(Color.mmGreen)
                Text("MRR").font(.caption2).foregroundStyle(.secondary)
            }
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
        .padding(14).background(Color.mmCard, in: RoundedRectangle(cornerRadius: 16))
    }
}

struct ProjectView: View {
    @EnvironmentObject var store: Store
    let p: ProjectSummary
    @State private var events: [EventItem] = []
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                    Tile(title: "MRR", value: p.mrrMicros.money(p.currency))
                    Tile(title: "Revenu", value: p.netRevenueMicros.money(p.currency, compact: true))
                    Tile(title: "Abonnés", value: "\(p.activeSubscriptions)")
                    Tile(title: "Essais", value: "\(p.activeTrials)")
                    Tile(title: "Conversion essai", value: p.trialConversionRate.map { $0.formatted(.percent.precision(.fractionLength(1))) } ?? "—")
                    Tile(title: "Churn", value: p.churnRate.map { $0.formatted(.percent.precision(.fractionLength(1))) } ?? "—")
                }
                if p.billingIssues > 0 {
                    Label("\(p.billingIssues) problème(s) de paiement en cours", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange).font(.subheadline)
                }
                Text("Activité").font(.title3.bold()).padding(.top, 6)
                ForEach(events) { e in
                    HStack(alignment: .top) {
                        Image(systemName: icon(e.type)).foregroundStyle(color(e.type)).frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(label(e.type)).font(.subheadline.weight(.semibold))
                            Text([e.productId, e.appUserId].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            if let m = e.priceMicros, m > 0, let c = e.currency { Text(m.money(c)).font(.caption.monospacedDigit()) }
                            Text(Date(timeIntervalSince1970: e.at / 1000).formatted(.relative(presentation: .numeric))).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .padding(12).background(Color.mmCard, in: RoundedRectangle(cornerRadius: 14))
                }
                if events.isEmpty { Text("Aucun événement pour l'instant.").foregroundStyle(.secondary) }
            }
            .padding(16)
        }
        .navigationTitle(p.name)
        .refreshable { await load() }
        .task { await load() }
    }

    func load() async { events = (try? await store.client.events(projectId: p.projectId)) ?? events }
    func label(_ t: String) -> String {
        ["INITIAL_PURCHASE": "Nouvel abonné", "RENEWAL": "Renouvellement", "TRIAL_STARTED": "Essai démarré", "TRIAL_CONVERTED": "Essai converti",
         "CANCELLATION": "Annulation", "UNCANCELLATION": "Réactivation", "EXPIRATION": "Expiration", "BILLING_ISSUE": "Problème de paiement",
         "BILLING_RECOVERED": "Paiement récupéré", "REFUND": "Remboursement", "PRODUCT_CHANGE": "Changement d'offre",
         "NON_RENEWING_PURCHASE": "Achat", "GRANT": "Accès offert", "REVOKED": "Révoqué", "PAUSED": "En pause", "TEST": "Test"][t] ?? t
    }
    func icon(_ t: String) -> String {
        switch t {
        case "INITIAL_PURCHASE", "TRIAL_CONVERTED", "NON_RENEWING_PURCHASE": return "arrow.up.circle.fill"
        case "RENEWAL", "BILLING_RECOVERED", "UNCANCELLATION": return "arrow.clockwise.circle.fill"
        case "TRIAL_STARTED": return "sparkles"
        case "REFUND", "REVOKED": return "arrow.uturn.backward.circle.fill"
        case "BILLING_ISSUE": return "exclamationmark.triangle.fill"
        default: return "circle.fill"
        }
    }
    func color(_ t: String) -> Color {
        switch t {
        case "INITIAL_PURCHASE", "TRIAL_CONVERTED", "RENEWAL", "NON_RENEWING_PURCHASE", "BILLING_RECOVERED": return .mmGreen
        case "TRIAL_STARTED", "UNCANCELLATION", "GRANT": return .mmBlue
        case "BILLING_ISSUE", "CANCELLATION": return .orange
        default: return .red
        }
    }
}
