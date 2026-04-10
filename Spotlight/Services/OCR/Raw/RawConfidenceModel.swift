import Foundation

struct RawStageAssessment: Codable, Hashable, Sendable {
    let titleTextPrimary: String?
    let titleConfidenceScore: Double
    let collectorNumberExact: String?
    let setHintTokens: [String]
    let shouldEscalate: Bool
    let reasons: [String]
}

struct RawResolvedTitleEvidence: Codable, Hashable, Sendable {
    let primaryText: String?
    let secondaryText: String?
    let confidence: OCRFieldConfidence?

    var isStrong: Bool {
        (confidence?.score ?? 0) >= 0.46 && (primaryText?.count ?? 0) >= 4
    }
}

struct RawResolvedCollectorEvidence: Codable, Hashable, Sendable {
    let exact: String?
    let partial: String?
    let confidence: OCRFieldConfidence?
    let wasCornerConfirmed: Bool
}

struct RawResolvedSetEvidence: Codable, Hashable, Sendable {
    let hints: [String]
    let confidence: OCRFieldConfidence?
}

struct RawEvidenceConfidenceSummary: Codable, Hashable, Sendable {
    let title: RawResolvedTitleEvidence
    let collector: RawResolvedCollectorEvidence
    let set: RawResolvedSetEvidence
    let overallScore: Double
}

struct RawConfidenceModel {
    private let tuning: OCRTuning.Raw
    private let parser = CardIdentifierParser()

    init(tuning: OCRTuning.Raw = .default) {
        self.tuning = tuning
    }

    func assessStage1(
        passResults: [RawOCRPassResult],
        sceneTraits: RawSceneTraits
    ) -> RawStageAssessment {
        let title = resolveTitleEvidence(from: passResults)
        let collector = resolveCollectorEvidence(from: passResults)
        let set = resolveSetEvidence(from: passResults)

        var reasons: [String] = []
        if (collector.confidence?.score ?? 0) < tuning.minimumCollectorConfidenceForStrongSignal {
            reasons.append("collector_signal_weak")
        }
        if (title.confidence?.score ?? 0) < tuning.minimumTitleConfidenceForStrongSignal {
            reasons.append("title_signal_weak")
        }
        if (set.confidence?.score ?? 0) < tuning.minimumSetConfidenceForStrongSignal {
            reasons.append("set_signal_weak")
        }
        if sceneTraits.targetQualityScore < tuning.minimumTargetQualityForEscalation {
            reasons.append("target_quality_too_low_for_escalation")
        }

        let shouldEscalate =
            sceneTraits.targetQualityScore >= tuning.minimumTargetQualityForEscalation &&
            (
                (collector.confidence?.score ?? 0) < tuning.minimumCollectorConfidenceForStrongSignal ||
                (title.confidence?.score ?? 0) < tuning.minimumTitleConfidenceForStrongSignal ||
                (set.confidence?.score ?? 0) < tuning.minimumSetConfidenceForStrongSignal
            )

        return RawStageAssessment(
            titleTextPrimary: title.primaryText,
            titleConfidenceScore: title.confidence?.score ?? 0,
            collectorNumberExact: collector.exact,
            setHintTokens: set.hints,
            shouldEscalate: shouldEscalate,
            reasons: reasons
        )
    }

    func summarizeEvidence(from passResults: [RawOCRPassResult]) -> RawEvidenceConfidenceSummary {
        let title = resolveTitleEvidence(from: passResults)
        let collector = resolveCollectorEvidence(from: passResults)
        let set = resolveSetEvidence(from: passResults)

        let overallScore = clamp01(
            ((title.confidence?.score ?? 0) * 0.40) +
            ((collector.confidence?.score ?? 0) * 0.40) +
            ((set.confidence?.score ?? 0) * 0.20)
        )

        return RawEvidenceConfidenceSummary(
            title: title,
            collector: collector,
            set: set,
            overallScore: overallScore
        )
    }

