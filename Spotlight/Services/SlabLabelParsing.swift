import Foundation

enum SlabVerificationMethod: String, Codable, Hashable, Sendable {
    case barcode
    case certOCR = "cert_ocr"
    case labelOCR = "label_ocr"
    case none
}

enum SlabRecommendedLookupPath: String, Codable, Hashable, Sendable {
    case psaCert = "psa_cert"
    case labelTextSearch = "label_text_search"
    case needsReview = "needs_review"
}

struct SlabVisualSignals: Codable, Hashable, Sendable {
    let redBandConfidence: Float
    let barcodeRegionConfidence: Float
    let rightColumnConfidence: Float
    let whitePanelConfidence: Float

    static let none = SlabVisualSignals(
        redBandConfidence: 0,
        barcodeRegionConfidence: 0,
        rightColumnConfidence: 0,
        whitePanelConfidence: 0
    )

    var psaStyleConfidence: Float {
        min(
            1,
            (redBandConfidence * 0.45)
                + (barcodeRegionConfidence * 0.30)
                + (rightColumnConfidence * 0.15)
                + (whitePanelConfidence * 0.10)
        )
    }
}

struct SlabLabelAnalysis: Hashable, Sendable {
    let parsedLabelText: [String]
    let normalizedLabelText: String
    let grader: String?
    let graderConfidence: Float
    let grade: String?
    let gradeRaw: String?
    let gradeConfidence: Float
    let certNumber: String?
    let certNumberRaw: String?
    let certConfidence: Float
    let cardNumberRaw: String?
    let barcodePayloads: [String]
    let verificationMethod: SlabVerificationMethod
    let visualSignals: SlabVisualSignals
    let reasons: [String]
    let recommendedLookupPath: SlabRecommendedLookupPath

    var isLikelySlab: Bool {
        graderConfidence >= 0.6
            || certConfidence >= 0.72
            || recommendedLookupPath != .needsReview
            || SlabLabelParser.looksLikeSlabText(normalizedLabelText)
    }
}

enum SlabLabelParser {
    static func analyze(
        labelText: String,
        barcodePayloads: [String] = [],
        visualSignals: SlabVisualSignals = .none
    ) -> SlabLabelAnalysis {
        analyze(
            labelTexts: [labelText],
            barcodePayloads: barcodePayloads,
            visualSignals: visualSignals
        )
    }

