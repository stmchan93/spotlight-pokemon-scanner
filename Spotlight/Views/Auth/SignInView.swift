import AuthenticationServices
import SwiftUI

struct SignInView: View {
    @ObservedObject var authStore: AuthStore
    @Environment(\.lootyTheme) private var theme

    private var configurationIssue: String? { authStore.configurationIssue }
    private var signInEnabled: Bool { authStore.isConfigured && !authStore.isBusy }

    var body: some View {
        ZStack {
            theme.colors.canvas
                .ignoresSafeArea()

            VStack {
                Spacer()
                signInStack
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .padding(.horizontal, theme.spacing.lg)
            .padding(.bottom, theme.spacing.xxl)
        }
    }

    private var signInStack: some View {
        VStack(spacing: theme.spacing.sm) {
            Text("Sign into Loooty")
                .font(theme.typography.title)
                .foregroundStyle(theme.colors.textPrimary)
                .frame(maxWidth: .infinity, alignment: .center)

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
                Text("Continue with Google")
            }
            .buttonStyle(
                LootyFilledButtonStyle(
                    fill: theme.colors.brand,
                    foreground: theme.colors.textInverse,
                    cornerRadius: theme.radius.md,
                    minHeight: 56
                )
            )
            .disabled(signInEnabled == false)
            .opacity(signInEnabled ? 1 : 0.55)

            if let configurationIssue {
                authMessage(configurationIssue, accent: theme.colors.warning)
            }

            if let errorMessage = authStore.errorMessage {
                authMessage(errorMessage, accent: theme.colors.danger)
            }
        }
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
        .frame(maxWidth: .infinity, alignment: .center)
    }
}
