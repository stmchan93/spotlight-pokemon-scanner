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
            canvas: Color(red: 0.99, green: 0.99, blue: 0.98),
            canvasElevated: Color.white,
            surface: Color(red: 0.96, green: 0.96, blue: 0.94),
            surfaceMuted: Color(red: 0.98, green: 0.90, blue: 0.34).opacity(0.18),
            surfaceLight: Color.white,
            pageLight: Color(red: 0.99, green: 0.99, blue: 0.98),
            field: Color(red: 0.95, green: 0.95, blue: 0.93),
            fieldLight: Color.white,
            brand: Color(red: 0.96, green: 0.84, blue: 0.25),
            success: Color(red: 0.96, green: 0.84, blue: 0.25),
            info: Color(red: 0.90, green: 0.75, blue: 0.20),
            warning: Color(red: 0.97, green: 0.76, blue: 0.24),
            danger: Color(red: 0.95, green: 0.46, blue: 0.46),
            textPrimary: Color(red: 0.06, green: 0.06, blue: 0.07),
            textSecondary: Color(red: 0.30, green: 0.31, blue: 0.34),
            textInverse: Color(red: 0.06, green: 0.06, blue: 0.07),
            textSecondaryInverse: Color(red: 0.30, green: 0.31, blue: 0.34),
            outlineSubtle: Color.black.opacity(0.08),
            outlineStrong: Color.black.opacity(0.16),
            outlineLight: Color.black.opacity(0.08)
        ),
        spacing: Spacing(
            xxxs: 4,
            xxs: 8,
            xs: 12,
            sm: 16,
            md: 20,
            lg: 24,
            xl: 28,
            xxl: 32,
            xxxl: 40
        ),
        radius: Radius(
            sm: 8,
            md: 12,
            lg: 16,
            xl: 20,
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
            color: Color.black.opacity(0.08),
            radius: 12,
            x: 0,
            y: 6
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
