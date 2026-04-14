import CoreGraphics
import Foundation

enum RawROIKind: String, Codable, Hashable, Sendable {
    case headerWide = "header_wide"
    case footerBandWide = "footer_band_wide"
    case footerLeft = "footer_left"
    case footerRight = "footer_right"
    case footerMetadata = "footer_metadata"
}

enum RawOCRPreprocessing: String, Codable, Hashable, Sendable {
    case none
    case contrastBoosted = "contrast_boosted"
}

enum RawOCRRecognitionLevel: String, Codable, Hashable, Sendable {
    case accurate
    case fast
}

enum RawFooterFamily: String, Codable, Hashable, Sendable, CaseIterable {
    case modernLeft = "modern_left"
    case legacyRightMid = "legacy_right_mid"
    case legacyRightCorner = "legacy_right_corner"
}

enum RawFooterFieldRole: String, Codable, Hashable, Sendable {
    case setBadge = "set_badge"
    case collector = "collector"
}

struct RawFooterRoutingContext: Codable, Hashable, Sendable {
    let collectorAnchor: OCRNormalizedRect?
    let anchorIdentifier: String?
    let reasons: [String]

    static let none = RawFooterRoutingContext(
        collectorAnchor: nil,
        anchorIdentifier: nil,
        reasons: ["footer_band_anchor_unavailable"]
    )
}

struct RawROIPlanItem: Codable, Hashable, Sendable {
    let kind: RawROIKind
    let label: String
    let normalizedRect: OCRNormalizedRect
    let minimumTextHeight: Float
    let upscaleFactor: Double
    let preprocessing: RawOCRPreprocessing
    let recognitionLevel: RawOCRRecognitionLevel
    let usesLanguageCorrection: Bool
    let recognitionLanguages: [String]
    let footerFamily: RawFooterFamily?
    let footerRole: RawFooterFieldRole?

    init(
        kind: RawROIKind,
        label: String,
        normalizedRect: OCRNormalizedRect,
        minimumTextHeight: Float,
        upscaleFactor: Double,
        preprocessing: RawOCRPreprocessing,
        recognitionLevel: RawOCRRecognitionLevel = .accurate,
        usesLanguageCorrection: Bool,
        recognitionLanguages: [String],
        footerFamily: RawFooterFamily? = nil,
        footerRole: RawFooterFieldRole? = nil
    ) {
        self.kind = kind
        self.label = label
        self.normalizedRect = normalizedRect
        self.minimumTextHeight = minimumTextHeight
        self.upscaleFactor = upscaleFactor
        self.preprocessing = preprocessing
        self.recognitionLevel = recognitionLevel
        self.usesLanguageCorrection = usesLanguageCorrection
        self.recognitionLanguages = recognitionLanguages
        self.footerFamily = footerFamily
        self.footerRole = footerRole
    }

    var cgRect: CGRect {
        CGRect(
            x: normalizedRect.x,
            y: normalizedRect.y,
            width: normalizedRect.width,
            height: normalizedRect.height
        )
    }
}

struct RawROIPlanner {
    func stage1BroadPlan(for sceneTraits: RawSceneTraits) -> [RawROIPlanItem] {
        let footerNeedsBoost =
            sceneTraits.holderLikely ||
            sceneTraits.usedFallback ||
            sceneTraits.targetQualityScore < 0.72

        return [
            RawROIPlanItem(
                kind: .footerBandWide,
                label: "13_raw_footer_band",
                normalizedRect: mapCardRelativeRect(
                    OCRNormalizedRect(
                        x: sceneTraits.holderLikely ? 0.05 : 0.0,
                        y: sceneTraits.holderLikely ? 0.76 : 0.78,
                        width: sceneTraits.holderLikely ? 0.90 : 1.0,
                        height: sceneTraits.holderLikely ? 0.20 : 0.22
                    ),
                    sceneTraits: sceneTraits
                ),
                minimumTextHeight: 0.0035,
                upscaleFactor: 3.6,
                preprocessing: footerNeedsBoost ? .contrastBoosted : .none,
                usesLanguageCorrection: false,
                recognitionLanguages: ["ja-JP", "en-US"]
            )
        ]
    }

