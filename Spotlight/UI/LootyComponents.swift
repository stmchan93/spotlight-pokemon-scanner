import SwiftUI

enum LootySurfaceVariant {
    case dark
    case muted
    case light
}

private struct LootySurfaceModifier: ViewModifier {
    @Environment(\.lootyTheme) private var theme

    let variant: LootySurfaceVariant
    let padding: CGFloat
    let cornerRadius: CGFloat?
    let strokeOpacity: Double

    private var fillColor: Color {
        switch variant {
        case .dark:
            return theme.colors.canvasElevated
        case .muted:
            return theme.colors.surfaceMuted
        case .light:
            return theme.colors.surfaceLight
        }
    }

    private var resolvedCornerRadius: CGFloat {
        cornerRadius ?? theme.radius.lg
    }

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: resolvedCornerRadius, style: .continuous)
                    .fill(fillColor)
                    .overlay(
                        RoundedRectangle(cornerRadius: resolvedCornerRadius, style: .continuous)
                            .stroke(theme.colors.outlineSubtle.opacity(strokeOpacity), lineWidth: 1)
                    )
            )
    }
}

extension View {
    func lootySurface(
        _ variant: LootySurfaceVariant = .dark,
        padding: CGFloat = 16,
        cornerRadius: CGFloat? = nil,
        strokeOpacity: Double = 1
    ) -> some View {
        modifier(
            LootySurfaceModifier(
                variant: variant,
                padding: padding,
                cornerRadius: cornerRadius,
                strokeOpacity: strokeOpacity
            )
        )
    }
}

struct LootyPrimaryButtonStyle: ButtonStyle {
    @Environment(\.lootyTheme) private var theme

    func makeBody(configuration: Configuration) -> some View {
        LootyFilledButtonBody(
            configuration: configuration,
            fill: theme.colors.brand,
            foreground: theme.colors.textInverse,
            cornerRadius: theme.radius.md,
            minHeight: nil
        )
    }
}

struct LootySecondaryButtonStyle: ButtonStyle {
    @Environment(\.lootyTheme) private var theme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(theme.typography.headline)
            .foregroundStyle(theme.colors.textPrimary.opacity(configuration.isPressed ? 0.78 : 1))
            .padding(.horizontal, theme.spacing.lg)
            .padding(.vertical, theme.spacing.sm)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: theme.radius.md, style: .continuous)
                    .fill(theme.colors.surfaceMuted.opacity(configuration.isPressed ? 0.84 : 1))
                    .overlay(
                        RoundedRectangle(cornerRadius: theme.radius.md, style: .continuous)
                            .stroke(theme.colors.outlineSubtle, lineWidth: 1)
                    )
            )
            .scaleEffect(configuration.isPressed ? 0.99 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

struct LootyFilledButtonStyle: ButtonStyle {
    let fill: Color
    let foreground: Color
    var cornerRadius: CGFloat = 14
    var minHeight: CGFloat? = nil

    func makeBody(configuration: Configuration) -> some View {
        LootyFilledButtonBody(
            configuration: configuration,
            fill: fill,
            foreground: foreground,
            cornerRadius: cornerRadius,
            minHeight: minHeight
        )
    }
}

private struct LootyFilledButtonBody: View {
    @Environment(\.lootyTheme) private var theme

    let configuration: ButtonStyleConfiguration
    let fill: Color
    let foreground: Color
    let cornerRadius: CGFloat
    let minHeight: CGFloat?

    var body: some View {
        configuration.label
            .font(theme.typography.headline)
            .foregroundStyle(foreground.opacity(configuration.isPressed ? 0.82 : 1))
            .padding(.horizontal, theme.spacing.lg)
            .padding(.vertical, theme.spacing.sm)
            .frame(maxWidth: .infinity, minHeight: minHeight)
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(fill.opacity(configuration.isPressed ? 0.84 : 1))
            )
            .scaleEffect(configuration.isPressed ? 0.99 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

struct LootySectionHeader: View {
    @Environment(\.lootyTheme) private var theme

    let title: String
    var subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: theme.spacing.xxxs) {
            Text(title)
                .font(theme.typography.titleCompact)
                .foregroundStyle(theme.colors.textPrimary)

            if let subtitle, subtitle.isEmpty == false {
                Text(subtitle)
                    .font(theme.typography.body)
                    .foregroundStyle(theme.colors.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct LootyPill: View {
    @Environment(\.lootyTheme) private var theme

    let title: String
    var isSelected: Bool = false
    var fill: Color? = nil
    var foreground: Color? = nil
    var stroke: Color? = nil
    var font: Font? = nil

    var body: some View {
        Text(title)
            .font(font ?? theme.typography.caption)
            .foregroundStyle(foreground ?? (isSelected ? theme.colors.textInverse : theme.colors.textPrimary))
            .padding(.horizontal, theme.spacing.sm)
            .padding(.vertical, theme.spacing.xs)
            .background(
                Capsule(style: .continuous)
                    .fill(fill ?? (isSelected ? theme.colors.brand : theme.colors.surfaceMuted))
            )
            .overlay(
                Capsule(style: .continuous)
                    .stroke(stroke ?? theme.colors.outlineSubtle, lineWidth: isSelected ? 0 : 1)
            )
    }
}
