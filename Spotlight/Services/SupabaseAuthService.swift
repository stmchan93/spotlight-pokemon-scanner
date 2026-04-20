import Foundation
import Supabase

enum SupabaseAuthConfigurationLoadError: LocalizedError {
    case invalidConfiguration(String)

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration(let message):
            return message
        }
    }
}

struct SupabaseAuthConfiguration: Equatable {
    let supabaseURL: URL
    let anonKey: String
    let redirectURL: URL

    var callbackScheme: String? {
        redirectURL.scheme
    }

    static func load(bundle: Bundle = .main) -> Result<Self, SupabaseAuthConfigurationLoadError> {
        let urlString = infoPlistString(forKey: "SpotlightSupabaseURL", bundle: bundle)
        let anonKey = infoPlistString(forKey: "SpotlightSupabaseAnonKey", bundle: bundle)
        let redirectURLString = infoPlistString(forKey: "SpotlightAuthRedirectURL", bundle: bundle)

        guard let supabaseURL = URL(string: urlString), urlString.isEmpty == false else {
            return .failure(.invalidConfiguration("Supabase URL is missing. Set SPOTLIGHT_SUPABASE_URL in your xcconfig overrides."))
        }
        guard anonKey.isEmpty == false else {
            return .failure(.invalidConfiguration("Supabase anon key is missing. Set SPOTLIGHT_SUPABASE_ANON_KEY in your xcconfig overrides."))
        }
        guard let redirectURL = URL(string: redirectURLString),
              redirectURL.scheme?.isEmpty == false else {
            return .failure(.invalidConfiguration("Auth redirect URL is missing or invalid. Check SPOTLIGHT_AUTH_REDIRECT_* config."))
        }

        return .success(
            SupabaseAuthConfiguration(
                supabaseURL: supabaseURL,
                anonKey: anonKey,
                redirectURL: redirectURL
            )
        )
    }

