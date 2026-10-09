//
//  Plan.swift
//  MoneyMaker — pilotage : à mettre de côté, virements à venir, échéances, dépenses réelles,
//  objectif de MRR, alertes intelligentes et export comptable.
//

import SwiftUI

struct PlanData: Codable, Hashable {
    struct SetAside: Codable, Hashable { let totalMicros: Int; let vatMicros: Int; let socialMicros: Int; let corporateMicros: Int; let dividendMicros: Int; let shareOfNet: Double? }
    struct Payout: Codable, Hashable { let store: String; let date: Double; let amountMicros: Int; let label: String }
    struct Deadline: Codable, Hashable { let date: Double; let label: String; let amountMicros: Int; let kind: String }
    struct Goal: Codable, Hashable { let goalMicros: Int; let slopePerMonthMicros: Int?; let etaDate: Double?; let reached: Bool }
    struct Expenses: Codable, Hashable { let list: [Expense]; let periodMicros: Int; let monthlyMicros: Int }
    struct Point: Codable, Hashable { let t: Double; let mrr: Double }
    let currency: String
    let days: Int
    let setAside: SetAside
    let payouts: [Payout]
    let deadlines: [Deadline]
    let goal: Goal?
    let expenses: Expenses
    let mrrHistory: [Point]
}

struct Expense: Codable, Hashable, Identifiable {
    let id: String
    var name: String
    var amountMicros: Int
    var currency: String
    var every: String
    var projectId: String?
    var category: String?
}

struct Insight: Codable, Hashable, Identifiable {
    let id: String
    let type: String
    let projectId: String
    let projectName: String
    let title: String
    let body: String
    let at: Double
}

extension MoneyMakerClient {
    func plan(days: Int, projectIds: [String]?, goal: Int?) async throws -> PlanData {
        var q = "finance/plan?days=\(days)"
        if let projectIds { q += "&projectIds=\(projectIds.joined(separator: ","))" }
        if let goal { q += "&goal=\(goal)" }
        return try await get(q)
    }
    func insights() async throws -> [Insight] {
        struct R: Decodable { let insights: [Insight] }
        let r: R = try await get("insights")
        return r.insights
    }
    func saveExpense(id: String, name: String, amount: Double, every: String, projectId: String?) async throws {
        var body: [String: Any] = ["name": name, "amount": amount, "every": every, "currency": "EUR"]
        if let projectId { body["projectId"] = projectId }
        let _: Ack = try await send("PUT", "expenses/\(id)", body: body)
    }
    func deleteExpense(id: String) async throws { let _: Ack = try await send("DELETE", "expenses/\(id)") }

    /// Télécharge l'export comptable d'un mois dans un fichier temporaire (pour le partage).
    func exportCSV(month: String, projectIds: [String]?) async throws -> URL {
        guard let token else { throw APIError(message: "Non connecté") }
        var path = "\(MM.baseURL.absoluteString)/finance/export?month=\(month)"
        if let projectIds { path += "&projectIds=\(projectIds.joined(separator: ","))" }
        var req = URLRequest(url: URL(string: path)!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, res) = try await URLSession.shared.data(for: req)
        guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw APIError(message: "Export impossible") }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("moneymaker-\(month).csv")
        try data.write(to: url)
        return url
    }
}

@MainActor
final class PlanModel: ObservableObject {
    static let shared = PlanModel()
    @Published var plan: PlanData?
    @Published var insights: [Insight] = []
    private var key = ""

    func load(_ store: Store, force: Bool = false) async {
        let days = store.period == 0 ? 28 : store.period
        let k = "\(days)|\(store.scopeIds ?? [])|\(MMShared.mrrGoal ?? 0)"
        guard force || k != key || plan == nil else { return }
        key = k
        async let p = try? store.client.plan(days: days, projectIds: store.scopeIds, goal: MMShared.mrrGoal)
        async let i = try? store.client.insights()
        let (np, ni) = await (p, i)
        withAnimation(.smooth(duration: 0.45)) {
            if let np { plan = np }
            if let ni { insights = ni }
        }
    }
}

private func day(_ ms: Double) -> String {
    Date(timeIntervalSince1970: ms / 1000).formatted(.dateTime.day().month(.abbreviated))
}

// MARK: - Carte de l'Accueil

