import SwiftUI

struct LootyTheme: Equatable {
    struct Colors: Equatable {
        let canvas: Color
        let canvasElevated: Color
        let surface: Color
        let surfaceMuted: Color
        let surfaceLight: Color
        let pageLight: Color
        let field: Color
        let fieldLight: Color
        let brand: Color
        let success: Color
        let info: Color
        let warning: Color
        let danger: Color
        let textPrimary: Color
        let textSecondary: Color
        let textInverse: Color
        let textSecondaryInverse: Color
        let outlineSubtle: Color
        let outlineStrong: Color
        let outlineLight: Color
    }

    struct Spacing: Equatable {
        let xxxs: CGFloat
        let xxs: CGFloat
        let xs: CGFloat
        let sm: CGFloat
        let md: CGFloat
        let lg: CGFloat
        let xl: CGFloat
        let xxl: CGFloat
        let xxxl: CGFloat
    }

    struct Radius: Equatable {
        let sm: CGFloat
        let md: CGFloat
        let lg: CGFloat
        let xl: CGFloat
        let pill: CGFloat
    }

    struct Typography: Equatable {
        let display: Font
        let title: Font
        let titleCompact: Font
        let headline: Font
        let body: Font
        let bodyStrong: Font
        let caption: Font
        let micro: Font
    }

    struct Shadow: Equatable {
        let color: Color
        let radius: CGFloat
        let x: CGFloat
        let y: CGFloat
    }

    let colors: Colors
    let spacing: Spacing
    let radius: Radius
    let typography: Typography
    let shadow: Shadow

    static let `default` = LootyTheme(
        colors: Colors(
            canvas: Color(red: 0.02, green: 0.02, blue: 0.03),
            canvasElevated: Color(red: 0.06, green: 0.06, blue: 0.07),
            surface: Color(red: 0.10, green: 0.10, blue: 0.12),
            surfaceMuted: Color(red: 0.96, green: 0.84, blue: 0.25).opacity(0.10),
            surfaceLight: Color(red: 0.98, green: 0.97, blue: 0.91),
            pageLight: Color(red: 0.99, green: 0.98, blue: 0.94),
            field: Color(red: 0.96, green: 0.84, blue: 0.25).opacity(0.12),
            fieldLight: Color(red: 0.99, green: 0.98, blue: 0.95),
            brand: Color(red: 0.96, green: 0.84, blue: 0.25),
            success: Color(red: 0.95, green: 0.82, blue: 0.22),
            info: Color(red: 0.88, green: 0.72, blue: 0.18),
            warning: Color(red: 0.97, green: 0.76, blue: 0.24),
            danger: Color(red: 0.95, green: 0.46, blue: 0.46),
            textPrimary: .white,
            textSecondary: Color.white.opacity(0.70),
            textInverse: Color(red: 0.05, green: 0.05, blue: 0.06),
            textSecondaryInverse: Color(red: 0.45, green: 0.48, blue: 0.53),
            outlineSubtle: Color.white.opacity(0.08),
            outlineStrong: Color.white.opacity(0.18),
            outlineLight: Color.black.opacity(0.08)
        ),
        spacing: Spacing(
            xxxs: 4,
            xxs: 6,
            xs: 8,
            sm: 12,
            md: 16,
            lg: 20,
            xl: 24,
            xxl: 28,
            xxxl: 32
        ),
        radius: Radius(
            sm: 10,
            md: 14,
            lg: 18,
            xl: 24,
            pill: 999
        ),
        typography: Typography(
            display: .system(size: 34, weight: .bold, design: .rounded),
            title: .system(size: 24, weight: .bold, design: .rounded),
            titleCompact: .system(size: 20, weight: .bold, design: .rounded),
            headline: .system(size: 16, weight: .semibold),
            body: .system(size: 15),
            bodyStrong: .system(size: 15, weight: .semibold),
            caption: .system(size: 12, weight: .semibold),
            micro: .system(size: 11, weight: .bold)
        ),
        shadow: Shadow(
            color: Color.black.opacity(0.22),
            radius: 18,
            x: 0,
            y: 10
        )
    )
}

private struct LootyThemeKey: EnvironmentKey {
    static let defaultValue = LootyTheme.default
}

extension EnvironmentValues {
    var lootyTheme: LootyTheme {
        get { self[LootyThemeKey.self] }
        set { self[LootyThemeKey.self] = newValue }
    }
}

extension View {
    func lootyTheme(_ theme: LootyTheme) -> some View {
        environment(\.lootyTheme, theme)
    }
}
