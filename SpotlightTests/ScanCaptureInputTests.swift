import XCTest
import UIKit
@testable import Spotlight

final class ScanCaptureInputTests: XCTestCase {
    func testTrayPreviewImageUsesExactCropForLiveCaptures() {
        let original = makeImage(
            size: CGSize(width: 300, height: 420),
            color: UIColor.red
        )
        let search = makeImage(
            size: CGSize(width: 220, height: 320),
            color: UIColor.green
        )
        let fallback = makeImage(
            size: CGSize(width: 180, height: 260),
            color: UIColor.blue
        )

        let capture = ScanCaptureInput(
            originalImage: original,
            searchImage: search,
            fallbackImage: fallback,
            captureSource: .livePreviewFrame
        )

        XCTAssertEqual(capture.trayPreviewImage.pngData(), fallback.pngData())
        XCTAssertNotEqual(capture.trayPreviewImage.pngData(), original.pngData())
        XCTAssertNotEqual(capture.trayPreviewImage.pngData(), search.pngData())
    }

    func testTrayPreviewImageFallsBackToSearchCropWhenExactCropMissing() {
        let original = makeImage(
            size: CGSize(width: 300, height: 420),
            color: UIColor.red
        )
        let search = makeImage(
            size: CGSize(width: 220, height: 320),
            color: UIColor.green
        )

        let capture = ScanCaptureInput(
            originalImage: original,
            searchImage: search,
            fallbackImage: nil,
            captureSource: .liveStillPhoto
        )

        XCTAssertEqual(capture.trayPreviewImage.pngData(), search.pngData())
        XCTAssertNotEqual(capture.trayPreviewImage.pngData(), original.pngData())
    }

    func testTrayPreviewImageUsesOriginalForImportedPhotos() {
        let original = makeImage(
            size: CGSize(width: 300, height: 420),
            color: UIColor.red
        )
        let search = makeImage(
            size: CGSize(width: 220, height: 320),
            color: UIColor.green
        )

        let capture = ScanCaptureInput(
            originalImage: original,
            searchImage: search,
            fallbackImage: nil,
            captureSource: .importedPhoto
        )

        XCTAssertEqual(capture.trayPreviewImage.pngData(), original.pngData())
        XCTAssertNotEqual(capture.trayPreviewImage.pngData(), search.pngData())
    }

    private func makeImage(size: CGSize, color: UIColor) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { context in
            color.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
    }
}
