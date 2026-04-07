import Foundation

struct ParsedCardIdentifier {
    let identifier: String
    let confidence: Float
    let sourceRegion: String
}

func normalizeConfusableLatinCharacters(in text: String) -> String {
    let confusables: [Character: Character] = [
        "А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H", "І": "I",
        "К": "K", "М": "M", "О": "O", "Р": "P", "Т": "T", "Х": "X",
        "Υ": "Y", "Ζ": "Z",
    ]

    return String(text.map { confusables[$0] ?? $0 })
}

struct CardIdentifierParser {
    private enum Pattern {
        case prefixed
        case standard
        case promo
        case compact

        var regex: String {
            switch self {
            case .prefixed: return #"\b[A-Z]{1,3}\d{1,3}/[A-Z]{1,3}\d{1,3}\b"#
            case .standard: return #"\b\d{1,3}/\d{1,3}\b"#
            case .promo: return #"\b(?:SVP|SWSH|SM|XY|BW|DP|HGSS|POP|PR)\s?\d{1,3}\b"#
            case .compact: return #"\b\d{6}\b"#
            }
        }

        var boost: Float {
            switch self {
            case .prefixed: return 0.95
            case .standard: return 1.0
            case .promo: return 0.9
            case .compact: return 0.7
            }
        }
    }

    func parse(text: String, sourceRegion: String) -> ParsedCardIdentifier? {
        guard !text.isEmpty else { return nil }
        let normalized = normalize(text)

        if let match = firstMatch(in: normalized, pattern: Pattern.prefixed.regex) {
            let cleaned = clean(match)
            let confidence = min(1.0, Pattern.prefixed.boost + (normalized.count < 20 ? 0.05 : 0.0))

            return ParsedCardIdentifier(
                identifier: cleaned,
                confidence: confidence,
                sourceRegion: sourceRegion
            )
        }

        if let heuristic = heuristicPrefixedMatch(in: normalized) {
            return ParsedCardIdentifier(
                identifier: heuristic,
                confidence: 0.84,
                sourceRegion: sourceRegion
            )
        }

        for pattern in [Pattern.standard, .promo, .compact] {
            if let match = firstMatch(in: normalized, pattern: pattern.regex) {
                let cleaned = clean(match)
                let confidence = min(1.0, pattern.boost + (normalized.count < 20 ? 0.05 : 0.0))

                return ParsedCardIdentifier(
                    identifier: cleaned,
                    confidence: confidence,
                    sourceRegion: sourceRegion
                )
            }
        }

        if let heuristic = heuristicStandardMatch(in: normalized) {
            return ParsedCardIdentifier(
                identifier: heuristic,
                confidence: 0.72,
                sourceRegion: sourceRegion
            )
        }

        return nil
    }

