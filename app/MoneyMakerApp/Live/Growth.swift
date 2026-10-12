//
//  Growth.swift
//  MoneyMaker — graphiques (parité RevenueCat), prévision de LTV, anomalies et tests A/B.
//

import SwiftUI
import Charts

// MARK: - Modèles

/// Clé JSON quelconque : les lignes de graphique portent des champs variables selon le graphique.
private struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

/// Ligne de série : une date (cohorte/jour) et des nombres (value, new, churned, p1…).
struct ChartRow: Decodable, Hashable {
    var date: String = ""
    var values: [String: Double] = [:]
    subscript(_ k: String) -> Double? { values[k] }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        for k in c.allKeys {
            if k.stringValue == "date" { date = (try? c.decode(String.self, forKey: k)) ?? "" }
            else if let v = try? c.decode(Double.self, forKey: k) { values[k.stringValue] = v }
        }
    }

    var day: Date? { ChartRow.parser.date(from: date) }
    static let parser: DateFormatter = {
        let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC"); f.dateFormat = "yyyy-MM-dd"; return f
    }()
}

struct ChartData: Decodable, Hashable {
    let name: String
    let unit: String
    var currency: String? = nil
    var resolution: String? = nil
    let series: [ChartRow]
    var summary: ChartRow? = nil
    var note: String? = nil

    func format(_ v: Double?, compact: Bool = true) -> String {
        guard let v, v.isFinite else { return "—" }
        switch unit {
        case "micros": return Int(v).money(currency ?? "EUR", compact: compact)
        case "ratio": return v.formatted(.percent.precision(.fractionLength(1)))
        default: return Int(v.rounded()).formatted()
        }
    }
}

struct LTVPrediction: Decodable, Hashable {
    struct Group: Decodable, Hashable, Identifiable {
        let key: String
        let customers: Int
        var ltv12: Int? = nil
        var ltv24: Int? = nil
        var arpuMonthMicros: Int? = nil
        var confidence: String? = nil
        var id: String { key }
    }
    let currency: String
    let groups: [Group]
}

struct AnomalyItem: Decodable, Hashable, Identifiable {
    let id: String
    var metric: String? = nil
    var date: String? = nil
    var title: String? = nil
    var body: String? = nil
    var direction: String? = nil
    var severity: String? = nil
    var good: Bool? = nil
    var at: Double? = nil
}

struct ExperimentInfo: Decodable, Hashable, Identifiable {
    let id: String
    let name: String
    let status: String
    var placement: String? = nil
    var startedAt: Double? = nil
}

struct ExperimentResults: Decodable, Hashable {
    struct Variant: Decodable, Hashable, Identifiable {
        let id: String
        var offeringId: String? = nil
        var enrolled: Int = 0
        var conversions: Int = 0
        var revenueMicros: Int = 0
        var conversionRate: Double = 0
        var arpuMicros: Int? = nil
        var probabilityToBeBest: Double = 0
    }
    var currency: String? = nil
    let variants: [Variant]
}

// MARK: - Réseau (+ cache court)

actor GrowthCache {
    static let shared = GrowthCache()
    private var entries: [String: (at: Date, value: Any)] = [:]
    func get<T>(_ key: String, ttl: TimeInterval) -> T? {
        guard let e = entries[key], Date().timeIntervalSince(e.at) < ttl else { return nil }
        return e.value as? T
    }
    func set(_ key: String, _ value: Any) { entries[key] = (Date(), value) }
}

extension MoneyMakerClient {
    /// GET mis en cache quelques minutes : changer de graphique ou de période ne relance pas la requête.
    func cached<T: Decodable>(_ path: String, ttl: TimeInterval = 180) async throws -> T {
        let key = "\(token ?? "")|\(path)"
        if let hit: T = await GrowthCache.shared.get(key, ttl: ttl) { return hit }
        let v: T = try await get(path)
        await GrowthCache.shared.set(key, v)
        return v
    }

    func chart(projectId: String, name: String, days: Int, resolution: String) async throws -> ChartData {
        try await cached("projects/\(projectId)/charts/\(name)?days=\(days)&resolution=\(resolution)")
    }

