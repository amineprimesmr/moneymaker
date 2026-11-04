//
//  ProjectInsights.swift
//  MoneyMaker — ce que l'Accueil ajoute quand un seul business est sélectionné.
//

import SwiftUI

struct ProjectInsights: View {
    @EnvironmentObject var store: Store
    let p: ProjectSummary
    @State private var events: [EventItem] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ProHealthCard(p: p)
            if p.billingIssues > 0 {
                MMCard(padding: 16, radius: 22, glow: MMColor.orange) {
                    Label("\(p.billingIssues) problème(s) de paiement en cours", systemImage: "exclamationmark.triangle.fill")
                        .font(MMFont.system(14, .medium)).foregroundStyle(MMColor.orange)
                }
            }
            GrowthSections(p: p).proLocked("Graphiques, prévision LTV et anomalies")
            if !events.isEmpty {
                HStack {
                    MMLabel(text: String(localized: "Activité"))
                    NavigationLink(value: p) {
                        Text("Tout voir").font(MMFont.system(12, .medium)).foregroundStyle(MMColor.ink2)
                    }
                }
                .padding(.horizontal, 4).padding(.top, 8)
                MMCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(Array(events.prefix(5).enumerated()), id: \.element.id) { i, e in
                            EventRow(e: e, isLast: i == min(events.count, 5) - 1)
                        }
                    }
                    .padding(.vertical, 8)
                }
            }
        }
        .task(id: p.projectId) {
            let ne = try? await store.client.events(projectId: p.projectId)
            withAnimation(.easeOut(duration: 0.3)) { events = ne ?? [] }
        }
    }
}