    private func normalize(_ text: String) -> String {
        normalizeConfusableLatinCharacters(in: text)
            .uppercased()
            .replacingOccurrences(of: #"\b([A-Z]{2,4})\s*EN\s*(\d{1,3})\b"#, with: "$1 $2", options: .regularExpression)
            .replacingOccurrences(of: #"\b([A-Z]{2,4})EN\s*(\d{1,3})\b"#, with: "$1 $2", options: .regularExpression)
            .replacingOccurrences(of: "O", with: "0")
            .replacingOccurrences(of: #"(?<=\d)[I|L](?=\d)"#, with: "/", options: .regularExpression)
            .replacingOccurrences(of: #"(?<=\d)\s+(?=\d{2,3}\b)"#, with: "/", options: .regularExpression)
            .replacingOccurrences(of: #"(?<=\d)ZZ(?=\d)"#, with: "7/", options: .regularExpression)
            .replacingOccurrences(of: #"(?<=/\d{2})Z\b"#, with: "1", options: .regularExpression)
            .replacingOccurrences(of: #"([A-Z]{2})(\d{1,3})([A-Z]{2})(\d{1,3})"#, with: "$1$2/$3$4", options: .regularExpression)
    }

    private func clean(_ identifier: String) -> String {
        if identifier.count == 6, identifier.allSatisfy(\.isNumber) {
            return "\(identifier.prefix(3))/\(identifier.suffix(3))"
        }

        return identifier
            .replacingOccurrences(of: #"\s*/\s*"#, with: "/", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func firstMatch(in text: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }

        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              let matchRange = Range(match.range, in: text) else {
            return nil
        }

        return String(text[matchRange])
    }

    private func heuristicStandardMatch(in text: String) -> String? {
        let preferSecretRareNumbering = containsSecretRareHint(in: text)
        let patterns = [
            #"\b[A-Z0-9]{2,6}\s+[A-Z]\s+([A-Z0-9]{6,8})\s+(?:CHR|CSR|AR|SAR|SR|HR|UR|RRR|RR|R)\b"#,
            #"\b([A-Z0-9]{6,8})\s+(?:CHR|CSR|AR|SAR|SR|HR|UR|RRR|RR|R)\b"#
        ]

        for pattern in patterns {
            guard let token = firstCaptureGroup(in: text, pattern: pattern),
                  let candidate = decodeNoisyStandardNumber(token, preferSecretRareNumbering: preferSecretRareNumbering) else {
                continue
            }
            return candidate
        }

        for token in text.split(whereSeparator: \.isWhitespace).map(String.init) {
            if let candidate = decodeNoisyStandardNumber(token, preferSecretRareNumbering: preferSecretRareNumbering) {
                return candidate
            }
        }

        return nil
    }

    private func heuristicPrefixedMatch(in text: String) -> String? {
        let patterns = [
            #"\b([A-Z]{1,3})(\d{1,3})/([A-Z0-9]{2,6})\b"#,
            #"\b([A-Z]{1,3})(\d{1,3})\s*/\s*([A-Z0-9]{2,6})\b"#
        ]

        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
                continue
            }

            let range = NSRange(text.startIndex..., in: text)
            for match in regex.matches(in: text, options: [], range: range) {
                guard match.numberOfRanges == 4,
                      let prefixRange = Range(match.range(at: 1), in: text),
                      let leftDigitsRange = Range(match.range(at: 2), in: text),
                      let rightRange = Range(match.range(at: 3), in: text) else {
                    continue
                }

                let prefix = String(text[prefixRange])
                let leftDigits = String(text[leftDigitsRange])
                let rightRaw = String(text[rightRange])

                if rightRaw.hasPrefix(prefix) {
                    let suffix = String(rightRaw.dropFirst(prefix.count))
                    if suffix.count >= 1, suffix.count <= 3, suffix.allSatisfy(\.isNumber) {
                        return "\(prefix)\(leftDigits)/\(prefix)\(suffix)"
                    }
                }

                let digitCharacters = rightRaw.filter(\.isNumber)
                let rightDigitsLength = min(max(leftDigits.count, 2), 3)
                guard digitCharacters.count >= rightDigitsLength else {
                    continue
                }

                let suffixDigits = String(digitCharacters.suffix(rightDigitsLength))
                guard suffixDigits.allSatisfy(\.isNumber) else {
                    continue
                }

                return "\(prefix)\(leftDigits)/\(prefix)\(suffixDigits)"
            }
        }

        return nil
    }

    private func decodeNoisyStandardNumber(_ token: String, preferSecretRareNumbering: Bool = false) -> String? {
        let compact = token.replacingOccurrences(of: #"[^A-Z0-9/]"#, with: "", options: .regularExpression)
        guard !compact.isEmpty else { return nil }

        if let exact = firstMatch(in: compact, pattern: #"\d{1,3}/\d{1,3}"#) {
            return exact
        }

        var candidates: [(value: String, score: Int)] = []

        if compact.count == 7 {
            let value = Array(compact)
            let separator = value[3]
            let separatorScore = separatorConfidence(for: separator)

            if separatorScore > 0 {
                let left = String(value[0..<3])
                let right = String(value[4..<7])
                let leftCandidates = normalizeNoisyDigitTripletCandidates(left, preferTrailingOne: false)
                let rightCandidates = normalizeNoisyDigitTripletCandidates(right, preferTrailingOne: true)

                for leftCandidate in leftCandidates {
                    for rightCandidate in rightCandidates {
                        var score = leftCandidate.score + rightCandidate.score + separatorScore
                        let leftValue = Int(leftCandidate.value) ?? 0
                        let rightValue = Int(rightCandidate.value) ?? 0

                        if preferSecretRareNumbering {
                            score += leftValue > rightValue ? 3 : -2
                        }

                        candidates.append(("\(leftCandidate.value)/\(rightCandidate.value)", score))
                    }
                }
            }
        }

        if compact.count == 6 {
            let leftCandidates = normalizeNoisyDigitTripletCandidates(String(compact.prefix(3)), preferTrailingOne: false)
            let rightCandidates = normalizeNoisyDigitTripletCandidates(String(compact.suffix(3)), preferTrailingOne: true)

            for leftCandidate in leftCandidates {
                for rightCandidate in rightCandidates {
                    var score = leftCandidate.score + rightCandidate.score
                    let leftValue = Int(leftCandidate.value) ?? 0
                    let rightValue = Int(rightCandidate.value) ?? 0

                    if preferSecretRareNumbering {
                        score += leftValue > rightValue ? 2 : -1
                    }

                    candidates.append(("\(leftCandidate.value)/\(rightCandidate.value)", score))
                }
            }
        }

        return candidates
            .reduce(into: [String: Int]()) { bestScores, candidate in
                bestScores[candidate.value] = max(bestScores[candidate.value] ?? .min, candidate.score)
            }
            .sorted { lhs, rhs in
                if lhs.value == rhs.value {
                    return lhs.key > rhs.key
                }
                return lhs.value > rhs.value
            }
            .first?
            .key
    }

    private func normalizeNoisyDigitTripletCandidates(_ value: String, preferTrailingOne: Bool) -> [(value: String, score: Int)] {
        guard value.count == 3 else { return [] }

        var candidates: [(value: String, score: Int)] = [("", 0)]
        for (index, character) in value.enumerated() {
            let digitOptions = noisyDigitOptions(for: character, index: index, preferTrailingOne: preferTrailingOne)
            guard !digitOptions.isEmpty else { return [] }

            var nextCandidates: [String: Int] = [:]
            for candidate in candidates {
                for option in digitOptions {
                    let nextValue = candidate.value + option.digit
                    let nextScore = candidate.score + option.score
                    nextCandidates[nextValue] = max(nextCandidates[nextValue] ?? .min, nextScore)
                }
            }

            candidates = nextCandidates.map { ($0.key, $0.value) }
        }

        return candidates
            .filter { $0.value.count == 3 && $0.value.allSatisfy(\.isNumber) }
            .sorted { lhs, rhs in
                if lhs.score == rhs.score {
                    return lhs.value > rhs.value
                }
                return lhs.score > rhs.score
            }
    }

    private func noisyDigitOptions(for character: Character, index: Int, preferTrailingOne: Bool) -> [(digit: String, score: Int)] {
        if character.isNumber {
            return [(String(character), 5)]
        }

        switch character {
        case "O", "Q", "D":
            return [("0", 3)]
        case "I", "L", "T":
            return [("1", 3)]
        case "S":
            return [("5", 2)]
        case "B":
            return [("8", 2)]
        case "G":
            return [("6", 1)]
        case "A":
            return [("4", 1)]
        case "Z":
            if index == 2 {
                return preferTrailingOne
                    ? [("1", 3), ("7", 2)]
                    : [("7", 3), ("1", 2)]
            }
            return [("7", 3), ("1", 1)]
        default:
            return []
        }
    }

    private func separatorConfidence(for character: Character) -> Int {
        switch character {
        case "/":
            return 5
        case "I", "L", "|":
            return 3
        case "7", "Z", "2", "T":
            return 2
        default:
            return 0
        }
    }

    private func containsSecretRareHint(in text: String) -> Bool {
        let rarityHints = [" CHR", " CSR", " AR", " SAR", " SR", " HR", " UR"]
        return rarityHints.contains { text.contains($0) }
    }

    private func firstCaptureGroup(in text: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }

        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              match.numberOfRanges > 1,
              let captureRange = Range(match.range(at: 1), in: text) else {
            return nil
        }

        return String(text[captureRange])
    }
}
