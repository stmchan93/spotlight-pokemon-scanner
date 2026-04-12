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
    private enum SetHintMatchKind: String, Codable, Hashable, Sendable {
        case exact
        case fuzzy
    }

    private struct SetHintCandidate: Codable, Hashable, Sendable {
        let token: String
        let matchKind: SetHintMatchKind
    }

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
        let footerSatisfied = footerEvidenceSatisfiesEarlyExit(
            collector: collector,
            set: set,
            sceneTraits: sceneTraits
        )

        var reasons: [String] = []
        if (collector.confidence?.score ?? 0) < tuning.minimumCollectorConfidenceForStrongSignal {
            reasons.append("collector_signal_weak")
        }
        if !footerSatisfied,
           (title.confidence?.score ?? 0) < tuning.minimumTitleConfidenceForStrongSignal {
            reasons.append("title_signal_weak")
        }
        if (set.confidence?.score ?? 0) < tuning.minimumSetConfidenceForStrongSignal {
            reasons.append("set_signal_weak")
        }
        if footerSatisfied {
            reasons.append("footer_signal_sufficient_for_early_exit")
        }
        if sceneTraits.targetQualityScore < tuning.minimumTargetQualityForEscalation {
            reasons.append("target_quality_too_low_for_escalation")
        }

        let shouldEscalate =
            sceneTraits.targetQualityScore >= tuning.minimumTargetQualityForEscalation &&
            !footerSatisfied &&
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

    func deriveFooterRoutingContext(from broadPassResults: [RawOCRPassResult]) -> RawFooterRoutingContext {
        guard let footerBand = broadPassResults.first(where: { $0.kind == .footerBandWide }) else {
            return .none
        }

        if let anchor = deriveCollectorAnchor(from: footerBand) {
            return RawFooterRoutingContext(
                collectorAnchor: anchor.normalizedRect,
                anchorIdentifier: anchor.identifier,
                reasons: ["footer_band_collector_anchor"]
            )
        }

        if let parsed = parseCollector(from: footerBand.text, region: "bottom-full") {
            return RawFooterRoutingContext(
                collectorAnchor: nil,
                anchorIdentifier: parsed.identifier,
                reasons: ["footer_band_identifier_without_bbox"]
            )
        }

        return .none
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
        let titleCandidates = passResults
            .compactMap(makeTitleCandidate)
            .sorted { lhs, rhs in
                if lhs.selectionScore == rhs.selectionScore {
                    if lhs.averageConfidence == rhs.averageConfidence {
                        return titleReason(for: lhs.kind) < titleReason(for: rhs.kind)
                    }
                    return lhs.averageConfidence > rhs.averageConfidence
                }
                return lhs.selectionScore > rhs.selectionScore
            }
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
        let bandParsed = parseCollector(from: footerBand?.text, region: "bottom-full")
        let metadataCollectorCandidates = passResults
            .filter {
                $0.kind == .footerMetadata
                    ? $0.footerRole == .collector
                    : $0.kind == .footerLeft || $0.kind == .footerRight
            }
            .compactMap(makeMetadataCollectorCandidate)
        let bestMetadataCandidate = metadataCollectorCandidates.first
        let matchingMetadataCandidates = bandParsed.map { bandParsed in
            metadataCollectorCandidates.filter {
                normalizedCollectorIdentifier($0.identifier) == normalizedCollectorIdentifier(bandParsed.identifier)
            }
        } ?? []
        let metadataAgreementCandidate = bestRepeatedCollectorIdentifier(in: metadataCollectorCandidates)

        var reasons: [String] = []
        let exact: String?
        let agreementScore: Double?
        let baseScore: Double
        let wasCornerConfirmed: Bool

        if let bandParsed, !matchingMetadataCandidates.isEmpty {
            exact = bandParsed.identifier
            agreementScore = 0.90
            baseScore = 0.92
            wasCornerConfirmed = true
            reasons = ["rewrite_raw_footer_band_metadata_agreement"]
        } else if let metadataAgreementCandidate {
            exact = metadataAgreementCandidate.identifier
            agreementScore = 0.92
            baseScore = 0.94
            wasCornerConfirmed = true
            reasons = ["rewrite_raw_footer_metadata_families_agree"]
        } else if let bestMetadataCandidate {
            exact = bestMetadataCandidate.identifier
            agreementScore = nil
            baseScore = clamp01(0.76 + (bestMetadataCandidate.selectionScore * 0.16))
            wasCornerConfirmed = false
            reasons = ["rewrite_raw_footer_metadata_collector"]
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

        let partial = exact == nil ? partialCollectorHint(
            from: metadataCollectorCandidates.map(\.sourceText) + [footerBand?.text]
        ) : nil
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

    private func footerEvidenceSatisfiesEarlyExit(
        collector: RawResolvedCollectorEvidence,
        set: RawResolvedSetEvidence,
        sceneTraits: RawSceneTraits
    ) -> Bool {
        let collectorScore = collector.confidence?.score ?? 0
        let setScore = set.confidence?.score ?? 0
        let minimumSetScore = max(0.58, tuning.minimumSetConfidenceForStrongSignal - 0.04)
        let minimumCornerConfirmedSetScore = sceneTraits.usedFallback ? 0.56 : 0.48

        if collector.wasCornerConfirmed,
           collector.exact != nil,
           collectorScore >= 0.82,
           setScore >= minimumCornerConfirmedSetScore {
            return true
        }

        if collector.exact != nil,
           collectorScore >= 0.78,
           setScore >= minimumSetScore {
            return true
        }

        if isPromoStyleCollectorHint(collector.partial ?? collector.exact),
           collectorScore >= 0.70,
           setScore >= minimumSetScore {
            return true
        }

        return false
    }

    private func resolveSetEvidence(from passResults: [RawOCRPassResult]) -> RawResolvedSetEvidence {
        let footerBandText = passResults.first(where: { $0.kind == .footerBandWide })?.text ?? ""
        let headerText = passResults.first(where: { $0.kind == .headerWide })?.text ?? ""
        let metadataCollectorFamilies = Set(
            passResults
                .filter {
                    $0.kind == .footerMetadata
                        ? $0.footerRole == .collector
                        : $0.kind == .footerLeft || $0.kind == .footerRight
                }
                .compactMap { result -> RawFooterFamily? in
                    guard parseCollector(from: result.text, region: result.label) != nil else { return nil }
                    return result.footerFamily
                }
        )
        let setBadgePasses = passResults.filter {
            if $0.kind == .footerMetadata {
                return $0.footerRole == .setBadge &&
                    (
                        metadataCollectorFamilies.isEmpty ||
                        ($0.footerFamily.map { metadataCollectorFamilies.contains($0) } ?? false)
                    )
            }
            return $0.kind == .footerLeft || $0.kind == .footerRight
        }

        let broadHints = extractSetHintCandidates(from: [footerBandText, headerText])
        let familyHints = extractSetHintCandidates(from: setBadgePasses.map(\.text))
        let mergedHints = Array(Set((broadHints + familyHints).map(\.token))).sorted()

        guard !mergedHints.isEmpty else {
            return RawResolvedSetEvidence(hints: [], confidence: nil)
        }

        let broadHintLookup = Dictionary(uniqueKeysWithValues: broadHints.map { ($0.token, $0.matchKind) })
        let familyHintLookup = Dictionary(uniqueKeysWithValues: familyHints.map { ($0.token, $0.matchKind) })
        let agreement = Set(broadHintLookup.keys).intersection(Set(familyHintLookup.keys))
        let broadHasOnlyFuzzy = !broadHints.isEmpty && broadHints.allSatisfy { $0.matchKind == .fuzzy }
        let familyHasOnlyFuzzy = !familyHints.isEmpty && familyHints.allSatisfy { $0.matchKind == .fuzzy }
        let agreementIncludesOnlyFuzzy = !agreement.isEmpty && agreement.allSatisfy { token in
            broadHintLookup[token] == .fuzzy && familyHintLookup[token] == .fuzzy
        }
        let score: Double
        let reasons: [String]
        if !agreement.isEmpty {
            score = agreementIncludesOnlyFuzzy ? 0.62 : 0.74
            reasons = agreementIncludesOnlyFuzzy
                ? ["rewrite_raw_footer_band_set_hints", "rewrite_raw_footer_family_set_agreement", "rewrite_raw_fuzzy_set_hints"]
                : ["rewrite_raw_footer_band_set_hints", "rewrite_raw_footer_family_set_agreement"]
        } else if !familyHints.isEmpty {
            if familyHasOnlyFuzzy {
                score = metadataCollectorFamilies.isEmpty ? 0.40 : 0.46
                reasons = ["rewrite_raw_footer_family_set_hints", "rewrite_raw_fuzzy_set_hints"]
            } else {
                score = metadataCollectorFamilies.isEmpty ? 0.56 : 0.62
                reasons = ["rewrite_raw_footer_family_set_hints"]
            }
        } else {
            score = broadHasOnlyFuzzy ? 0.30 : 0.48
            reasons = broadHasOnlyFuzzy
                ? ["rewrite_raw_footer_band_set_hints", "rewrite_raw_fuzzy_set_hints"]
                : ["rewrite_raw_footer_band_set_hints"]
        }

        return RawResolvedSetEvidence(
            hints: mergedHints,
            confidence: OCRFieldConfidence(
                score: score,
                agreementScore: !agreement.isEmpty ? 0.76 : nil,
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

    private func isPromoStyleCollectorHint(_ value: String?) -> Bool {
        guard let value = value?
            .uppercased()
            .replacingOccurrences(of: #"\s+"#, with: "", options: .regularExpression),
            !value.isEmpty else {
            return false
        }

        return value.range(
            of: #"^(?:SVP|SWSH|SM|XY|BW|DP|HGSS|POP|PR)\d{1,3}$"#,
            options: .regularExpression
        ) != nil
    }

    private func extractSetHintCandidates(from texts: [String]) -> [SetHintCandidate] {
        var hints: [String: SetHintCandidate] = [:]
        let alphanumericPattern = #"\b([A-Z]{1,4}\d{1,3}[A-Z]{0,2})\b"#
        let spacedLanguagePattern = #"\b([A-Z]{2,5})\s+(?:EN|JP|DE|FR|IT|ES|PT)\b"#
        let alphaOnlyPattern = #"\b([A-Z]{3,5})\b"#

        for text in texts {
            let normalizedText = normalizedSetHintText(text)

            for match in captureGroups(in: normalizedText, pattern: alphanumericPattern) {
                if let hint = normalizedSetHintCandidate(match) {
                    mergeSetHintCandidate(hint, into: &hints)
                }
            }

            for match in captureGroups(in: normalizedText, pattern: spacedLanguagePattern) {
                if let hint = normalizedSetHintCandidate(match) {
                    mergeSetHintCandidate(hint, into: &hints)
                }
            }

            for match in captureGroups(in: normalizedText, pattern: alphaOnlyPattern) {
                if let hint = normalizedSetHintCandidate(match) {
                    mergeSetHintCandidate(hint, into: &hints)
                }
            }
        }

        return hints.values.sorted { lhs, rhs in
            lhs.token < rhs.token
        }
    }

    private func bestParsedIdentifier(candidates: [ParsedCardIdentifier?]) -> ParsedCardIdentifier? {
        candidates
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

    private func mergeSetHintCandidate(
        _ candidate: SetHintCandidate,
        into candidates: inout [String: SetHintCandidate]
    ) {
        guard let existing = candidates[candidate.token] else {
            candidates[candidate.token] = candidate
            return
        }
        if existing.matchKind == .fuzzy && candidate.matchKind == .exact {
            candidates[candidate.token] = candidate
        }
    }

    private func normalizedSetHintCandidate(_ token: String) -> SetHintCandidate? {
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
            if knownAlphaOnlyHints.contains(lowercased) {
                return SetHintCandidate(token: lowercased, matchKind: .exact)
            }
            guard let fuzzyHint = nearestKnownAlphaOnlyHint(
                to: lowercased,
                knownHints: knownAlphaOnlyHints
            ) else {
                return nil
            }
            return SetHintCandidate(token: fuzzyHint, matchKind: .fuzzy)
        }

        guard normalized.range(of: #"^[A-Z]{1,4}\d{1,3}[A-Z]{0,2}$"#, options: .regularExpression) != nil else {
            return nil
        }

        return SetHintCandidate(token: normalized.lowercased(), matchKind: .exact)
    }

    private func nearestKnownAlphaOnlyHint(
        to token: String,
        knownHints: Set<String>
    ) -> String? {
        let candidates = knownHints.compactMap { hint -> (String, Int)? in
            let distance = levenshteinDistance(between: token, and: hint)
            guard distance <= 1 else { return nil }
            return (hint, distance)
        }.sorted { lhs, rhs in
            if lhs.1 == rhs.1 {
                return lhs.0 < rhs.0
            }
            return lhs.1 < rhs.1
        }

        guard let best = candidates.first else { return nil }
        if candidates.count > 1, candidates[1].1 == best.1 {
            return nil
        }
        return best.0
    }

    private func levenshteinDistance(between lhs: String, and rhs: String) -> Int {
        let lhsCharacters = Array(lhs)
        let rhsCharacters = Array(rhs)
        guard !lhsCharacters.isEmpty else { return rhsCharacters.count }
        guard !rhsCharacters.isEmpty else { return lhsCharacters.count }

        var previousRow = Array(0...rhsCharacters.count)
        for (lhsIndex, lhsCharacter) in lhsCharacters.enumerated() {
            var currentRow = [lhsIndex + 1]
            for (rhsIndex, rhsCharacter) in rhsCharacters.enumerated() {
                let substitutionCost = lhsCharacter == rhsCharacter ? 0 : 1
                currentRow.append(
                    min(
                        previousRow[rhsIndex + 1] + 1,
                        currentRow[rhsIndex] + 1,
                        previousRow[rhsIndex] + substitutionCost
                    )
                )
            }
            previousRow = currentRow
        }

        return previousRow.last ?? max(lhsCharacters.count, rhsCharacters.count)
    }

    private func makeTitleCandidate(from result: RawOCRPassResult) -> RawTitleCandidate? {
        guard result.kind == .headerWide,
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
        case .headerWide:
            return 0.08
        case .footerBandWide, .footerLeft, .footerRight, .footerMetadata:
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
        case .footerBandWide, .footerLeft, .footerRight, .footerMetadata:
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

    private func deriveCollectorAnchor(from result: RawOCRPassResult) -> RawFooterAnchorCandidate? {
        let orderedTokens = result.tokens.sorted { lhs, rhs in
            let lhsX = lhs.normalizedBoundingBox?.x ?? 0
            let rhsX = rhs.normalizedBoundingBox?.x ?? 0
            return lhsX < rhsX
        }

        var candidates: [RawFooterAnchorCandidate] = []

        for windowSize in 1...3 {
            guard orderedTokens.count >= windowSize else { continue }
            for startIndex in 0...(orderedTokens.count - windowSize) {
                let window = Array(orderedTokens[startIndex..<(startIndex + windowSize)])
                guard let boundingBox = unionBoundingBox(for: window) else { continue }
                let joinedText = window.map(\.text).joined(separator: " ")
                guard let parsed = parseCollector(from: joinedText, region: "bottom-full") else { continue }

                let averageConfidence = Double(window.map(\.confidence).reduce(0, +)) / Double(window.count)
                var score = Double(parsed.confidence) + averageConfidence
                if windowSize == 1 {
                    score += 0.25
                } else {
                    score -= Double(windowSize - 1) * 0.06
                }

                candidates.append(
                    RawFooterAnchorCandidate(
                        identifier: parsed.identifier,
                        normalizedRect: boundingBox,
                        selectionScore: score
                    )
                )
            }
        }

        return candidates.sorted { lhs, rhs in
            if lhs.selectionScore == rhs.selectionScore {
                return lhs.identifier < rhs.identifier
            }
            return lhs.selectionScore > rhs.selectionScore
        }.first
    }

    private func makeMetadataCollectorCandidate(from result: RawOCRPassResult) -> RawMetadataCollectorCandidate? {
        guard let parsed = parseCollector(from: result.text, region: result.label) else {
            return nil
        }

        return RawMetadataCollectorCandidate(
            family: result.footerFamily,
            identifier: parsed.identifier,
            selectionScore: clamp01(Double(parsed.confidence) * 0.60 + result.averageConfidence * 0.40),
            sourceText: result.text
        )
    }

    private func bestRepeatedCollectorIdentifier(
        in candidates: [RawMetadataCollectorCandidate]
    ) -> RawMetadataCollectorCandidate? {
        let grouped = Dictionary(grouping: candidates) {
            normalizedCollectorIdentifier($0.identifier)
        }

        return grouped.values
            .filter { $0.count >= 2 }
            .compactMap { group in
                group.sorted { lhs, rhs in
                    lhs.selectionScore > rhs.selectionScore
                }.first
            }
            .sorted { lhs, rhs in
                lhs.selectionScore > rhs.selectionScore
            }
            .first
    }

    private func unionBoundingBox(for tokens: [RecognizedToken]) -> OCRNormalizedRect? {
        let rects = tokens.compactMap(\.normalizedBoundingBox)
        guard rects.count == tokens.count, !rects.isEmpty else {
            return nil
        }

        let minX = rects.map(\.x).min() ?? 0
        let minY = rects.map(\.y).min() ?? 0
        let maxX = rects.map { $0.x + $0.width }.max() ?? minX
        let maxY = rects.map { $0.y + $0.height }.max() ?? minY

        return OCRNormalizedRect(
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY
        )
    }
}

private struct RawTitleCandidate {
    let kind: RawROIKind
    let text: String
    let averageConfidence: Double
    let selectionScore: Double
}

private struct RawFooterAnchorCandidate {
    let identifier: String
    let normalizedRect: OCRNormalizedRect
    let selectionScore: Double
}

private struct RawMetadataCollectorCandidate {
    let family: RawFooterFamily?
    let identifier: String
    let selectionScore: Double
    let sourceText: String
}
