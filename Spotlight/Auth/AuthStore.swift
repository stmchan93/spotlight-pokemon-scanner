import AuthenticationServices
import CryptoKit
import Foundation
import Security
import Supabase

@MainActor
final class AuthStore: ObservableObject {
    @Published private(set) var state: AuthState = .loading
    @Published private(set) var currentUser: AppUser?
    @Published private(set) var currentSession: Session?
    @Published private(set) var isBusy = false
    @Published var errorMessage: String?
    @Published var profileDraftName = ""

    let service: SupabaseAuthService
    private var authStateTask: Task<Void, Never>?
    private var pendingAppleNonce: String?

    init(service: SupabaseAuthService = SupabaseAuthService()) {
        self.service = service
        if AppRuntime.shouldBypassAuthForUITests {
            let uiTestUser = AppUser(
                id: UUID(uuidString: "00000000-0000-0000-0000-000000000001") ?? UUID(),
                email: "ui-tests@spotlight.local",
                displayName: "UI Test User",
                avatarURL: nil,
                providers: ["ui-tests"]
            )
            self.currentUser = uiTestUser
            self.profileDraftName = uiTestUser.resolvedDisplayName
            self.state = .signedIn
            return
        }
        startAuthStateListener()
    }

    deinit {
        authStateTask?.cancel()
    }

    var isConfigured: Bool {
        service.isConfigured
    }

    var configurationIssue: String? {
        service.configurationIssue
    }

    func prepareAppleSignIn(_ request: ASAuthorizationAppleIDRequest) {
        let nonce = Self.randomNonce()
        pendingAppleNonce = nonce
        request.requestedScopes = [.fullName, .email]
        request.nonce = Self.sha256(nonce)
        errorMessage = nil
    }

    func completeAppleSignIn(_ result: Result<ASAuthorization, Error>) async {
        switch result {
        case .failure(let error):
            errorMessage = error.localizedDescription
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                errorMessage = SupabaseAuthServiceError.invalidAppleCredential.localizedDescription
                return
            }
            guard let nonce = pendingAppleNonce else {
                errorMessage = "Apple sign-in did not start correctly. Please try again."
                return
            }
            guard let tokenData = credential.identityToken,
                  let idToken = String(data: tokenData, encoding: .utf8) else {
                errorMessage = SupabaseAuthServiceError.invalidAppleIdentityToken.localizedDescription
                return
            }

            let preferredName = Self.displayName(from: credential.fullName)
            pendingAppleNonce = nil
            await performAuthAction { [self] in
                let session = try await self.service.signInWithApple(idToken: idToken, rawNonce: nonce)
                await self.service.bootstrapProfileIfNeeded(
                    for: session.user,
                    preferredDisplayName: preferredName
                )
                await self.updateFromSession(session)
            }
        }
    }

    func signInWithGoogle() async {
        await performAuthAction { [self] in
            let session = try await self.service.signInWithGoogle()
            await self.service.bootstrapProfileIfNeeded(for: session.user, preferredDisplayName: nil)
            await self.updateFromSession(session)
        }
    }

    func completeProfileOnboarding() async {
        guard let user = currentUser else { return }
        let trimmedName = profileDraftName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmedName.isEmpty == false else {
            errorMessage = "Enter a display name to continue."
            return
        }

        await performAuthAction { [self] in
            _ = try await self.service.upsertProfile(
                userID: user.id,
                displayName: trimmedName,
                avatarURL: user.avatarURL
            )
            if let currentSession = self.currentSession {
                await self.updateFromSession(currentSession)
            }
        }
    }

    func signOut() async {
        await performAuthAction { [self] in
            try await self.service.signOut()
            self.currentSession = nil
            self.currentUser = nil
            self.profileDraftName = ""
            self.state = .signedOut
        }
    }

    func handleOpenURL(_ url: URL) {
        service.handleOpenURL(url)
    }

    private func startAuthStateListener() {
        authStateTask = Task { [weak self] in
            guard let self else { return }
            for await (_, session) in service.authStateChanges() {
                guard Task.isCancelled == false else { return }
                await self.updateFromSession(session)
            }
        }
    }

    private func updateFromSession(_ session: Session?) async {
        currentSession = session

        guard let session else {
            currentUser = nil
            profileDraftName = ""
            state = .signedOut
            return
        }

        let resolvedUser = await service.resolvedAppUser(from: session)
        currentUser = resolvedUser
        if state == .loading || profileDraftName.isEmpty {
            profileDraftName = resolvedUser.displayName ?? ""
        }
        state = resolvedUser.requiresProfileCompletion ? .needsProfile : .signedIn
    }

    private func performAuthAction(_ operation: @escaping @MainActor () async throws -> Void) async {
        guard isBusy == false else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }

        do {
            try await operation()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private static func displayName(from components: PersonNameComponents?) -> String? {
        guard let components else { return nil }
        let formatted = PersonNameComponentsFormatter().string(from: components)
        return UserProfile.normalized(formatted)
    }

    private static func randomNonce(length: Int = 32) -> String {
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var nonce = ""
        nonce.reserveCapacity(length)

        while nonce.count < length {
            var randomByte: UInt8 = 0
            let status = SecRandomCopyBytes(kSecRandomDefault, 1, &randomByte)
            if status != errSecSuccess {
                fatalError("Unable to generate secure random nonce. OSStatus=\(status)")
            }

            if randomByte < charset.count {
                nonce.append(charset[Int(randomByte)])
            }
        }

        return nonce
    }

    private static func sha256(_ input: String) -> String {
        let inputData = Data(input.utf8)
        let digest = SHA256.hash(data: inputData)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
