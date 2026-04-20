import SwiftUI

struct AccountView: View {
    @ObservedObject var authStore: AuthStore

    @Environment(\.dismiss) private var dismiss
    @Environment(\.lootyTheme) private var theme

    private var user: AppUser? { authStore.currentUser }

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: theme.spacing.lg) {
                    identityCard
                    signOutCard
                }
                .padding(.horizontal, theme.spacing.xs)
                .padding(.vertical, theme.spacing.lg)
            }
            .background(theme.colors.canvas.ignoresSafeArea())
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                    .foregroundStyle(theme.colors.textPrimary)
                }
            }
        }
    }

    private var identityCard: some View {
        VStack(alignment: .leading, spacing: theme.spacing.lg) {
            HStack(spacing: theme.spacing.md) {
                Circle()
                    .fill(theme.colors.brand)
                    .frame(width: 56, height: 56)
                    .overlay(
                        Text(user?.initials ?? "?")
                            .font(theme.typography.headline)
                            .foregroundStyle(theme.colors.textInverse)
                    )

                VStack(alignment: .leading, spacing: theme.spacing.xxxs) {
                    Text(user?.resolvedDisplayName ?? "Collector")
                        .font(theme.typography.titleCompact)
                        .foregroundStyle(theme.colors.textPrimary)

                    if let email = user?.email, email.isEmpty == false {
                        Text(email)
                            .font(theme.typography.body)
                            .foregroundStyle(theme.colors.textSecondary)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .lootySurface(.dark, padding: theme.spacing.lg, cornerRadius: theme.radius.xl)
    }

    private var signOutCard: some View {
        Button {
            dismiss()
            Task {
                await authStore.signOut()
            }
        } label: {
            HStack {
                if authStore.isBusy {
                    ProgressView()
                        .tint(theme.colors.textPrimary)
                }
                Text("Sign out")
            }
        }
        .buttonStyle(
            LootyFilledButtonStyle(
                fill: theme.colors.danger,
                foreground: theme.colors.textPrimary,
                cornerRadius: theme.radius.md,
                minHeight: 52
            )
        )
        .disabled(authStore.isBusy)
    }
}