    private static func infoPlistString(forKey key: String, bundle: Bundle) -> String {
        guard let value = bundle.object(forInfoDictionaryKey: key) as? String else {
            return ""
        }
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum SupabaseAuthServiceError: LocalizedError {
    case missingConfiguration(String)
    case invalidAppleCredential
    case invalidAppleIdentityToken

    var errorDescription: String? {
        switch self {
        case .missingConfiguration(let message):
            return message
        case .invalidAppleCredential:
            return "Apple sign-in did not return a valid credential."
        case .invalidAppleIdentityToken:
            return "Apple sign-in did not return a valid identity token."
        }
    }
}

private struct UserProfileRow: Codable, Sendable {
    let userID: UUID
    let displayName: String?
    let avatarURL: String?

    enum CodingKeys: String, CodingKey {
        case userID = "user_id"
        case displayName = "display_name"
        case avatarURL = "avatar_url"
    }

    var userProfile: UserProfile {
        UserProfile(
            userID: userID,
            displayName: displayName,
            avatarURL: avatarURL.flatMap(URL.init(string:))
        )
    }
}

struct SupabaseAuthService: Sendable {
    let configuration: SupabaseAuthConfiguration?
    let configurationIssue: String?
    private let client: SupabaseClient?

    init(bundle: Bundle = .main) {
        switch SupabaseAuthConfiguration.load(bundle: bundle) {
        case .success(let configuration):
            self.configuration = configuration
            self.configurationIssue = nil
            self.client = SupabaseClient(
                supabaseURL: configuration.supabaseURL,
                supabaseKey: configuration.anonKey,
                options: SupabaseClientOptions(
                    auth: .init(
                        redirectToURL: configuration.redirectURL
                    )
                )
            )
        case .failure(let issue):
            self.configuration = nil
            self.configurationIssue = issue.localizedDescription
            self.client = nil
        }
    }

    var isConfigured: Bool {
        client != nil
    }

    func authStateChanges() -> AsyncStream<(event: AuthChangeEvent, session: Session?)> {
        guard let client else {
            return AsyncStream { continuation in
                continuation.yield((.initialSession, nil))
                continuation.finish()
            }
        }
        return client.auth.authStateChanges
    }

    func handleOpenURL(_ url: URL) {
        client?.auth.handle(url)
    }

    func signInWithGoogle() async throws -> Session {
        guard let client else {
            throw SupabaseAuthServiceError.missingConfiguration(configurationIssue ?? "Supabase Auth is not configured.")
        }

        return try await client.auth.signInWithOAuth(
            provider: .google,
            redirectTo: configuration?.redirectURL
        ) { session in
            session.prefersEphemeralWebBrowserSession = false
        }
    }

    func signInWithApple(idToken: String, rawNonce: String) async throws -> Session {
        guard let client else {
            throw SupabaseAuthServiceError.missingConfiguration(configurationIssue ?? "Supabase Auth is not configured.")
        }

        return try await client.auth.signInWithIdToken(
            credentials: OpenIDConnectCredentials(
                provider: .apple,
                idToken: idToken,
                nonce: rawNonce
            )
        )
    }

    func signOut() async throws {
        guard let client else { return }
        try await client.auth.signOut()
    }

    func resolvedAppUser(from session: Session) async -> AppUser {
        let authUser = session.user
        let profile = await fetchProfile(for: authUser.id)
        let displayName = UserProfile.normalized(profile?.displayName) ?? fallbackDisplayName(from: authUser)
        let avatarURL = profile?.avatarURL ?? fallbackAvatarURL(from: authUser)
        let providers = (authUser.identities ?? [])
            .map(\.provider)
            .filter { $0.isEmpty == false }
        let uniqueProviders = Array(NSOrderedSet(array: providers)) as? [String] ?? providers

        return AppUser(
            id: authUser.id,
            email: authUser.email,
            displayName: displayName,
            avatarURL: avatarURL,
            providers: uniqueProviders
        )
    }

    func bootstrapProfileIfNeeded(
        for user: User,
        preferredDisplayName: String?,
        preferredAvatarURL: URL? = nil
    ) async {
        let displayName = UserProfile.normalized(preferredDisplayName) ?? fallbackDisplayName(from: user)
        let avatarURL = preferredAvatarURL ?? fallbackAvatarURL(from: user)
        guard let displayName else { return }
        _ = try? await upsertProfile(
            userID: user.id,
            displayName: displayName,
            avatarURL: avatarURL
        )
    }

    @discardableResult
    func upsertProfile(
        userID: UUID,
        displayName: String,
        avatarURL: URL?
    ) async throws -> UserProfile {
        let normalizedDisplayName = UserProfile.normalized(displayName) ?? displayName
        let profileRow = UserProfileRow(
            userID: userID,
            displayName: normalizedDisplayName,
            avatarURL: avatarURL?.absoluteString
        )

        try await syncUserMetadata(
            displayName: normalizedDisplayName,
            avatarURL: avatarURL
        )

        guard let client else {
            return profileRow.userProfile
        }

        do {
            let response: PostgrestResponse<UserProfileRow> = try await client
                .from("user_profiles")
                .upsert(profileRow, onConflict: "user_id")
                .select()
                .single()
                .execute()
            return response.value.userProfile
        } catch {
            print("⚠️ [AUTH] Failed to upsert user_profiles row: \(error)")
            return profileRow.userProfile
        }
    }

    func fetchProfile(for userID: UUID) async -> UserProfile? {
        guard let client else { return nil }

        do {
            let response: PostgrestResponse<UserProfileRow> = try await client
                .from("user_profiles")
                .select()
                .eq("user_id", value: userID.uuidString)
                .single()
                .execute()
            return response.value.userProfile
        } catch {
            return nil
        }
    }

    private func syncUserMetadata(
        displayName: String,
        avatarURL: URL?
    ) async throws {
        guard let client else { return }

        var metadata: [String: AnyJSON] = [
            "display_name": .string(displayName)
        ]
        if let avatarURL {
            metadata["avatar_url"] = .string(avatarURL.absoluteString)
        }

        _ = try await client.auth.update(
            user: UserAttributes(
                data: metadata
            )
        )
    }

    private func fallbackDisplayName(from user: User) -> String? {
        let metadataKeys = [
            "display_name",
            "full_name",
            "name",
            "preferred_username",
            "user_name",
            "given_name"
        ]

        for key in metadataKeys {
            if let value = UserProfile.normalized(user.userMetadata[key]?.stringValue) {
                return value
            }
        }

        if let email = user.email?
            .split(separator: "@")
            .first
            .map(String.init),
           email.isEmpty == false {
            return email
        }

        return nil
    }

    private func fallbackAvatarURL(from user: User) -> URL? {
        let metadataKeys = ["avatar_url", "picture"]
        for key in metadataKeys {
            if let value = user.userMetadata[key]?.stringValue,
               let url = URL(string: value) {
                return url
            }
        }
        return nil
    }
}