    func shouldRetryWithStillPhoto(
        captureSource: ScanCaptureSource,
        summary: RawEvidenceConfidenceSummary,
        targetQualityScore: Double
    ) -> Bool {
        // Temporary debugging mode: keep the original tap-time preview frame authoritative.
        // Automatic still-photo retries can capture a different scene than the user intended.
        _ = captureSource
        _ = summary
        _ = targetQualityScore
        return false
    }

    private func resolveTitleEvidence(from passResults: [RawOCRPassResult]) -> RawResolvedTitleEvidence {
        let titleCandidates = passResults.compactMap(makeTitleCandidate)
        guard let primary = titleCandidates.first else {
            return RawResolvedTitleEvidence(primaryText: nil, secondaryText: nil, confidence: nil)
        }

        let secondary = titleCandidates.first(where: {
            normalizedComparable($0.text) != normalizedComparable(primary.text)
        })
        let agreementScore = secondary.map { titleAgreementScore(header: primary.text, nameplate: $0.text) } ?? nil
        var score = primary.selectionScore
        if let agreementScore {
            score += agreementScore * 0.18
        }
        if primary.text.count < tuning.minimumTitleLengthForStrongSignal {
            score -= 0.14
        }
        if secondary != nil {
            score += 0.05
        }

        var reasons = [titleReason(for: primary.kind)]
        if let secondary {
            reasons.append(titleReason(for: secondary.kind))
        }
        if agreementScore != nil {
            reasons.append("rewrite_raw_title_region_agreement")
        }

        return RawResolvedTitleEvidence(
            primaryText: primary.text,
            secondaryText: secondary?.text,
            confidence: OCRFieldConfidence(
                score: clamp01(max(score, 0.18)),
                agreementScore: agreementScore,
                tokenConfidenceAverage: clamp01(primary.averageConfidence),
                reasons: Array(NSOrderedSet(array: reasons)) as? [String] ?? reasons
            )
        )
    }

    private func resolveCollectorEvidence(from passResults: [RawOCRPassResult]) -> RawResolvedCollectorEvidence {
        let footerBand = passResults.first(where: { $0.kind == .footerBandWide })
        let footerLeft = passResults.first(where: { $0.kind == .footerLeft })
        let footerRight = passResults.first(where: { $0.kind == .footerRight })

        let bandParsed = parseCollector(from: footerBand?.text, region: "bottom-full")
        let leftParsed = parseCollector(from: footerLeft?.text, region: "bottom-left")
        let rightParsed = parseCollector(from: footerRight?.text, region: "bottom-right")
        let cornerBestParsed = bestParsedIdentifier(left: leftParsed, right: rightParsed)

        var reasons: [String] = []
        let exact: String?
        let agreementScore: Double?
        let baseScore: Double
        let wasCornerConfirmed: Bool

        if let leftParsed,
           let rightParsed,
           normalizedCollectorIdentifier(leftParsed.identifier) == normalizedCollectorIdentifier(rightParsed.identifier) {
            exact = leftParsed.identifier
            agreementScore = 0.92
            baseScore = 0.94
            wasCornerConfirmed = true
            reasons = ["rewrite_raw_footer_corners_confirm"]
        } else if let bandParsed,
                  let cornerBestParsed,
                  normalizedCollectorIdentifier(bandParsed.identifier) == normalizedCollectorIdentifier(cornerBestParsed.identifier) {
            exact = bandParsed.identifier
            agreementScore = 0.82
            baseScore = 0.88
            wasCornerConfirmed = true
            reasons = ["rewrite_raw_footer_band_corner_agreement"]
        } else if let bandParsed, cornerBestParsed != nil {
            exact = bandParsed.identifier
            agreementScore = nil
            baseScore = 0.74
            wasCornerConfirmed = false
            reasons = ["rewrite_raw_footer_band_preferred_over_single_corner"]
        } else if let cornerBestParsed {
            exact = cornerBestParsed.identifier
            agreementScore = nil
            baseScore = 0.68
            wasCornerConfirmed = false
            reasons = ["rewrite_raw_footer_corner_exact"]
        } else if let bandParsed {
            exact = bandParsed.identifier
            agreementScore = nil
            baseScore = 0.66
            wasCornerConfirmed = false
            reasons = ["rewrite_raw_footer_band_wide"]
        } else {
            exact = nil
            agreementScore = nil
            baseScore = 0
            wasCornerConfirmed = false
        }

        let partial = exact == nil ? partialCollectorHint(from: [footerLeft?.text, footerRight?.text, footerBand?.text]) : nil
        let confidence: OCRFieldConfidence? = {
            if let exact {
                _ = exact
                return OCRFieldConfidence(
                    score: clamp01(baseScore),
                    agreementScore: agreementScore,
                    tokenConfidenceAverage: nil,
                    reasons: reasons
                )
            }
            if partial != nil {
                return OCRFieldConfidence(
                    score: 0.42,
                    agreementScore: nil,
                    tokenConfidenceAverage: nil,
                    reasons: ["rewrite_raw_partial_collector_hint"]
                )
            }
            return nil
        }()

        return RawResolvedCollectorEvidence(
            exact: exact,
            partial: partial,
            confidence: confidence,
            wasCornerConfirmed: wasCornerConfirmed
        )
    }

