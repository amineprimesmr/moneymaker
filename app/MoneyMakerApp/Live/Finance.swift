//
//  Finance.swift
//  MoneyMaker — du brut au « net en poche ».
//
//  Carte de l'Accueil : cascade Brut TTC → TVA → commissions stores → frais Stripe →
//  CA net HT → cotisations / IS → impôt dividendes → en poche, sur la période et les
//  business affichés. Réglages : montage juridique (préréglages) et tous les taux.
//

import SwiftUI

struct FinanceSettings: Codable, Hashable {
    struct Processors: Codable, Hashable { var appStore: Bool; var googlePlay: Bool; var stripe: Bool }
    var showNet: Bool?
    var companyName: String?
    var country: String?
    var processors: Processors?
    var structure: String
    var appleSmallBusiness: Bool
    var googleRate: Double
    var stripePercent: Double
    var stripeFixed: Double
    var stripePricesIncludeVat: Bool
    var vatFranchise: Bool?
    var socialRate: Double
    var incomeTaxRate: Double
    var expensesRate: Double
    var corporateReducedRate: Double
    var corporateReducedCap: Double?
    var corporateRate: Double
    var payoutShare: Double
    var dividendTaxRate: Double
}

struct Waterfall: Codable, Hashable {
    struct StoreLine: Codable, Hashable { let grossMicros: Int; let vatMicros: Int; let feesMicros: Int; let netMicros: Int }
    struct Annual: Codable, Hashable { let netRevenueMicros: Int; let pocketMicros: Int }
    struct Preset: Codable, Hashable { let label: String; let note: String }
    let currency: String
    let days: Int
    let grossMicros: Int
    let vatMicros: Int
    let storeFeesMicros: Int
    let paymentFeesMicros: Int
    let refundsMicros: Int
    let netRevenueMicros: Int
    let expensesMicros: Int
    let socialMicros: Int
    let corporateTaxMicros: Int
    let dividendTaxMicros: Int
    let pocketMicros: Int
    let byStore: [String: StoreLine]
    let annualized: Annual
    let settings: FinanceSettings
    let presets: [String: Preset]?
}

extension MoneyMakerClient {
    func finance(days: Int, projectIds: [String]?) async throws -> Waterfall {
        try await get("finance?days=\(days)" + (projectIds.map { "&projectIds=\($0.joined(separator: ","))" } ?? ""))
    }
    func saveFinance(_ changes: [String: Any]) async throws -> FinanceSettings {
        struct R: Decodable { let settings: FinanceSettings }
        let r: R = try await send("PUT", "finance/settings", body: changes)
        return r.settings
    }
}

@MainActor
final class FinanceModel: ObservableObject {
    static let shared = FinanceModel()
    @Published var waterfall: Waterfall?
    @Published var loading = false
    private var key = ""

    func load(_ store: Store, force: Bool = false) async {
        let days = store.period == 0 ? 1 : store.period
        let k = "\(days)|\(store.scopeIds ?? [])"
        guard force || k != key || waterfall == nil else { return }
        key = k
        loading = true; defer { loading = false }
        if let w = try? await store.client.finance(days: days, projectIds: store.scopeIds) {
            withAnimation(.smooth(duration: 0.5)) { waterfall = w }
        }
    }
}

// MARK: - Carte de l'Accueil

