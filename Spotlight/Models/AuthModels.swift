import Foundation

enum AuthState: Equatable {
    case loading
    case signedOut
    case needsProfile
    case signedIn
}

struct UserProfile: Identifiable, Codable, Equatable, Sendable {
    let userID: UUID
    var displayName: String?
    var avatarURL: URL?

    var id: UUID { userID }

    var hasDisplayName: Bool {
        Self.normalized(displayName) != nil
    }

    static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

struct AppUser: Identifiable, Equatable, Sendable {
    let id: UUID
    let email: String?
    let displayName: String?
    let avatarURL: URL?
    let providers: [String]

    var requiresProfileCompletion: Bool {
        UserProfile.normalized(displayName) == nil
    }

    var resolvedDisplayName: String {
        if let displayName = UserProfile.normalized(displayName) {
            return displayName
        }
        if let emailPrefix = email?
            .split(separator: "@")
            .first
            .map(String.init),
           emailPrefix.isEmpty == false {
            return emailPrefix
        }
        return "Collector"
    }

    var initials: String {
        let words = resolvedDisplayName
            .split(whereSeparator: { $0.isWhitespace || $0.isNewline })
            .prefix(2)
        let letters = words.compactMap { $0.first }.map { String($0).uppercased() }
        if letters.isEmpty, let first = resolvedDisplayName.first {
            return String(first).uppercased()
        }
        return letters.joined()
    }
}
