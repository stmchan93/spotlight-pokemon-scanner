import XCTest
import UIKit
@testable import Spotlight

final class PerspectiveNormalizationTests: XCTestCase {
    func testNormalizeOCRInputImageCanonicalizesRawModeToStandardCanvas() {
        let sourceImage = OCRTestSupport.makeImage(size: CGSize(width: 400, height: 560)) { context in
            UIColor.darkGray.setFill()
            context.fill(CGRect(origin: .zero, size: CGSize(width: 400, height: 560)))
            UIColor.white.setFill()
            context.fill(CGRect(x: 52, y: 44, width: 296, height: 452))
        }

        let result = normalizeOCRInputImage(
            sourceImage,
            chosenCandidate: OCRTestSupport.makeCandidate(rank: 1, totalScore: 0.85),
            mode: .rawCard
        )

        XCTAssertEqual(result.geometryKind.rawValue, OCRTargetGeometryKind.rawCard.rawValue)
        XCTAssertEqual(result.reason, "basic_perspective_canonicalization")
        XCTAssertEqual(result.image.size.width, 630, accuracy: 0.0001)
        XCTAssertEqual(result.image.size.height, 880, accuracy: 0.0001)
        XCTAssertNotNil(result.normalizedContentRect)
        XCTAssertGreaterThan(result.normalizedContentRect?.width ?? 0, 0)
        XCTAssertGreaterThan(result.normalizedContentRect?.height ?? 0, 0)
    }

    func testNormalizeFallbackOCRInputImageUsesExactReticleFallbackForRawMode() {
        let searchImage = OCRTestSupport.makeImage(size: CGSize(width: 320, height: 460)) { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: CGSize(width: 320, height: 460)))
        }
        let fallbackImage = OCRTestSupport.makeImage(size: CGSize(width: 630, height: 880)) { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: CGSize(width: 630, height: 880)))
            UIColor.white.setFill()
            context.fill(CGRect(x: 60, y: 68, width: 510, height: 740))
        }

        let result = normalizeFallbackOCRInputImage(
            searchImage: searchImage,
            fallbackImage: fallbackImage,
            mode: .rawCard
        )

        XCTAssertEqual(result.geometryKind.rawValue, OCRTargetGeometryKind.fallback.rawValue)
        XCTAssertEqual(result.reason, "exact_reticle_fallback")
        XCTAssertEqual(result.image.size.width, 630, accuracy: 0.0001)
        XCTAssertEqual(result.image.size.height, 880, accuracy: 0.0001)
        XCTAssertEqual(result.normalizedContentRect, OCRNormalizedRect(x: 0, y: 0, width: 1, height: 1))
    }

    func testNormalizeFallbackOCRInputImagePreservesSlabLabelSearchFallbackMode() {
        let searchImage = OCRTestSupport.makeImage(size: CGSize(width: 380, height: 320)) { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: CGSize(width: 380, height: 320)))
        }
        let fallbackImage = OCRTestSupport.makeImage(size: CGSize(width: 380, height: 320)) { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: CGSize(width: 380, height: 320)))
        }

        let result = normalizeFallbackOCRInputImage(
            searchImage: searchImage,
            fallbackImage: fallbackImage,
            mode: .psaSlab
        )

        XCTAssertEqual(result.geometryKind.rawValue, OCRTargetGeometryKind.slabLabel.rawValue)
        XCTAssertEqual(result.reason, "slab_label_search_fallback")
        XCTAssertNil(result.normalizedContentRect)
        XCTAssertEqual(result.image.size.width, searchImage.size.width, accuracy: 0.0001)
        XCTAssertEqual(result.image.size.height, searchImage.size.height, accuracy: 0.0001)
    }

    private func makeImage(
        size: CGSize,
        draw: (CGContext) -> Void
    ) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        if #available(iOS 12.0, *) {
            format.preferredRange = .standard
        }
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { context in
            draw(context.cgContext)
        }
    }
}
