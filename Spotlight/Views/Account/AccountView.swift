import SwiftUI
import UniformTypeIdentifiers

struct AccountView: View {
    @ObservedObject var authStore: AuthStore
    @ObservedObject var collectionStore: CollectionStore
    let matcher: any CardMatchingService

    @Environment(\.dismiss) private var dismiss
    @Environment(\.lootyTheme) private var theme

    private var user: AppUser? { authStore.currentUser }
    @State private var showingImportPicker = false
    @State private var selectedImportSource: PortfolioImportSourceType?
    @State private var isPreparingImport = false
    @State private var importErrorMessage: String?
    @State private var selectedImportFile: PortfolioImportSelectedFile?

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: theme.spacing.lg) {
                    identityCard
                    importCard
                    if let importErrorMessage, importErrorMessage.isEmpty == false {
                        errorCard(message: importErrorMessage)
                    }
                    signOutCard
                }
                .padding(.horizontal, theme.spacing.xs)
                .padding(.vertical, theme.spacing.lg)
            }
            .background(theme.colors.canvas.ignoresSafeArea())
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(item: $selectedImportFile) { selectedFile in
                PortfolioImportView(
                    selectedFile: selectedFile,
                    collectionStore: collectionStore,
                    matcher: matcher
                )
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                    .foregroundStyle(theme.colors.textPrimary)
                }
            }
            .fileImporter(
                isPresented: $showingImportPicker,
                allowedContentTypes: [.commaSeparatedText, .text],
                allowsMultipleSelection: false
            ) { result in
                handleImportSelection(result)
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

    private var importCard: some View {
        VStack(alignment: .leading, spacing: theme.spacing.lg) {
            VStack(alignment: .leading, spacing: theme.spacing.xs) {
                Text("Bring Your Inventory Over")
                    .font(theme.typography.titleCompact)
                    .foregroundStyle(theme.colors.textPrimary)

                Text("Upload a CSV, review every row, and only import what looks right.")
                    .font(theme.typography.body)
                    .foregroundStyle(theme.colors.textSecondary)
            }

            if isPreparingImport {
                HStack(spacing: 12) {
                    ProgressView()
                        .tint(theme.colors.brand)

                    Text("Opening your import file")
                        .font(theme.typography.body)
                        .foregroundStyle(theme.colors.textSecondary)
                }
                .padding(.vertical, 4)
            }

            VStack(spacing: theme.spacing.sm) {
                importSourceButton(
                    sourceType: .collectrCSVV1,
                    fill: theme.colors.brand,
                    foreground: theme.colors.textInverse,
                    style: LootyFilledButtonStyle(
                        fill: theme.colors.brand,
                        foreground: theme.colors.textInverse,
                        cornerRadius: theme.radius.lg,
                        minHeight: 60
                    )
                )

                importSourceButton(
                    sourceType: .tcgplayerCSVV1,
                    fill: theme.colors.surfaceMuted,
                    foreground: theme.colors.textPrimary,
                    style: LootySecondaryButtonStyle()
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .lootySurface(.dark, padding: theme.spacing.lg, cornerRadius: theme.radius.xl)
    }

    private func importSourceButton<ButtonStyleType: ButtonStyle>(
        sourceType: PortfolioImportSourceType,
        fill: Color,
        foreground: Color,
        style: ButtonStyleType
    ) -> some View {
        Button {
            beginImport(for: sourceType)
        } label: {
            HStack(spacing: theme.spacing.md) {
                VStack(alignment: .leading, spacing: theme.spacing.xxxs) {
                    Text(sourceType.buttonTitle)
                        .font(theme.typography.headline)
                        .foregroundStyle(foreground)

                    Text(sourceType.subtitle)
                        .font(theme.typography.caption)
                        .foregroundStyle(foreground.opacity(sourceType == .collectrCSVV1 ? 0.86 : 0.74))
                        .multilineTextAlignment(.leading)
                }

                Spacer(minLength: theme.spacing.md)

                Image(systemName: "square.and.arrow.down")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(foreground)
                    .padding(10)
                    .background(
                        Circle()
                            .fill(fill.opacity(sourceType == .collectrCSVV1 ? 0.18 : 0.08))
                    )
            }
        }
        .buttonStyle(style)
        .disabled(isPreparingImport || authStore.isBusy)
    }

    private func errorCard(message: String) -> some View {
        VStack(alignment: .leading, spacing: theme.spacing.sm) {
            Label("Import unavailable", systemImage: "exclamationmark.triangle.fill")
                .font(theme.typography.headline)
                .foregroundStyle(theme.colors.textPrimary)

            Text(message)
                .font(theme.typography.body)
                .foregroundStyle(theme.colors.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .lootySurface(.muted, padding: theme.spacing.lg, cornerRadius: theme.radius.xl)
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

    private func beginImport(for sourceType: PortfolioImportSourceType) {
        importErrorMessage = nil
        selectedImportSource = sourceType
        showingImportPicker = true
    }

    private func handleImportSelection(_ result: Result<[URL], Error>) {
        guard let sourceType = selectedImportSource else { return }
        selectedImportSource = nil

        switch result {
        case .success(let urls):
            guard let fileURL = urls.first else { return }
            isPreparingImport = true
            Task {
                do {
                    let csvText = try readCSVText(from: fileURL)
                    let selectedFile = PortfolioImportSelectedFile(
                        sourceType: sourceType,
                        fileName: fileURL.lastPathComponent,
                        csvText: csvText
                    )
                    await MainActor.run {
                        isPreparingImport = false
                        selectedImportFile = selectedFile
                    }
                } catch {
                    await MainActor.run {
                        isPreparingImport = false
                        importErrorMessage = error.localizedDescription
                    }
                }
            }
        case .failure(let error):
            importErrorMessage = error.localizedDescription
        }
    }

    private func readCSVText(from fileURL: URL) throws -> String {
        let didStartSecurityScope = fileURL.startAccessingSecurityScopedResource()
        defer {
            if didStartSecurityScope {
                fileURL.stopAccessingSecurityScopedResource()
            }
        }

        let data = try Data(contentsOf: fileURL)
        let encodings: [String.Encoding] = [
            .utf8,
            .unicode,
            .utf16LittleEndian,
            .utf16BigEndian,
            .windowsCP1252
        ]

        for encoding in encodings {
            if let string = String(data: data, encoding: encoding) {
                let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    return string
                }
            }
        }

        throw NSError(
            domain: "PortfolioImport",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "This file could not be read as a CSV export."]
        )
    }
}