struct NetCard: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var model = FinanceModel.shared
    @State private var expanded = false

    var body: some View {
        Group {
            if model.waterfall?.settings.showNet == true { card }
        }
        .task(id: "\(store.period)|\(store.scopeIds ?? [])|\(store.overview?.generatedAt ?? 0)") { await model.load(store) }
    }

    private var card: some View {
        MMCard(padding: 20) {
            if let w = model.waterfall {
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        MMLabel(text: "Net en poche", trailing: store.period == 0 ? "aujourd'hui" : "\(w.days) j")
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(w.pocketMicros.money(w.currency))
                            .font(MMFont.number(40, .light)).tracking(-1.2)
                            .lineLimit(1).minimumScaleFactor(0.5)
                            .contentTransition(.numericText(value: Double(w.pocketMicros)))
                        if w.grossMicros > 0 {
                            Text("\(Int((Double(w.pocketMicros) / Double(w.grossMicros) * 100).rounded())) % du brut")
                                .font(MMFont.system(12, .medium)).foregroundStyle(MMColor.ink3)
                        }
                    }
                    Text("≈ \(w.annualized.pocketMicros.money(w.currency, compact: true)) par an à ce rythme · CA net HT \(w.netRevenueMicros.money(w.currency, compact: true))")
                        .font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                    WaterfallBar(w: w).frame(height: 10)
                    if expanded { lines(w).transition(.opacity.combined(with: .move(edge: .top))) }
                    Button {
                        withAnimation(.smooth(duration: 0.4)) { expanded.toggle() }
                    } label: {
                        HStack(spacing: 6) {
                            Text(expanded ? "Masquer le détail" : "Voir le détail").font(MMFont.system(13, .medium))
                            Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold)).rotationEffect(.degrees(expanded ? 180 : 0))
                        }
                        .foregroundStyle(MMColor.ink2)
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(MMPressStyle(scale: 0.97))
                }
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    MMLabel(text: "Net en poche")
                    RoundedRectangle(cornerRadius: 8).fill(MMColor.cardFill).frame(width: 160, height: 36)
                }
                .modifier(MMShimmer())
            }
        }
    }

    private func lines(_ w: Waterfall) -> some View {
        let franchise = w.settings.vatFranchise ?? w.settings.structure.hasPrefix("micro")
        let micro = w.settings.structure.hasPrefix("micro")
        let rows: [(String, Int, Color, Bool, String)] = [
            ("Brut payé par les clients", w.grossMicros, MMColor.ink, false, "Ce que tes clients ont payé, toutes ventes confondues."),
            (franchise ? "TVA collectée par Apple / Google" : "TVA et taxes", -w.vatMicros, MMColor.ink3, true,
             franchise ? "Les stores prélèvent la TVA du pays du client avant de te payer. Sur Stripe, en franchise, tu n'en factures pas."
                       : "TVA comprise dans tes prix : collectée par les stores, à reverser toi-même pour Stripe."),
            ("Commission App Store / Google Play", -w.storeFeesMicros, MMColor.orange, true, "15 % (Small Business / Google) ou 30 %."),
            ("Frais de paiement Stripe", -w.paymentFeesMicros, MMColor.orange, true, "≈ 1,5 % + 0,25 € par paiement (carte européenne)."),
            ("CA net encaissé", w.netRevenueMicros, MMColor.blue, false, micro ? "Base de calcul de tes cotisations URSSAF." : "Ce qui arrive réellement sur ton compte, hors TVA."),
            ("Charges", -w.expensesMicros, MMColor.ink3, true, "Tes dépenses (Pilotage) ou l'estimation en %."),
            (micro ? "Cotisations URSSAF" : "Cotisations", -w.socialMicros, MMColor.red, true,
             micro ? "Pourcentage de ton CA payé à l'URSSAF chaque mois ou trimestre (+ versement libératoire si tu l'as choisi)." : "Cotisations sociales."),
            ("Impôt sur les sociétés", -w.corporateTaxMicros, MMColor.red, true, "15 % jusqu'à 42 500 € de bénéfice, puis 25 %."),
            ("Impôt sur les dividendes", -w.dividendTaxMicros, MMColor.red, true, "Flat tax sur ce que tu te verses."),
            ("Net en poche", w.pocketMicros, MMColor.accent, false, micro ? "Avant ton impôt sur le revenu annuel (sauf versement libératoire)." : "Ce qui te revient personnellement."),
        ].filter { !$0.3 || $0.1 != 0 }
        return VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
                if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1) }
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Circle().fill(r.2).frame(width: 6, height: 6)
                        Text(r.0).font(MMFont.system(13, r.3 ? .regular : .medium)).foregroundStyle(r.3 ? MMColor.ink2 : MMColor.ink)
                        Spacer()
                        Text(r.1.money(w.currency)).font(MMFont.number(13, r.3 ? .regular : .medium)).foregroundStyle(r.3 ? MMColor.ink2 : r.2)
                    }
                    Text(r.4).font(MMFont.system(11)).foregroundStyle(MMColor.ink3).padding(.leading, 14)
                }
                .padding(.vertical, 8)
            }
            if !w.byStore.isEmpty {
                HStack(spacing: 8) {
                    ForEach(w.byStore.sorted { $0.value.grossMicros > $1.value.grossMicros }, id: \.key) { k, v in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(storeName(k)).font(MMFont.system(10, .medium)).foregroundStyle(MMColor.ink3)
                            Text(v.netMicros.money(w.currency, compact: true)).font(MMFont.number(13, .regular))
                        }
                        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
                .padding(.top, 10)
            }
        }
    }

    private func storeName(_ k: String) -> String {
        ["app_store": "App Store", "play_store": "Google Play", "stripe": "Stripe", "promotional": "Offert"][k] ?? k
    }
}