    func stage1TightPlan(
        for sceneTraits: RawSceneTraits,
        routing: RawFooterRoutingContext
    ) -> [RawROIPlanItem] {
        let footerNeedsBoost =
            sceneTraits.holderLikely ||
            sceneTraits.usedFallback ||
            sceneTraits.targetQualityScore < 0.72

        var plans: [RawROIPlanItem] = []
        var nextArtifactIndex = 14
        let labelSuffix = routing.collectorAnchor == nil ? "" : "_anchored"

        for family in RawFooterFamily.allCases {
            let collectorRect = collectorRect(
                for: family,
                sceneTraits: sceneTraits,
                anchor: routing.collectorAnchor
            )
            let setBadgeRect = setBadgeRect(
                for: family,
                sceneTraits: sceneTraits,
                collectorRect: collectorRect
            )

            plans.append(
                RawROIPlanItem(
                    kind: .footerMetadata,
                    label: String(
                        format: "%02d_raw_footer_%@_set%@",
                        nextArtifactIndex,
                        family.rawValue,
                        labelSuffix
                    ),
                    normalizedRect: setBadgeRect,
                    minimumTextHeight: 0.001,
                    upscaleFactor: 4.8,
                    preprocessing: footerNeedsBoost ? .contrastBoosted : .none,
                    usesLanguageCorrection: false,
                    recognitionLanguages: ["ja-JP", "en-US"],
                    footerFamily: family,
                    footerRole: .setBadge
                )
            )
            nextArtifactIndex += 1

            plans.append(
                RawROIPlanItem(
                    kind: .footerMetadata,
                    label: String(
                        format: "%02d_raw_footer_%@_collector%@",
                        nextArtifactIndex,
                        family.rawValue,
                        labelSuffix
                    ),
                    normalizedRect: collectorRect,
                    minimumTextHeight: 0.001,
                    upscaleFactor: 4.8,
                    preprocessing: footerNeedsBoost ? .contrastBoosted : .none,
                    usesLanguageCorrection: false,
                    recognitionLanguages: ["ja-JP", "en-US"],
                    footerFamily: family,
                    footerRole: .collector
                )
            )
            nextArtifactIndex += 1
        }

        return plans
    }

    func stage2Plan(for sceneTraits: RawSceneTraits) -> [RawROIPlanItem] {
        let titleInsetX = sceneTraits.holderLikely ? 0.06 : (sceneTraits.usedFallback ? 0.02 : 0.0)
        let topInsetY = sceneTraits.holderLikely ? 0.02 : 0.0
        if sceneTraits.isExactReticleFallback {
            return [
                headerWidePlan(
                    label: "12_raw_header_wide_lowered",
                    rect: OCRNormalizedRect(
                        x: 0.04 + titleInsetX,
                        y: sceneTraits.holderLikely ? 0.05 : 0.05,
                        width: 0.92 - (titleInsetX * 2),
                        height: sceneTraits.holderLikely ? 0.24 : 0.22
                    ),
                    sceneTraits: sceneTraits
                ),
                headerWidePlan(
                    label: "12_raw_header_wide",
                    rect: OCRNormalizedRect(
                        x: 0.04 + titleInsetX,
                        y: topInsetY,
                        width: 0.92 - (titleInsetX * 2),
                        height: sceneTraits.holderLikely ? 0.22 : 0.20
                    ),
                    sceneTraits: sceneTraits
                )
            ]
        }

        return [
            headerWidePlan(
                label: "12_raw_header_wide",
                rect: OCRNormalizedRect(
                    x: 0.04 + titleInsetX,
                    y: topInsetY,
                    width: 0.92 - (titleInsetX * 2),
                    height: sceneTraits.holderLikely ? 0.22 : 0.20
                ),
                sceneTraits: sceneTraits
            )
        ]
    }

    private func headerWidePlan(
        label: String,
        rect: OCRNormalizedRect,
        sceneTraits: RawSceneTraits
    ) -> RawROIPlanItem {
        let isLoweredFallbackPass = sceneTraits.isExactReticleFallback && label == "12_raw_header_wide_lowered"
        return RawROIPlanItem(
            kind: .headerWide,
            label: label,
            normalizedRect: mapCardRelativeRect(rect, sceneTraits: sceneTraits),
            minimumTextHeight: 0.008,
            upscaleFactor: isLoweredFallbackPass ? 1.8 : (sceneTraits.holderLikely ? 3.0 : 2.6),
            preprocessing: sceneTraits.holderLikely ? .contrastBoosted : .none,
            recognitionLevel: isLoweredFallbackPass ? .fast : .accurate,
            usesLanguageCorrection: isLoweredFallbackPass ? false : true,
            recognitionLanguages: ["ja-JP", "en-US"]
        )
    }

