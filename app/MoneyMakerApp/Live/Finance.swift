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
    var structure: String
    var appleSmallBusiness: Bool
    var googleRate: Double
    var stripePercent: Double
    var stripeFixed: Double
    var stripePricesIncludeVat: Bool
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
        .task(id: "\(store.period)|\(store.scopeIds ?? [])|\(store.overview?.generatedAt ?? 0)") { await model.load(store) }
    }

    private func lines(_ w: Waterfall) -> some View {
        let rows: [(String, Int, Color, Bool)] = [
            ("Brut payé par les clients", w.grossMicros, MMColor.ink, false),
            ("TVA et taxes reversées", -w.vatMicros, MMColor.ink3, true),
            ("Commission App Store / Google Play", -w.storeFeesMicros, MMColor.orange, true),
            ("Frais de paiement Stripe", -w.paymentFeesMicros, MMColor.orange, true),
            ("CA net HT encaissé", w.netRevenueMicros, MMColor.blue, false),
            ("Charges estimées", -w.expensesMicros, MMColor.ink3, true),
            ("Cotisations / impôt micro", -w.socialMicros, MMColor.red, true),
            ("Impôt sur les sociétés", -w.corporateTaxMicros, MMColor.red, true),
            ("Impôt sur les dividendes", -w.dividendTaxMicros, MMColor.red, true),
            ("Net en poche", w.pocketMicros, MMColor.accent, false),
        ].filter { !$0.3 || $0.1 != 0 }
        return VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
                if i > 0 { Rectangle().fill(MMColor.hairline).frame(height: 1) }
                HStack {
                    Circle().fill(r.2).frame(width: 6, height: 6)
                    Text(r.0).font(MMFont.system(13, r.3 ? .regular : .medium)).foregroundStyle(r.3 ? MMColor.ink2 : MMColor.ink)
                    Spacer()
                    Text(r.1.money(w.currency)).font(MMFont.number(13, r.3 ? .regular : .medium)).foregroundStyle(r.3 ? MMColor.ink2 : r.2)
                }
                .padding(.vertical, 9)
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

// MARK: - Réglages : montage juridique et taux

struct FinanceSettingsSection: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var model = FinanceModel.shared
    @State private var saving = false

    private let order = ["micro_services", "micro_vente", "sasu_is", "eurl_is", "llc_us", "uae_freezone", "custom"]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            MMLabel(text: "Fiscalité · net en poche").padding(.horizontal, 4).padding(.top, 8)
            MMCard(padding: 0) {
                if let w = model.waterfall {
                    let s = w.settings
                    VStack(spacing: 0) {
                        Menu {
                            ForEach(order, id: \.self) { k in
                                Button(w.presets?[k]?.label ?? k) { save(["structure": k]) }
                            }
                        } label: {
                            row("Montage", value: w.presets?[s.structure]?.label ?? s.structure, chevron: true)
                        }
                        if let note = w.presets?[s.structure]?.note {
                            Text(note).font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 16).padding(.bottom, 10)
                        }
                        divider
                        Toggle(isOn: Binding(get: { s.appleSmallBusiness }, set: { save(["appleSmallBusiness": $0]) })) {
                            Text("Apple Small Business (15 %)").font(MMFont.system(15))
                        }
                        .padding(.horizontal, 16).padding(.vertical, 11)
                        divider
                        percent("Commission Google Play", "googleRate", s.googleRate)
                        percent("Frais Stripe (%)", "stripePercent", s.stripePercent, step: 0.001)
                        divider
                        percent("Cotisations sociales (micro)", "socialRate", s.socialRate, step: 0.001)
                        percent("Versement libératoire", "incomeTaxRate", s.incomeTaxRate, step: 0.001)
                        percent("Charges estimées", "expensesRate", s.expensesRate)
                        percent("IS taux réduit", "corporateReducedRate", s.corporateReducedRate)
                        percent("IS taux normal", "corporateRate", s.corporateRate)
                        percent("Part distribuée", "payoutShare", s.payoutShare, step: 0.05)
                        percent("Impôt dividendes", "dividendTaxRate", s.dividendTaxRate, step: 0.001)
                    }
                    .tint(MMColor.accent)
                    .disabled(saving)
                } else {
                    Text("Chargement…").font(MMFont.system(14)).foregroundStyle(MMColor.ink3).padding(18)
                }
            }
            Text("Repères 2026 indicatifs, à ajuster avec ton expert-comptable — ce n'est pas un conseil fiscal.")
                .font(MMFont.system(11)).foregroundStyle(MMColor.ink3).padding(.horizontal, 4)
        }
        .task { await model.load(store) }
    }

    private var divider: some View { Rectangle().fill(MMColor.hairline).frame(height: 1).padding(.leading, 16) }

    private func row(_ title: String, value: String, chevron: Bool = false) -> some View {
        HStack {
            Text(title).font(MMFont.system(15)).foregroundStyle(MMColor.ink)
            Spacer()
            Text(value).font(MMFont.system(14, .medium)).foregroundStyle(MMColor.ink2)
            if chevron { Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(MMColor.ink3) }
        }
        .padding(.horizontal, 16).padding(.vertical, 13)
    }

    private func percent(_ title: String, _ key: String, _ value: Double, step: Double = 0.01) -> some View {
        Stepper(value: Binding(get: { value }, set: { save([key: (($0 * 1000).rounded() / 1000)]) }), in: 0...1, step: step) {
            HStack {
                Text(title).font(MMFont.system(14))
                Spacer()
                Text((value).formatted(.percent.precision(.fractionLength(0...1)))).font(MMFont.number(14, .regular)).foregroundStyle(MMColor.ink2)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 6)
    }

    private func save(_ changes: [String: Any]) {
        saving = true
        Task {
            _ = try? await store.client.saveFinance(changes)
            await model.load(store, force: true)
            saving = false
        }
    }
}