/// Barre empilée : où part chaque euro brut.
private struct WaterfallBar: View {
    let w: Waterfall
    var body: some View {
        let total = max(Double(w.grossMicros), 1)
        let parts: [(Double, Color)] = [
            (Double(w.pocketMicros), MMColor.accent),
            (Double(w.dividendTaxMicros + w.corporateTaxMicros + w.socialMicros), MMColor.red),
            (Double(w.expensesMicros), Color.white.opacity(0.25)),
            (Double(w.storeFeesMicros + w.paymentFeesMicros), MMColor.orange),
            (Double(w.vatMicros), Color.white.opacity(0.15)),
        ]
        GeometryReader { g in
            HStack(spacing: 2) {
                ForEach(Array(parts.enumerated()), id: \.offset) { _, p in
                    if p.0 > 0 { Capsule().fill(p.1).frame(width: max(3, g.size.width * p.0 / total)) }
                }
                Spacer(minLength: 0)
            }
        }
    }
}

// MARK: - Réglages : afficher le net, profil, taux

struct FinanceSettingsSection: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var model = FinanceModel.shared
    @State private var saving = false
    @State private var showProfile = false
    @State private var showAdvanced = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            MMLabel(text: "Net en poche").padding(.horizontal, 4).padding(.top, 8)
            MMCard(padding: 0) {
                if let w = model.waterfall {
                    let s = w.settings
                    VStack(spacing: 0) {
                        Toggle(isOn: Binding(get: { s.showNet == true }, set: { on in
                            if on { showProfile = true } else { save(["showNet": false]) }
                        })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Afficher le net en poche").font(MMFont.system(15))
                                Text("Ce qu'il te reste après TVA, commissions, frais et impôts, selon ton statut.")
                                    .font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                            }
                        }
                        .padding(.horizontal, 16).padding(.vertical, 12)
                        if s.showNet == true {
                            divider
                            Button { showProfile = true } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "building.2.fill").font(.system(size: 14)).foregroundStyle(MMColor.ink2).frame(width: 22)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text((s.companyName?.isEmpty == false ? s.companyName! : "Mon entreprise")).font(MMFont.system(15, .medium)).foregroundStyle(MMColor.ink)
                                        Text(profileSummary(w)).font(MMFont.system(12)).foregroundStyle(MMColor.ink3).lineLimit(2)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(MMColor.ink3)
                                }
                                .padding(.horizontal, 16).padding(.vertical, 12)
                            }
                            .buttonStyle(.plain)
                            divider
                            Button { withAnimation(.smooth) { showAdvanced.toggle() } } label: {
                                HStack {
                                    Text("Taux détaillés").font(MMFont.system(14)).foregroundStyle(MMColor.ink2)
                                    Spacer()
                                    Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold)).foregroundStyle(MMColor.ink3)
                                        .rotationEffect(.degrees(showAdvanced ? 180 : 0))
                                }
                                .padding(.horizontal, 16).padding(.vertical, 12)
                            }
                            .buttonStyle(.plain)
                            if showAdvanced {
                                percent("Commission Google Play", "googleRate", s.googleRate)
                                percent("Frais Stripe (%)", "stripePercent", s.stripePercent, step: 0.001)
                                percent("Cotisations sociales", "socialRate", s.socialRate, step: 0.001)
                                percent("Versement libératoire", "incomeTaxRate", s.incomeTaxRate, step: 0.001)
                                percent("Charges estimées", "expensesRate", s.expensesRate)
                                percent("IS taux réduit", "corporateReducedRate", s.corporateReducedRate)
                                percent("IS taux normal", "corporateRate", s.corporateRate)
                                percent("Part distribuée", "payoutShare", s.payoutShare, step: 0.05)
                                percent("Impôt dividendes", "dividendTaxRate", s.dividendTaxRate, step: 0.001)
                            }
                        }
                    }
                    .tint(MMColor.accent)
                    .disabled(saving)
                } else {
                    Text("Chargement…").font(MMFont.system(14)).foregroundStyle(MMColor.ink3).padding(18)
                }
            }
            Text("Repères 2026 indicatifs, à valider avec ton expert-comptable — ce n'est pas un conseil fiscal.")
                .font(MMFont.system(11)).foregroundStyle(MMColor.ink3).padding(.horizontal, 4)
        }
        .task { await model.load(store) }
        .sheet(isPresented: $showProfile) {
            if let w = model.waterfall {
                TaxProfileSheet(initial: w.settings, presets: w.presets ?? [:], detected: detectedProcessors) { changes in
                    var all = changes; all["showNet"] = true
                    save(all)
                }
            }
        }
    }

    /// Moyens d'encaissement réellement branchés sur tes business (étapes de mise en route validées).
    private var detectedProcessors: FinanceSettings.Processors {
        let steps = SetupCache.shared.byProject.values.flatMap(\.steps).filter(\.done).map(\.id)
        return .init(appStore: steps.contains("asc") || steps.contains("appleNotifications"),
                     googlePlay: steps.contains("google"), stripe: steps.contains("stripe"))
    }

    private func profileSummary(_ w: Waterfall) -> String {
        let s = w.settings
        var parts = [w.presets?[s.structure]?.label ?? s.structure]
        if s.vatFranchise ?? s.structure.hasPrefix("micro") { parts.append("franchise de TVA") }
        let p = s.processors
        let procs = [p?.appStore == true ? "App Store" : nil, p?.googlePlay == true ? "Google Play" : nil, p?.stripe == true ? "Stripe" : nil].compactMap { $0 }
        if !procs.isEmpty { parts.append(procs.joined(separator: ", ")) }
        return parts.joined(separator: " · ")
    }

    private var divider: some View { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 16) }

    private func percent(_ title: String, _ key: String, _ value: Double, step: Double = 0.01) -> some View {
        Stepper(value: Binding(get: { value }, set: { save([key: (($0 * 1000).rounded() / 1000)]) }), in: 0...1, step: step) {
            HStack {
                Text(title).font(MMFont.system(14))
                Spacer()
                Text(value.formatted(.percent.precision(.fractionLength(0...1)))).font(MMFont.number(14, .regular)).foregroundStyle(MMColor.ink2)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 6)
    }

    private func save(_ changes: [String: Any]) {
        saving = true
        Task {
            _ = try? await store.client.saveFinance(changes)
            await model.load(store, force: true)
            await PlanModel.shared.load(store, force: true)
            saving = false
        }
    }
}

