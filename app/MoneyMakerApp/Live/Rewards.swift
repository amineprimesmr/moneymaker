import SwiftUI
import UIKit

// MARK: - Préférences d'affichage

/// Réglages locaux (comme RevenueCat) : devise, fuseau des heures, ouverture d'une vente, détail par business, haptique.
enum AppPrefs {
    static let currencyKey = "mm.currency", utcKey = "mm.utc", openAsKey = "mm.openAs"
    static let perBusinessKey = "mm.perBusiness", hapticsKey = "mm.haptics"
    static var currency: String? { (UserDefaults.standard.string(forKey: currencyKey)).flatMap { $0.isEmpty ? nil : $0 } }
    static var utc: Bool { UserDefaults.standard.bool(forKey: utcKey) }
    static var openAsCustomer: Bool { UserDefaults.standard.string(forKey: openAsKey) == "customer" }
    static var perBusiness: Bool { UserDefaults.standard.object(forKey: perBusinessKey) as? Bool ?? true }
    static var haptics: Bool { UserDefaults.standard.object(forKey: hapticsKey) as? Bool ?? true }

    static let currencies: [(String, String, String?)] = [
        ("", String(localized: "Auto"), String(localized: "Devise du compte")), ("EUR", "EUR", String(localized: "Euro (€)")), ("USD", "USD", String(localized: "Dollar US ($)")), ("GBP", "GBP", String(localized: "Livre sterling (£)")),
        ("CHF", "CHF", String(localized: "Franc suisse")), ("CAD", "CAD", String(localized: "Dollar canadien")), ("AUD", "AUD", String(localized: "Dollar australien")), ("JPY", "JPY", String(localized: "Yen (¥)")),
        ("BRL", "BRL", String(localized: "Réal brésilien")), ("MAD", "MAD", String(localized: "Dirham marocain")), ("AED", "AED", String(localized: "Dirham des Émirats")),
    ]
}

extension Date {
    /// Heure affichée selon le réglage « Heures en » (local ou UTC).
    func mmFormatted(_ style: Date.FormatStyle) -> String {
        var s = style
        if AppPrefs.utc { s.timeZone = TimeZone(identifier: "UTC")! }
        return formatted(s)
    }
}

// MARK: - Trophées

struct Trophy: Identifiable {
    enum Tier { case bronze, silver, gold, diamond, legend
        var color: Color {
            switch self {
            case .bronze: Color(red: 0.85, green: 0.55, blue: 0.3)
            case .silver: Color(red: 0.8, green: 0.83, blue: 0.9)
            case .gold: Color(red: 1, green: 0.8, blue: 0.3)
            case .diamond: Color(red: 0.6, green: 0.85, blue: 1)
            case .legend: Color(red: 0.75, green: 0.55, blue: 1)
            }
        }
        var points: Int { switch self { case .bronze: 10; case .silver: 25; case .gold: 50; case .diamond: 100; case .legend: 250 } }
    }
    let id: String
    let family: String
    let title: String
    let detail: String
    let symbol: String
    let tier: Tier
    let current: Double
    let target: Double
    var unlocked: Bool { current >= target }
    var progress: Double { min(current / max(target, 1), 1) }
}

/// Icône alternative débloquée par un palier.
struct RewardIcon: Identifiable {
    let id: String            // nom de l'icône alternative (nil = classique)
    let title: String
    let requirement: String
    let trophyId: String?
    var alternateName: String? { id == "Classic" ? nil : "AppIcon-\(id)" }
}