    func ltvPrediction(projectId: String) async throws -> LTVPrediction {
        try await cached("projects/\(projectId)/ltv-prediction?groupBy=product", ttl: 600)
    }

    func anomalies(projectId: String) async throws -> [AnomalyItem] {
        struct R: Decodable { let anomalies: [AnomalyItem] }
        let r: R = try await cached("projects/\(projectId)/anomalies")
        return r.anomalies
    }

    func experiments(projectId: String) async throws -> [ExperimentInfo] {
        struct P: Decodable {
            struct C: Decodable { var experiments: [ExperimentInfo]? }
            let id: String; let config: C?
        }
        struct R: Decodable { let projects: [P] }
        let r: R = try await cached("projects")
        return r.projects.first { $0.id == projectId }?.config?.experiments ?? []
    }

    func experimentResults(projectId: String, experimentId: String) async throws -> ExperimentResults {
        let eid = experimentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? experimentId
        return try await cached("projects/\(projectId)/experiments/\(eid)/results")
    }
}

// MARK: - Écran Graphiques

enum ChartKind { case line, movement, retention, funnel }

struct ChartDef: Hashable, Identifiable {
    let name: String, title: String
    var id: String { name }
    var kind: ChartKind {
        switch name {
        case "active_subscriptions_movement", "mrr_movement": return .movement
        case "subscription_retention": return .retention
        case "trial_conversion_funnel": return .funnel
        default: return .line
        }
    }
    static let all: [ChartDef] = [
        .init(name: "mrr", title: "MRR"),
        .init(name: "revenue", title: "Revenu"),
        .init(name: "active_subscriptions", title: "Abonnés"),
        .init(name: "active_subscriptions_movement", title: "Mouvements"),
        .init(name: "new_customers", title: "Nouveaux clients"),
        .init(name: "active_trials", title: "Essais"),
        .init(name: "trial_conversion_funnel", title: "Entonnoir essai"),
        .init(name: "churn", title: "Churn"),
        .init(name: "subscription_retention", title: "Rétention"),
        .init(name: "realized_ltv_per_paying_customer", title: "LTV réalisée"),
        .init(name: "refund_rate", title: "Remboursements"),
    ]
}

struct ChartsScreen: View {
    @EnvironmentObject var store: Store
    let projectId: String
    @State private var chart = ChartDef.all[0]
    @State private var days = 30
    @State private var data: ChartData?
    @State private var loading = true
    @State private var error: String?
    @State private var selected: Date?

    private var resolution: String { days <= 31 ? "day" : days <= 120 ? "week" : "month" }
    private var projectName: String? { store.overview?.projects.first { $0.projectId == projectId }?.name }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Graphiques").font(MMFont.system(34, .bold)).tracking(-0.8)
                    if let projectName { Text(projectName).font(MMFont.system(14)).foregroundStyle(MMColor.ink3) }
                }
                .mmAppear(0)
                chips.mmAppear(1)
                MMSegmented(options: [(30, "30 j"), (90, "90 j"), (365, "1 an")], selection: $days).mmAppear(1)
                content.mmAppear(2)
                if let note = data?.note {
                    Text(note).font(MMFont.system(11)).foregroundStyle(MMColor.ink3).padding(.horizontal, 4)
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        .navigationBarTitleDisplayMode(.inline)
        .mmPage()
        .task(id: "\(chart.name)|\(days)") { await load() }
    }

    private var chips: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(ChartDef.all) { c in
                    let on = c == chart
                    Button {
                        withAnimation(.snappy) { chart = c; selected = nil }
                    } label: {
                        Text(c.title).font(MMFont.system(13, on ? .medium : .regular))
                            .foregroundStyle(on ? Color.black : MMColor.ink2)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(on ? AnyShapeStyle(MMColor.ink) : AnyShapeStyle(Color.white.opacity(0.06)), in: Capsule())
                            .overlay { Capsule().strokeBorder(on ? .clear : MMColor.hairline, lineWidth: 1) }
                    }
                    .buttonStyle(MMPressStyle())
                }
            }
            .padding(.horizontal, 16)
        }
        .scrollIndicators(.hidden)
        .padding(.horizontal, -16)
        .sensoryFeedback(.selection, trigger: chart)
    }

    @ViewBuilder private var content: some View {
        if loading && data == nil {
            MMCard(padding: 20) {
                VStack(alignment: .leading, spacing: 14) {
                    RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.06)).frame(width: 120, height: 12)
                    RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.06)).frame(width: 180, height: 40)
                    RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.04)).frame(height: 180)
                }
                .modifier(MMShimmer())
            }
        } else if let error, data == nil {
            MMCard { Label(error, systemImage: "exclamationmark.triangle").font(MMFont.system(13)).foregroundStyle(MMColor.red) }
        } else if let d = data {
            VStack(alignment: .leading, spacing: 14) {
                switch chart.kind {
                case .line: LineChartCard(data: d, title: chart.title, selected: $selected)
                case .movement: MovementChartCard(data: d, title: chart.title)
                case .retention: RetentionGrid(data: d)
                case .funnel: FunnelCard(data: d)
                }
            }
            .opacity(loading ? 0.5 : 1)
            .animation(.easeOut(duration: 0.2), value: loading)
        }
    }

    private func load() async {
        loading = true
        do {
            let d = try await store.client.chart(projectId: projectId, name: chart.name, days: days, resolution: resolution)
            withAnimation(.easeOut(duration: 0.3)) { data = d; error = nil }
        } catch {
            if !(error is CancellationError) { self.error = error.localizedDescription; data = nil }
        }
        loading = false
    }
}

