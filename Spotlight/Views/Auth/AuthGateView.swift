import SwiftUI

struct AuthGateView<Content: View>: View {
    @ObservedObject var authStore: AuthStore
    @ViewBuilder let authenticatedContent: () -> Content

    var body: some View {
        switch authStore.state {
        case .loading:
            AuthLoadingView()
        case .signedOut:
            SignInView(authStore: authStore)
        case .needsProfile:
            ProfileOnboardingView(authStore: authStore, user: authStore.currentUser)
        case .signedIn:
            authenticatedContent()
        }
    }
}

private struct AuthLoadingView: View {
    @Environment(\.lootyTheme) private var theme

    var body: some View {
        ZStack {
            theme.colors.canvas
                .ignoresSafeArea()

            VStack(spacing: theme.spacing.lg) {
                ProgressView()
                    .tint(theme.colors.brand)
                    .scaleEffect(1.2)

                Text("Restoring your Spotlight account")
                    .font(theme.typography.headline)
                    .foregroundStyle(theme.colors.textPrimary)
            }
            .padding(theme.spacing.xxl)
            .lootySurface(.dark, padding: theme.spacing.xxl, cornerRadius: theme.radius.xl)
            .padding(theme.spacing.xl)
        }
    }
}