@MainActor
enum Rewards {
    static let icons: [RewardIcon] = [
        .init(id: "Classic", title: String(localized: "Classique"), requirement: "", trophyId: nil),
        .init(id: "Light", title: String(localized: "Négatif"), requirement: "", trophyId: nil),
        .init(id: "Violet", title: String(localized: "Néon"), requirement: String(localized: "Ta première vente"), trophyId: "first-sale"),
        .init(id: "Silver", title: String(localized: "Argent"), requirement: String(localized: "1 000€ de MRR"), trophyId: "mrr-1k"),
        .init(id: "Club", title: String(localized: "Club 2 500"), requirement: String(localized: "2 500€ de MRR"), trophyId: "mrr-2500"),
        .init(id: "Gold", title: String(localized: "Or"), requirement: String(localized: "10 000€ de MRR"), trophyId: "mrr-10k"),
        .init(id: "Diamond", title: String(localized: "Diamant"), requirement: String(localized: "100 000€ de MRR"), trophyId: "mrr-100k"),
        .init(id: "Million", title: String(localized: "Le Million"), requirement: String(localized: "1 000 000€ de MRR"), trophyId: "mrr-1m"),
    ]

    /// Mémo : les Réglages, la page Trophées et le choix d'icône appellent `trophies` dans leur
    /// `body`, redessiné à chaque publication du Store (tic du direct…). Le calcul (série de
    /// 365 jours, ventes par pays, 31 libellés localisés et montants formatés) ne refait que
    /// si ses entrées changent.
    private struct MemoKey: Equatable {
        let overview: Overview?
        let view: Set<String>
        let feedHead: String?
        let feedCount: Int
        let rated: Bool
        let utc: Bool
    }
    private static var memoKey: MemoKey?
    private static var memo: [Trophy] = []

    static func trophies(_ store: Store) -> [Trophy] {
        let key = MemoKey(overview: store.overview, view: store.viewIds, feedHead: store.feed.first?.id,
                          feedCount: store.feed.count, rated: store.alerts.contains { $0.own != false && ($0.rank ?? 999) <= 10 }, utc: AppPrefs.utc)
        if key == memoKey { return memo }
        let t = computeTrophies(store)
        memoKey = key; memo = t
        return t
    }

