import SwiftUI

enum SellModalLayout {
    static let modalCornerRadius: CGFloat = 32
    static let formCardCornerRadius: CGFloat = 28
    static let heroBackdropHeight: CGFloat = 320
    static let heroArtworkSize = CGSize(width: 106, height: 148)
    static let heroArtworkCornerRadius: CGFloat = 18
    static let compactFieldHeight: CGFloat = 32
    static let compactFieldCornerRadius: CGFloat = 12
    static let compactFieldWidth: CGFloat = 120
    static let quantityControlSize: CGFloat = 24
    static let swipeRailHeight: CGFloat = 47
    static let bottomPromptHeight: CGFloat = 64
    static let grabberSize = CGSize(width: 40, height: 4)
}

struct SellModalHeroStage<Background: View, Foreground: View>: View {
    @Environment(\.lootyTheme) private var theme

    let height: CGFloat
    let blurRadius: CGFloat
    let backgroundScale: CGFloat
    let foregroundAlignment: Alignment
    let background: Background
    let foreground: Foreground

    init(
        height: CGFloat = SellModalLayout.heroBackdropHeight,
        blurRadius: CGFloat = 28,
        backgroundScale: CGFloat = 1.16,
        foregroundAlignment: Alignment = .top,
        @ViewBuilder background: () -> Background,
        @ViewBuilder foreground: () -> Foreground
    ) {
        self.height = height
        self.blurRadius = blurRadius
        self.backgroundScale = backgroundScale
        self.foregroundAlignment = foregroundAlignment
        self.background = background()
        self.foreground = foreground()
    }

    var body: some View {
        ZStack(alignment: foregroundAlignment) {
            background
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .scaleEffect(backgroundScale, anchor: .top)
                .blur(radius: blurRadius)
                .overlay {
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.08),
                            Color.white.opacity(0.22),
                            theme.colors.pageLight.opacity(0.82),
                            theme.colors.pageLight
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                }
                .clipped()

            foreground
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .clipShape(RoundedRectangle(cornerRadius: SellModalLayout.modalCornerRadius, style: .continuous))
    }
}

struct SellModalGrabber: View {
    @Environment(\.lootyTheme) private var theme

    var body: some View {
        Capsule(style: .continuous)
            .fill(theme.colors.textPrimary.opacity(0.14))
            .frame(
                width: SellModalLayout.grabberSize.width,
                height: SellModalLayout.grabberSize.height
            )
    }
}

struct SellModalHeaderBar<Leading: View, Trailing: View>: View {
    @Environment(\.lootyTheme) private var theme

    let title: String
    let showsGrabber: Bool
    let leading: Leading
    let trailing: Trailing

    init(
        title: String,
        showsGrabber: Bool = true,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.title = title
        self.showsGrabber = showsGrabber
        self.leading = leading()
        self.trailing = trailing()
    }

    var body: some View {
        VStack(spacing: 8) {
            if showsGrabber {
                SellModalGrabber()
            }

            ZStack {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(theme.colors.textPrimary)
                    .lineLimit(1)

                HStack(spacing: 12) {
                    leading
                    Spacer(minLength: 12)
                    trailing
                }
            }
            .frame(minHeight: 20)
        }
    }
}

extension SellModalHeaderBar where Leading == EmptyView {
    init(
        title: String,
        showsGrabber: Bool = true,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.init(title: title, showsGrabber: showsGrabber, leading: { EmptyView() }, trailing: trailing)
    }
}

extension SellModalHeaderBar where Trailing == EmptyView {
    init(
        title: String,
        showsGrabber: Bool = true,
        @ViewBuilder leading: () -> Leading
    ) {
        self.init(title: title, showsGrabber: showsGrabber, leading: leading, trailing: { EmptyView() })
    }
}

extension SellModalHeaderBar where Leading == EmptyView, Trailing == EmptyView {
    init(title: String, showsGrabber: Bool = true) {
        self.init(title: title, showsGrabber: showsGrabber, leading: { EmptyView() }, trailing: { EmptyView() })
    }
}

struct SellModalHeroArtworkPlate<Content: View>: View {
    @Environment(\.lootyTheme) private var theme

    let size: CGSize
    let content: Content

    init(
        size: CGSize = SellModalLayout.heroArtworkSize,
        @ViewBuilder content: () -> Content
    ) {
        self.size = size
        self.content = content()
    }

    var body: some View {
        content
            .frame(width: size.width, height: size.height)
            .background(theme.colors.surfaceLight)
            .clipShape(
                RoundedRectangle(
                    cornerRadius: SellModalLayout.heroArtworkCornerRadius,
                    style: .continuous
                )
            )
            .overlay(
                RoundedRectangle(
                    cornerRadius: SellModalLayout.heroArtworkCornerRadius,
                    style: .continuous
                )
                .stroke(theme.colors.outlineSubtle.opacity(0.95), lineWidth: 1)
            )
            .shadow(color: theme.shadow.color.opacity(0.52), radius: 24, x: 0, y: 14)
    }
}

