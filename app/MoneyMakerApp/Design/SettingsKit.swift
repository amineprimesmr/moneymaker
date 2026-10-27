import SwiftUI

// Repris 1:1 de V2 (V2/Features/Settings/SettingsDesignSystem.swift) : cartes de 28 pt,
// lignes à icône, titres de section, pression douce, pied de version. Fond toujours sombre.

enum SettingsTheme {
    static let cardCornerRadius: CGFloat = 28
    static let horizontalPadding: CGFloat = 16
    static let sectionHeaderTop: CGFloat = 18
    static let sectionHeaderBottom: CGFloat = 10
    static let rowVerticalPadding: CGFloat = 9
    static let rowMinHeight: CGFloat = 46
    static let accountRowMinHeight: CGFloat = 50
    static let iconColumnWidth: CGFloat = 26
    static let dividerLeadingInset: CGFloat = horizontalPadding + iconColumnWidth + 12
    static let spring = Animation.spring(response: 0.28, dampingFraction: 0.9, blendDuration: 0.06)

    static let cardFill = MMColor.cardFill
    static let cardBorder = MMColor.cardBorder
    static let iconTint = MMColor.fg(0.82)
    static let valueTint = MMColor.fg(0.48)
    static let chevronTint = MMColor.fg(0.32)
    static let sectionTitleTint = MMColor.fg(0.92)
}

struct SettingsRowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.68 : 1)
            .scaleEffect(configuration.isPressed ? 0.988 : 1, anchor: .center)
            .animation(SettingsTheme.spring, value: configuration.isPressed)
    }
}

extension View {
    func settingsRowButton() -> some View { buttonStyle(SettingsRowPressStyle()) }
}

struct SettingsSectionTitle: View {
    let title: String
    var footer: String? = nil
    var body: some View {
        Text(title)
            .font(V2Font.system(size: 16.5, weight: .bold))
            .foregroundStyle(SettingsTheme.sectionTitleTint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, SettingsTheme.horizontalPadding + 4)
            .padding(.top, SettingsTheme.sectionHeaderTop)
            .padding(.bottom, SettingsTheme.sectionHeaderBottom)
    }
}

/// Note sous une carte (comme les explications grises de RevenueCat).
struct SettingsFootnote: View {
    let text: String
    var body: some View {
        Text(text)
            .font(V2Font.system(size: 13))
            .foregroundStyle(SettingsTheme.valueTint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, SettingsTheme.horizontalPadding + 4)
            .padding(.top, 8)
    }
}

struct SettingsCard<Content: View>: View {
    @ViewBuilder let content: () -> Content
    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: SettingsTheme.cardCornerRadius, style: .continuous) }
    var body: some View {
        VStack(spacing: 0) { content() }
            .clipShape(shape)
            // Ombre portée par la seule forme du fond (même rendu : blanc opaque en clair, ombre
            // transparente en sombre) au lieu de tout le contenu : plus de passe hors écran par carte.
            .background {
                shape.fill(SettingsTheme.cardFill)
                    .shadow(color: MMColor.cardShadow, radius: 12, y: 4)
                    .overlay { shape.strokeBorder(SettingsTheme.cardBorder, lineWidth: 0.5) }
            }
            .padding(.horizontal, SettingsTheme.horizontalPadding)
    }
}

struct SettingsRowDivider: View {
    var body: some View {
        HStack(spacing: 0) {
            Spacer().frame(width: SettingsTheme.dividerLeadingInset)
            Rectangle().fill(MMColor.fg(0.10)).frame(height: 1 / 3)
        }
    }
}

enum SettingsRowTrailing {
    case chevron, external, none
    case status(String)
    case badge(String, Color)
}

