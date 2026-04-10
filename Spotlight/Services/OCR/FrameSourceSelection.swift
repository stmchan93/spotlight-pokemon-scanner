import UIKit

struct OCRFrameSourceSelectionResult {
    let searchImage: UIImage
    let fallbackImage: UIImage
}

func selectOCRFrameSources(from capture: ScanCaptureInput) -> OCRFrameSourceSelectionResult {
    OCRFrameSourceSelectionResult(
        searchImage: capture.searchImage.normalizedOrientation(),
        fallbackImage: (capture.fallbackImage ?? capture.searchImage).normalizedOrientation()
    )
}