struct PlanCard: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var model = PlanModel.shared

    var body: some View {
        NavigationLink(value: Router.Destination.plan) {
            MMCard(padding: 18) {
                if let p = model.plan {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            MMLabel(text: "Pilotage")
                            Image(systemName: "chevron.right").font(.system(size: 11, weight: .bold)).foregroundStyle(MMColor.ink3)
                        }
                        HStack(alignment: .top, spacing: 10) {
                            tile("À mettre de côté", p.setAside.totalMicros.money(p.currency, compact: true), MMColor.orange)
                            if let next = p.payouts.first {
                                tile("Prochain virement · \(day(next.date))", next.amountMicros.money(p.currency, compact: true), MMColor.accent)
                            }
                        }
                        if let d = p.deadlines.first {
                            Label("\(d.label) · \(day(d.date)) · ≈ \(d.amountMicros.money(p.currency, compact: true))", systemImage: "calendar.badge.exclamationmark")
                                .font(MMFont.system(12)).foregroundStyle(MMColor.ink2).lineLimit(1)
                        }
                        if let i = model.insights.first, Date().timeIntervalSince1970 * 1000 - i.at < 3 * 86_400_000 {
                            Label(i.title, systemImage: "sparkles").font(MMFont.system(12, .medium)).foregroundStyle(MMColor.blue).lineLimit(1)
                        }
                    }
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        MMLabel(text: "Pilotage")
                        RoundedRectangle(cornerRadius: 8).fill(MMColor.cardFill).frame(height: 44)
                    }
                    .modifier(MMShimmer())
                }
            }
        }
        .buttonStyle(MMPressStyle(scale: 0.98))
        .task(id: "\(store.period)|\(store.scopeIds ?? [])|\(store.overview?.generatedAt ?? 0)") { await model.load(store) }
    }

    private func tile(_ title: String, _ value: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(MMFont.system(11, .medium)).foregroundStyle(MMColor.ink3).lineLimit(1)
            Text(value).font(MMFont.number(22, .regular)).foregroundStyle(tint).contentTransition(.numericText())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

// MARK: - Écran complet

struct PlanScreen: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var model = PlanModel.shared
    @State private var editing: Expense?
    @State private var adding = false
    @State private var exportURL: URL?
    @State private var exporting = false
    @State private var month = Calendar.current.date(byAdding: .month, value: -1, to: .now)!

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Pilotage").font(MMFont.system(34, .bold)).tracking(-0.8)
                    Text("\(store.scopeLabel) · \(model.plan?.days ?? 28) j").font(MMFont.system(13)).foregroundStyle(MMColor.ink3)
                }
                .padding(.top, 8).mmAppear(0)
                if let p = model.plan {
                    setAside(p).mmAppear(1)
                    payouts(p).mmAppear(2)
                    deadlines(p).mmAppear(3)
                    goal(p).mmAppear(4)
                    expenses(p).mmAppear(5)
                }
                insights.mmAppear(6)
                exportCard.mmAppear(7)
            }
            .padding(.horizontal, 16).padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        .navigationBarTitleDisplayMode(.inline)
        .mmPage()
        .refreshable { await model.load(store, force: true) }
        .task { await model.load(store) }
        .sheet(isPresented: $adding) { ExpenseEditor(expense: nil) { await model.load(store, force: true) }.environmentObject(store) }
        .sheet(item: $editing) { e in ExpenseEditor(expense: e) { await model.load(store, force: true) }.environmentObject(store) }
    }

    private func setAside(_ p: PlanData) -> some View {
        MMCard(padding: 20, glow: MMColor.orange) {
            VStack(alignment: .leading, spacing: 10) {
                MMLabel(text: "À mettre de côté", trailing: "\(p.days) j")
                Text(p.setAside.totalMicros.money(p.currency)).font(MMFont.number(40, .light)).tracking(-1.2).foregroundStyle(MMColor.orange)
                Text("Cet argent n'est pas à toi : vire-le sur un compte séparé dès qu'il arrive.").font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                VStack(spacing: 6) {
                    line("TVA collectée (Stripe UE) à reverser", p.setAside.vatMicros, p.currency)
                    line("Cotisations / impôt micro", p.setAside.socialMicros, p.currency)
                    line("Impôt sur les sociétés", p.setAside.corporateMicros, p.currency)
                    line("Impôt sur les dividendes", p.setAside.dividendMicros, p.currency)
                }
                .padding(.top, 4)
            }
        }
    }

    private func payouts(_ p: PlanData) -> some View {
        section("Virements à venir") {
            if p.payouts.isEmpty { empty("Aucun virement en attente.") }
            ForEach(Array(p.payouts.enumerated()), id: \.offset) { i, x in
                if i > 0 { divider }
                HStack(spacing: 12) {
                    Image(systemName: x.store == "stripe" ? "creditcard.fill" : x.store == "app_store" ? "apple.logo" : "play.fill")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(MMColor.accent)
                        .frame(width: 30, height: 30).background(MMColor.accent.opacity(0.12), in: Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text(x.label).font(MMFont.system(14, .medium)).lineLimit(1)
                        Text("vers le \(day(x.date))").font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                    }
                    Spacer()
                    Text(x.amountMicros.money(p.currency)).font(MMFont.number(15, .regular))
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
            }
        }
    }

    private func deadlines(_ p: PlanData) -> some View {
        section("Échéances") {
            if p.deadlines.isEmpty { empty("Aucune échéance estimée pour ton montage.") }
            ForEach(Array(p.deadlines.enumerated()), id: \.offset) { i, d in
                if i > 0 { divider }
                HStack(spacing: 12) {
                    VStack(spacing: 0) {
                        Text(Date(timeIntervalSince1970: d.date / 1000).formatted(.dateTime.day())).font(MMFont.number(16, .medium))
                        Text(Date(timeIntervalSince1970: d.date / 1000).formatted(.dateTime.month(.abbreviated)).uppercased()).font(MMFont.system(9, .medium)).foregroundStyle(MMColor.ink3)
                    }
                    .frame(width: 40, height: 40).background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    Text(d.label).font(MMFont.system(14, .medium)).lineLimit(2)
                    Spacer()
                    Text("≈ \(d.amountMicros.money(p.currency, compact: true))").font(MMFont.number(14, .regular)).foregroundStyle(MMColor.orange)
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
            }
        }
    }

    @ViewBuilder
    private func goal(_ p: PlanData) -> some View {
        section("Objectif de MRR") {
            Group {
                if let g = p.goal {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(g.goalMicros.money(p.currency, compact: true)).font(MMFont.number(24, .regular))
                        Text(g.reached ? "Objectif atteint 🎉"
                             : g.etaDate.map { "Atteint vers \(Date(timeIntervalSince1970: $0 / 1000).formatted(.dateTime.month(.wide).year())) au rythme actuel" }
                             ?? (p.mrrHistory.count < 7 ? "Projection disponible après une semaine d'historique." : "Au rythme actuel, le MRR ne progresse pas : pas de date estimée."))
                            .font(MMFont.system(13)).foregroundStyle(g.reached ? MMColor.accent : MMColor.ink2)
                        if let s = g.slopePerMonthMicros {
                            Text("Tendance : \(s >= 0 ? "+" : "")\(s.money(p.currency, compact: true)) de MRR par mois").font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                        }
                    }
                } else {
                    Text("Fixe un objectif dans Réglages → Widgets pour voir la date estimée.").font(MMFont.system(13)).foregroundStyle(MMColor.ink2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
    }

    private func expenses(_ p: PlanData) -> some View {
        section("Dépenses", trailing: "\(p.expenses.monthlyMicros.money(p.currency, compact: true)) / mois") {
            ForEach(Array(p.expenses.list.enumerated()), id: \.element.id) { i, e in
                if i > 0 { divider }
                Button { editing = e } label: {
                    HStack {
                        Text(e.name).font(MMFont.system(14, .medium)).foregroundStyle(MMColor.ink)
                        Spacer()
                        Text("\(e.amountMicros.money(e.currency)) / \(e.every == "year" ? "an" : "mois")").font(MMFont.number(14, .regular)).foregroundStyle(MMColor.ink2)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 12)
                }
                .buttonStyle(.plain)
            }
            if !p.expenses.list.isEmpty { divider }
            Button { adding = true } label: {
                Label("Ajouter une dépense (serveur, outil, pub…)", systemImage: "plus.circle.fill")
                    .font(MMFont.system(14, .medium)).foregroundStyle(MMColor.accent)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.vertical, 12)
            }
            .buttonStyle(.plain)
        }
    }

    private var insights: some View {
        section("Alertes intelligentes") {
            if model.insights.isEmpty { empty("Rien d'anormal. Chaque matin, la veille est comparée aux 28 jours précédents.") }
            ForEach(Array(model.insights.prefix(10).enumerated()), id: \.element.id) { i, x in
                if i > 0 { divider }
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: icon(x.type)).font(.system(size: 12, weight: .semibold)).foregroundStyle(tint(x.type))
                        .frame(width: 30, height: 30).background(tint(x.type).opacity(0.12), in: Circle())
                    VStack(alignment: .leading, spacing: 3) {
                        Text(x.title).font(MMFont.system(14, .medium))
                        Text(x.body).font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                    }
                    Spacer(minLength: 0)
                    Text(Date(timeIntervalSince1970: x.at / 1000), style: .relative).font(MMFont.system(10)).foregroundStyle(MMColor.ink3)
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
            }
        }
    }

    private var exportCard: some View {
        section("Export comptable") {
            VStack(alignment: .leading, spacing: 12) {
                Text("CSV du mois : chaque transaction avec TVA, HT, commissions et net, plus un récapitulatif par pays (déclaration OSS).")
                    .font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                HStack {
                    DatePicker("Mois", selection: $month, in: ...Date.now, displayedComponents: .date)
                        .labelsHidden().datePickerStyle(.compact)
                    Spacer()
                    if let url = exportURL {
                        ShareLink(item: url) { Label("Partager", systemImage: "square.and.arrow.up") }
                            .font(MMFont.system(14, .medium))
                    } else {
                        Button(exporting ? "Préparation…" : "Générer") {
                            exporting = true
                            Task {
                                let m = month.formatted(.iso8601.year().month())
                                exportURL = try? await store.client.exportCSV(month: m, projectIds: store.scopeIds)
                                exporting = false
                            }
                        }
                        .font(MMFont.system(14, .medium)).disabled(exporting)
                    }
                }
                .tint(MMColor.accent)
                .onChange(of: month) { _, _ in exportURL = nil }
            }
            .padding(16)
        }
    }

    // MARK: Briques

    private func section<C: View>(_ title: String, trailing: String? = nil, @ViewBuilder _ content: () -> C) -> some View {
        let body = VStack(spacing: 0) { content() }
        return VStack(alignment: .leading, spacing: 10) {
            MMLabel(text: title, trailing: trailing).padding(.horizontal, 4).padding(.top, 8)
            MMCard(padding: 0) { body }
        }
    }
    private var divider: some View { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 16) }
    private func empty(_ t: String) -> some View { Text(t).font(MMFont.system(13)).foregroundStyle(MMColor.ink3).frame(maxWidth: .infinity, alignment: .leading).padding(16) }
    private func line(_ title: String, _ v: Int, _ cur: String) -> some View {
        HStack { Text(title).font(MMFont.system(13)).foregroundStyle(MMColor.ink2); Spacer(); Text(v.money(cur)).font(MMFont.number(13, .regular)).foregroundStyle(v > 0 ? MMColor.ink : MMColor.ink3) }
    }
    private func icon(_ t: String) -> String {
        ["SALES_DROP": "arrow.down.right", "SALES_SPIKE": "flame.fill", "REFUND_SPIKE": "arrow.uturn.backward", "BILLING_FAILURES": "creditcard.trianglebadge.exclamationmark", "FIRST_SALE_COUNTRY": "globe"][t] ?? "sparkles"
    }
    private func tint(_ t: String) -> Color {
        t == "SALES_SPIKE" || t == "FIRST_SALE_COUNTRY" ? MMColor.accent : t == "SALES_DROP" || t == "REFUND_SPIKE" ? MMColor.red : MMColor.orange
    }
}

// MARK: - Édition d'une dépense

struct ExpenseEditor: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    let expense: Expense?
    var onDone: () async -> Void
    @State private var name = ""
    @State private var amount = ""
    @State private var yearly = false
    @State private var projectId: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("Nom (ex. Serveur, Figma, Meta Ads)", text: $name)
                TextField("Montant en €", text: $amount).keyboardType(.decimalPad)
                Picker("Fréquence", selection: $yearly) { Text("Par mois").tag(false); Text("Par an").tag(true) }
                Picker("Business", selection: $projectId) {
                    Text("Tous (frais communs)").tag(String?.none)
                    ForEach(store.allProjects) { Text($0.name).tag(Optional($0.projectId)) }
                }
                if expense != nil {
                    Button("Supprimer la dépense", role: .destructive) {
                        Task { try? await store.client.deleteExpense(id: expense!.id); await onDone(); dismiss() }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.black)
            .navigationTitle(expense == nil ? "Nouvelle dépense" : "Dépense")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annuler") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Enregistrer") {
                        let value = Double(amount.replacingOccurrences(of: ",", with: ".")) ?? 0
                        Task {
                            try? await store.client.saveExpense(id: expense?.id ?? UUID().uuidString, name: name, amount: value, every: yearly ? "year" : "month", projectId: projectId)
                            await onDone(); dismiss()
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || Double(amount.replacingOccurrences(of: ",", with: ".")) == nil)
                }
            }
            .onAppear {
                if let e = expense {
                    name = e.name; amount = String(format: "%.2f", Double(e.amountMicros) / 1e6); yearly = e.every == "year"; projectId = e.projectId
                }
            }
        }
        .tint(MMColor.accent)
        .presentationBackground(Color.black)
        .presentationDetents([.medium])
        .environment(\.colorScheme, .dark)
    }
}
