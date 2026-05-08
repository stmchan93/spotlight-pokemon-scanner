import ExpoModulesCore
import Foundation
import ImageIO
import UIKit
import MLKitVision
import MLKitTextRecognition
import MLKitBarcodeScanning

public final class SpotlightSlabScannerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SpotlightSlabScanner")

    AsyncFunction("scanPSALabel") { (imageUri: String) -> [String: Any] in
      let fileURL = try Self.resolveFileURL(from: imageUri)
      let pixelSize = try Self.loadPixelSize(from: fileURL)
      let image = try Self.loadImage(from: fileURL)

      let visionImage = VisionImage(image: image)
      visionImage.orientation = image.imageOrientation

      async let textBlocksTask = Self.recognizeText(in: visionImage)
      async let barcodesTask = Self.scanBarcodes(in: visionImage)

      let textBlocks = try await textBlocksTask
      let barcodes = try await barcodesTask

      return [
        "width": pixelSize.width,
        "height": pixelSize.height,
        "textBlocks": textBlocks,
        "barcodes": barcodes,
      ]
    }
  }

  private static func loadPixelSize(from fileURL: URL) throws -> CGSize {
    guard
      let imageSource = CGImageSourceCreateWithURL(fileURL as CFURL, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
      let height = properties[kCGImagePropertyPixelHeight] as? NSNumber
    else {
      throw Exception(
        name: "ImageLoadFailed",
        description: "Could not read image dimensions from \(fileURL.lastPathComponent)."
      )
    }
    return CGSize(width: width.doubleValue, height: height.doubleValue)
  }

  // MARK: - URI handling (mirrors SpotlightPSASlabAnalysisModule.resolveFileURL)

  private static func resolveFileURL(from imageURI: String) throws -> URL {
    let trimmed = imageURI.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      throw Exception(
        name: "InvalidImageUri",
        description: "Expected a non-empty local image URI."
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

    throw Exception(
      name: "InvalidImageUri",
      description: "Only local file:// image URIs are supported for PSA slab analysis."
    )
  }

  private static func loadImage(from fileURL: URL) throws -> UIImage {
    let data: Data
    do {
      data = try Data(contentsOf: fileURL)
    } catch {
      throw Exception(
        name: "ImageLoadFailed",
        description: "Could not read image data from \(fileURL.lastPathComponent): \(error.localizedDescription)"
      )
    }

    guard let image = UIImage(data: data) else {
      throw Exception(
        name: "ImageLoadFailed",
        description: "Could not decode image at \(fileURL.lastPathComponent)."
      )
    }

    return image
  }

  // MARK: - Text recognition

  private static func recognizeText(in image: VisionImage) async throws -> [[String: Any]] {
    // The MLKitTextRecognition pod ships the latin script recognizer by default;
    // `TextRecognizerOptions()` here uses latin script.
    let options = TextRecognizerOptions()
    let recognizer = TextRecognizer.textRecognizer(options: options)

    let result: Text = try await withCheckedThrowingContinuation { continuation in
      recognizer.process(image) { text, error in
        if let error = error {
          continuation.resume(throwing: Exception(
            name: "TextRecognitionFailed",
            description: "ML Kit text recognition failed: \(error.localizedDescription)"
          ))
          return
        }
        guard let text = text else {
          continuation.resume(throwing: Exception(
            name: "TextRecognitionFailed",
            description: "ML Kit text recognition returned no result."
          ))
          return
        }
        continuation.resume(returning: text)
      }
    }

    return makeTextBlocks(from: result)
  }

  private static func makeTextBlocks(from text: Text) -> [[String: Any]] {
    let blocks: [[String: Any]] = text.blocks.compactMap { block in
      let trimmed = block.text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else {
        return nil
      }
      return [
        "text": block.text,
        "boundingBox": makeBoundingBox(block.frame),
      ]
    }

    return blocks.sorted { lhs, rhs in
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

  // MARK: - Barcode scanning

  private static func scanBarcodes(in image: VisionImage) async throws -> [[String: Any]] {
    let options = BarcodeScannerOptions(formats: [
      .code39,
      .code93,
      .code128,
      .dataMatrix,
      .EAN8,
      .EAN13,
      .PDF417,
      .qrCode,
      .UPCE,
    ])
    let scanner = BarcodeScanner.barcodeScanner(options: options)

    let barcodes: [Barcode] = try await withCheckedThrowingContinuation { continuation in
      scanner.process(image) { result, error in
        if let error = error {
          continuation.resume(throwing: Exception(
            name: "BarcodeScanningFailed",
            description: "ML Kit barcode scanning failed: \(error.localizedDescription)"
          ))
          return
        }
        continuation.resume(returning: result ?? [])
      }
    }

    return makeBarcodes(from: barcodes)
  }

  private static func makeBarcodes(from barcodes: [Barcode]) -> [[String: Any]] {
    return barcodes.compactMap { barcode in
      guard let raw = barcode.rawValue?.trimmingCharacters(in: .whitespacesAndNewlines),
            !raw.isEmpty else {
        return nil
      }

      return [
        "rawValue": raw,
        "format": formatString(for: barcode.format),
        "boundingBox": makeBoundingBox(barcode.frame),
      ]
    }
  }

  private static func formatString(for format: BarcodeFormat) -> String {
    switch format {
    case .code39: return "code39"
    case .code93: return "code93"
    case .code128: return "code128"
    case .dataMatrix: return "dataMatrix"
    case .EAN8: return "ean8"
    case .EAN13: return "ean13"
    case .PDF417: return "pdf417"
    case .qrCode: return "qr"
    case .UPCE: return "upce"
    case .UPCA: return "upca"
    case .codaBar: return "codabar"
    case .ITF: return "itf"
    case .aztec: return "aztec"
    case .all: return "all"
    default: return "unknown"
    }
  }

  // MARK: - Bounding box helpers
  //
  // ML Kit on iOS reports `frame` already in pixel coordinates with the
  // origin at the top-left and the y-axis growing downward. That matches
  // the coordinate system the existing Apple Vision module exposes (after
  // its own normalized->pixel + y-flip conversion in `makeBoundingBox`),
  // so we pass through unchanged.

  private static func makeBoundingBox(_ frame: CGRect) -> [String: CGFloat] {
    return [
      "x": frame.origin.x,
      "y": frame.origin.y,
      "width": frame.size.width,
      "height": frame.size.height,
    ]
  }
}