struct SellModalHeroTitleBlock: View {
    @Environment(\.lootyTheme) private var theme

    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 5) {
            Text(title)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(theme.colors.textPrimary)
                .multilineTextAlignment(.center)
                .lineLimit(2)

            Text(subtitle)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(theme.colors.textSecondary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
        }
    }
}

struct SellModalHeaderBadge: View {
    @Environment(\.lootyTheme) private var theme

    let title: String
    let systemName: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: systemName)
                .font(.system(size: 11, weight: .semibold))

            Text(title)
                .font(.system(size: 12, weight: .semibold))
        }
        .foregroundStyle(theme.colors.textPrimary.opacity(0.9))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
            Capsule(style: .continuous)
                .fill(theme.colors.surfaceLight.opacity(0.88))
        )
        .overlay(
            Capsule(style: .continuous)
                .stroke(theme.colors.outlineSubtle, lineWidth: 1)
        )
    }
}

struct SellModalFormCard<Content: View>: View {
    @Environment(\.lootyTheme) private var theme

    let padding: CGFloat
    let content: Content

    init(
        padding: CGFloat = 16,
        @ViewBuilder content: () -> Content
    ) {
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        content
            .padding(padding)
            .background(
                RoundedRectangle(
                    cornerRadius: SellModalLayout.formCardCornerRadius,
                    style: .continuous
                )
                .fill(theme.colors.surfaceLight.opacity(0.98))
                .shadow(color: theme.shadow.color.opacity(0.28), radius: 20, x: 0, y: 10)
            )
            .overlay(
                RoundedRectangle(
                    cornerRadius: SellModalLayout.formCardCornerRadius,
                    style: .continuous
                )
                .stroke(theme.colors.outlineSubtle.opacity(0.95), lineWidth: 1)
            )
    }
}

struct SellModalDivider: View {
    @Environment(\.lootyTheme) private var theme

    var opacity: Double = 1

    var body: some View {
        Rectangle()
            .fill(theme.colors.outlineSubtle.opacity(opacity))
            .frame(height: 1)
    }
}

struct SellModalFieldRow<Trailing: View>: View {
    @Environment(\.lootyTheme) private var theme

    let label: String
    let verticalPadding: CGFloat
    let trailing: Trailing

    init(
        _ label: String,
        verticalPadding: CGFloat = 0,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.label = label
        self.verticalPadding = verticalPadding
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 12) {
            Text(label)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(theme.colors.textPrimary)

            Spacer(minLength: 12)

            trailing
        }
        .padding(.vertical, verticalPadding)
    }
}

struct SellModalLabeledValueRow: View {
    @Environment(\.lootyTheme) private var theme

    let label: String
    let value: String
    var systemName: String? = nil
    var accent: Color? = nil

    var body: some View {
        SellModalFieldRow(label) {
            HStack(spacing: 6) {
                Text(value)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(accent ?? theme.colors.textPrimary)
                    .monospacedDigit()

                if let systemName {
                    Image(systemName: systemName)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(theme.colors.textSecondary)
                }
            }
        }
    }
}

struct SellModalTrailingIconRow: View {
    @Environment(\.lootyTheme) private var theme

    let label: String
    let systemName: String
    var trailingText: String? = nil

    var body: some View {
        SellModalFieldRow(label) {
            HStack(spacing: 6) {
                if let trailingText, trailingText.isEmpty == false {
                    Text(trailingText)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(theme.colors.textPrimary)
                }

                Image(systemName: systemName)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(theme.colors.textSecondary)
            }
        }
    }
}

struct SellModalCompactFieldShell<Content: View>: View {
    @Environment(\.lootyTheme) private var theme

    let width: CGFloat?
    let height: CGFloat
    let alignment: Alignment
    let isHighlighted: Bool
    let content: Content

    init(
        width: CGFloat? = SellModalLayout.compactFieldWidth,
        height: CGFloat = SellModalLayout.compactFieldHeight,
        alignment: Alignment = .trailing,
        isHighlighted: Bool = false,
        @ViewBuilder content: () -> Content
    ) {
        self.width = width
        self.height = height
        self.alignment = alignment
        self.isHighlighted = isHighlighted
        self.content = content()
    }

