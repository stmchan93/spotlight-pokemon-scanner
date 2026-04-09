import Foundation

enum OCRTargetMode: String {
    case rawCard = "raw"

    var minimumSelectionScore: Double { 0.62 }
}

enum OCRTargetGeometryKind: String {
    case rawCard = "raw_card"
    case rawHolder = "raw_holder"
}

struct OCRTargetCandidateSummary {
    let rank: Int
    let areaCoverage: Double
    let aspectScore: Double
    let proximityScore: Double
    let totalScore: Double
    let geometryKind: OCRTargetGeometryKind
}

struct RawBroadOCRSignals {
    let primaryTitleText: String
    let secondaryTitleText: String?
    let titleConfidence: Double
    let secondaryTitleConfidence: Double
    let footerBandText: String
    let footerBandConfidence: Double
    let footerCollectorNumber: String?
    let footerSetHintTokens: [String]
    let cropConfidence: Double
}

struct RawFooterConfirmationSignals {
    let collectorNumber: String?
    let setHintTokens: [String]
}

struct RawCandidateHypothesis {
    let titleText: String
    let collectorNumber: String?
    let setHintTokens: [String]
    let score: Double
    let reasons: [String]
    let sourceLabels: [String]
    let footerConfirmed: Bool
}

func normalizedRawCollectorIdentifier(_ value: String) -> String {
    value
        .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        .uppercased()
        .replacingOccurrences(of: #"\s+"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: #"\s*/\s*"#, with: "/", options: .regularExpression)
}

func buildCoarseRawCandidateHypotheses(from signals: RawBroadOCRSignals) -> [RawCandidateHypothesis] {
    var hypotheses: [RawCandidateHypothesis] = []
    let footerHasCollector = signals.footerCollectorNumber != nil
    let footerHasSetHints = !signals.footerSetHintTokens.isEmpty
    let titleStrength = min(0.42, signals.titleConfidence * 0.42)
    let secondaryTitleStrength = min(0.30, signals.secondaryTitleConfidence * 0.30)
    let footerStrength = min(0.20, signals.footerBandConfidence * 0.20)
    let cropStrength = min(0.18, signals.cropConfidence * 0.18)
    let collectorStrength = footerHasCollector ? 0.18 : 0
    let setHintStrength = footerHasSetHints ? 0.08 : 0

    func appendHypothesis(titleText: String, titleScore: Double, sourceLabels: [String], baseBonus: Double) {
        let normalizedTitle = titleText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedTitle.isEmpty || !signals.footerBandText.isEmpty else { return }

        var reasons: [String] = []
        if !normalizedTitle.isEmpty { reasons.append("title/header candidate") }
        if !signals.footerBandText.isEmpty { reasons.append("footer band candidate") }
        if footerHasCollector { reasons.append("broad footer collector") }
        if footerHasSetHints { reasons.append("broad footer set hints") }

        hypotheses.append(
            RawCandidateHypothesis(
                titleText: normalizedTitle,
                collectorNumber: signals.footerCollectorNumber,
                setHintTokens: signals.footerSetHintTokens,
                score: baseBonus + titleScore + footerStrength + cropStrength + collectorStrength + setHintStrength,
                reasons: reasons,
                sourceLabels: sourceLabels,
                footerConfirmed: false
            )
        )
    }

    appendHypothesis(
        titleText: signals.primaryTitleText,
        titleScore: titleStrength,
        sourceLabels: ["title_header", "footer_full"],
        baseBonus: 0.18
    )

    if let secondaryTitleText = signals.secondaryTitleText,
       normalizedRawCollectorIdentifier(secondaryTitleText) != normalizedRawCollectorIdentifier(signals.primaryTitleText) {
        appendHypothesis(
            titleText: secondaryTitleText,
            titleScore: secondaryTitleStrength,
            sourceLabels: ["title_secondary", "footer_full"],
            baseBonus: 0.14
        )
    }

    if !signals.footerBandText.isEmpty {
        hypotheses.append(
            RawCandidateHypothesis(
                titleText: "",
                collectorNumber: signals.footerCollectorNumber,
                setHintTokens: signals.footerSetHintTokens,
                score: 0.14 + footerStrength + cropStrength + collectorStrength + setHintStrength,
                reasons: ["footer-only candidate"],
                sourceLabels: ["footer_full"],
                footerConfirmed: false
            )
        )
    }

    let deduped = Dictionary(grouping: hypotheses) { hypothesis in
        [
            normalizedRawCollectorIdentifier(hypothesis.titleText),
            normalizedRawCollectorIdentifier(hypothesis.collectorNumber ?? ""),
            hypothesis.setHintTokens.sorted().joined(separator: ",")
        ].joined(separator: "|")
    }
    .compactMap { $0.value.max(by: { $0.score < $1.score }) }

    return deduped.sorted { lhs, rhs in
        if lhs.score == rhs.score { return lhs.titleText < rhs.titleText }
        return lhs.score > rhs.score
    }
}

func rerankRawCandidateHypotheses(
    _ hypotheses: [RawCandidateHypothesis],
    footerConfirmation: RawFooterConfirmationSignals
) -> [RawCandidateHypothesis] {
    let footerHintSet = Set(footerConfirmation.setHintTokens)

    return hypotheses
        .map { hypothesis in
            var score = hypothesis.score
            var reasons = hypothesis.reasons
            var collectorNumber = hypothesis.collectorNumber
            var setHintTokens = hypothesis.setHintTokens
            var footerConfirmed = hypothesis.footerConfirmed

            if let confirmedCollector = footerConfirmation.collectorNumber {
                if let existingCollector = collectorNumber {
                    if normalizedRawCollectorIdentifier(existingCollector) == normalizedRawCollectorIdentifier(confirmedCollector) {
                        score += 0.22
                        reasons.append("footer corners confirm collector")
                        footerConfirmed = true
                    } else {
                        score -= 0.10
                        collectorNumber = confirmedCollector
                        reasons.append("footer corners override collector")
                    }
                } else {
                    collectorNumber = confirmedCollector
                    score += 0.24
                    footerConfirmed = true
                    reasons.append("footer corners supply collector")
                }
            }

            if !footerHintSet.isEmpty {
                let existingHints = Set(setHintTokens)
                if existingHints.isEmpty {
                    setHintTokens = footerConfirmation.setHintTokens.sorted()
                    score += 0.08
                    reasons.append("footer corners supply set hints")
                } else if !existingHints.isDisjoint(with: footerHintSet) {
                    score += 0.06
                    reasons.append("footer corners confirm set hints")
                }
            }

            return RawCandidateHypothesis(
                titleText: hypothesis.titleText,
                collectorNumber: collectorNumber,
                setHintTokens: setHintTokens,
                score: score,
                reasons: reasons,
                sourceLabels: hypothesis.sourceLabels,
                footerConfirmed: footerConfirmed
            )
        }
        .sorted { lhs, rhs in
            if lhs.score == rhs.score { return lhs.titleText < rhs.titleText }
            return lhs.score > rhs.score
        }
}

func chooseBestSelectionCandidateRank(
    from candidates: [OCRTargetCandidateSummary],
    mode: OCRTargetMode
) -> Int? {
    guard let best = candidates.first else { return nil }
    let margin = best.totalScore - (candidates.dropFirst().first?.totalScore ?? 0)
    let holderAccepted = mode == .rawCard
        && best.geometryKind == .rawHolder
        && best.proximityScore >= 0.44
        && best.areaCoverage >= 0.18
    guard best.totalScore >= mode.minimumSelectionScore else { return nil }
    guard best.aspectScore >= 0.45 || holderAccepted else { return nil }
    guard best.proximityScore >= 0.32 else { return nil }
    guard margin >= 0.05 || candidates.count == 1 else { return nil }
    return best.rank
}

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("FAIL: \(message)\n", stderr)
        Foundation.exit(1)
    }
}

