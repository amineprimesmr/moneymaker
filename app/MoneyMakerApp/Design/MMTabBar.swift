//
//  MMTabBar.swift
//  MoneyMaker — tab bar flottante Liquid Glass, reprise de V2 (Design/LiquidGlassTabBar.swift).
//
//  Capsule de verre flottante : l'onglet sélectionné s'élargit en pilule
//  blanche (icône + libellé), les autres restent des icônes seules. Verre
//  natif iOS 26 (`glassEffect`), repli `.ultraThinMaterial` avant.
//

import SwiftUI

enum MMTabBarMetrics {
    /// Contenu 52 + padding capsule 12 + marge basse — à réserver sous le contenu défilant.
    static let clearance: CGFloat = 84
}

struct MMTabBar: View {
    struct Item: Identifiable, Equatable {
        let tag: Int
        let title: String
        let icon: String
        var id: Int { tag }
    }

    @Binding var selection: Int
    let items: [Item]
    var onReselect: (Int) -> Void = { _ in }

    @Namespace private var pillNamespace

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items) { tabButton(for: $0) }
        }
        .padding(6)
        .modifier(GlassCapsuleBackground())
        .padding(.horizontal, 24)
        .sensoryFeedback(.selection, trigger: selection)
    }

    private func tabButton(for item: Item) -> some View {
        let isSelected = selection == item.tag
        return Button {
            guard selection != item.tag else { onReselect(item.tag); return }
            withAnimation(.snappy(duration: 0.35, extraBounce: 0.08)) { selection = item.tag }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: item.icon)
                    .font(.system(size: 20, weight: .semibold))
                    .contentTransition(.symbolEffect(.replace))
                if isSelected {
                    Text(item.title)
                        .font(MMFont.system(17, .semibold))
                        .fixedSize()
                        .contentTransition(.opacity)
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, isSelected ? 20 : 16)
            .frame(height: 52)
            .foregroundStyle(isSelected ? AnyShapeStyle(Color.black) : AnyShapeStyle(Color.white.opacity(0.55)))
            .background {
                if isSelected {
                    Capsule()
                        .fill(Color.white)
                        .shadow(color: .black.opacity(0.18), radius: 6, y: 2)
                        .matchedGeometryEffect(id: "selection.pill", in: pillNamespace)
                }
            }
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.title)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

/// Verre Liquid Glass natif sur iOS 26+, matériau translucide avant.
private struct GlassCapsuleBackground: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: .capsule)
        } else {
            content
                .background(.ultraThinMaterial, in: .capsule)
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.15), lineWidth: 0.5))
        }
    }
}