struct SettingsRow: View {
    let icon: String?
    let title: String
    var trailing: SettingsRowTrailing = .chevron
    var iconTint: Color = SettingsTheme.iconTint

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            if let icon {
                Image(systemName: icon)
                    .font(V2Font.system(size: 17, weight: .medium))
                    .foregroundStyle(iconTint)
                    .frame(width: SettingsTheme.iconColumnWidth, alignment: .center)
            }
            Text(title)
                .font(V2Font.system(size: 16, weight: .regular))
                .foregroundStyle(MMColor.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
            trailingView
        }
        .frame(minHeight: SettingsTheme.rowMinHeight, alignment: .center)
        .padding(.horizontal, SettingsTheme.horizontalPadding)
        .padding(.vertical, SettingsTheme.rowVerticalPadding)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var trailingView: some View {
        switch trailing {
        case .chevron:
            Image(systemName: "chevron.right").font(V2Font.system(size: 13, weight: .semibold)).foregroundStyle(SettingsTheme.chevronTint)
        case .external:
            Image(systemName: "arrow.up.right").font(V2Font.system(size: 14, weight: .semibold)).foregroundStyle(SettingsTheme.chevronTint)
        case .none:
            EmptyView()
        case .status(let text):
            HStack(spacing: 6) {
                Text(text).font(V2Font.system(size: 16)).foregroundStyle(SettingsTheme.valueTint).lineLimit(1)
                Image(systemName: "chevron.right").font(V2Font.system(size: 13, weight: .semibold)).foregroundStyle(SettingsTheme.chevronTint)
            }
        case .badge(let text, let color):
            HStack(spacing: 8) {
                Text(text).font(.system(size: 11, weight: .bold)).foregroundStyle(.black)
                    .padding(.horizontal, 8).padding(.vertical, 3).background(color, in: Capsule())
                Image(systemName: "chevron.right").font(V2Font.system(size: 13, weight: .semibold)).foregroundStyle(SettingsTheme.chevronTint)
            }
        }
    }
}

/// Ligne à interrupteur.
struct SettingsToggleRow: View {
    let icon: String
    let title: String
    @Binding var isOn: Bool
    var body: some View {
        Toggle(isOn: $isOn) { SettingsRow(icon: icon, title: title, trailing: .none).padding(.trailing, -16) }
            .padding(.trailing, SettingsTheme.horizontalPadding)
            .tint(MMColor.accent)
            .sensoryFeedback(.selection, trigger: isOn)
    }
}

/// Ligne à menu déroulant (valeur + chevrons haut/bas, comme RevenueCat).
struct SettingsMenuRow<T: Hashable>: View {
    let icon: String
    let title: String
    let options: [(T, String, String?)]
    @Binding var selection: T
    var body: some View {
        Menu {
            Picker(title, selection: $selection) {
                ForEach(options, id: \.0) { value, label, sub in
                    if let sub { Text(label).tag(value); Text(sub) } else { Text(label).tag(value) }
                }
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon).font(V2Font.system(size: 17, weight: .medium)).foregroundStyle(SettingsTheme.iconTint)
                    .frame(width: SettingsTheme.iconColumnWidth)
                Text(title).font(V2Font.system(size: 16)).foregroundStyle(MMColor.ink).frame(maxWidth: .infinity, alignment: .leading)
                Text(options.first { $0.0 == selection }?.1 ?? "").font(V2Font.system(size: 16)).foregroundStyle(SettingsTheme.valueTint)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(SettingsTheme.chevronTint)
            }
            .frame(minHeight: SettingsTheme.rowMinHeight)
            .padding(.horizontal, SettingsTheme.horizontalPadding)
            .padding(.vertical, SettingsTheme.rowVerticalPadding)
            .contentShape(Rectangle())
        }
        .sensoryFeedback(.selection, trigger: selection)
    }
}

struct SettingsDestructiveButton: View {
    let title: String
    let icon: String
    let action: () -> Void
    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: SettingsTheme.cardCornerRadius, style: .continuous) }
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon).font(V2Font.system(size: 16, weight: .semibold))
                Text(title).font(V2Font.system(size: 17, weight: .semibold))
            }
            .foregroundStyle(Color.red)
            .frame(maxWidth: .infinity).frame(height: 48)
            .background { shape.strokeBorder(Color.red.opacity(0.55), lineWidth: 1).background(shape.fill(Color.red.opacity(0.10))) }
            .contentShape(shape)
        }
        .buttonStyle(SettingsRowPressStyle())
        .padding(.horizontal, SettingsTheme.horizontalPadding)
    }
}

struct SettingsVersionFooter: View {
    var suffix: String = ""
    var body: some View {
        VStack(spacing: 10) {
            Image("IconPreview-Classic").resizable().frame(width: 44, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous)).opacity(0.7)
            Text("MoneyMaker \(version) (\(build))\(suffix)")
                .font(V2Font.system(size: 13)).foregroundStyle(SettingsTheme.valueTint.opacity(0.85))
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 28).padding(.bottom, 8)
    }
    private var version: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—" }
    private var build: String { Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "—" }
}

/// Page de réglages : défilement, titre en ligne, fond noir.
struct SettingsScrollPage<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content
    var body: some View {
        ScrollView {
            VStack(spacing: 0) { content() }.padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        .background(MMColor.bg.ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
    }
}
