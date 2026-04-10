import CoreGraphics
import Foundation

enum RawROIKind: String, Codable, Hashable, Sendable {
    case headerWide = "header_wide"
    case footerBandWide = "footer_band_wide"
    case nameplateTight = "nameplate_tight"
    case titleBandExpanded = "title_band_expanded"
    case footerLeft = "footer_left"
    case footerRight = "footer_right"
}

enum RawOCRPreprocessing: String, Codable, Hashable, Sendable {
    case none
    case contrastBoosted = "contrast_boosted"
}

struct RawROIPlanItem: Codable, Hashable, Sendable {
    let kind: RawROIKind
    let label: String
    let normalizedRect: OCRNormalizedRect
    let minimumTextHeight: Float
    let upscaleFactor: Double
    let preprocessing: RawOCRPreprocessing
    let usesLanguageCorrection: Bool
    let recognitionLanguages: [String]

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
    func stage1Plan(for sceneTraits: RawSceneTraits) -> [RawROIPlanItem] {
        let titleInsetX = sceneTraits.holderLikely ? 0.08 : (sceneTraits.usedFallback ? 0.02 : 0.0)
        let footerInsetX = sceneTraits.holderLikely ? 0.05 : 0.0
        let topInsetY = sceneTraits.holderLikely ? 0.02 : 0.0

        return [
            RawROIPlanItem(
                kind: .headerWide,
                label: "12_rewrite_raw_header_wide",
                normalizedRect: OCRNormalizedRect(
                    x: 0.04 + titleInsetX,
                    y: topInsetY,
                    width: 0.92 - (titleInsetX * 2),
                    height: sceneTraits.holderLikely ? 0.22 : 0.20
                ),
                minimumTextHeight: 0.008,
                upscaleFactor: sceneTraits.holderLikely ? 3.0 : 2.6,
                preprocessing: sceneTraits.holderLikely ? .contrastBoosted : .none,
                usesLanguageCorrection: true,
                recognitionLanguages: ["ja-JP", "en-US"]
            ),
            RawROIPlanItem(
                kind: .footerBandWide,
                label: "13_rewrite_raw_footer_band_wide",
                normalizedRect: OCRNormalizedRect(
                    x: footerInsetX,
                    y: sceneTraits.holderLikely ? 0.76 : 0.78,
                    width: 1.00 - (footerInsetX * 2),
                    height: sceneTraits.holderLikely ? 0.20 : 0.22
                ),
                minimumTextHeight: 0.0035,
                upscaleFactor: 3.6,
                preprocessing: sceneTraits.holderLikely ? .contrastBoosted : .none,
                usesLanguageCorrection: false,
                recognitionLanguages: ["ja-JP", "en-US"]
            )
        ]
    }

    func stage2Plan(for sceneTraits: RawSceneTraits) -> [RawROIPlanItem] {
        let titleInsetX = sceneTraits.holderLikely ? 0.06 : (sceneTraits.usedFallback ? 0.02 : 0.0)
        let titleBandY = sceneTraits.holderLikely ? 0.03 : 0.05
        let footerInsetX = sceneTraits.holderLikely ? 0.05 : 0.0

        return [
            RawROIPlanItem(
                kind: .titleBandExpanded,
                label: "17_rewrite_raw_title_band_expanded",
                normalizedRect: OCRNormalizedRect(
                    x: 0.08 + titleInsetX,
                    y: max(0, titleBandY - 0.01),
                    width: 0.84 - (titleInsetX * 2),
                    height: sceneTraits.holderLikely ? 0.24 : 0.26
                ),
                minimumTextHeight: 0.007,
                upscaleFactor: 3.2,
                preprocessing: .contrastBoosted,
                usesLanguageCorrection: true,
                recognitionLanguages: ["ja-JP", "en-US"]
            ),
            RawROIPlanItem(
                kind: .nameplateTight,
                label: "14_rewrite_raw_nameplate_tight",
                normalizedRect: OCRNormalizedRect(
                    x: 0.10 + titleInsetX,
                    y: sceneTraits.holderLikely ? 0.03 : 0.02,
                    width: 0.76 - (titleInsetX * 2),
                    height: sceneTraits.holderLikely ? 0.18 : 0.17
                ),
                minimumTextHeight: 0.008,
                upscaleFactor: 3.0,
                preprocessing: .contrastBoosted,
                usesLanguageCorrection: true,
                recognitionLanguages: ["ja-JP", "en-US"]
            ),
            RawROIPlanItem(
                kind: .footerLeft,
                label: "15_rewrite_raw_footer_left",
                normalizedRect: OCRNormalizedRect(
                    x: footerInsetX,
                    y: sceneTraits.holderLikely ? 0.78 : 0.80,
                    width: 0.42 - footerInsetX,
                    height: 0.18
                ),
                minimumTextHeight: 0.001,
                upscaleFactor: 4.0,
                preprocessing: sceneTraits.holderLikely ? .contrastBoosted : .none,
                usesLanguageCorrection: false,
                recognitionLanguages: ["ja-JP", "en-US"]
            ),
            RawROIPlanItem(
                kind: .footerRight,
                label: "16_rewrite_raw_footer_right",
                normalizedRect: OCRNormalizedRect(
                    x: 0.56 - (sceneTraits.holderLikely ? 0.02 : 0.0),
                    y: sceneTraits.holderLikely ? 0.78 : 0.80,
                    width: 0.44 - footerInsetX,
                    height: 0.18
                ),
                minimumTextHeight: 0.001,
                upscaleFactor: 4.0,
                preprocessing: sceneTraits.holderLikely ? .contrastBoosted : .none,
                usesLanguageCorrection: false,
                recognitionLanguages: ["ja-JP", "en-US"]
            )
        ]
    }
}
