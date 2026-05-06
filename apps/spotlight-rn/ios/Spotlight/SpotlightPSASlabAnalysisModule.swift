import Foundation
import ImageIO
import Vision

@objc(SpotlightPSASlabAnalysis)
final class SpotlightPSASlabAnalysis: NSObject {
    @objc
    static func requiresMainQueueSetup() -> Bool {
        false
    }

    @objc(analyzeLabel:resolver:rejecter:)
    func analyzeLabel(
        _ imageURI: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let fileURL = try Self.resolveFileURL(from: imageURI)
                let imageSize = try Self.loadImageSize(from: fileURL)

                let handler = VNImageRequestHandler(url: fileURL, options: [:])

                let textRequest = VNRecognizeTextRequest()
                textRequest.recognitionLevel = .accurate
                textRequest.usesLanguageCorrection = false
                textRequest.recognitionLanguages = ["en-US"]

                let barcodeRequest = VNDetectBarcodesRequest()
                if #available(iOS 16.0, *) {
                    barcodeRequest.symbologies = [
                        .code39,
                        .code39Checksum,
                        .code93,
                        .code128,
                        .dataMatrix,
                        .ean8,
                        .ean13,
                        .pdf417,
                        .qr,
                        .upce,
                    ]
                }

                try handler.perform([textRequest, barcodeRequest])

                let textBlocks = Self.makeTextBlocks(
                    from: textRequest.results ?? [],
                    imageSize: imageSize
                )
                let barcodes = Self.makeBarcodes(
                    from: barcodeRequest.results ?? [],
                    imageSize: imageSize
                )

                resolve([
                    "width": imageSize.width,
                    "height": imageSize.height,
                    "textBlocks": textBlocks,
                    "barcodes": barcodes,
                ])
            } catch let error as SpotlightPSASlabAnalysisError {
                reject(error.code, error.message, nil)
            } catch {
                reject(
                    "native_analysis_failed",
                    "Unexpected Vision slab analysis failure: \(error.localizedDescription)",
                    error
                )
            }
        }
    }

    private static func resolveFileURL(from imageURI: String) throws -> URL {
        let trimmed = imageURI.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw SpotlightPSASlabAnalysisError(
                code: "invalid_image_uri",
                message: "Expected a non-empty local image URI."
            )
        }

        if let url = URL(string: trimmed), url.isFileURL {
            return url
        }

        if trimmed.hasPrefix("/") {
            return URL(fileURLWithPath: trimmed)
        }

        if let decoded = trimmed.removingPercentEncoding,
           decoded.hasPrefix("/") {
            return URL(fileURLWithPath: decoded)
        }

        throw SpotlightPSASlabAnalysisError(
            code: "invalid_image_uri",
            message: "Only local file:// image URIs are supported for PSA slab analysis."
        )
    }

    private static func loadImageSize(from fileURL: URL) throws -> CGSize {
        guard let imageSource = CGImageSourceCreateWithURL(fileURL as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber else {
            throw SpotlightPSASlabAnalysisError(
                code: "image_load_failed",
                message: "Could not read image dimensions from \(fileURL.lastPathComponent)."
            )
        }

        return CGSize(width: width.doubleValue, height: height.doubleValue)
    }

    private static func makeTextBlocks(
        from observations: [VNRecognizedTextObservation],
        imageSize: CGSize
    ) -> [[String: Any]] {
        return observations
            .compactMap { observation in
                guard let candidate = observation.topCandidates(1).first else {
                    return nil
                }
                return [
                    "text": candidate.string,
                    "boundingBox": makeBoundingBox(observation.boundingBox, imageSize: imageSize),
                ]
            }
            .sorted { lhs, rhs in
                guard let leftBox = lhs["boundingBox"] as? [String: CGFloat],
                      let rightBox = rhs["boundingBox"] as? [String: CGFloat] else {
                    return false
                }
                if abs(leftBox["y", default: 0] - rightBox["y", default: 0]) < 6 {
                    return leftBox["x", default: 0] < rightBox["x", default: 0]
                }
                return leftBox["y", default: 0] < rightBox["y", default: 0]
            }
    }

    private static func makeBarcodes(
        from observations: [VNBarcodeObservation],
        imageSize: CGSize
    ) -> [[String: Any]] {
        return observations.compactMap { observation in
            guard let rawValue = observation.payloadStringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !rawValue.isEmpty else {
                return nil
            }

            return [
                "rawValue": rawValue,
                "format": observation.symbology.rawValue,
                "boundingBox": makeBoundingBox(observation.boundingBox, imageSize: imageSize),
            ]
        }
    }

    private static func makeBoundingBox(
        _ normalizedRect: CGRect,
        imageSize: CGSize
    ) -> [String: CGFloat] {
        let width = normalizedRect.width * imageSize.width
        let height = normalizedRect.height * imageSize.height
        let x = normalizedRect.origin.x * imageSize.width
        let y = (1 - normalizedRect.origin.y - normalizedRect.height) * imageSize.height

        return [
            "x": x,
            "y": y,
            "width": width,
            "height": height,
        ]
    }
}

private struct SpotlightPSASlabAnalysisError: Error {
    let code: String
    let message: String
}