    static func analyze(
        labelTexts: [String],
        barcodePayloads: [String] = [],
        visualSignals: SlabVisualSignals = .none
    ) -> SlabLabelAnalysis {
        let normalizedSegments = dedupe(labelTexts.map(normalizeLabelText).filter { !$0.isEmpty })
        let normalizedLabelText = normalizedSegments.joined(separator: " ")
        let dedupedBarcodePayloads = dedupe(barcodePayloads)
        let normalizedBarcodeText = normalizeLabelText(dedupedBarcodePayloads.joined(separator: " "))
        let combinedText = [normalizedLabelText, normalizedBarcodeText]
            .filter { !$0.isEmpty }
            .joined(separator: " ")

        let certCandidate = resolveCertCandidate(
            normalizedLabelText: normalizedLabelText,
            barcodePayloads: dedupedBarcodePayloads
        )
        let cardNumberRaw = extractCardNumber(from: normalizedLabelText)
        let preliminaryPSAConfidence = inferredPSAConfidence(
            from: combinedText,
            certNumber: certCandidate.normalizedValue,
            cardNumberRaw: cardNumberRaw,
            visualSignals: visualSignals,
            includeGradeSignal: false
        )
        let provisionalGrader = parseExplicitGrader(from: combinedText)?.normalizedValue
            ?? (preliminaryPSAConfidence >= 0.45 ? "PSA" : nil)
        let gradeCandidate = resolveGradeCandidate(
            from: combinedText,
            grader: provisionalGrader,
            certNumber: certCandidate.normalizedValue
        )
        let graderCandidate = resolveGraderCandidate(
            from: combinedText,
            certNumber: certCandidate.normalizedValue,
            cardNumberRaw: cardNumberRaw,
            visualSignals: visualSignals,
            gradeCandidate: gradeCandidate
        )
        let verificationMethod: SlabVerificationMethod
        if certCandidate.source == .barcode {
            verificationMethod = .barcode
        } else if certCandidate.source == .labelOCR {
            verificationMethod = .certOCR
        } else if !normalizedLabelText.isEmpty {
            verificationMethod = .labelOCR
        } else {
            verificationMethod = .none
        }
        let recommendedLookupPath = recommendedLookupPath(
            grader: graderCandidate.normalizedValue,
            graderConfidence: graderCandidate.confidence,
            certNumber: certCandidate.normalizedValue,
            certConfidence: certCandidate.confidence,
            grade: gradeCandidate.normalizedValue,
            gradeConfidence: gradeCandidate.confidence
        )
        var reasons = graderCandidate.reasons
        reasons += certCandidate.reasons
        reasons += gradeCandidate.reasons
        reasons += visualReasons(from: visualSignals)
        if let cardNumberRaw {
            reasons.append("card_number:\(cardNumberRaw)")
        }
        reasons.append("lookup_path:\(recommendedLookupPath.rawValue)")
        reasons = dedupe(reasons)

        return SlabLabelAnalysis(
            parsedLabelText: normalizedSegments,
            normalizedLabelText: normalizedLabelText,
            grader: graderCandidate.normalizedValue,
            graderConfidence: graderCandidate.confidence,
            grade: gradeCandidate.normalizedValue,
            gradeRaw: gradeCandidate.rawValue,
            gradeConfidence: gradeCandidate.confidence,
            certNumber: certCandidate.normalizedValue,
            certNumberRaw: certCandidate.rawValue,
            certConfidence: certCandidate.confidence,
            cardNumberRaw: cardNumberRaw,
            barcodePayloads: dedupedBarcodePayloads,
            verificationMethod: verificationMethod,
            visualSignals: visualSignals,
            reasons: reasons,
            recommendedLookupPath: recommendedLookupPath
        )
    }

    static func looksLikeSlabText(_ normalizedLabelText: String) -> Bool {
        guard !normalizedLabelText.isEmpty else { return false }
        if parseExplicitGrader(from: normalizedLabelText)?.normalizedValue != nil {
            return true
        }

        let hasCertLikeNumber = extractCertNumber(from: normalizedLabelText) != nil
        let slabKeywords = [
            "POKEMON",
            "MINT",
            "GEM MT",
            "NM MT",
            "PRISTINE",
            "PERFECT",
            "CERT",
            "GRADE",
        ]
        let keywordHits = slabKeywords.filter(normalizedLabelText.contains).count
        return hasCertLikeNumber && keywordHits >= 1
    }