    private static func computeTrophies(_ store: Store) -> [Trophy] {
        guard let o = store.overview else { return [] }
        let mrr = Double(o.mrrMicros) / 1e6
        let subs = Double(o.activeSubscriptions)
        let paying = Double(o.payingCustomers ?? o.activeSubscriptions)
        let daily = dailySeries(o.mergedRevenueByDay, days: max(o.periodDays, 28))
        let best = daily.map(\.value).max() ?? 0
        let streak = Double(daily.reversed().prefix { $0.value > 0 }.count)
        var longest = 0, run = 0
        for p in daily { run = p.value > 0 ? run + 1 : 0; longest = max(longest, run) }
        let countries = Double(store.globeSpots.filter { $0.value >= 0.01 }.count)
        let anySale = (o.revenueMicros > 0 || o.mrrMicros > 0 || store.feed.contains { $0.isRevenue }) ? 1.0 : 0
        let projects = Double(o.projects.count)
        let rated = store.alerts.contains { $0.own != false && ($0.rank ?? 999) <= 10 } ? 1.0 : 0
        // Montant compact dans la langue de l'appareil (« 2,5 k€ », « $2.5K », « 1 M€ »).
        func money(_ v: Double) -> String { Int(v * 1_000_000).money(o.currency, compact: v >= 10_000) }

        var t: [Trophy] = [
            .init(id: "first-sale", family: String(localized: "Débuts"), title: String(localized: "Première vente"), detail: String(localized: "Encaisser ton tout premier paiement"), symbol: "sparkles", tier: .bronze, current: anySale, target: 1),
            .init(id: "multi", family: String(localized: "Débuts"), title: String(localized: "Serial maker"), detail: String(localized: "Suivre 3 business dans MoneyMaker"), symbol: "square.stack.3d.up.fill", tier: .silver, current: projects, target: 3),
            .init(id: "top10", family: String(localized: "Débuts"), title: String(localized: "Top 10"), detail: String(localized: "Entrer dans le top 10 de l'App Store d'un pays"), symbol: "trophy.fill", tier: .gold, current: rated, target: 1),
        ]
        for (target, tier, id) in [(100.0, Trophy.Tier.bronze, "mrr-100"), (1_000, .silver, "mrr-1k"), (2_500, .silver, "mrr-2500"),
                                   (10_000, .gold, "mrr-10k"), (100_000, .diamond, "mrr-100k"), (1_000_000, .legend, "mrr-1m")] {
            t.append(.init(id: id, family: String(localized: "MRR"), title: String(localized: "\(money(target)) de MRR"), detail: String(localized: "Revenu récurrent mensuel"), symbol: "arrow.triangle.2.circlepath", tier: tier, current: mrr, target: target))
        }
        for (target, tier) in [(10.0, Trophy.Tier.bronze), (100, .silver), (1_000, .gold), (10_000, .diamond), (100_000, .legend)] {
            t.append(.init(id: "subs-\(Int(target))", family: String(localized: "Abonnés"), title: String(localized: "\(Int(target).formatted()) abonnés"), detail: String(localized: "Abonnés actifs en même temps"), symbol: "person.2.fill", tier: tier, current: subs, target: target))
        }
        for (target, tier) in [(50.0, Trophy.Tier.bronze), (500, .silver), (5_000, .gold)] {
            t.append(.init(id: "paying-\(Int(target))", family: String(localized: "Clients"), title: String(localized: "\(Int(target).formatted()) clients payants"), detail: String(localized: "Utilisateurs qui paient en ce moment"), symbol: "creditcard.fill", tier: tier, current: paying, target: target))
        }
        for (target, tier) in [(100.0, Trophy.Tier.bronze), (1_000, .gold), (10_000, .diamond)] {
            t.append(.init(id: "day-\(Int(target))", family: String(localized: "Records"), title: String(localized: "Journée à \(money(target))"), detail: String(localized: "Encaisser autant en une seule journée"), symbol: "bolt.fill", tier: tier, current: best, target: target))
        }
        for (target, tier) in [(3.0, Trophy.Tier.bronze), (7, .silver), (14, .gold), (28, .diamond)] {
            t.append(.init(id: "streak-\(Int(target))", family: String(localized: "Séries"), title: String(localized: "\(Int(target)) jours d'affilée"), detail: String(localized: "Au moins une vente chaque jour (record : \(longest) j, en cours : \(Int(streak)) j)"), symbol: "flame.fill", tier: tier, current: Double(longest), target: target))
        }
        for (target, tier) in [(5.0, Trophy.Tier.bronze), (25, .silver), (50, .gold), (100, .diamond)] {
            t.append(.init(id: "countries-\(Int(target))", family: String(localized: "Monde"), title: String(localized: "\(Int(target)) pays"), detail: String(localized: "Vendre dans autant de pays"), symbol: "globe.europe.africa.fill", tier: tier, current: countries, target: target))
        }
        return t
    }

    // Trophées déjà vus (pour fêter les nouveaux une seule fois).
    private static let seenKey = "mm.trophies.seen"
    static var seen: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: seenKey) ?? []) }
        set { UserDefaults.standard.set(Array(newValue), forKey: seenKey) }
    }
    static func newlyUnlocked(_ list: [Trophy]) -> [Trophy] { let s = seen; return list.filter { $0.unlocked && !s.contains($0.id) } }
    static func markSeen(_ list: [Trophy]) { seen.formUnion(list.filter(\.unlocked).map(\.id)) }

    /// Niveau du maker : chaque trophée rapporte des points selon son rang.
    static func level(_ list: [Trophy]) -> (level: Int, points: Int, into: Int, next: Int) {
        let pts = list.filter(\.unlocked).reduce(0) { $0 + $1.tier.points }
        var level = 1, need = 30, acc = 0
        while pts >= acc + need { acc += need; level += 1; need = Int(Double(need) * 1.45) }
        return (level, pts, pts - acc, need)
    }

    static let titles = [String(localized: "Apprenti"), String(localized: "Maker"), String(localized: "Entrepreneur"), String(localized: "Bâtisseur"), String(localized: "Stratège"), String(localized: "Machine à cash"), String(localized: "Magnat"), String(localized: "Légende"), String(localized: "Icône"), String(localized: "Mythe")]
    static func title(for level: Int) -> String { titles[min(max(level - 1, 0), titles.count - 1)] }
}