// MARK: - Profil fiscal (au moment d'activer le net)

struct TaxProfileSheet: View {
    @Environment(\.dismiss) private var dismiss
    let initial: FinanceSettings
    let presets: [String: Waterfall.Preset]
    let detected: FinanceSettings.Processors
    var onSave: ([String: Any]) -> Void

    @State private var company = ""
    @State private var country = "FR"
    @State private var structure = "micro_services"
    @State private var franchise = true
    @State private var libératoire = false
    @State private var appStore = true
    @State private var smallBusiness = true
    @State private var googlePlay = false
    @State private var stripe = true

    private let structures = ["micro_vente", "micro_services", "micro_liberal", "sasu_is", "eurl_is", "llc_us", "uae_freezone", "custom"]
    private let countries = [("FR", "France"), ("BE", "Belgique"), ("CH", "Suisse"), ("LU", "Luxembourg"), ("CA", "Canada"), ("US", "États-Unis"), ("AE", "Émirats"), ("GB", "Royaume-Uni")]
    /// Taux du versement libératoire selon l'activité micro.
    private var vlRate: Double { structure == "micro_vente" ? 0.01 : structure == "micro_liberal" ? 0.022 : 0.017 }
    private var isMicro: Bool { structure.hasPrefix("micro") }

    var body: some View {
        NavigationStack {
            Form {
                Section("Entreprise") {
                    TextField("Nom (ex. Amine Ennasri EI)", text: $company)
                    Picker("Pays", selection: $country) { ForEach(countries, id: \.0) { Text($0.1).tag($0.0) } }
                }
                Section {
                    Picker("Statut", selection: $structure) {
                        ForEach(structures, id: \.self) { Text(presets[$0]?.label ?? $0).tag($0) }
                    }
                    if let note = presets[structure]?.note { Text(note).font(.footnote).foregroundStyle(.secondary) }
                } header: { Text("Statut juridique") } footer: {
                    Text("En micro : « vente » pour des biens physiques, « services » pour la plupart des apps et produits numériques, « libéral » si ton activité est déclarée en BNC. C'est indiqué sur ton attestation URSSAF.")
                }
                Section {
                    Toggle("Franchise en base de TVA", isOn: $franchise)
                    if isMicro { Toggle("Versement libératoire (\(vlRate.formatted(.percent.precision(.fractionLength(1)))))", isOn: $libératoire) }
                } header: { Text("TVA et impôt") } footer: {
                    Text(franchise ? "Tu ne factures pas de TVA (« TVA non applicable, art. 293 B du CGI »)." : "Tu factures la TVA : elle est retirée de ton chiffre d'affaires.")
                    + Text(isMicro ? " Le versement libératoire paie ton impôt sur le revenu en même temps que l'URSSAF ; sans lui, il est calculé une fois par an." : "")
                }
                Section {
                    Toggle("App Store", isOn: $appStore)
                    if appStore { Toggle("Programme Small Business (15 %)", isOn: $smallBusiness) }
                    Toggle("Google Play", isOn: $googlePlay)
                    Toggle("Stripe", isOn: $stripe)
                } header: { Text("Moyens d'encaissement") } footer: {
                    Text("Pré-rempli d'après tes connexions. App Store : 15 % avec le Small Business Program (moins d'1 M$/an), sinon 30 %. Google Play : 15 %. Stripe : ≈ 1,5 % + 0,25 € par paiement.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.black)
            .navigationTitle("Ton profil")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annuler") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Afficher le net") {
                        var changes: [String: Any] = [
                            "structure": structure, "companyName": company, "country": country, "vatFranchise": franchise,
                            "appleSmallBusiness": smallBusiness,
                            "processors": ["appStore": appStore, "googlePlay": googlePlay, "stripe": stripe],
                        ]
                        if isMicro { changes["incomeTaxRate"] = libératoire ? vlRate : 0 }
                        onSave(changes)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
            .onAppear {
                company = initial.companyName ?? ""
                country = initial.country ?? "FR"
                structure = initial.structure
                franchise = initial.vatFranchise ?? initial.structure.hasPrefix("micro")
                libératoire = initial.incomeTaxRate > 0
                smallBusiness = initial.appleSmallBusiness
                let p = initial.processors ?? detected
                appStore = p.appStore || detected.appStore
                googlePlay = p.googlePlay || detected.googlePlay
                stripe = p.stripe || detected.stripe
            }
        }
        .tint(MMColor.accent)
        .presentationBackground(Color.black)
        .environment(\.colorScheme, .dark)
    }
}
