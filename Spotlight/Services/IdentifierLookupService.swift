import Foundation

private func isRuntimeSupportedIdentifierCard(_ card: CardIdentifier) -> Bool {
    let lowered = card.id.lowercased()
    guard lowered.hasPrefix("me") else {
        return true
    }

    let suffix = lowered.dropFirst(2)
    guard let first = suffix.first else {
        return true
    }

    return !first.isNumber
}

// MARK: - Identifier Lookup Models

/// Entry in the identifier map (minimal card data for offline lookup)
struct CardIdentifier: Codable {
    let id: String
    let name: String
    let set: String
    let image: String
}

/// Result of identifier lookup
enum IdentifierLookupResult {
    case unique(CardIdentifier)
    case ambiguous([CardIdentifier])
    case notFound
}

// MARK: - Identifier Lookup Service

/// Service for looking up cards by OCR text using bundled identifier map
///
/// Enables instant offline card identification from collector numbers.
/// Loads a 332 KB map of 2,020+ Pokémon cards on initialization.
///
/// Usage:
/// ```
/// let service = IdentifierLookupService()
/// let result = service.lookup("GG37/GG70")
/// ```
class IdentifierLookupService {
    private var identifiers: [String: [CardIdentifier]] = [:]
    private let conservativeSetAliasesByName: [String: Set<String>] = [
        "obsidian flame": ["obf"],
        "obsidian flames": ["obf"],
        "paldea evolved": ["pal"],
        "151": ["mew"],
        "crown zenith galarian gallery": ["gg", "crz"],
        "scarlet & violet promos": ["svp", "prsv", "pr-sv"],
        "scarlet & violet black star promos": ["svp", "prsv", "pr-sv"],
        "destined rivals": ["dri"],
        "paradox rift": ["par"],
        "scarlet & violet": ["svi"],
        "brilliant stars": ["brs"],
        "lost origin": ["lor"],
        "surging sparks": ["ssp"],
        "mega evolution": ["meg"],
    ]
    private let vintageSetPrintedTotalsByIDPrefix: [String: Int] = [
        "base1": 102,
        "base2": 64,
        "base3": 62,
        "base4": 130,
        "base5": 82,
        "base6": 110,
        "gym1": 132,
        "gym2": 132,
        "neo1": 111,
        "neo2": 75,
        "neo3": 64,
        "neo4": 113,
        "ecard1": 165,
        "ecard2": 186,
        "ecard3": 144,
    ]
    private let vintageSetPrintedTotalsByName: [String: Int] = [
        "base": 102,
        "jungle": 64,
        "fossil": 62,
        "base set 2": 130,
        "team rocket": 82,
        "gym heroes": 132,
        "gym challenge": 132,
        "neo genesis": 111,
        "neo discovery": 75,
        "neo revelation": 64,
        "neo destiny": 113,
        "legendary collection": 110,
        "expedition base set": 165,
        "aquapolis": 186,
        "skyridge": 144,
    ]

    init() {
        loadIdentifiers()
    }

    private func loadIdentifiers() {
        guard let url = Bundle.main.url(forResource: "identifiers_pokemon", withExtension: "json"),
              let data = try? Data(contentsOf: url) else {
            print("❌ Failed to load identifier map file")
            return
        }

        do {
            let decoded = try JSONDecoder().decode([String: [String: [CardIdentifier]]].self, from: data)
            guard let identifierMap = decoded["identifiers"] else {
                print("❌ Missing 'identifiers' key in JSON")
                return
            }

            identifiers = identifierMap.reduce(into: [:]) { partialResult, element in
                let filteredCards = element.value.filter(isRuntimeSupportedIdentifierCard)
                guard !filteredCards.isEmpty else {
                    return
                }
                partialResult[element.key] = filteredCards
            }
            print("✅ Loaded \(identifiers.count) card identifiers")
        } catch {
            print("❌ Failed to decode identifier map: \(error)")
        }
    }

    /// Lookup card by OCR text (e.g., "GG37/GG70", "TG30/TG30", "001/165")
    func lookup(_ ocrText: String, setHintTokens: [String] = []) -> IdentifierLookupResult {
        let normalized = normalizedLookupKey(ocrText)

        if let exactResult = result(for: identifiers[normalized]) {
            return exactResult
        }

        if let fallbackResult = fallbackVintageLookup(for: normalized) {
            return fallbackResult
        }

        if let setHintResult = fallbackSetHintLookup(for: normalized, setHintTokens: setHintTokens) {
            return setHintResult
        }

        return .notFound
    }

