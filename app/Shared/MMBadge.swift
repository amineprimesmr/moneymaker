//
//  MMBadge.swift
//  MoneyMaker — badge du type de transaction (ONE TIME, NEW SUB, TRIAL…) : libellé et couleur,
//  source unique pour l'app et les widgets.
//

import SwiftUI

extension FeedEvent {
    struct Badge { let label: String; let color: Color; var free = false }
    /// Type de transaction, comme les badges des transactions RevenueCat.
    var badge: Badge {
        let purple = Color(red: 0.72, green: 0.55, blue: 1), blue = Color(red: 0.45, green: 0.58, blue: 1)
        let green = Color(red: 0.2, green: 0.85, blue: 0.5), teal = Color(red: 0.3, green: 0.8, blue: 0.85)
        let orange = Color(red: 1, green: 0.62, blue: 0.25), red = Color(red: 1, green: 0.38, blue: 0.38), grey = MMColor.fg(0.6)
        switch type {
        case "NON_RENEWING_PURCHASE": return Badge(label: String(localized: "ONE TIME"), color: purple, free: true)
        case "INITIAL_PURCHASE": return isTrial == true ? Badge(label: String(localized: "TRIAL"), color: teal, free: true) : Badge(label: String(localized: "NEW SUB"), color: blue, free: true)
        case "TRIAL_STARTED": return Badge(label: String(localized: "TRIAL"), color: teal, free: true)
        case "TRIAL_CONVERTED": return Badge(label: String(localized: "CONVERSION"), color: green)
        case "RENEWAL": return Badge(label: String(localized: "RENEWAL"), color: green, free: true)
        case "UNCANCELLATION": return Badge(label: String(localized: "REACTIVATED"), color: green)
        case "BILLING_RECOVERED": return Badge(label: String(localized: "RECOVERED"), color: green)
        case "PRODUCT_CHANGE": return Badge(label: String(localized: "PLAN CHANGE"), color: blue)
        case "CANCELLATION": return Badge(label: String(localized: "CANCELLED"), color: orange)
        case "BILLING_ISSUE": return Badge(label: String(localized: "BILLING ISSUE"), color: orange)
        case "PAUSED": return Badge(label: String(localized: "PAUSED"), color: grey)
        case "EXPIRATION": return Badge(label: String(localized: "EXPIRED"), color: grey)
        case "REFUND", "REVOKED": return Badge(label: String(localized: "REFUND"), color: red)
        case "GRANT": return Badge(label: String(localized: "PROMO"), color: purple, free: true)
        default: return Badge(label: type.replacingOccurrences(of: "_", with: " "), color: grey)
        }
    }
}

/// Badge coloré du type de transaction (ONE TIME, NEW SUB, RENEWAL, TRIAL…).
struct TransactionBadge: View {
    let kind: FeedEvent.Badge
    var size: CGFloat = 10.5
    var body: some View {
        Text(kind.label)
            .font(.system(size: size, weight: .bold)).tracking(size * 0.076)
            .foregroundStyle(kind.color)
            .padding(.horizontal, size * 0.86).padding(.vertical, size * 0.38)
            .background(kind.color.opacity(0.16), in: Capsule())
            .lineLimit(1).fixedSize()
    }
}