/// Résumé chiffré : libellés français des champs secondaires renvoyés par l'API.
private let summaryLabels: [(String, String)] = [
    ("new", "Nouveaux"), ("reactivated", "Réactivés"), ("churned", "Perdus"), ("net", "Net"),
    ("revenue", "Brut"), ("refunds", "Remb."), ("transactions", "Transactions"),
    ("customers", "Clients"), ("payingCustomers", "Payants"), ("started", "Essais"), ("converted", "Convertis"),
]

private struct SummaryRow: View {
    let data: ChartData
    var body: some View {
        let items = summaryLabels.compactMap { k, l in data.summary?[k].map { (k, l, $0) } }
        if !items.isEmpty {
            HStack(spacing: 18) {
                ForEach(items.prefix(4), id: \.0) { k, l, v in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(l.uppercased()).font(MMFont.system(9, .medium)).tracking(1.2).foregroundStyle(MMColor.ink3)
                        Text(["revenue", "refunds"].contains(k) || (data.unit == "micros" && ["new", "reactivated", "churned", "net"].contains(k))
                             ? Int(v).money(data.currency ?? "EUR", compact: true) : Int(v).formatted())
                            .font(MMFont.number(15, .regular)).monospacedDigit()
                    }
                }
            }
        }
    }
}

private struct LineChartCard: View {
    let data: ChartData
    let title: String
    @Binding var selected: Date?

    var body: some View {
        let pts = data.series.compactMap { r in r.day.flatMap { d in r["value"].map { MMPoint(date: d, value: $0) } } }
        let point = selected.flatMap { d in pts.min { abs($0.date.timeIntervalSince(d)) < abs($1.date.timeIntervalSince(d)) } }
        let headline = point?.value ?? data.summary?["value"] ?? pts.last?.value
        MMCard(padding: 20, glow: MMColor.accent) {
            VStack(alignment: .leading, spacing: 16) {
                MMLabel(text: title, trailing: point.map { $0.date.formatted(.dateTime.day().month(.abbreviated).year()) } ?? resolutionLabel(data.resolution))
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(data.format(headline, compact: false))
                        .font(MMFont.number(44)).tracking(-1.2).lineLimit(1).minimumScaleFactor(0.5)
                        .contentTransition(.numericText(value: headline ?? 0))
                        .animation(.snappy(duration: 0.25), value: headline)
                    if point == nil, data.unit != "ratio" { MMDelta(value: halfOverHalf(pts)) }
                }
                SummaryRow(data: data)
                if pts.count > 1 {
                    MMGlowChart(points: pts, selection: $selected, showsAxis: true).frame(height: 180)
                        .sensoryFeedback(.selection, trigger: point?.date)
                } else {
                    Text("Pas encore assez de données.").font(MMFont.system(13)).foregroundStyle(MMColor.ink3).frame(height: 80)
                }
            }
        }
    }
}

