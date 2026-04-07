import XCTest
@testable import Spotlight

/// Unit tests for IdentifierLookupService
///
/// Tests offline card identification including:
/// - Unique matches
/// - Ambiguous matches (multiple cards with same number)
/// - Not found cases
/// - Map loading
final class IdentifierLookupServiceTests: XCTestCase {

    // MARK: - Mock Service

    /// Mock service with test data instead of bundled file
    class MockIdentifierLookupService {
        private var identifiers: [String: IdentifierEntry] = [:]
        private let conservativeSetAliasesByName: [String: Set<String>] = [
            "obsidian flame": ["obf"],
            "obsidian flames": ["obf"],
            "paldea evolved": ["pal"],
            "151": ["mew"],
            "crown zenith galarian gallery": ["gg", "crz"],
            "scarlet & violet promos": ["svp", "prsv", "pr-sv"],
            "scarlet & violet black star promos": ["svp", "prsv", "pr-sv"],
            "destined rivals": ["dri"],
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

        enum IdentifierEntry {
            case single(CardIdentifier)
            case multiple([CardIdentifier])
        }

        private func isRuntimeSupportedIdentifierCard(_ card: CardIdentifier) -> Bool {
            let lowered = card.id.lowercased()
            guard lowered.hasPrefix("me") else { return true }

            let suffix = lowered.dropFirst(2)
            guard let first = suffix.first else { return true }
            return !first.isNumber
        }

        init(testData: [String: Any]) {
            // Parse test data into identifiers
            for (number, value) in testData {
                if let dict = value as? [String: String] {
                    let card = CardIdentifier(
                        id: dict["id"] ?? "",
                        name: dict["name"] ?? "",
                        set: dict["set"] ?? "",
                        image: dict["image"] ?? ""
                    )
                    guard isRuntimeSupportedIdentifierCard(card) else { continue }
                    identifiers[number] = .single(card)
                } else if let array = value as? [[String: String]] {
                    let cards = array.map { dict in
                        CardIdentifier(
                            id: dict["id"] ?? "",
                            name: dict["name"] ?? "",
                            set: dict["set"] ?? "",
                            image: dict["image"] ?? ""
                        )
                    }.filter(isRuntimeSupportedIdentifierCard)
                    guard !cards.isEmpty else { continue }
                    identifiers[number] = .multiple(cards)
                }
            }
        }

        func lookup(_ ocrText: String, setHintTokens: [String] = []) -> IdentifierLookupResult {
            let normalized = ocrText.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()

            if let result = result(for: identifiers[normalized]) {
                return result
            }

            if let fallback = fallbackVintageLookup(normalized) {
                return fallback
            }

            if let fallback = fallbackSetHintLookup(normalized, setHintTokens: setHintTokens) {
                return fallback
            }

            return .notFound
        }

        func has(_ ocrText: String) -> Bool {
            if case .notFound = lookup(ocrText) {
                return false
            }
            return true
        }

        private func result(for entry: IdentifierEntry?) -> IdentifierLookupResult? {
            guard let entry else { return nil }

            switch entry {
            case .single(let card):
                return .unique(card)
            case .multiple(let cards):
                return .ambiguous(cards)
            }
        }

        private func fallbackVintageLookup(_ normalized: String) -> IdentifierLookupResult? {
            let parts = normalized.split(separator: "/", omittingEmptySubsequences: false)
            guard parts.count == 2,
                  let denominator = Int(parts[1]) else {
                return nil
            }

            let numerator = String(parts[0])
            let strippedNumerator = {
                let stripped = numerator.drop { $0 == "0" }
                return stripped.isEmpty ? "0" : String(stripped)
            }()

            for key in [numerator, strippedNumerator] {
                guard let entry = identifiers[key] else { continue }

                let cards: [CardIdentifier]
                switch entry {
                case .single(let card):
                    cards = [card]
                case .multiple(let multiple):
                    cards = multiple
                }

                let filtered = cards.filter { card in
                    guard let prefix = card.id.split(separator: "-").first else { return false }
                    return vintageSetPrintedTotalsByIDPrefix[String(prefix).lowercased()] == denominator
                }

                if filtered.count == 1, let card = filtered.first {
                    return .unique(card)
                }

                if filtered.count > 1 {
                    return .ambiguous(filtered)
                }
            }

            return nil
        }

        private func fallbackSetHintLookup(_ normalized: String, setHintTokens: [String]) -> IdentifierLookupResult? {
            let parts = normalized.split(separator: "/", omittingEmptySubsequences: false)
            guard parts.count == 2 else { return nil }

            let knownAliases = Set(conservativeSetAliasesByName.values.flatMap { $0 })
            let normalizedHints = Set(
                setHintTokens.compactMap { token in
                    let normalizedToken = token.lowercased().replacingOccurrences(of: #"[^a-z0-9-]"#, with: "", options: .regularExpression)
                    return knownAliases.contains(normalizedToken) ? normalizedToken : nil
                }
            )
            guard !normalizedHints.isEmpty else { return nil }

            let numerator = String(parts[0])
            let strippedNumerator = {
                let stripped = numerator.drop { $0 == "0" }
                return stripped.isEmpty ? "0" : String(stripped)
            }()

            var candidates: [CardIdentifier] = []
            var seenCardIDs = Set<String>()

            for key in [numerator, strippedNumerator] {
                guard let entry = identifiers[key] else { continue }

                let cards: [CardIdentifier]
                switch entry {
                case .single(let card):
                    cards = [card]
                case .multiple(let multiple):
                    cards = multiple
                }

                for card in cards where seenCardIDs.insert(card.id).inserted {
                    candidates.append(card)
                }
            }

            let filtered = candidates.filter { card in
                let normalizedSetName = card.set.lowercased()
                var candidateTokens = Set(
                    normalizedSetName
                        .replacingOccurrences(of: #"[^a-z0-9]+"#, with: " ", options: .regularExpression)
                        .split(separator: " ")
                        .map(String.init)
                )
                candidateTokens.insert(normalizedSetName)
                candidateTokens.formUnion(conservativeSetAliasesByName[normalizedSetName] ?? [])
                return !candidateTokens.isDisjoint(with: normalizedHints)
            }

            if filtered.count == 1, let card = filtered.first {
                return .unique(card)
            }

            if filtered.count > 1 {
                return .ambiguous(filtered)
            }

            return nil
        }
    }

    // MARK: - Test Cases

    func testUniqueLookup() {
        // Given: A service with unique card entries
        let testData: [String: Any] = [
            "GG37/GG70": [
                "id": "swsh12pt5gg-GG37",
                "name": "Simisear VSTAR",
                "set": "Crown Zenith Galarian Gallery",
                "image": "https://images.pokemontcg.io/swsh12pt5gg/GG37.png"
            ],
            "001/165": [
                "id": "swsh9-1",
                "name": "Bulbasaur",
                "set": "Brilliant Stars",
                "image": "https://images.pokemontcg.io/swsh9/1.png"
            ]
        ]
        let service = MockIdentifierLookupService(testData: testData)

        // When: Looking up a unique collector number
        let result = service.lookup("GG37/GG70")

        // Then: Should return unique match
        if case .unique(let card) = result {
            XCTAssertEqual(card.id, "swsh12pt5gg-GG37")
            XCTAssertEqual(card.name, "Simisear VSTAR")
            XCTAssertEqual(card.set, "Crown Zenith Galarian Gallery")
        } else {
            XCTFail("Expected unique match but got: \\(result)")
        }
    }

    func testAmbiguousLookup() {
        // Given: A service with duplicate collector numbers
        let testData: [String: Any] = [
            "25/102": [
                [
                    "id": "base1-25",
                    "name": "Pikachu",
                    "set": "Base Set",
                    "image": "https://images.pokemontcg.io/base1/25.png"
                ],
                [
                    "id": "base2-25",
                    "name": "Pikachu",
                    "set": "Jungle",
                    "image": "https://images.pokemontcg.io/base2/25.png"
                ]
            ]
        ]
        let service = MockIdentifierLookupService(testData: testData)

        // When: Looking up an ambiguous collector number
        let result = service.lookup("25/102")

        // Then: Should return ambiguous match with multiple candidates
        if case .ambiguous(let cards) = result {
            XCTAssertEqual(cards.count, 2)
            XCTAssertEqual(cards[0].id, "base1-25")
            XCTAssertEqual(cards[1].id, "base2-25")
        } else {
            XCTFail("Expected ambiguous match but got: \\(result)")
        }
    }

    func testNotFoundLookup() {
        // Given: A service with some cards
        let testData: [String: Any] = [
            "001/165": [
                "id": "swsh9-1",
                "name": "Bulbasaur",
                "set": "Brilliant Stars",
                "image": "https://images.pokemontcg.io/swsh9/1.png"
            ]
        ]
        let service = MockIdentifierLookupService(testData: testData)

        // When: Looking up a non-existent collector number
        let result = service.lookup("999/999")

        // Then: Should return not found
        if case .notFound = result {
            // Success
        } else {
            XCTFail("Expected notFound but got: \\(result)")
        }
    }

    func testWhitespaceNormalization() {
        // Given: A service with a card
        let testData: [String: Any] = [
            "001/165": [
                "id": "swsh9-1",
                "name": "Bulbasaur",
                "set": "Brilliant Stars",
                "image": "https://images.pokemontcg.io/swsh9/1.png"
            ]
        ]
        let service = MockIdentifierLookupService(testData: testData)

        // When: Looking up with extra whitespace
        let result = service.lookup("  001/165  ")

        // Then: Should still find the card
        if case .unique(let card) = result {
            XCTAssertEqual(card.id, "swsh9-1")
        } else {
            XCTFail("Expected unique match but got: \\(result)")
        }
    }

    func testHasMethod() {
        // Given: A service with some cards
        let testData: [String: Any] = [
            "001/165": [
                "id": "swsh9-1",
                "name": "Bulbasaur",
                "set": "Brilliant Stars",
                "image": "https://images.pokemontcg.io/swsh9/1.png"
            ]
        ]
        let service = MockIdentifierLookupService(testData: testData)

        // When/Then: Checking existence
        XCTAssertTrue(service.has("001/165"))
        XCTAssertFalse(service.has("999/999"))
    }

    func testEmptyLookup() {
        // Given: A service with some cards
        let testData: [String: Any] = [
            "001/165": [
                "id": "swsh9-1",
                "name": "Bulbasaur",
                "set": "Brilliant Stars",
                "image": "https://images.pokemontcg.io/swsh9/1.png"
            ]
        ]
        let service = MockIdentifierLookupService(testData: testData)

        // When: Looking up empty string
        let result = service.lookup("")

        // Then: Should return not found
        if case .notFound = result {
            // Success
        } else {
            XCTFail("Expected notFound for empty string")
        }
    }

    func testSpecialCharacters() {
        // Given: A service with special collector numbers
        let testData: [String: Any] = [
            "TG30/TG30": [
                "id": "swsh12tg-TG30",
                "name": "Charizard VSTAR",
                "set": "Silver Tempest Trainer Gallery",
                "image": "https://images.pokemontcg.io/swsh12tg/TG30.png"
            ],
            "SV001/SV122": [
                "id": "sv3pt5-1",
                "name": "Bulbasaur",
                "set": "151",
                "image": "https://images.pokemontcg.io/sv3pt5/1.png"
            ]
        ]
        let service = MockIdentifierLookupService(testData: testData)

        // When/Then: Special characters should work
        if case .unique(let card) = service.lookup("TG30/TG30") {
            XCTAssertEqual(card.name, "Charizard VSTAR")
        } else {
            XCTFail("Expected to find TG30/TG30")
        }

        if case .unique(let card) = service.lookup("SV001/SV122") {
            XCTAssertEqual(card.name, "Bulbasaur")
        } else {
            XCTFail("Expected to find SV001/SV122")
        }
    }

    func testVintageCollectorNumberFallsBackToNumeratorBucketAndSetTotal() {
        let testData: [String: Any] = [
            "14": [
                [
                    "id": "base5-14",
                    "name": "Dark Weezing",
                    "set": "Team Rocket",
                    "image": "https://images.pokemontcg.io/base5/14.png"
                ],
                [
                    "id": "base1-14",
                    "name": "Raichu",
                    "set": "Base",
                    "image": "https://images.pokemontcg.io/base1/14.png"
                ],
                [
                    "id": "base3-14",
                    "name": "Raichu",
                    "set": "Fossil",
                    "image": "https://images.pokemontcg.io/base3/14.png"
                ]
            ]
        ]
        let service = MockIdentifierLookupService(testData: testData)

        let result = service.lookup("14/82")

        if case .unique(let card) = result {
            XCTAssertEqual(card.id, "base5-14")
            XCTAssertEqual(card.name, "Dark Weezing")
        } else {
            XCTFail("Expected Dark Weezing unique match but got: \\(result)")
        }
    }

    func testSetHintLookupCanResolveModernCardWhenExactSlashKeyIsMissing() {
        let testData: [String: Any] = [
            "199": [
                [
                    "id": "sv10-199",
                    "name": "Team Rocket's Weezing",
                    "set": "Destined Rivals",
                    "image": "https://images.pokemontcg.io/sv10/199.png"
                ],
                [
                    "id": "svp-199",
                    "name": "Zarude",
                    "set": "Scarlet & Violet Promos",
                    "image": "https://images.pokemontcg.io/svp/199.png"
                ]
            ]
        ]
        let service = MockIdentifierLookupService(testData: testData)

        let result = service.lookup("199/182", setHintTokens: ["dri"])

        if case .unique(let card) = result {
            XCTAssertEqual(card.id, "sv10-199")
        } else {
            XCTFail("Expected Team Rocket's Weezing unique match but got: \\(result)")
        }
    }

    func testSetHintLookupIgnoresUnsafeJapaneseStyleHint() {
        let testData: [String: Any] = [
            "66": [
                [
                    "id": "sm9-66",
                    "name": "Mr. Mime",
                    "set": "Team Up",
                    "image": "https://images.pokemontcg.io/sm9/66.png"
                ]
            ]
        ]
        let service = MockIdentifierLookupService(testData: testData)

        let result = service.lookup("066/095", setHintTokens: ["sm9"])

        if case .notFound = result {
            XCTAssertTrue(true)
        } else {
            XCTFail("Expected notFound but got: \\(result)")
        }
    }

    func testLowTrustCustomMegaIdentifiersAreIgnored() {
        let testData: [String: Any] = [
            "130/094": [
                "id": "me2-130",
                "name": "Mega Charizard X ex",
                "set": "Phantasmal Flames",
                "image": "https://images.example/me2-130.png"
            ],
            "130/095": [
                "id": "xy2-130",
                "name": "M Charizard EX",
                "set": "Flashfire",
                "image": "https://images.example/xy2-130.png"
            ]
        ]
        let service = MockIdentifierLookupService(testData: testData)

        if case .notFound = service.lookup("130/094") {
            XCTAssertTrue(true)
        } else {
            XCTFail("Expected low-trust custom identifier to be filtered out")
        }

        if case .unique(let card) = service.lookup("130/095") {
            XCTAssertEqual(card.id, "xy2-130")
        } else {
            XCTFail("Expected official Flashfire identifier to remain available")
        }
    }
}
