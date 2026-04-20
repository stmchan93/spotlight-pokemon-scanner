import SwiftUI

struct ProfileOnboardingView: View {
    @ObservedObject var authStore: AuthStore
    let user: AppUser?

    @Environment(\.lootyTheme) private var theme

    private var canContinue: Bool {
        authStore.profileDraftName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false && !authStore.isBusy
    }

    var body: some View {
        ZStack {
            theme.colors.canvas
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: theme.spacing.xl) {
                header
                formCard
            }
            .padding(theme.spacing.lg)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: theme.spacing.sm) {
            Text("Finish your profile")
                .font(theme.typography.display)
                .foregroundStyle(theme.colors.textPrimary)

            Text("Pick the display name other collectors and future marketplace buyers will see.")
                .font(theme.typography.body)
                .foregroundStyle(theme.colors.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var formCard: some View {
        VStack(alignment: .leading, spacing: theme.spacing.lg) {
            if let email = user?.email, email.isEmpty == false {
                VStack(alignment: .leading, spacing: theme.spacing.xxxs) {
                    Text("Signed in as")
                        .font(theme.typography.caption)
                        .foregroundStyle(theme.colors.textSecondary)
                    Text(email)
                        .font(theme.typography.bodyStrong)
                        .foregroundStyle(theme.colors.textPrimary)
                }
            }

            VStack(alignment: .leading, spacing: theme.spacing.xs) {
                Text("Display name")
                    .font(theme.typography.caption)
                    .foregroundStyle(theme.colors.textSecondary)

                TextField("Your name or table alias", text: $authStore.profileDraftName)
                    .textInputAutocapitalization(.words)
                    .disableAutocorrection(true)
                    .submitLabel(.continue)
                    .font(theme.typography.bodyStrong)
                    .foregroundStyle(theme.colors.textPrimary)
                    .padding(.horizontal, theme.spacing.md)
                    .padding(.vertical, theme.spacing.md)
                    .background(
                        RoundedRectangle(cornerRadius: theme.radius.md, style: .continuous)
                            .fill(theme.colors.field)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: theme.radius.md, style: .continuous)
                            .stroke(theme.colors.outlineSubtle, lineWidth: 1)
                    )
                    .onSubmit {
                        guard canContinue else { return }
                        Task {
                            await authStore.completeProfileOnboarding()
                        }
                    }
            }

            if let errorMessage = authStore.errorMessage {
                Text(errorMessage)
                    .font(theme.typography.body)
                    .foregroundStyle(theme.colors.danger)
            }

            Button {
                Task {
                    await authStore.completeProfileOnboarding()
                }
            } label: {
                HStack {
                    if authStore.isBusy {
                        ProgressView()
                            .tint(theme.colors.textInverse)
                    }
                    Text("Continue")
                }
            }
            .buttonStyle(LootyPrimaryButtonStyle())
            .disabled(canContinue == false)
            .opacity(canContinue ? 1 : 0.55)
        }
        .lootySurface(.dark, padding: theme.spacing.lg, cornerRadius: theme.radius.xl)
    }
}