    private func collectorRect(
        for family: RawFooterFamily,
        sceneTraits: RawSceneTraits,
        anchor: OCRNormalizedRect?
    ) -> OCRNormalizedRect {
        let defaultRect = mapCardRelativeRect(defaultCollectorRect(for: family), sceneTraits: sceneTraits)
        guard let anchor else {
            return defaultRect
        }

        let contentBounds = contentBounds(for: sceneTraits)
        let targetWidth = max(defaultRect.width, anchor.width * 1.8)
        let targetHeight = max(defaultRect.height, anchor.height * 2.2)
        let anchoredRect = OCRNormalizedRect(
            x: clamp(
                anchor.x + (anchor.width / 2) - (targetWidth / 2),
                min: contentBounds.x,
                max: contentBounds.x + contentBounds.width - targetWidth
            ),
            y: clamp(
                anchor.y + (anchor.height / 2) - (targetHeight / 2),
                min: contentBounds.y,
                max: contentBounds.y + contentBounds.height - targetHeight
            ),
            width: min(targetWidth, contentBounds.width),
            height: min(targetHeight, contentBounds.height)
        )

        return clampRect(anchoredRect, within: contentBounds)
    }

    private func setBadgeRect(
        for family: RawFooterFamily,
        sceneTraits: RawSceneTraits,
        collectorRect: OCRNormalizedRect
    ) -> OCRNormalizedRect {
        let defaultRect = mapCardRelativeRect(defaultSetBadgeRect(for: family), sceneTraits: sceneTraits)
        let contentBounds = contentBounds(for: sceneTraits)

        let proposedX: Double
        let proposedY: Double

        switch family {
        case .modernLeft:
            proposedX = collectorRect.x - (defaultRect.width * 0.72)
            proposedY = collectorRect.y - (defaultRect.height * 0.05)
        case .legacyRightMid:
            proposedX = collectorRect.x - (defaultRect.width * 0.38)
            proposedY = collectorRect.y - (defaultRect.height * 0.08)
        case .legacyRightCorner:
            proposedX = (collectorRect.x + collectorRect.width) - (defaultRect.width * 0.95)
            proposedY = collectorRect.y - (defaultRect.height * 0.12)
        }

        let anchoredRect = OCRNormalizedRect(
            x: clamp(
                proposedX,
                min: contentBounds.x,
                max: contentBounds.x + contentBounds.width - defaultRect.width
            ),
            y: clamp(
                proposedY,
                min: contentBounds.y,
                max: contentBounds.y + contentBounds.height - defaultRect.height
            ),
            width: defaultRect.width,
            height: defaultRect.height
        )

        return clampRect(anchoredRect, within: contentBounds)
    }

    private func defaultCollectorRect(for family: RawFooterFamily) -> OCRNormalizedRect {
        switch family {
        case .modernLeft:
            return OCRNormalizedRect(x: 0.170, y: 0.850, width: 0.275, height: 0.092)
        case .legacyRightMid:
            return OCRNormalizedRect(x: 0.720, y: 0.850, width: 0.185, height: 0.100)
        case .legacyRightCorner:
            return OCRNormalizedRect(x: 0.705, y: 0.842, width: 0.190, height: 0.102)
        }
    }

    private func defaultSetBadgeRect(for family: RawFooterFamily) -> OCRNormalizedRect {
        switch family {
        case .modernLeft:
            return OCRNormalizedRect(x: 0.118, y: 0.845, width: 0.138, height: 0.098)
        case .legacyRightMid:
            return OCRNormalizedRect(x: 0.665, y: 0.842, width: 0.125, height: 0.102)
        case .legacyRightCorner:
            return OCRNormalizedRect(x: 0.705, y: 0.836, width: 0.115, height: 0.105)
        }
    }

    private func mapCardRelativeRect(
        _ rect: OCRNormalizedRect,
        sceneTraits: RawSceneTraits
    ) -> OCRNormalizedRect {
        let contentRect = contentBounds(for: sceneTraits)
        return OCRNormalizedRect(
            x: contentRect.x + (rect.x * contentRect.width),
            y: contentRect.y + (rect.y * contentRect.height),
            width: rect.width * contentRect.width,
            height: rect.height * contentRect.height
        )
    }

    private func contentBounds(for sceneTraits: RawSceneTraits) -> OCRNormalizedRect {
        sceneTraits.normalizedContentRect ?? OCRNormalizedRect(x: 0, y: 0, width: 1, height: 1)
    }

    private func clampRect(_ rect: OCRNormalizedRect, within bounds: OCRNormalizedRect) -> OCRNormalizedRect {
        let width = min(rect.width, bounds.width)
        let height = min(rect.height, bounds.height)
        return OCRNormalizedRect(
            x: clamp(rect.x, min: bounds.x, max: bounds.x + bounds.width - width),
            y: clamp(rect.y, min: bounds.y, max: bounds.y + bounds.height - height),
            width: width,
            height: height
        )
    }

    private func clamp(_ value: Double, min minValue: Double, max maxValue: Double) -> Double {
        guard minValue <= maxValue else { return minValue }
        return Swift.min(Swift.max(value, minValue), maxValue)
    }
}