    /// Check if identifier exists in local map
    func has(_ ocrText: String) -> Bool {
        if case .notFound = lookup(ocrText) {
            return false
        }
        return true
    }

    private func normalizedLookupKey(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
    }

    private func result(for cards: [CardIdentifier]?) -> IdentifierLookupResult? {
        guard let cards, !cards.isEmpty else { return nil }
        if cards.count == 1, let card = cards.first {
            return .unique(card)
        }
        return .ambiguous(cards)
    }

    private func fallbackVintageLookup(for normalized: String) -> IdentifierLookupResult? {
        guard let (numerator, denominator) = parsedStandardCollectorNumber(normalized) else {
            return nil
        }

        let numeratorKeys = [numerator, strippedLeadingZeroes(from: numerator)]
            .filter { !$0.isEmpty }

        for key in numeratorKeys {
            guard let cards = identifiers[key], !cards.isEmpty else { continue }

            let filtered = cards.filter { printedTotal(for: $0) == denominator }
            if let filteredResult = result(for: filtered) {
                return filteredResult
            }
        }

        return nil
    }

    private func fallbackSetHintLookup(for normalized: String, setHintTokens: [String]) -> IdentifierLookupResult? {
        guard let (numerator, _) = parsedStandardCollectorNumber(normalized) else {
            return nil
        }

        let normalizedSetHints = normalizedLocalSetHints(setHintTokens)
        guard !normalizedSetHints.isEmpty else {
            return nil
        }

        let numeratorKeys = [numerator, strippedLeadingZeroes(from: numerator)]
            .filter { !$0.isEmpty }
        var candidates: [CardIdentifier] = []
        var seenCardIDs = Set<String>()

        for key in numeratorKeys {
            guard let cards = identifiers[key], !cards.isEmpty else { continue }
            for card in cards where seenCardIDs.insert(card.id).inserted {
                candidates.append(card)
            }
        }

        let filtered = candidates.filter { cardMatchesSetHints($0, normalizedSetHints) }
        return result(for: filtered)
    }

    private func parsedStandardCollectorNumber(_ normalized: String) -> (numerator: String, denominator: Int)? {
        let parts = normalized.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }

        let numerator = String(parts[0])
        guard !numerator.isEmpty,
              numerator.allSatisfy(\.isNumber),
              let denominator = Int(parts[1]),
              denominator > 0 else {
            return nil
        }

        return (numerator, denominator)
    }

    private func strippedLeadingZeroes(from value: String) -> String {
        let stripped = value.drop { $0 == "0" }
        return stripped.isEmpty ? "0" : String(stripped)
    }

    private func printedTotal(for card: CardIdentifier) -> Int? {
        if let prefix = card.id.split(separator: "-").first {
            let normalizedPrefix = String(prefix).lowercased()
            if let total = vintageSetPrintedTotalsByIDPrefix[normalizedPrefix] {
                return total
            }
        }

        return vintageSetPrintedTotalsByName[card.set.lowercased()]
    }

    private func normalizedLocalSetHints(_ setHintTokens: [String]) -> Set<String> {
        let knownAliases = Set(conservativeSetAliasesByName.values.flatMap { $0 })

        return Set(
            setHintTokens.compactMap { token in
                let normalized = token
                    .lowercased()
                    .replacingOccurrences(of: #"[^a-z0-9-]"#, with: "", options: .regularExpression)
                guard !normalized.isEmpty, knownAliases.contains(normalized) else {
                    return nil
                }
                return normalized
            }
        )
    }

    private func cardMatchesSetHints(_ card: CardIdentifier, _ setHints: Set<String>) -> Bool {
        guard !setHints.isEmpty else { return false }

        let normalizedSetName = card.set.lowercased()
        var candidateTokens = Set(
            normalizedSetName
                .replacingOccurrences(of: #"[^a-z0-9]+"#, with: " ", options: .regularExpression)
                .split(separator: " ")
                .map(String.init)
        )
        candidateTokens.insert(normalizedSetName)
        candidateTokens.formUnion(conservativeSetAliasesByName[normalizedSetName] ?? [])

        return !candidateTokens.isDisjoint(with: setHints)
    }
}