    private func resolveSetEvidence(from passResults: [RawOCRPassResult]) -> RawResolvedSetEvidence {
        let footerBandText = passResults.first(where: { $0.kind == .footerBandWide })?.text ?? ""
        let footerLeftText = passResults.first(where: { $0.kind == .footerLeft })?.text ?? ""
        let footerRightText = passResults.first(where: { $0.kind == .footerRight })?.text ?? ""
        let headerText = passResults.first(where: { $0.kind == .headerWide })?.text ?? ""
        let titleBandText = passResults.first(where: { $0.kind == .titleBandExpanded })?.text ?? ""
        let nameplateText = passResults.first(where: { $0.kind == .nameplateTight })?.text ?? ""

        let broadHints = extractSetHintTokens(from: [footerBandText, headerText, titleBandText, nameplateText])
        let cornerHints = extractSetHintTokens(from: [footerLeftText, footerRightText])
        let mergedHints = Array(Set(broadHints + cornerHints)).sorted()

        guard !mergedHints.isEmpty else {
            return RawResolvedSetEvidence(hints: [], confidence: nil)
        }

        let agreement = Set(broadHints).intersection(Set(cornerHints))
        let score: Double
        let reasons: [String]
        if !agreement.isEmpty {
            score = 0.74
            reasons = ["rewrite_raw_footer_band_set_hints", "rewrite_raw_footer_corner_set_agreement"]
        } else if !cornerHints.isEmpty {
            score = 0.60
            reasons = ["rewrite_raw_footer_corners_set_hints"]
        } else {
            score = 0.52
            reasons = ["rewrite_raw_footer_band_set_hints"]
        }

        return RawResolvedSetEvidence(
            hints: mergedHints,
            confidence: OCRFieldConfidence(
                score: score,
                agreementScore: agreement.isEmpty ? nil : 0.76,
                tokenConfidenceAverage: nil,
                reasons: reasons
            )
        )
    }

    private func parseCollector(from text: String?, region: String) -> ParsedCardIdentifier? {
        guard let text = text, !text.isEmpty else { return nil }
        guard let parsed = parser.parse(text: text, sourceRegion: region) else {
            return nil
        }
        return isPlausibleCollectorNumber(parsed.identifier) ? parsed : nil
    }

