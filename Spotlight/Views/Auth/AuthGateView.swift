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
            theme.colors.brand
                .ignoresSafeArea()

            VStack(spacing: theme.spacing.xs) {
                Text("Loading Loooty")
                    .font(theme.typography.titleCompact)
                    .foregroundStyle(theme.colors.textPrimary)

                Text("Please be patient, it'll be worth the wait!")
                    .font(theme.typography.body)
                    .foregroundStyle(theme.colors.textPrimary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, theme.spacing.lg)
        }
    }
}