// MARK: - Page Trophées

struct RewardsView: View {
    @EnvironmentObject var store: Store
    @State private var fresh: Set<String> = []
    @State private var confetti = 0
    @State private var family = RewardsView.all
    private static let all = String(localized: "Tous")

    var body: some View {
        let list = Rewards.trophies(store)
        let lvl = Rewards.level(list)
        let families = [Self.all] + Array(NSOrderedSet(array: list.map(\.family))) as! [String]
        SettingsScrollPage(title: String(localized: "Trophées")) {
            levelCard(lvl, unlocked: list.filter(\.unlocked).count, total: list.count)
                .padding(.horizontal, SettingsTheme.horizontalPadding).padding(.top, 8)
            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    ForEach(families, id: \.self) { f in
                        Button { withAnimation(.snappy) { family = f } } label: {
                            Text(f).font(V2Font.system(size: 14, weight: .medium))
                                .foregroundStyle(family == f ? MMColor.inkInverse : MMColor.ink)
                                .padding(.horizontal, 14).frame(height: 32)
                                .background(family == f ? AnyShapeStyle(MMColor.ink) : AnyShapeStyle(MMColor.fg(0.08)), in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, SettingsTheme.horizontalPadding)
            }
            .scrollIndicators(.hidden)
            .padding(.top, 18)
            .sensoryFeedback(.selection, trigger: family)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible())], spacing: 10) {
                ForEach(list.filter { family == Self.all || $0.family == family }.sorted { ($0.unlocked ? 0 : 1, -$0.progress) < ($1.unlocked ? 0 : 1, -$1.progress) }) { t in
                    TrophyCard(t: t, isNew: fresh.contains(t.id))
                }
            }
            .padding(.horizontal, SettingsTheme.horizontalPadding).padding(.top, 14)
            .animation(.snappy, value: family)
        }
        .overlay { ConfettiBurst(trigger: confetti).allowsHitTesting(false) }
        .onAppear {
            let n = Rewards.newlyUnlocked(list)
            fresh = Set(n.map(\.id))
            if !n.isEmpty {
                Task { try? await Task.sleep(for: .milliseconds(350)); confetti += 1
                    if AppPrefs.haptics { UINotificationFeedbackGenerator().notificationOccurred(.success) } }
            }
            Rewards.markSeen(list)
        }
    }

    private func levelCard(_ l: (level: Int, points: Int, into: Int, next: Int), unlocked: Int, total: Int) -> some View {
        RecoveryTileSurface(dotsAnchor: .topTrailing, dotsReach: 0.8) {
            HStack(spacing: 18) {
                ZStack {
                    Circle().stroke(MMColor.fg(0.08), lineWidth: 8)
                    Circle().trim(from: 0, to: Double(l.into) / Double(max(l.next, 1)))
                        .stroke(AngularGradient(colors: [RecoveryTileTheme.violetDeep, RecoveryTileTheme.violetBright, RecoveryTileTheme.violetDeep], center: .center),
                                style: StrokeStyle(lineWidth: 8, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                    VStack(spacing: 0) {
                        Text("NIV.").font(.system(size: 10, weight: .bold)).foregroundStyle(MMColor.ink3)
                        Text("\(l.level)").font(V2Font.system(size: 30, weight: .bold))
                    }
                }
                .frame(width: 92, height: 92)
                VStack(alignment: .leading, spacing: 6) {
                    Text(Rewards.title(for: l.level)).font(V2Font.system(size: 22, weight: .bold))
                    Text("\(l.points) points · \(l.next - l.into) avant le niveau \(l.level + 1)")
                        .font(MMFont.system(13)).foregroundStyle(MMColor.ink2)
                    Text("\(unlocked)/\(total) trophées débloqués").font(MMFont.system(13)).foregroundStyle(MMColor.ink3)
                }
                Spacer(minLength: 0)
            }
            .padding(18)
        }
    }
}

struct TrophyCard: View {
    let t: Trophy
    var isNew = false
    @State private var pop = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                ZStack {
                    Circle().fill(t.unlocked ? t.tier.color.opacity(0.18) : MMColor.fg(0.05))
                    Image(systemName: t.unlocked ? t.symbol : "lock.fill")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(t.unlocked ? t.tier.color : MMColor.ink3)
                        .symbolEffect(.bounce, value: pop)
                }
                .frame(width: 44, height: 44)
                .shadow(color: t.unlocked ? t.tier.color.opacity(0.5) : .clear, radius: 10)
                Spacer()
                if isNew {
                    Text("NOUVEAU").font(.system(size: 10, weight: .heavy)).foregroundStyle(.black)
                        .padding(.horizontal, 7).padding(.vertical, 3).background(t.tier.color, in: Capsule())
                }
            }
            Text(t.title).font(V2Font.system(size: 15, weight: .semibold)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            Text(t.detail).font(MMFont.system(11)).foregroundStyle(MMColor.ink3).lineLimit(3).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if !t.unlocked {
                VStack(alignment: .leading, spacing: 4) {
                    GeometryReader { g in
                        Capsule().fill(MMColor.fg(0.08))
                            .overlay(alignment: .leading) { Capsule().fill(t.tier.color.opacity(0.8)).frame(width: max(4, g.size.width * t.progress)) }
                    }
                    .frame(height: 5)
                    Text("\(Int((t.progress * 100).rounded()))%").font(MMFont.system(11, .medium)).foregroundStyle(MMColor.ink3)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 168, alignment: .topLeading)
        .background(MMColor.fg(0.062), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(t.unlocked ? t.tier.color.opacity(0.45) : MMColor.fg(0.08), lineWidth: t.unlocked ? 1 : 0.5)
        }
        .scaleEffect(pop ? 1.04 : 1)
        .onAppear {
            guard isNew else { return }
            withAnimation(.spring(response: 0.35, dampingFraction: 0.5).delay(0.4)) { pop = true }
            withAnimation(.spring(response: 0.4, dampingFraction: 0.8).delay(0.9)) { pop = false }
        }
    }
}

/// Pluie de confettis, déclenchée par `trigger`.
struct ConfettiBurst: View {
    let trigger: Int
    @State private var start: Date?
    var body: some View {
        TimelineView(.animation(paused: start == nil)) { tl in
            Canvas { ctx, size in
                guard let start else { return }
                let t = tl.date.timeIntervalSince(start)
                guard t < 2.6 else { return }
                let colors: [Color] = [.yellow, .pink, .purple, .mint, .orange, .white, .cyan]
                for i in 0..<90 {
                    let seed = Double(i) * 12.9898
                    let r = { (k: Double) in (sin(seed * k) * 43758.5453).truncatingRemainder(dividingBy: 1).magnitude }
                    let x = size.width * (0.5 + (r(1) - 0.5) * 0.3) + (r(2) - 0.5) * 520 * t
                    let y = size.height * 0.25 - 520 * r(3) * t + 520 * t * t
                    let rect = CGRect(x: x, y: y, width: 7, height: 11)
                    ctx.opacity = max(0, 1 - t / 2.6)
                    var c = ctx
                    c.translateBy(x: rect.midX, y: rect.midY)
                    c.rotate(by: .radians(t * 8 * (r(4) - 0.5)))
                    c.fill(Path(roundedRect: CGRect(x: -3.5, y: -5.5, width: 7, height: 11), cornerRadius: 2), with: .color(colors[i % colors.count]))
                }
            }
        }
        .onChange(of: trigger) { _, _ in
            start = .now
            Task { try? await Task.sleep(for: .seconds(2.7)); start = nil }
        }
    }
}

// MARK: - Icône de l'app

struct AppIconPickerView: View {
    @EnvironmentObject var store: Store
    @State private var current: String? = UIApplication.shared.alternateIconName
    @State private var error: String?

    var body: some View {
        let unlocked = Set(Rewards.trophies(store).filter(\.unlocked).map(\.id))
        let free = Rewards.icons.filter { $0.trophyId == nil }
        let earned = Rewards.icons.filter { $0.trophyId.map(unlocked.contains) ?? false }
        let locked = Rewards.icons.filter { $0.trophyId.map { !unlocked.contains($0) } ?? false }
        SettingsScrollPage(title: String(localized: "Icône de l'app")) {
            SettingsSectionTitle(title: String(localized: "Classiques"))
            card(free, unlocked: true)
            if !earned.isEmpty {
                SettingsSectionTitle(title: String(localized: "Débloquées"))
                SettingsFootnote(text: String(localized: "Tu les as gagnées. Elles sont à toi pour toujours.")).padding(.top, -14).padding(.bottom, 10)
                card(earned, unlocked: true)
            }
            if !locked.isEmpty {
                SettingsSectionTitle(title: String(localized: "Paliers à atteindre"))
                SettingsFootnote(text: String(localized: "Chaque palier de MRR débloque une icône. Pas de raccourci.")).padding(.top, -14).padding(.bottom, 10)
                card(locked, unlocked: false)
            }
            if let error { SettingsFootnote(text: error) }
        }
    }

    private func card(_ icons: [RewardIcon], unlocked: Bool) -> some View {
        SettingsCard {
            ForEach(Array(icons.enumerated()), id: \.element.id) { i, icon in
                if i > 0 { SettingsRowDivider() }
                Button { select(icon) } label: {
                    HStack(spacing: 14) {
                        Image("IconPreview-\(icon.id)").resizable().frame(width: 60, height: 60)
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(MMColor.fg(0.12)) }
                            .saturation(unlocked ? 1 : 0).opacity(unlocked ? 1 : 0.45)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(icon.title).font(V2Font.system(size: 17, weight: .semibold)).foregroundStyle(MMColor.ink)
                            if !icon.requirement.isEmpty {
                                Text(icon.requirement).font(MMFont.system(13)).foregroundStyle(SettingsTheme.valueTint)
                            }
                        }
                        Spacer()
                        if !unlocked {
                            Image(systemName: "lock.fill").foregroundStyle(SettingsTheme.chevronTint)
                        } else if current == icon.alternateName {
                            Image(systemName: "checkmark").font(.system(size: 18, weight: .semibold)).foregroundStyle(MMColor.accent)
                        }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .contentShape(Rectangle())
                }
                .buttonStyle(SettingsRowPressStyle())
                .disabled(!unlocked)
            }
        }
    }

    private func select(_ icon: RewardIcon) {
        guard current != icon.alternateName else { return }
        UIApplication.shared.setAlternateIconName(icon.alternateName) { err in
            Task { @MainActor in
                if let err { error = err.localizedDescription } else { withAnimation(.snappy) { current = icon.alternateName } }
            }
        }
    }
}

// MARK: - Langue

/// Langue de l'app : celle de l'iPhone (Auto) ou forcée. iOS lit `AppleLanguages` au lancement,
/// le changement s'applique donc à la prochaine ouverture.
enum AppLanguage {
    static let options: [(String, String, String?)] = [("auto", String(localized: "Automatique"), nil), ("fr", "Français", nil), ("en", "English", nil)]
    static var current: String { (UserDefaults.standard.object(forKey: "mm.lang") as? String) ?? "auto" }
    static func set(_ v: String) {
        UserDefaults.standard.set(v, forKey: "mm.lang")
        if v == "auto" { UserDefaults.standard.removeObject(forKey: "AppleLanguages") }
        else { UserDefaults.standard.set([v], forKey: "AppleLanguages") }
    }
}