    private func partialCollectorHint(from texts: [String?]) -> String? {
        for rawText in texts {
            guard let rawText, !rawText.isEmpty else { continue }
            let normalized = normalizeConfusableLatinCharacters(in: rawText).uppercased()
            if let promo = firstMatch(in: normalized, pattern: #"\b(?:SVP|SWSH|SM|XY|BW|DP|HGSS|POP|PR)\s?\d{1,3}\b"#) {
                return promo.replacingOccurrences(of: #"\s+"#, with: "", options: .regularExpression)
            }
            if let numberOnly = firstMatch(in: normalized, pattern: #"(?<![#A-Z0-9])\b\d{2,3}\b"#) {
                return numberOnly
            }
        }
        return nil
    }

    private func extractSetHintTokens(from texts: [String]) -> [String] {
        var hints = Set<String>()
        let alphanumericPattern = #"\b([A-Z]{1,4}\d{1,3}[A-Z]{0,2})\b"#
        let spacedLanguagePattern = #"\b([A-Z]{2,5})\s+(?:EN|JP|DE|FR|IT|ES|PT)\b"#

        for text in texts {
            let normalizedText = normalizedSetHintText(text)

            for match in captureGroups(in: normalizedText, pattern: alphanumericPattern) {
                if let hint = normalizedSetHintToken(match) {
                    hints.insert(hint)
                }
            }

            for match in captureGroups(in: normalizedText, pattern: spacedLanguagePattern) {
                if let hint = normalizedSetHintToken(match) {
                    hints.insert(hint)
                }
            }
        }

        return hints.sorted()
    }

    private func bestParsedIdentifier(left: ParsedCardIdentifier?, right: ParsedCardIdentifier?) -> ParsedCardIdentifier? {
        [left, right]
            .compactMap { $0 }
            .filter { isPlausibleCollectorNumber($0.identifier) }
            .sorted { lhs, rhs in
                if lhs.confidence == rhs.confidence {
                    return lhs.sourceRegion < rhs.sourceRegion
                }
                return lhs.confidence > rhs.confidence
            }
            .first
    }

    private func isPlausibleCollectorNumber(_ identifier: String) -> Bool {
        let parts = identifier.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2 else {
            return true
        }

        let numeratorRaw = String(parts[0]).uppercased()
        let denominatorRaw = String(parts[1]).uppercased()
        let numeratorLetters = String(numeratorRaw.prefix { $0.isLetter })
        let denominatorLetters = String(denominatorRaw.prefix { $0.isLetter })

        if !numeratorLetters.isEmpty || !denominatorLetters.isEmpty {
            let allowedSlashPrefixes = Set(["TG", "GG"])
            guard !numeratorLetters.isEmpty,
                  numeratorLetters == denominatorLetters,
                  allowedSlashPrefixes.contains(numeratorLetters),
                  Int(numeratorRaw.dropFirst(numeratorLetters.count)) != nil,
                  Int(denominatorRaw.dropFirst(denominatorLetters.count)) != nil else {
                return false
            }
            return true
        }

        guard let numerator = Int(parts[0]),
              let denominator = Int(parts[1]) else {
            return true
        }

        guard denominator >= 10 else { return false }
        guard numerator > 0 else { return false }
        return true
    }

    private func normalizedSetHintText(_ text: String) -> String {
        normalizeConfusableLatinCharacters(in: text)
            .uppercased()
            .replacingOccurrences(of: #"[§$](?=\d{1,3}[A-Z]{0,2}\b)"#, with: "S", options: .regularExpression)
    }

    private func normalizedSetHintToken(_ token: String) -> String? {
        let knownAlphaOnlyHints = Set([
            "dri", "obf", "pal", "mew", "gg", "crz", "svp", "prsv", "pr-sv",
            "par", "svi", "brs", "lor", "ssp", "meg",
        ])
        var normalized = token
            .uppercased()
            .replacingOccurrences(of: #"[^A-Z0-9]"#, with: "", options: .regularExpression)

        guard !normalized.isEmpty else { return nil }

        for suffix in ["EN", "JP", "DE", "FR", "IT", "ES", "PT"] where normalized.hasSuffix(suffix) && normalized.count > suffix.count + 1 {
            normalized.removeLast(suffix.count)
            break
        }

        guard normalized.count >= 3 else { return nil }
        guard normalized.contains(where: \.isLetter) else { return nil }

        if normalized.hasPrefix("X"), normalized.dropFirst().allSatisfy(\.isNumber) {
            return nil
        }

        if normalized.allSatisfy(\.isLetter) {
            let lowercased = normalized.lowercased()
            return knownAlphaOnlyHints.contains(lowercased) ? lowercased : nil
        }

        guard normalized.range(of: #"^[A-Z]{1,4}\d{1,3}[A-Z]{0,2}$"#, options: .regularExpression) != nil else {
            return nil
        }

        return normalized.lowercased()
    }

    private func makeTitleCandidate(from result: RawOCRPassResult) -> RawTitleCandidate? {
        guard [.headerWide, .titleBandExpanded, .nameplateTight].contains(result.kind),
              let text = sanitizedTitleCandidate(from: result.text) else {
            return nil
        }

        var selectionScore = result.averageConfidence + titleSourceBoost(for: result.kind)
        selectionScore += titlePlausibilityBoost(for: text)

        return RawTitleCandidate(
            kind: result.kind,
            text: text,
            averageConfidence: result.averageConfidence,
            selectionScore: clamp01(selectionScore)
        )
    }

    private func sanitizedTitleCandidate(from text: String?) -> String? {
        guard let text = trimmedNonEmpty(text) else { return nil }

        let normalized = normalizeConfusableLatinCharacters(in: text)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        let hardStopTokens = Set([
            "weakness", "resistance", "retreat", "cost", "lv", "lv.", "illus", "nintendo",
            "creatures", "gamefreak", "game", "freak", "pokemon"
        ])
        let leadingBodyTokens = Set([
            "you", "may", "play", "only", "during", "your", "turn", "search", "discard",
            "draw", "choose", "attach", "damage", "each", "flip"
        ])
        let titleNoiseTokens = Set([
            "evolves", "from", "put", "basic", "stage", "supporter", "trainer"
        ])

        let rawTokens = normalized.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !rawTokens.isEmpty else { return nil }

        let cleanedTokens = rawTokens.compactMap { rawToken -> String? in
            let cleaned = rawToken.trimmingCharacters(in: CharacterSet(charactersIn: ".,:;!?()[]{}<>|"))
            return cleaned.isEmpty ? nil : cleaned
        }

        var bestWindow: (text: String, score: Double)?
        for startIndex in cleanedTokens.indices {
            let token = cleanedTokens[startIndex]
            let lowercased = token.lowercased()

            if leadingBodyTokens.contains(lowercased) {
                continue
            }
            if hardStopTokens.contains(lowercased) || token.contains("/") {
                continue
            }
            if token.rangeOfCharacter(from: .letters) == nil {
                continue
            }

            var window: [String] = []
            for tokenIndex in startIndex..<cleanedTokens.count {
                let windowToken = cleanedTokens[tokenIndex]
                let lowercasedToken = windowToken.lowercased()

                if hardStopTokens.contains(lowercasedToken) || windowToken.contains("/") {
                    break
                }
                if lowercasedToken.hasPrefix("lv"), windowToken.count <= 4 {
                    break
                }
                if windowToken.rangeOfCharacter(from: .letters) == nil {
                    if window.isEmpty {
                        continue
                    }
                    break
                }

                window.append(windowToken)
                if window.count > 4 {
                    break
                }

                let candidate = window.joined(separator: " ")
                let alphaCount = candidate.unicodeScalars.filter { CharacterSet.letters.contains($0) }.count
                guard alphaCount >= 4 else { continue }

                var score = Double(alphaCount) * 0.02
                if window.contains(where: { $0.contains("'") || $0.contains(".") }) {
                    score += 0.14
                }
                if window.count >= 2 {
                    score += 0.12
                }
                if window.count <= 4 {
                    score += 0.06
                }
                let noiseCount = window.filter { titleNoiseTokens.contains($0.lowercased()) }.count
                score -= Double(noiseCount) * 0.08
                if leadingBodyTokens.contains(window.first?.lowercased() ?? "") {
                    score -= 0.24
                }

                if bestWindow == nil || score > (bestWindow?.score ?? 0) {
                    bestWindow = (candidate, score)
                }
            }
        }

        let candidate = bestWindow?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !candidate.isEmpty else { return nil }

        let alphaCount = candidate.unicodeScalars.filter { CharacterSet.letters.contains($0) }.count
        guard alphaCount >= 4 else { return nil }

        return candidate
    }

    private func titleSourceBoost(for kind: RawROIKind) -> Double {
        switch kind {
        case .nameplateTight:
            return 0.18
        case .titleBandExpanded:
            return 0.14
        case .headerWide:
            return 0.08
        case .footerBandWide, .footerLeft, .footerRight:
            return 0.0
        }
    }

    private func titlePlausibilityBoost(for text: String) -> Double {
        let lowercased = text.lowercased()
        let tokenCount = lowercased.split(whereSeparator: \.isWhitespace).count
        var boost = 0.0

        if text.contains("'") {
            boost += 0.08
        }
        if tokenCount >= 2 && tokenCount <= 4 {
            boost += 0.06
        }
        if lowercased.contains(" ex") || lowercased.hasSuffix(" ex") {
            boost += 0.05
        }

        let suspiciousPrefixes = ["you ", "may ", "play ", "only ", "during ", "search ", "discard "]
        if suspiciousPrefixes.contains(where: { lowercased.hasPrefix($0) }) {
            boost -= 0.18
        }

        return boost
    }

    private func titleReason(for kind: RawROIKind) -> String {
        switch kind {
        case .headerWide:
            return "rewrite_raw_header_wide"
        case .titleBandExpanded:
            return "rewrite_raw_title_band_expanded"
        case .nameplateTight:
            return "rewrite_raw_nameplate_tight"
        case .footerBandWide, .footerLeft, .footerRight:
            return "rewrite_raw_header_wide"
        }
    }

    private func titleAgreementScore(header: String?, nameplate: String?) -> Double? {
        guard let header = trimmedNonEmpty(header),
              let nameplate = trimmedNonEmpty(nameplate) else {
            return nil
        }

        let headerTokens = Set(header.lowercased().split(whereSeparator: \.isWhitespace).map(String.init))
        let nameplateTokens = Set(nameplate.lowercased().split(whereSeparator: \.isWhitespace).map(String.init))
        guard !headerTokens.isEmpty, !nameplateTokens.isEmpty else { return nil }

        let overlap = headerTokens.intersection(nameplateTokens)
        let union = headerTokens.union(nameplateTokens)
        guard !union.isEmpty else { return nil }
        return Double(overlap.count) / Double(union.count)
    }

    private func normalizedCollectorIdentifier(_ value: String?) -> String {
        guard let value else { return "" }
        return value
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .uppercased()
            .replacingOccurrences(of: #"\s+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s*/\s*"#, with: "/", options: .regularExpression)
    }

    private func normalizedComparable(_ value: String?) -> String {
        guard let value else { return "" }
        return value
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .lowercased()
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func trimmedNonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
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

    private func captureGroups(in text: String, pattern: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return []
        }

        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, options: [], range: range).compactMap { match in
            guard match.numberOfRanges > 1,
                  let captureRange = Range(match.range(at: 1), in: text) else {
                return nil
            }
            return String(text[captureRange])
        }
    }

    private func clamp01(_ value: Double) -> Double {
        min(max(value, 0), 1)
    }
}

private struct RawTitleCandidate {
    let kind: RawROIKind
    let text: String
    let averageConfidence: Double
    let selectionScore: Double
}
