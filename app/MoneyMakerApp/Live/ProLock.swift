//
//  ProLock.swift
//  MoneyMaker — ce que Pro débloque : contenu flouté avec un accès direct au paywall, et carte Santé.
//

import SwiftUI

extension ProPaywall {
    /// Statut inconnu ou achat indisponible : rien n'est verrouillé.
    var locksContent: Bool { !Self.freeLaunch && (status.map { !$0.pro && $0.available } ?? false) }
}

private struct ProLock: ViewModifier {
    let title: LocalizedStringKey
    @ObservedObject private var paywall = ProPaywall.shared

    func body(content: Content) -> some View {
        if paywall.locksContent {
            content
                .blur(radius: 9)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
                .frame(minHeight: 120)
                .clipped()
                .overlay {
                    Button { paywall.isPresented = true } label: {
                        VStack(spacing: 8) {
                            Image(systemName: "lock.fill").font(.system(size: 16, weight: .semibold))
                            Text(title).font(MMFont.system(14, .semibold)).multilineTextAlignment(.center)
                            Text("Débloquer avec Pro").font(MMFont.system(12, .medium)).foregroundStyle(MMColor.ink2)
                        }
                        .foregroundStyle(MMColor.ink)
                        .padding(.horizontal, 20).padding(.vertical, 14)
                        .mmGlass(in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    }
                    .buttonStyle(MMPressStyle())
                }
        } else {
            content
        }
    }
}

extension View {
    func proLocked(_ title: LocalizedStringKey) -> some View { modifier(ProLock(title: title)) }
}

/// Santé d'un business : ce que rapporte un abonné, ce qu'on perd, ce qu'on convertit.
struct ProHealthCard: View {
    let p: ProjectSummary

    private var revenuePerSubscriber: String {
        p.activeSubscriptions > 0 ? (p.mrrMicros / p.activeSubscriptions).money(p.currency) : "—"
    }
    private var revenuePerPayer: String {
        guard let n = p.payingCustomers, n > 0 else { return "—" }
        return (p.shownRevenueMicros / n).money(p.currency)
    }
    private var installToPaid: Double? {
        guard let d = p.downloads, d > 0, let n = p.payingCustomers else { return nil }
        return Double(n) / Double(d)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            MMLabel(text: String(localized: "Santé")).padding(.horizontal, 4).padding(.top, 6)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible())], spacing: 12) {
                StatTile(icon: "person.fill", title: String(localized: "Revenu par abonné"), value: revenuePerSubscriber)
                StatTile(icon: "creditcard", title: String(localized: "Revenu par client"), value: revenuePerPayer)
                RateTile(title: String(localized: "Churn"), value: p.churnRate, color: MMColor.red)
                RateTile(title: String(localized: "Conversion essai"), value: p.trialConversionRate, color: MMColor.accent)
                if let installToPaid {
                    RateTile(title: String(localized: "Installation → payant"), value: installToPaid, color: MMColor.blue)
                }
            }
        }
        .proLocked("Revenu par abonné, churn et conversion")
    }
}