private func run() {
    let centered = rerankRawCandidateHypotheses(
        buildCoarseRawCandidateHypotheses(
            from: RawBroadOCRSignals(
                primaryTitleText: "Pikachu",
                secondaryTitleText: nil,
                titleConfidence: 0.92,
                secondaryTitleConfidence: 0,
                footerBandText: "MEW EN 025/165",
                footerBandConfidence: 0.88,
                footerCollectorNumber: "025/165",
                footerSetHintTokens: ["mew"],
                cropConfidence: 0.90
            )
        ),
        footerConfirmation: RawFooterConfirmationSignals(collectorNumber: "025/165", setHintTokens: ["mew"])
    )
    expect(centered.first?.collectorNumber == "025/165", "raw_centered_clean_numeric collector")
    expect(centered.first?.footerConfirmed == true, "raw_centered_clean_numeric confirmation")

    let offcenter = buildCoarseRawCandidateHypotheses(
        from: RawBroadOCRSignals(
            primaryTitleText: "Lt. Surge's Bargain",
            secondaryTitleText: nil,
            titleConfidence: 0.74,
            secondaryTitleConfidence: 0,
            footerBandText: "185/132 Creatures GAME FREAK",
            footerBandConfidence: 0.46,
            footerCollectorNumber: "185/132",
            footerSetHintTokens: [],
            cropConfidence: 0.73
        )
    )
    expect(offcenter.first?.titleText == "Lt. Surge's Bargain", "raw_offcenter_numeric title")
    expect(offcenter.first?.collectorNumber == "185/132", "raw_offcenter_numeric collector")

    let farther = buildCoarseRawCandidateHypotheses(
        from: RawBroadOCRSignals(
            primaryTitleText: "Sabrina's Slowbro",
            secondaryTitleText: nil,
            titleConfidence: 0.66,
            secondaryTitleConfidence: 0,
            footerBandText: "",
            footerBandConfidence: 0.08,
            footerCollectorNumber: nil,
            footerSetHintTokens: [],
            cropConfidence: 0.70
        )
    )
    expect(!farther.isEmpty, "raw_farther_numeric candidates")
    expect(farther.first?.titleText == "Sabrina's Slowbro", "raw_farther_numeric title recovery")
    expect(farther.first?.collectorNumber == nil, "raw_farther_numeric safe no collector")

    let leadingZero = rerankRawCandidateHypotheses(
        buildCoarseRawCandidateHypotheses(
            from: RawBroadOCRSignals(
                primaryTitleText: "Togepi & Cleffa & Igglybuff GX",
                secondaryTitleText: nil,
                titleConfidence: 0.71,
                secondaryTitleConfidence: 0,
                footerBandText: "094/173",
                footerBandConfidence: 0.61,
                footerCollectorNumber: "094/173",
                footerSetHintTokens: [],
                cropConfidence: 0.80
            )
        ),
        footerConfirmation: RawFooterConfirmationSignals(collectorNumber: "094/173", setHintTokens: [])
    )
    expect(leadingZero.first?.collectorNumber == "094/173", "raw_leading_zero")

    let special = rerankRawCandidateHypotheses(
        buildCoarseRawCandidateHypotheses(
            from: RawBroadOCRSignals(
                primaryTitleText: "Charizard",
                secondaryTitleText: nil,
                titleConfidence: 0.84,
                secondaryTitleConfidence: 0,
                footerBandText: "SWSH101",
                footerBandConfidence: 0.73,
                footerCollectorNumber: "SWSH101",
                footerSetHintTokens: [],
                cropConfidence: 0.88
            )
        ),
        footerConfirmation: RawFooterConfirmationSignals(collectorNumber: "SWSH101", setHintTokens: [])
    )
    expect(special.first?.collectorNumber == "SWSH101", "raw_special_format")

    let holder = buildCoarseRawCandidateHypotheses(
        from: RawBroadOCRSignals(
            primaryTitleText: "Charmander",
            secondaryTitleText: nil,
            titleConfidence: 0.69,
            secondaryTitleConfidence: 0,
            footerBandText: "",
            footerBandConfidence: 0.10,
            footerCollectorNumber: nil,
            footerSetHintTokens: [],
            cropConfidence: 0.77
        )
    )
    expect(!holder.isEmpty, "raw_in_holder_offcenter candidates")
    expect(holder.first?.collectorNumber == nil, "raw_in_holder_offcenter safe fallback")

    let multiObject = chooseBestSelectionCandidateRank(
        from: [
            OCRTargetCandidateSummary(rank: 1, areaCoverage: 0.28, aspectScore: 0.80, proximityScore: 0.92, totalScore: 0.79, geometryKind: .rawCard),
            OCRTargetCandidateSummary(rank: 2, areaCoverage: 0.30, aspectScore: 0.83, proximityScore: 0.55, totalScore: 0.71, geometryKind: .rawCard)
        ],
        mode: .rawCard
    )
    expect(multiObject == 1, "raw_multi_object_choose_target")

    let lowConfidence = chooseBestSelectionCandidateRank(
        from: [
            OCRTargetCandidateSummary(rank: 1, areaCoverage: 0.18, aspectScore: 0.64, proximityScore: 0.55, totalScore: 0.63, geometryKind: .rawCard),
            OCRTargetCandidateSummary(rank: 2, areaCoverage: 0.17, aspectScore: 0.66, proximityScore: 0.53, totalScore: 0.60, geometryKind: .rawCard)
        ],
        mode: .rawCard
    )
    expect(lowConfidence == nil, "raw_low_confidence_fallback")

    print("raw_card_decision_tests: PASS")
}

run()