    static func normalizeLabelText(_ value: String) -> String {
        let latin = value.applyingTransform(.toLatin, reverse: false) ?? value
        return latin
            .uppercased()
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: #"[|]"#, with: "1", options: .regularExpression)
            .replacingOccurrences(of: #"[^A-Z0-9#./:&+\- ]+"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func extractCertNumber(from value: String) -> String? {
        let normalized = normalizeLabelText(value)
        guard !normalized.isEmpty else { return nil }

        let patterns = [
            #"(?:PSACARD|CGCCARDS|BECKETT|BGS)[^0-9]{0,24}(\d{7,10})"#,
            #"(?:CERT|CERTIFICATE|CERTNUMBER|VERIFY)[^0-9]{0,12}(\d{7,10})"#,
            #"/CERT/(\d{7,10})"#,
            #"\b(\d{7,10})\b"#,
        ]

        for pattern in patterns {
            if let match = normalized.firstCapturedGroup(of: pattern) {
                return match
            }
        }

        return nil
    }

    private static func resolveGradeCandidate(
        from normalizedText: String,
        grader: String?,
        certNumber: String?
    ) -> SlabFieldCandidate? {
        guard !normalizedText.isEmpty else { return nil }

        if grader == "PSA" {
            if let explicit = firstCapturedField(
                in: normalizedText,
                patterns: [
                    (#"\bGEM MT\s+(10|[1-9])\b"#, 0.97, "grade_from_psa_gem_mt"),
                    (#"\bGEM MINT\s+(10|[1-9])\b"#, 0.97, "grade_from_psa_gem_mint"),
                    (#"\bMINT\s+(10|[1-9])\b"#, 0.93, "grade_from_psa_mint"),
                    (#"\bNM MT\s+(10|[1-9])\b"#, 0.92, "grade_from_psa_nm_mt"),
                    (#"\bNM-MT\s+(10|[1-9])\b"#, 0.92, "grade_from_psa_nm_mt"),
                    (#"\bEX MT\s+(10|[1-9])\b"#, 0.90, "grade_from_psa_ex_mt"),
                    (#"\bEX-MT\s+(10|[1-9])\b"#, 0.90, "grade_from_psa_ex_mt"),
                    (#"\bVG EX\s+(10|[1-9])\b"#, 0.88, "grade_from_psa_vg_ex"),
                    (#"\bVG-EX\s+(10|[1-9])\b"#, 0.88, "grade_from_psa_vg_ex"),
                    (#"\bGOOD\s+(10|[1-9])\b"#, 0.86, "grade_from_psa_good"),
                    (#"\bFAIR\s+(10|[1-9](?:\.5)?)\b"#, 0.84, "grade_from_psa_fair"),
                    (#"\bPR\s+(10|[1-9])\b"#, 0.84, "grade_from_psa_poor"),
                    (#"\b(10|[1-9](?:\.5)?)\b(?=\s+PSA\b)"#, 0.96, "grade_before_psa_token"),
                    (#"\b(10|[1-9](?:\.5)?)\b(?=\s+(?:[A-Z]{2,4}\s+)?\d{7,10}\b)"#, 0.91, "grade_before_cert_number"),
                    (#"\bNM\b(?:\s+[A-Z][A-Z-]*){0,4}\s+(10|[1-9](?:\.5)?)\b(?:\s+(?:PSA|[A-Z]{2,4})\b|\s+\d{7,10}\b|$)(?:\s+\d{7,10}\b|$)"#, 0.94, "grade_from_nm_layout"),
                ]
            ) {
                return explicit
            }

            let adjectiveOnlyMappings: [(String, String)] = [
                (#"\bGEM MT\b"#, "10"),
                (#"\bGEM MINT\b"#, "10"),
                (#"\bMINT\b"#, "9"),
                (#"\bNM MT\b"#, "8"),
                (#"\bNM-MT\b"#, "8"),
                (#"\bEX MT\b"#, "6"),
                (#"\bEX-MT\b"#, "6"),
                (#"\bVG EX\b"#, "4"),
                (#"\bVG-EX\b"#, "4"),
                (#"\bGOOD\b"#, "2"),
                (#"\bFAIR\b"#, "1.5"),
                (#"\bPR\b"#, "1"),
            ]
            for (pattern, mappedGrade) in adjectiveOnlyMappings where normalizedText.containsMatch(of: pattern) {
                return SlabFieldCandidate(
                    rawValue: mappedGrade,
                    normalizedValue: mappedGrade,
                    confidence: 0.72,
                    reasons: ["grade_from_psa_adjective_only"]
                )
            }
        }

        if let genericGrade = firstCapturedField(
            in: normalizedText,
            patterns: [
                (#"\b(?:PRISTINE|PERFECT|GEM MINT|MINT|NM\/MT|NM-MT|NM MT|EX-MT|EX MT)\s+(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4\.5|4|3\.5|3|2\.5|2|1\.5|1)\b"#, 0.88, "grade_from_generic_slab_layout"),
                (#"\b(?:CGC|BGS|BECKETT)\b.{0,24}\b(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4\.5|4|3\.5|3|2\.5|2|1\.5|1)\b"#, 0.92, "grade_from_explicit_other_grader"),
                (#"\b(?:NM/MINT\+?|NM MINT\+?|NM\/MT\+?|NM-MT\+?|NM MT\+?)(?=\s)(?:\s+[A-Z][A-Z0-9()/#.+&:\-]*){0,4}\s+(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4\.5|4|3\.5|3|2\.5|2|1\.5|1)\b"#, 0.92, "grade_from_plus_layout"),
                (#"\b(?:GEM MINT|PRISTINE|PERFECT|MINT|NM/MINT\+?|NM MINT\+?|NM\/MT\+?|NM-MT\+?|NM MT\+?|NM\/MT|NM-MT|NM MT)(?:\s+[A-Z0-9()/#.+&:\-]+){0,10}\s+(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4\.5|4|3\.5|3|2\.5|2|1\.5|1)\b"#, 0.90, "grade_from_extended_slab_layout"),
                (#"\b(?:CGC|BGS|BECKETT)\b(?:\s+[A-Z0-9()/#.+&:\-]+){0,18}\s+(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4\.5|4|3\.5|3|2\.5|2|1\.5|1)\b"#, 0.90, "grade_from_explicit_other_grader_layout"),
            ]
        ) {
            return genericGrade
        }

        if certNumber != nil,
           let inferred = firstCapturedField(
                in: normalizedText,
                patterns: [
                    (#"\b(?:NM|MINT|GEM MT|GEM MINT)\b(?:\s+[A-Z][A-Z-]*){0,4}\s+(10|[1-9](?:\.5)?)\b(?:\s+[A-Z]{2,4}\b)?(?:\s+\d{7,10}\b|$)"#, 0.79, "grade_from_cert_aligned_layout")
                ]
           ) {
            return inferred
        }

        return nil
    }

    private static func resolveCertCandidate(
        normalizedLabelText: String,
        barcodePayloads: [String]
    ) -> SlabFieldCandidate? {
        for payload in barcodePayloads {
            if let certNumber = extractCertNumber(from: payload) {
                return SlabFieldCandidate(
                    rawValue: certNumber,
                    normalizedValue: certNumber,
                    confidence: 1.0,
                    reasons: ["cert_from_barcode"],
                    source: .barcode
                )
            }
        }

        guard let certNumber = extractCertNumber(from: normalizedLabelText) else { return nil }
        let confidence: Float = normalizedLabelText.containsMatch(of: #"(?:PSACARD|CGCCARDS|BECKETT|BGS|CERT|VERIFY)[^0-9]{0,24}\d{7,10}"#)
            ? 0.95
            : 0.88
        return SlabFieldCandidate(
            rawValue: certNumber,
            normalizedValue: certNumber,
            confidence: confidence,
            reasons: ["cert_from_label_ocr"],
            source: .labelOCR
        )
    }

    private static func resolveGraderCandidate(
        from normalizedText: String,
        certNumber: String?,
        cardNumberRaw: String?,
        visualSignals: SlabVisualSignals,
        gradeCandidate: SlabFieldCandidate?
    ) -> SlabFieldCandidate? {
        if let explicit = parseExplicitGrader(from: normalizedText) {
            return explicit
        }

        let psaInference = inferLikelyPSA(
            from: normalizedText,
            certNumber: certNumber,
            cardNumberRaw: cardNumberRaw,
            visualSignals: visualSignals,
            gradeCandidate: gradeCandidate
        )
        if psaInference.confidence >= 0.62 {
            return psaInference
        }
        return nil
    }

    private static func parseExplicitGrader(from normalizedText: String) -> SlabFieldCandidate? {
        guard !normalizedText.isEmpty else { return nil }

        if normalizedText.contains("PSA") || normalizedText.contains("PSACARD") {
            return SlabFieldCandidate(
                rawValue: "PSA",
                normalizedValue: "PSA",
                confidence: 1.0,
                reasons: ["explicit_grader_psa"]
            )
        }
        if normalizedText.contains("CGC") || normalizedText.contains("CGCCARDS") {
            return SlabFieldCandidate(
                rawValue: "CGC",
                normalizedValue: "CGC",
                confidence: 1.0,
                reasons: ["explicit_grader_cgc"]
            )
        }
        if normalizedText.contains("BGS") || normalizedText.contains("BECKETT") {
            return SlabFieldCandidate(
                rawValue: "BGS",
                normalizedValue: "BGS",
                confidence: 1.0,
                reasons: ["explicit_grader_bgs"]
            )
        }

        return nil
    }

    private static func inferLikelyPSA(
        from normalizedText: String,
        certNumber: String?,
        cardNumberRaw: String?,
        visualSignals: SlabVisualSignals,
        gradeCandidate: SlabFieldCandidate?
    ) -> SlabFieldCandidate? {
        guard certNumber != nil || looksLikeSlabText(normalizedText) else { return nil }

        var score = max(0, visualSignals.psaStyleConfidence * 0.48)
        var reasons = visualReasons(from: visualSignals)

        if certNumber != nil {
            score += 0.18
            reasons.append("cert_number_present")
        }
        if cardNumberRaw != nil && normalizedText.contains("POKEMON") {
            score += 0.10
            reasons.append("pokemon_card_number_layout")
        }
        if normalizedText.contains("NM")
            || normalizedText.contains("MINT")
            || normalizedText.contains("GEM MT")
            || normalizedText.contains("GEM MINT") {
            score += 0.08
            reasons.append("grade_adjective_detected")
        }
        if normalizedText.containsMatch(of: #"\bP[5S]A\b"#)
            || normalizedText.containsMatch(of: #"\bPSA?\b"#)
            || normalizedText.contains("FEA") {
            score += 0.12
            reasons.append("partial_psa_logo_token")
        }
        if gradeCandidate.normalizedValue != nil {
            score += min(0.16, gradeCandidate.confidence * 0.18)
            reasons.append("psa_grade_layout_detected")
        }

        let confidence = min(0.94, score)
        guard confidence > 0 else { return nil }
        return SlabFieldCandidate(
            rawValue: "PSA",
            normalizedValue: "PSA",
            confidence: confidence,
            reasons: dedupe(reasons + ["inferred_grader_psa"])
        )
    }

    private static func inferredPSAConfidence(
        from normalizedText: String,
        certNumber: String?,
        cardNumberRaw: String?,
        visualSignals: SlabVisualSignals,
        includeGradeSignal: Bool
    ) -> Float {
        guard certNumber != nil || looksLikeSlabText(normalizedText) else { return 0 }

        var score = max(0, visualSignals.psaStyleConfidence * 0.48)

        if certNumber != nil {
            score += 0.18
        }
        if cardNumberRaw != nil && normalizedText.contains("POKEMON") {
            score += 0.10
        }
        if normalizedText.contains("NM")
            || normalizedText.contains("MINT")
            || normalizedText.contains("GEM MT")
            || normalizedText.contains("GEM MINT") {
            score += 0.08
        }
        if normalizedText.containsMatch(of: #"\bP[5S]A\b"#)
            || normalizedText.containsMatch(of: #"\bPSA?\b"#)
            || normalizedText.contains("FEA") {
            score += 0.12
        }
        if includeGradeSignal,
           normalizedText.containsMatch(of: #"\b(?:NM|MINT|GEM MT|GEM MINT)\b(?:\s+[A-Z][A-Z-]*){0,4}\s+(10|[1-9](?:\.5)?)\b(?:\s+\d{7,10}\b|$)"#) {
            score += 0.14
        }

        return min(0.94, score)
    }

    private static func recommendedLookupPath(
        grader: String?,
        graderConfidence: Float,
        certNumber: String?,
        certConfidence: Float,
        grade: String?,
        gradeConfidence: Float
    ) -> SlabRecommendedLookupPath {
        if grader == "PSA",
           graderConfidence >= 0.62,
           certNumber != nil,
           certConfidence >= 0.85 {
            return .psaCert
        }

        if grader != nil,
           graderConfidence >= 0.6,
           (grade != nil || certNumber != nil || gradeConfidence >= 0.7) {
            return .labelTextSearch
        }

        return .needsReview
    }

    private static func visualReasons(from signals: SlabVisualSignals) -> [String] {
        var reasons: [String] = []
        if signals.redBandConfidence >= 0.55 {
            reasons.append("psa_red_band_detected")
        }
        if signals.barcodeRegionConfidence >= 0.45 {
            reasons.append("barcode_region_detected")
        }
        if signals.rightColumnConfidence >= 0.45 {
            reasons.append("right_column_layout_detected")
        }
        if signals.whitePanelConfidence >= 0.45 {
            reasons.append("white_label_panel_detected")
        }
        return reasons
    }

    private static func extractCardNumber(from normalizedText: String) -> String? {
        for pattern in [
            #"#\s*([A-Z0-9-]{1,8})\b"#,
            #"\bNO\.?\s*([A-Z0-9-]{1,8})\b"#,
            #"\b([A-Z]{0,4}\d{1,4}/[A-Z]{0,4}\d{1,4})\b"#,
        ] {
            if let match = normalizedText.firstCapturedGroup(of: pattern) {
                return match
            }
        }
        return nil
    }

    private static func firstCapturedField(
        in value: String,
        patterns: [(String, Float, String)]
    ) -> SlabFieldCandidate? {
        for (pattern, confidence, reason) in patterns {
            if let match = value.firstCapturedGroup(of: pattern) {
                let normalized = normalizeGrade(match)
                return SlabFieldCandidate(
                    rawValue: match,
                    normalizedValue: normalized,
                    confidence: confidence,
                    reasons: [reason]
                )
            }
        }
        return nil
    }

    private static func normalizeGrade(_ value: String) -> String {
        let cleaned = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.hasSuffix(".0") ? String(cleaned.dropLast(2)) : cleaned
    }

    private static func dedupe(_ values: [String]) -> [String] {
        var seen = Set<String>()
        var ordered: [String] = []
        for value in values {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, !seen.contains(trimmed) else { continue }
            seen.insert(trimmed)
            ordered.append(trimmed)
        }
        return ordered
    }
}

private struct SlabFieldCandidate {
    let rawValue: String?
    let normalizedValue: String?
    let confidence: Float
    let reasons: [String]
    let source: SlabVerificationMethod

    init(
        rawValue: String?,
        normalizedValue: String?,
        confidence: Float,
        reasons: [String],
        source: SlabVerificationMethod = .labelOCR
    ) {
        self.rawValue = rawValue
        self.normalizedValue = normalizedValue
        self.confidence = confidence
        self.reasons = reasons
        self.source = source
    }
}

private extension Optional where Wrapped == SlabFieldCandidate {
    var rawValue: String? { self?.rawValue }
    var normalizedValue: String? { self?.normalizedValue }
    var confidence: Float { self?.confidence ?? 0 }
    var reasons: [String] { self?.reasons ?? [] }
    var source: SlabVerificationMethod { self?.source ?? .none }
}

private extension String {
    func firstCapturedGroup(of pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }

        let range = NSRange(startIndex..., in: self)
        guard let match = regex.firstMatch(in: self, options: [], range: range),
              match.numberOfRanges > 1,
              let captureRange = Range(match.range(at: 1), in: self) else {
            return nil
        }

        return String(self[captureRange])
    }

    func containsMatch(of pattern: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return false
        }

        let range = NSRange(startIndex..., in: self)
        return regex.firstMatch(in: self, options: [], range: range) != nil
    }
}