private func resolutionLabel(_ r: String?) -> String {
    ["day": "par jour", "week": "par semaine", "month": "par mois"][r ?? ""] ?? ""
}

private struct MovementChartCard: View {
    let data: ChartData
    let title: String

    private struct Bar: Identifiable { let id = UUID(); let date: Date; let kind: String; let value: Double }

    var body: some View {
        let bars: [Bar] = data.series.flatMap { r -> [Bar] in
            guard let d = r.day else { return [] }
            return [Bar(date: d, kind: "Nouveaux", value: r["new"] ?? 0),
                    Bar(date: d, kind: "Réactivés", value: r["reactivated"] ?? 0),
                    Bar(date: d, kind: "Perdus", value: -abs(r["churned"] ?? 0))]
        }
        let unit: Calendar.Component = data.resolution == "month" ? .month : data.resolution == "week" ? .weekOfYear : .day
        MMCard(padding: 20, glow: MMColor.accent) {
            VStack(alignment: .leading, spacing: 16) {
                MMLabel(text: title, trailing: resolutionLabel(data.resolution))
                Text((data.summary?["net"] ?? data.summary?["value"]).map { ($0 >= 0 ? "+" : "") + data.format($0, compact: false) } ?? "—")
                    .font(MMFont.number(44)).tracking(-1.2).lineLimit(1).minimumScaleFactor(0.5)
                SummaryRow(data: data)
                Chart(bars) { b in
                    BarMark(x: .value("Date", b.date, unit: unit), y: .value("Valeur", b.value))
                        .foregroundStyle(by: .value("Type", b.kind))
                        .cornerRadius(2)
                }
                .chartForegroundStyleScale(["Nouveaux": MMColor.accent, "Réactivés": MMColor.blue, "Perdus": MMColor.red])
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                        AxisValueLabel(format: .dateTime.day().month(.abbreviated)).font(MMFont.system(10)).foregroundStyle(MMColor.ink3)
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { _ in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 4])).foregroundStyle(MMColor.hairline)
                    }
                }
                .chartLegend(position: .bottom, alignment: .leading)
                .frame(height: 200)
            }
        }
    }
}

private struct RetentionGrid: View {
    let data: ChartData
    var body: some View {
        let cohorts = data.series.filter { ($0["value"] ?? 0) > 0 }
        let cols = (0..<12).filter { k in cohorts.contains { $0["p\(k)"] != nil } }
        MMCard(padding: 18, glow: MMColor.accent) {
            VStack(alignment: .leading, spacing: 14) {
                MMLabel(text: "Rétention par cohorte", trailing: data.summary?["customers"].map { "\(Int($0)) clients" })
                if cohorts.isEmpty {
                    Text("Aucune cohorte sur la période.").font(MMFont.system(13)).foregroundStyle(MMColor.ink3)
                } else {
                    ScrollView(.horizontal) {
                        Grid(horizontalSpacing: 3, verticalSpacing: 3) {
                            GridRow {
                                Text("").frame(width: 64)
                                ForEach(cols, id: \.self) { k in
                                    Text("M\(k)").font(MMFont.system(9, .medium)).foregroundStyle(MMColor.ink3).frame(width: 34)
                                }
                            }
                            ForEach(cohorts, id: \.date) { r in
                                GridRow {
                                    VStack(alignment: .leading, spacing: 0) {
                                        Text(r.day?.formatted(.dateTime.month(.abbreviated).year(.twoDigits)) ?? r.date)
                                            .font(MMFont.system(11, .medium))
                                        Text("\(Int(r["value"] ?? 0))").font(MMFont.system(9)).foregroundStyle(MMColor.ink3)
                                    }
                                    .frame(width: 64, alignment: .leading)
                                    ForEach(cols, id: \.self) { k in
                                        let v = r["p\(k)"]
                                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                                            .fill(v.map { MMColor.accent.opacity(0.08 + 0.72 * $0) } ?? Color.white.opacity(0.03))
                                            .frame(width: 34, height: 28)
                                            .overlay {
                                                if let v {
                                                    Text("\(Int((v * 100).rounded()))").font(MMFont.system(10, .medium))
                                                        .foregroundStyle(v > 0.55 ? Color.black : MMColor.ink)
                                                }
                                            }
                                    }
                                }
                            }
                        }
                    }
                    .scrollIndicators(.hidden)
                }
            }
        }
    }
}

