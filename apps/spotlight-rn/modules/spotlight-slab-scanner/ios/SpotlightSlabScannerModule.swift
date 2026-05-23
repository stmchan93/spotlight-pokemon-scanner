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

    AsyncFunction("quickClassifyCapture") { (imageUri: String, sourceImageUri: String?) -> [String: Any] in
      // 1. Record decode start time
      let decodeStart = Date()

      // 2. Load normalized image (cropped to reticle) for red-band pixel analysis
      let fileURL = try Self.resolveFileURL(from: imageUri)
      let image = try Self.loadImage(from: fileURL)

      // 3. Downsample to ~400px long-side
      let small = Self.downsample(image, toLongSide: 400.0)

      // 4. Record classify start and decode duration
      let classifyStart = Date()
      let decodeMs = classifyStart.timeIntervalSince(decodeStart) * 1000

      // Run barcode scan on the source photo when available — the normalized
      // target is cropped to the reticle and resized to raw-card portrait
      // dimensions (630×880), which squishes a landscape PSA slab and distorts
      // the barcode enough that ML Kit often fails to decode it.  The source
      // photo preserves the original aspect ratio and gives ML Kit the full
      // undistorted label to work with.
      let barcodeImage: UIImage
      if let srcUri = sourceImageUri, !srcUri.isEmpty,
         let srcURL = try? Self.resolveFileURL(from: srcUri),
         let srcImage = try? Self.loadImage(from: srcURL) {
        barcodeImage = srcImage
      } else {
        barcodeImage = image
      }
      let barcodeVisionImage = VisionImage(image: barcodeImage)
      barcodeVisionImage.orientation = barcodeImage.imageOrientation
      async let barcodesTask = Self.scanBarcodes(in: barcodeVisionImage)

      // Get raw pixel data once for both passes
      guard let (pixelData, width, height) = Self.getPixelData(from: small) else {
        throw Exception(
          name: "ImageLoadFailed",
          description: "Could not extract pixel data from image."
        )
      }

      // 5. Red band score — check top AND bottom 18% so upside-down slabs are caught too
      let redStripHeight = max(1, Int(Double(height) * 0.18))
      let totalPixelsInStrip = width * redStripHeight

      func countRedPixels(startY: Int) -> Int {
        var count = 0
        for y in startY..<(startY + redStripHeight) {
          for x in 0..<width {
            let idx = (y * width + x) * 4
            let r = Double(pixelData[idx])     / 255.0
            let g = Double(pixelData[idx + 1]) / 255.0
            let b = Double(pixelData[idx + 2]) / 255.0
            let (h, s, v) = Self.rgbToHSV(r: r, g: g, b: b)
            if (h >= 350.0 || h <= 10.0) && s >= 0.6 && v >= 0.4 {
              count += 1
            }
          }
        }
        return count
      }

      let topRedCount = countRedPixels(startY: 0)
      let bottomRedCount = countRedPixels(startY: max(0, height - redStripHeight))
      let redBandScore = Double(max(topRedCount, bottomRedCount)) / Double(totalPixelsInStrip)

      // 6. Barcode region score — bottom 12% of image height, Sobel-style edges
      let barcodeStripHeight = max(1, Int(Double(height) * 0.12))
      let barcodeStripStartY = height - barcodeStripHeight
      var magnitudeSum = 0.0
      var magnitudeCount = 0

      // Helper: grayscale luminance from pixel index
      func gray(_ px: Int, _ py: Int) -> Double {
        let i = (py * width + px) * 4
        let r = Double(pixelData[i])     / 255.0
        let g = Double(pixelData[i + 1]) / 255.0
        let b = Double(pixelData[i + 2]) / 255.0
        return 0.299 * r + 0.587 * g + 0.114 * b
      }

      for y in barcodeStripStartY..<height {
        for x in 0..<width {
          // Only compute where right and below neighbors exist
          guard x + 1 < width, y + 1 < height else { continue }
          let gx = abs(gray(x + 1, y) - gray(x, y))
          let gy = abs(gray(x, y + 1) - gray(x, y))
          let mag = (gx + gy) / 2.0
          magnitudeSum += mag
          magnitudeCount += 1
        }
      }

      let barcodeRegionScore = magnitudeCount > 0 ? magnitudeSum / Double(magnitudeCount) : 0.0

      // 7. Compute final metrics
      let barcodes = try await barcodesTask
      let hasBarcode = !barcodes.isEmpty
      let isSlabLikely = redBandScore > 0.12 || hasBarcode
      let confidence = redBandScore * 0.6 + barcodeRegionScore * 0.4
      let classifyMs = Date().timeIntervalSince(classifyStart) * 1000

      // 8. Return dictionary
      return [
        "isSlabLikely": isSlabLikely,
        "confidence": confidence,
        "redBandScore": redBandScore,
        "barcodeRegionScore": barcodeRegionScore,
        "hasBarcode": hasBarcode,
        "decodeMs": decodeMs,
        "classifyMs": classifyMs,
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

  // MARK: - Quick classify helpers

  private static func rgbToHSV(r: Double, g: Double, b: Double) -> (h: Double, s: Double, v: Double) {
    let maxC = max(r, g, b)
    let minC = min(r, g, b)
    let delta = maxC - minC
    let v = maxC
    let s = maxC == 0 ? 0.0 : delta / maxC
    var h = 0.0
    if delta > 0 {
      if maxC == r { h = 60.0 * (((g - b) / delta).truncatingRemainder(dividingBy: 6.0)) }
      else if maxC == g { h = 60.0 * ((b - r) / delta + 2.0) }
      else { h = 60.0 * ((r - g) / delta + 4.0) }
    }
    if h < 0 { h += 360.0 }
    return (h, s, v)
  }

  private static func getPixelData(from image: UIImage) -> (data: [UInt8], width: Int, height: Int)? {
    guard let cgImage = image.cgImage else { return nil }
    let width = cgImage.width
    let height = cgImage.height
    var data = [UInt8](repeating: 0, count: width * height * 4)
    guard let context = CGContext(
      data: &data,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
    return (data, width, height)
  }

  private static func downsample(_ image: UIImage, toLongSide targetLongSide: CGFloat) -> UIImage {
    let longSide = max(image.size.width, image.size.height)
    guard longSide > targetLongSide else { return image }
    let scale = targetLongSide / longSide
    let newSize = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    let renderer = UIGraphicsImageRenderer(size: newSize)
    return renderer.image { _ in
      image.draw(in: CGRect(origin: .zero, size: newSize))
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
