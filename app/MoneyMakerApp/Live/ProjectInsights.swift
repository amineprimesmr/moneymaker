//
//  ProjectInsights.swift
//  MoneyMaker — ce que l'Accueil ajoute quand un seul business est sélectionné.
//

import SwiftUI

struct ProjectInsights: View {
    @EnvironmentObject var store: Store
    let p: ProjectSummary
    @State private var apps: [TrackedAppSummary] = []
    @State private var events: [EventItem] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                if p.hasTrials ?? (p.activeTrials > 0) {
                    RateTile(title: "Conversion essai", value: p.trialConversionRate, color: MMColor.accent)
                }
                RateTile(title: "Churn", value: p.churnRate, color: MMColor.red)
            }
            if p.billingIssues > 0 {
                MMCard(padding: 16, radius: 22, glow: MMColor.orange) {
                    Label("\(p.billingIssues) problème(s) de paiement en cours", systemImage: "exclamationmark.triangle.fill")
                        .font(MMFont.system(14, .medium)).foregroundStyle(MMColor.orange)
                }
            }
            if !apps.isEmpty {
                MMLabel(text: "App Store").padding(.horizontal, 4).padding(.top, 8)
                ForEach(apps) { TrackedAppCard(app: $0) }
            }
            if !events.isEmpty {
                HStack {
                    MMLabel(text: "Activité")
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
            async let a = try? store.client.trackedApps(projectId: p.projectId)
            async let e = try? store.client.events(projectId: p.projectId)
            let (na, ne) = await (a, e)
            withAnimation(.easeOut(duration: 0.3)) {
                apps = (na ?? []).filter { $0.own != false }
                events = ne ?? []
            }
        }
    }
}
