import AuthenticationServices
import SwiftUI

struct SignInView: View {
    @ObservedObject var authStore: AuthStore
    @Environment(\.lootyTheme) private var theme

    private var configurationIssue: String? { authStore.configurationIssue }
    private var signInEnabled: Bool { authStore.isConfigured && !authStore.isBusy }

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    theme.colors.canvas,
                    theme.colors.canvasElevated,
                    theme.colors.surface
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: theme.spacing.xl) {
                    hero
                    credentialsCard
                    supportCard
                }
                .padding(.horizontal, theme.spacing.lg)
                .padding(.vertical, theme.spacing.xxxl)
            }
        }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: theme.spacing.sm) {
            Text("Spotlight account")
                .font(theme.typography.display)
                .foregroundStyle(theme.colors.textPrimary)

            Text("Keep your identity ready for shows, holds, and synced inventory without changing the scanner backend yet.")
                .font(theme.typography.body)
                .foregroundStyle(theme.colors.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var credentialsCard: some View {
        VStack(alignment: .leading, spacing: theme.spacing.lg) {
            LootySectionHeader(
                title: "Sign in",
                subtitle: "Apple is the primary iOS path. Google stays available as a secondary provider."
            )

            SignInWithAppleButton(.continue) { request in
                authStore.prepareAppleSignIn(request)
            } onCompletion: { result in
                Task {
                    await authStore.completeAppleSignIn(result)
                }
            }
            .signInWithAppleButtonStyle(.white)
            .frame(height: 56)
            .clipShape(RoundedRectangle(cornerRadius: theme.radius.md, style: .continuous))
            .disabled(signInEnabled == false)
            .opacity(signInEnabled ? 1 : 0.55)

            Button {
                Task {
                    await authStore.signInWithGoogle()
                }
            } label: {
                HStack(spacing: theme.spacing.sm) {
                    Image(systemName: "globe")
                        .font(.headline.weight(.bold))
                    Text("Continue with Google")
                }
            }
            .buttonStyle(
                LootyFilledButtonStyle(
                    fill: theme.colors.surfaceLight,
                    foreground: theme.colors.textInverse,
                    cornerRadius: theme.radius.md,
                    minHeight: 56
                )
            )
            .disabled(signInEnabled == false)
            .opacity(signInEnabled ? 1 : 0.55)

            if authStore.isBusy {
                HStack(spacing: theme.spacing.sm) {
                    ProgressView()
                        .tint(theme.colors.brand)
                    Text("Contacting Supabase…")
                        .font(theme.typography.body)
                        .foregroundStyle(theme.colors.textSecondary)
                }
            }

            if let configurationIssue {
                authMessage(configurationIssue, accent: theme.colors.warning)
            }

            if let errorMessage = authStore.errorMessage {
                authMessage(errorMessage, accent: theme.colors.danger)
            }
        }
        .lootySurface(.dark, padding: theme.spacing.lg, cornerRadius: theme.radius.xl)
    }

    private var supportCard: some View {
        VStack(alignment: .leading, spacing: theme.spacing.sm) {
            Text("Phase 1 behavior")
                .font(theme.typography.headline)
                .foregroundStyle(theme.colors.textPrimary)

            Text("Login now creates and restores a Supabase identity. Scanner, pricing, and collection APIs remain on the current Python backend until the next auth phase.")
                .font(theme.typography.body)
                .foregroundStyle(theme.colors.textSecondary)
        }
        .lootySurface(.muted, padding: theme.spacing.lg, cornerRadius: theme.radius.xl)
    }

    private func authMessage(_ message: String, accent: Color) -> some View {
        HStack(alignment: .top, spacing: theme.spacing.sm) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(accent)
                .font(.subheadline.weight(.bold))
            Text(message)
                .font(theme.typography.body)
                .foregroundStyle(theme.colors.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