    private var strokeColor: Color {
        isHighlighted ? theme.colors.danger : theme.colors.outlineSubtle
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment)
            .padding(.horizontal, 12)
            .frame(width: width, height: height)
            .background(
                RoundedRectangle(
                    cornerRadius: SellModalLayout.compactFieldCornerRadius,
                    style: .continuous
                )
                .fill(theme.colors.canvasElevated.opacity(0.98))
                .shadow(color: theme.shadow.color.opacity(0.12), radius: 6, x: 0, y: 2)
            )
            .overlay(
                RoundedRectangle(
                    cornerRadius: SellModalLayout.compactFieldCornerRadius,
                    style: .continuous
                )
                .stroke(strokeColor, lineWidth: isHighlighted ? 1.5 : 1)
            )
    }
}

struct SellModalCompactTextValue: View {
    @Environment(\.lootyTheme) private var theme

    let text: String
    var width: CGFloat? = SellModalLayout.compactFieldWidth
    var alignment: Alignment = .trailing
    var isHighlighted: Bool = false

    var body: some View {
        SellModalCompactFieldShell(
            width: width,
            alignment: alignment,
            isHighlighted: isHighlighted
        ) {
            Text(text)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(theme.colors.textPrimary)
                .monospacedDigit()
        }
    }
}

struct SellModalQuantityPillButton: View {
    @Environment(\.lootyTheme) private var theme

    let systemName: String
    let isDisabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(
                    isDisabled
                        ? theme.colors.textSecondary.opacity(0.35)
                        : theme.colors.textPrimary
                )
                .frame(
                    width: SellModalLayout.quantityControlSize,
                    height: SellModalLayout.quantityControlSize
                )
                .background(
                    Capsule(style: .continuous)
                        .fill(theme.colors.surface.opacity(isDisabled ? 0.4 : 0.92))
                )
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(theme.colors.outlineSubtle, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
    }
}

struct SellModalQuantityStepper: View {
    @Environment(\.lootyTheme) private var theme

    let value: String
    let canDecrement: Bool
    let canIncrement: Bool
    let onDecrement: () -> Void
    let onIncrement: () -> Void

    init(
        value: String,
        canDecrement: Bool = true,
        canIncrement: Bool = true,
        onDecrement: @escaping () -> Void,
        onIncrement: @escaping () -> Void
    ) {
        self.value = value
        self.canDecrement = canDecrement
        self.canIncrement = canIncrement
        self.onDecrement = onDecrement
        self.onIncrement = onIncrement
    }

    var body: some View {
        HStack(spacing: 11) {
            SellModalQuantityPillButton(
                systemName: "minus",
                isDisabled: !canDecrement,
                action: onDecrement
            )

            Text(value)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(theme.colors.textPrimary)
                .monospacedDigit()
                .frame(minWidth: 12)

            SellModalQuantityPillButton(
                systemName: "plus",
                isDisabled: !canIncrement,
                action: onIncrement
            )
        }
    }
}

struct SellModalSwipeCTAContainer: View {
    @Environment(\.lootyTheme) private var theme

    let title: String
    var subtitle: String? = nil
    var systemName: String = "chevron.up"
    var emphasis: CGFloat = 0

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(Color.white.opacity(0.26))

                Image(systemName: systemName)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(theme.colors.textPrimary)
            }
            .frame(width: 28, height: 28)

            VStack(alignment: .leading, spacing: subtitle == nil ? 0 : 2) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(theme.colors.textPrimary)

                if let subtitle, subtitle.isEmpty == false {
                    Text(subtitle)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(theme.colors.textPrimary.opacity(0.72))
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, minHeight: SellModalLayout.swipeRailHeight)
        .background(
            RoundedRectangle(
                cornerRadius: SellModalLayout.swipeRailHeight / 2,
                style: .continuous
            )
            .fill(theme.colors.brand)
            .shadow(color: theme.shadow.color.opacity(0.18), radius: 12, x: 0, y: 8)
        )
        .overlay(
            RoundedRectangle(
                cornerRadius: SellModalLayout.swipeRailHeight / 2,
                style: .continuous
            )
            .stroke(Color.white.opacity(0.32), lineWidth: 1)
        )
        .scaleEffect(1 + (emphasis * 0.015))
        .opacity(0.94 + min(max(emphasis, 0), 1) * 0.06)
    }
}

struct SellModalBottomPromptBar: View {
    @Environment(\.lootyTheme) private var theme

    let title: String
    var systemName: String = "chevron.up"

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: systemName)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(theme.colors.textPrimary)

            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(theme.colors.textPrimary)
        }
        .frame(maxWidth: .infinity, minHeight: SellModalLayout.bottomPromptHeight)
        .background(theme.colors.surfaceLight.opacity(0.98))
        .overlay(alignment: .top) {
            Rectangle()
                .fill(theme.colors.outlineSubtle)
                .frame(height: 1)
        }
    }
}