private struct FunnelCard: View {
    let data: ChartData
    var body: some View {
        let s = data.summary
        let started = max(s?["started"] ?? 0, 1)
        let steps: [(String, Double, Color)] = [
            ("Essais démarrés", s?["started"] ?? 0, MMColor.blue),
            ("Convertis", s?["converted"] ?? 0, MMColor.accent),
            ("Toujours abonnés", s?["stillActive"] ?? 0, MMColor.accent.opacity(0.7)),
            ("Annulés", s?["cancelled"] ?? 0, MMColor.red),
            ("En cours", s?["pending"] ?? 0, MMColor.ink3),
        ]
        MMCard(padding: 20, glow: MMColor.accent) {
            VStack(alignment: .leading, spacing: 16) {
                MMLabel(text: "Entonnoir essai", trailing: "taux de conversion")
                Text(data.format(s?["value"])).font(MMFont.number(44)).tracking(-1.2)
                VStack(spacing: 12) {
                    ForEach(steps, id: \.0) { label, v, color in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(label).font(MMFont.system(13)).foregroundStyle(MMColor.ink2)
                                Spacer()
                                Text("\(Int(v))").font(MMFont.number(14, .regular)).monospacedDigit()
                                Text((v / started).formatted(.percent.precision(.fractionLength(0))))
                                    .font(MMFont.system(11)).foregroundStyle(MMColor.ink3).frame(width: 40, alignment: .trailing)
                            }
                            GeometryReader { g in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(Color.white.opacity(0.05))
                                    Capsule().fill(color).frame(width: max(4, g.size.width * min(1, v / started)))
                                }
                            }
                            .frame(height: 8)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Sections du business (Accueil focalisé + ProjectView)

struct GrowthSections: View {
    @EnvironmentObject var store: Store
    let p: ProjectSummary
    @State private var ltv: LTVPrediction?
    @State private var anomalies: [AnomalyItem] = []
    @State private var experiments: [(ExperimentInfo, ExperimentResults?)] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            chartsLink
            if let ltv, !ltv.groups.isEmpty { ltvCard(ltv) }
            if !anomalies.isEmpty { anomaliesCard }
            if !experiments.isEmpty { experimentsSection }
        }
        .task(id: p.projectId) { await load() }
    }

    private var chartsLink: some View {
        NavigationLink(value: Router.Destination.charts(p.projectId)) {
            MMCard(padding: 16, radius: 22) {
                HStack(spacing: 14) {
                    Image(systemName: "chart.xyaxis.line").font(.system(size: 17, weight: .medium)).foregroundStyle(MMColor.accent)
                        .frame(width: 36, height: 36).background(MMColor.accent.opacity(0.12), in: Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Graphiques").font(MMFont.system(15, .medium)).foregroundStyle(MMColor.ink)
                        Text("MRR, rétention, churn, entonnoir…").font(MMFont.system(12)).foregroundStyle(MMColor.ink3)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(MMColor.ink3)
                }
            }
        }
        .buttonStyle(MMPressStyle())
    }

    private func ltvCard(_ l: LTVPrediction) -> some View {
        MMCard(padding: 18) {
            VStack(alignment: .leading, spacing: 12) {
                MMLabel(text: "Prévision LTV", trailing: "12 / 24 mois")
                ForEach(l.groups.prefix(6)) { g in
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(g.key).font(MMFont.system(13, .medium)).lineLimit(1)
                            Text("\(g.customers) clients · confiance \(confidence(g.confidence))")
                                .font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                        }
                        Spacer(minLength: 8)
                        Text(g.ltv12.map { $0.money(l.currency) } ?? "—").font(MMFont.number(15, .regular)).monospacedDigit()
                        Text(g.ltv24.map { $0.money(l.currency) } ?? "—").font(MMFont.number(15, .regular)).monospacedDigit()
                            .foregroundStyle(MMColor.accent).frame(minWidth: 74, alignment: .trailing)
                    }
                }
            }
        }
    }

    private func confidence(_ c: String?) -> String {
        ["high": "élevée", "medium": "moyenne", "low": "faible"][c ?? ""] ?? "—"
    }

    private var anomaliesCard: some View {
        MMCard(padding: 18, glow: anomalies.contains { $0.good == false } ? MMColor.orange : nil) {
            VStack(alignment: .leading, spacing: 12) {
                MMLabel(text: "Anomalies", trailing: "\(anomalies.count)")
                ForEach(anomalies.prefix(5)) { a in
                    let color = a.good == true ? MMColor.accent : a.severity == "critical" ? MMColor.red : MMColor.orange
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: a.direction == "down" ? "arrow.down.right" : "arrow.up.right")
                            .font(.system(size: 11, weight: .bold)).foregroundStyle(color)
                            .frame(width: 26, height: 26).background(color.opacity(0.12), in: Circle())
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.title ?? a.metric ?? "Anomalie").font(MMFont.system(13, .medium))
                            if let b = a.body { Text(b).font(MMFont.system(11)).foregroundStyle(MMColor.ink2).lineLimit(2) }
                        }
                        Spacer(minLength: 4)
                        if let d = a.date.flatMap({ ChartRow.parser.date(from: $0) }) {
                            Text(d.formatted(.dateTime.day().month(.abbreviated))).font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                        }
                    }
                }
            }
        }
    }

    private var experimentsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            MMLabel(text: "Tests A/B").padding(.horizontal, 4).padding(.top, 8)
            ForEach(experiments, id: \.0.id) { e, r in
                MMCard(padding: 18) {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Text(e.name).font(MMFont.system(15, .medium)).lineLimit(1)
                            Spacer()
                            Text("EN COURS").font(MMFont.system(9, .medium)).tracking(1.2).foregroundStyle(MMColor.accent)
                                .padding(.horizontal, 8).padding(.vertical, 3).background(MMColor.accent.opacity(0.12), in: Capsule())
                        }
                        if let r, !r.variants.isEmpty {
                            let best = r.variants.max { $0.probabilityToBeBest < $1.probabilityToBeBest }?.id
                            ForEach(r.variants) { v in
                                VStack(alignment: .leading, spacing: 5) {
                                    HStack(alignment: .firstTextBaseline) {
                                        Text(v.id).font(MMFont.system(13, .medium)).foregroundStyle(v.id == best ? MMColor.accent : MMColor.ink)
                                        Text("\(v.conversions)/\(v.enrolled)").font(MMFont.system(11)).foregroundStyle(MMColor.ink3)
                                        Spacer()
                                        Text(v.conversionRate.formatted(.percent.precision(.fractionLength(1))))
                                            .font(MMFont.number(14, .regular)).monospacedDigit()
                                        Text("\(v.probabilityToBeBest.formatted(.percent.precision(.fractionLength(0)))) meilleur")
                                            .font(MMFont.system(11)).foregroundStyle(MMColor.ink3).frame(minWidth: 82, alignment: .trailing)
                                    }
                                    GeometryReader { g in
                                        ZStack(alignment: .leading) {
                                            Capsule().fill(Color.white.opacity(0.05))
                                            Capsule().fill(v.id == best ? MMColor.accent : MMColor.blue.opacity(0.7))
                                                .frame(width: max(4, g.size.width * v.probabilityToBeBest))
                                        }
                                    }
                                    .frame(height: 6)
                                }
                            }
                        } else {
                            Text("Pas encore de résultats.").font(MMFont.system(13)).foregroundStyle(MMColor.ink3)
                        }
                    }
                }
            }
        }
    }

    private func load() async {
        let c = store.client, pid = p.projectId
        async let l = try? c.ltvPrediction(projectId: pid)
        async let a = try? c.anomalies(projectId: pid)
        async let e = try? c.experiments(projectId: pid)
        let (nl, na, ne) = await (l, a, e)
        var exps: [(ExperimentInfo, ExperimentResults?)] = []
        for x in (ne ?? []).filter({ $0.status == "running" }) {
            exps.append((x, try? await c.experimentResults(projectId: pid, experimentId: x.id)))
        }
        withAnimation(.easeOut(duration: 0.3)) {
            ltv = nl; anomalies = na ?? []; experiments = exps
        }
    }
}
