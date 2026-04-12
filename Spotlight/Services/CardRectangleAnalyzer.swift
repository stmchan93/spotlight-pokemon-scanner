import Foundation
import UIKit
import Vision
import CoreImage
import Photos

struct SlabScanConfiguration {
    struct LabelOCR {
        let topLabelWideRegion: CGRect
        let topLabelExpandedRegion: CGRect
        let rightColumnRegion: CGRect
        let certRegion: CGRect
        let minimumTextHeight: Float
        let upscaleFactor: CGFloat
        let fallbackMinimumTextHeight: Float
        let fallbackUpscaleFactor: CGFloat
        let certMinimumTextHeight: Float
        let certUpscaleFactor: CGFloat

        static let `default` = LabelOCR(
            topLabelWideRegion: CGRect(x: 0.03, y: 0.00, width: 0.94, height: 0.24),
            topLabelExpandedRegion: CGRect(x: 0.02, y: 0.00, width: 0.96, height: 0.30),
            rightColumnRegion: CGRect(x: 0.66, y: 0.01, width: 0.28, height: 0.22),
            certRegion: CGRect(x: 0.54, y: 0.05, width: 0.38, height: 0.15),
            minimumTextHeight: 0.008,
            upscaleFactor: 3.0,
            fallbackMinimumTextHeight: 0.006,
            fallbackUpscaleFactor: 3.5,
            certMinimumTextHeight: 0.004,
            certUpscaleFactor: 4.0
        )
    }

    struct Debug {
        let saveDebugImages: Bool
        let verboseLogging: Bool

        static let disabled = Debug(saveDebugImages: false, verboseLogging: false)
        static let enabled = Debug(saveDebugImages: true, verboseLogging: true)
    }

    let labelOCR: LabelOCR
    let debug: Debug

    static let `default` = SlabScanConfiguration(
        labelOCR: .default,
        debug: .enabled
    )
}

// MARK: - Slab Scanner

actor SlabScanner {
    private static let fullImageRegion = CGRect(x: 0, y: 0, width: 1, height: 1)
    private static let labelOnlyCertRegion = CGRect(x: 0.42, y: 0.10, width: 0.56, height: 0.82)
    private static let labelOnlyRightColumnRegion = CGRect(x: 0.58, y: 0.02, width: 0.40, height: 0.96)

    private let config: SlabScanConfiguration

    init(config: SlabScanConfiguration = .default) {
        self.config = config
    }

    func analyze(
        scanID: UUID,
        capture: ScanCaptureInput,
        resolverModeHint: ResolverMode = .psaSlab
    ) async throws -> AnalyzedCapture {
        let startTime = Date()
        let targetSelection = try selectOCRInput(
            scanID: scanID,
            capture: capture,
            mode: .psaSlab
        )
        let normalizedOriginal = capture.originalImage.normalizedOrientation()
        guard let cgImage = targetSelection.normalizedImage.cgImage else {
            throw AnalysisError.invalidImage
        }

        let labelOnlyPath = targetSelection.normalizedGeometryKind == .slabLabel
        let topLabelWideRegion = labelOnlyPath ? Self.fullImageRegion : config.labelOCR.topLabelWideRegion
        let topLabelExpandedRegion = labelOnlyPath ? Self.fullImageRegion : config.labelOCR.topLabelExpandedRegion
        let rightColumnRegion = labelOnlyPath ? Self.labelOnlyRightColumnRegion : config.labelOCR.rightColumnRegion
        let certRegion = labelOnlyPath ? Self.labelOnlyCertRegion : config.labelOCR.certRegion
        let barcodeRegions = labelOnlyPath ? [Self.fullImageRegion] : [config.labelOCR.topLabelWideRegion]
        let primaryMinimumTextHeight = labelOnlyPath
            ? config.labelOCR.fallbackMinimumTextHeight
            : config.labelOCR.minimumTextHeight
        let primaryUpscaleFactor = labelOnlyPath
            ? config.labelOCR.fallbackUpscaleFactor
            : config.labelOCR.upscaleFactor

        guard let topLabelWideImage = cropToRect(cgImage, region: topLabelWideRegion) else {
            throw AnalysisError.invalidImage
        }
        let certLabelImage = cropToRect(cgImage, region: certRegion)

        let topLabelWideText = try recognizeLabelRegion(
            croppedImage: topLabelWideImage,
            sourceImage: cgImage,
            region: topLabelWideRegion,
            label: labelOnlyPath ? "slab_label_only_wide" : "slab_top_label_wide",
            minimumTextHeight: primaryMinimumTextHeight,
            upscaleFactor: primaryUpscaleFactor
        )
        ScanStageArtifactWriter.recordRawRegionImage(
            scanID: scanID,
            image: UIImage(cgImage: topLabelWideImage),
            named: labelOnlyPath ? "07_slab_label_only_wide.jpg" : "07_slab_top_label_wide.jpg"
        )
        let certText: String
        if let certLabelImage {
            certText = try recognizeLabelRegion(
                croppedImage: certLabelImage,
                sourceImage: cgImage,
                region: certRegion,
                label: labelOnlyPath ? "slab_label_only_cert_focus" : "slab_cert_focus",
                minimumTextHeight: config.labelOCR.certMinimumTextHeight,
                upscaleFactor: config.labelOCR.certUpscaleFactor
            )
            ScanStageArtifactWriter.recordRawRegionImage(
                scanID: scanID,
                image: UIImage(cgImage: certLabelImage),
                named: labelOnlyPath ? "08_slab_label_only_cert_focus.jpg" : "08_slab_cert_focus.jpg"
            )
        } else {
            certText = ""
        }
        let barcodePayloads: [String]
        do {
            barcodePayloads = try detectVerificationPayloads(
                in: cgImage,
                regions: barcodeRegions
            )
        } catch {
            print("  ⚠️ [OCR] Slab barcode detection failed: \(error.localizedDescription)")
            barcodePayloads = []
        }
        let visualSignals = extractVisualSignals(from: topLabelWideImage)

        var labelTexts = [topLabelWideText]
        if !certText.isEmpty {
            labelTexts.append(certText)
        }
        var topLabelCandidates = [topLabelWideText]
        var slabLabelAnalysis = SlabLabelParser.analyze(
            labelTexts: labelTexts,
            barcodePayloads: barcodePayloads,
            visualSignals: visualSignals
        )
        var stage2Used = false
        if shouldRunSecondaryPSAPass(for: slabLabelAnalysis) {
            stage2Used = true
            print("  🔍 [OCR] Slab stage 2 triggered path=\(labelOnlyPath ? "label_only" : "full_slab")")

            if let expandedLabelImage = cropToRect(cgImage, region: topLabelExpandedRegion) {
                let expandedText = try recognizeLabelRegion(
                    croppedImage: expandedLabelImage,
                    sourceImage: cgImage,
                    region: topLabelExpandedRegion,
                    label: labelOnlyPath ? "slab_label_only_expanded" : "slab_top_label_expanded",
                    minimumTextHeight: config.labelOCR.fallbackMinimumTextHeight,
                    upscaleFactor: config.labelOCR.fallbackUpscaleFactor
                )
                if !expandedText.isEmpty {
                    labelTexts.append(expandedText)
                    topLabelCandidates.append(expandedText)
                }
                ScanStageArtifactWriter.recordRawRegionImage(
                    scanID: scanID,
                    image: UIImage(cgImage: expandedLabelImage),
                    named: labelOnlyPath ? "09_slab_label_only_expanded.jpg" : "09_slab_top_label_expanded.jpg"
                )
            }

            if let rightColumnImage = cropToRect(cgImage, region: rightColumnRegion) {
                let rightColumnText = try recognizeLabelRegion(
                    croppedImage: rightColumnImage,
                    sourceImage: cgImage,
                    region: rightColumnRegion,
                    label: labelOnlyPath ? "slab_label_only_right_column" : "slab_right_column_focus",
                    minimumTextHeight: config.labelOCR.fallbackMinimumTextHeight,
                    upscaleFactor: config.labelOCR.fallbackUpscaleFactor
                )
                if !rightColumnText.isEmpty {
                    labelTexts.append(rightColumnText)
                }
                ScanStageArtifactWriter.recordRawRegionImage(
                    scanID: scanID,
                    image: UIImage(cgImage: rightColumnImage),
                    named: labelOnlyPath ? "10_slab_label_only_right_column.jpg" : "10_slab_right_column_focus.jpg"
                )
            }

            slabLabelAnalysis = SlabLabelParser.analyze(
                labelTexts: labelTexts,
                barcodePayloads: barcodePayloads,
                visualSignals: visualSignals
            )
        }

        let topLabelText = preferredSlabLabelText(candidates: topLabelCandidates)
        let combinedText = labelTexts
            .filter { !$0.isEmpty }
            .reduce(into: [String]()) { unique, text in
                if !unique.contains(text) {
                    unique.append(text)
                }
            }
            .joined(separator: " ")
        var warnings: [String] = []
        if topLabelText.isEmpty {
            warnings.append("Could not read PSA label text")
        }
        if let unsupportedReason = slabLabelAnalysis.unsupportedReason {
            warnings.append(userVisibleWarning(for: unsupportedReason))
        }
        if slabLabelAnalysis.certNumber == nil,
           slabLabelAnalysis.unsupportedReason != "non_psa_slab_not_supported_yet" {
            warnings.append("Could not extract PSA cert number")
        }
        if barcodePayloads.isEmpty {
            warnings.append("Could not extract slab barcode payload")
        }
        if labelOnlyPath {
            warnings.append("Used slab label-only OCR path")
        }

        print("  🔍 [OCR] Slab top label: '\(topLabelText)'")
        if !certText.isEmpty {
            print("  🔍 [OCR] Slab cert focus: '\(certText)'")
        }
        print("  🔍 [OCR] Slab geometry path: \(targetSelection.normalizedGeometryKind.rawValue)")
        print("  🔍 [OCR] Slab combined text: '\(combinedText)'")
        if !barcodePayloads.isEmpty {
            print("  🔍 [OCR] Slab barcode payloads: \(barcodePayloads.joined(separator: " | "))")
        }
        print("  🔍 [OCR] Slab grader: \(slabLabelAnalysis.grader ?? "<none>")")
        print("  🔍 [OCR] Slab grader confidence: \(String(format: "%.2f", slabLabelAnalysis.graderConfidence))")
        print("  🔍 [OCR] Slab grade: \(slabLabelAnalysis.grade ?? "<none>")")
        print("  🔍 [OCR] Slab grade confidence: \(String(format: "%.2f", slabLabelAnalysis.gradeConfidence))")
        print("  🔍 [OCR] Slab cert: \(slabLabelAnalysis.certNumber ?? "<none>")")
        print("  🔍 [OCR] Slab cert confidence: \(String(format: "%.2f", slabLabelAnalysis.certConfidence))")
        print("  🔍 [OCR] Slab lookup path: \(slabLabelAnalysis.recommendedLookupPath.rawValue)")
        print("  🔍 [OCR] Slab PSA confident: \(slabLabelAnalysis.isPSAConfident)")
        if let unsupportedReason = slabLabelAnalysis.unsupportedReason {
            print("  🔍 [OCR] Slab unsupported reason: \(unsupportedReason)")
        }
        print("  🔍 [OCR] Slab stage 2 used: \(stage2Used)")
        print(
            "  🔍 [OCR] Slab signals: red=\(String(format: "%.2f", visualSignals.redBandConfidence)) " +
            "barcode=\(String(format: "%.2f", visualSignals.barcodeRegionConfidence)) " +
            "right=\(String(format: "%.2f", visualSignals.rightColumnConfidence)) " +
            "white=\(String(format: "%.2f", visualSignals.whitePanelConfidence))"
        )
        if !slabLabelAnalysis.reasons.isEmpty {
            print("  🔍 [OCR] Slab reasons: \(slabLabelAnalysis.reasons.joined(separator: ", "))")
        }

        let elapsed = Date().timeIntervalSince(startTime)
        if config.debug.verboseLogging {
            print("  ⏱️ [SCAN] Slab OCR total: \(Int(elapsed * 1000))ms")
        }

        let ocrAnalysis = buildLegacySlabOCRAnalysisEnvelope(
            targetSelection: targetSelection,
            topLabelText: topLabelText,
            combinedText: combinedText,
            slabLabelAnalysis: slabLabelAnalysis,
            warnings: warnings
        )
        ScanStageArtifactWriter.recordSynthesizedEvidenceArtifact(
            scanID: scanID,
            stage: "legacy_slab_ocr_analysis",
            payload: ocrAnalysis
        )

        return AnalyzedCapture(
            scanID: scanID,
            originalImage: normalizedOriginal,
            normalizedImage: targetSelection.normalizedImage,
            recognizedTokens: [],
            collectorNumber: nil,
            setHintTokens: [],
            promoCodeHint: nil,
            slabGrader: slabLabelAnalysis.grader,
            slabGrade: slabLabelAnalysis.grade,
            slabCertNumber: slabLabelAnalysis.certNumber,
            slabBarcodePayloads: slabLabelAnalysis.barcodePayloads,
            slabGraderConfidence: Double(slabLabelAnalysis.graderConfidence),
            slabGradeConfidence: Double(slabLabelAnalysis.gradeConfidence),
            slabCertConfidence: Double(slabLabelAnalysis.certConfidence),
            slabCardNumberRaw: slabLabelAnalysis.cardNumberRaw,
            slabParsedLabelText: slabLabelAnalysis.parsedLabelText,
            slabClassifierReasons: slabLabelAnalysis.reasons,
            slabRecommendedLookupPath: slabLabelAnalysis.recommendedLookupPath,
            resolverModeHint: resolverModeHint,
            cropConfidence: targetSelection.selectionConfidence,
            warnings: warnings,
            shouldRetryWithStillPhoto: false,
            stillPhotoRetryReason: nil,
            ocrAnalysis: ocrAnalysis
        )
    }

    private func preferredSlabLabelText(candidates: [String]) -> String {
        let texts = candidates.filter { !$0.isEmpty }
        guard !texts.isEmpty else { return "" }

        return texts.max { lhs, rhs in
            slabLabelScore(lhs) < slabLabelScore(rhs)
        } ?? ""
    }

    private func shouldRunSecondaryPSAPass(for analysis: SlabLabelAnalysis) -> Bool {
        analysis.unsupportedReason != "non_psa_slab_not_supported_yet" && !analysis.isPSAConfident
    }

    private func userVisibleWarning(for unsupportedReason: String) -> String {
        switch unsupportedReason {
        case "non_psa_slab_not_supported_yet":
            return "Only PSA slabs are supported right now"
        case "psa_label_not_confident_enough":
            return "Could not read this PSA label strongly enough"
        default:
            return unsupportedReason
        }
    }

    private func slabLabelScore(_ text: String) -> Int {
        let normalized = text.uppercased()
        var score = normalized.count
        if normalized.contains("PSA") { score += 100 }
        if normalized.range(of: #"\b(10|[1-9])\b"#, options: .regularExpression) != nil { score += 20 }
        if normalized.range(of: #"\b\d{7,8}\b"#, options: .regularExpression) != nil { score += 20 }
        if normalized.contains("#") { score += 10 }
        return score
    }

    private func recognizeLabelRegion(
        croppedImage: CGImage,
        sourceImage: CGImage,
        region: CGRect,
        label: String,
        minimumTextHeight: Float,
        upscaleFactor: CGFloat
    ) throws -> String {
        print("  🔍 [OCR] Slab image size: \(sourceImage.width)x\(sourceImage.height)")
        print("  🔍 [OCR] Slab region: \(region)")

        print("  🔍 [OCR] Slab cropped region size: \(croppedImage.width)x\(croppedImage.height)")

        let upscaled = upscale(croppedImage, factor: upscaleFactor) ?? croppedImage
        print("  🔍 [OCR] Slab after \(upscaleFactor)x upscale: \(upscaled.width)x\(upscaled.height)")

        if config.debug.saveDebugImages {
            saveDebugImage(upscaled, label: label)
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.minimumTextHeight = minimumTextHeight
        request.recognitionLanguages = ["en-US"]

        let handler = VNImageRequestHandler(cgImage: upscaled, options: [:])
        try handler.perform([request])

        let observations = (request.results ?? []).sorted {
            let lhsTop = $0.boundingBox.maxY
            let rhsTop = $1.boundingBox.maxY
            if abs(lhsTop - rhsTop) > 0.05 {
                return lhsTop > rhsTop
            }
            return $0.boundingBox.minX < $1.boundingBox.minX
        }
        print("  🔍 [OCR] Slab found \(observations.count) text observations")

        let tokens = observations.compactMap { observation -> String? in
            let text = observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines)
            if let text {
                print("  🔍 [OCR] Slab detected: '\(text)' (confidence: \(observation.confidence))")
            }
            return text
        }

        return tokens.joined(separator: " ")
    }

    private func extractVisualSignals(from labelImage: CGImage) -> SlabVisualSignals {
        guard let signals = withRenderedRGBA(labelImage, computeVisualSignals) else {
            return .none
        }
        return signals
    }

    private func computeVisualSignals(
        pixels: UnsafeBufferPointer<UInt8>,
        width: Int,
        height: Int,
        bytesPerRow: Int
    ) -> SlabVisualSignals {
        let topBand = regionMetrics(
            pixels: pixels,
            width: width,
            height: height,
            bytesPerRow: bytesPerRow,
            rect: CGRect(x: 0.0, y: 0.0, width: 1.0, height: 0.16)
        )
        let bottomBand = regionMetrics(
            pixels: pixels,
            width: width,
            height: height,
            bytesPerRow: bytesPerRow,
            rect: CGRect(x: 0.0, y: 0.70, width: 1.0, height: 0.28)
        )
        let barcodeRegion = regionMetrics(
            pixels: pixels,
            width: width,
            height: height,
            bytesPerRow: bytesPerRow,
            rect: CGRect(x: 0.03, y: 0.48, width: 0.30, height: 0.42)
        )
        let rightColumn = regionMetrics(
            pixels: pixels,
            width: width,
            height: height,
            bytesPerRow: bytesPerRow,
            rect: CGRect(x: 0.69, y: 0.08, width: 0.28, height: 0.80)
        )
        let whitePanel = regionMetrics(
            pixels: pixels,
            width: width,
            height: height,
            bytesPerRow: bytesPerRow,
            rect: CGRect(x: 0.06, y: 0.10, width: 0.88, height: 0.78)
        )

        return SlabVisualSignals(
            redBandConfidence: min(1, max(topBand.redDominantRatio * 1.35, bottomBand.redDominantRatio * 1.20)),
            barcodeRegionConfidence: min(1, (barcodeRegion.transitionConfidence * 0.72) + (barcodeRegion.darkRatio * 0.28)),
            rightColumnConfidence: min(1, (rightColumn.textBandConfidence * 0.70) + (rightColumn.darkRatio * 0.30)),
            whitePanelConfidence: min(1, whitePanel.brightRatio * 1.08)
        )
    }

    private func regionMetrics(
        pixels: UnsafeBufferPointer<UInt8>,
        width: Int,
        height: Int,
        bytesPerRow: Int,
        rect: CGRect
    ) -> SlabRegionMetrics {
        let x0 = max(0, min(width - 1, Int((rect.minX * CGFloat(width)).rounded(.down))))
        let x1 = max(x0 + 1, min(width, Int((rect.maxX * CGFloat(width)).rounded(.up))))
        let y0 = max(0, min(height - 1, Int((rect.minY * CGFloat(height)).rounded(.down))))
        let y1 = max(y0 + 1, min(height, Int((rect.maxY * CGFloat(height)).rounded(.up))))
        let xStep = max(1, (x1 - x0) / 96)
        let yStep = max(1, (y1 - y0) / 72)

        var totalSamples = 0
        var redDominantSamples = 0
        var brightSamples = 0
        var darkSamples = 0
        var transitionCount = 0
        var rowBandClusters = 0
        var previousBandRow = false

        for y in stride(from: y0, to: y1, by: yStep) {
            var previousBinary: Int?
            var rowSamples = 0
            var rowDarkSamples = 0

            for x in stride(from: x0, to: x1, by: xStep) {
                let offset = (y * bytesPerRow) + (x * 4)
                let red = Float(pixels[offset]) / 255.0
                let green = Float(pixels[offset + 1]) / 255.0
                let blue = Float(pixels[offset + 2]) / 255.0
                let luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
                let maxOther = max(green, blue)

                if red >= 0.42, red > (maxOther * 1.30) {
                    redDominantSamples += 1
                }
                if luminance >= 0.72 {
                    brightSamples += 1
                }
                if luminance <= 0.30 {
                    darkSamples += 1
                    rowDarkSamples += 1
                }

                let binary = luminance < 0.45 ? 1 : 0
                if let previousBinary, previousBinary != binary {
                    transitionCount += 1
                }
                previousBinary = binary
                rowSamples += 1
                totalSamples += 1
            }

            let rowDarkRatio = rowSamples > 0 ? Float(rowDarkSamples) / Float(rowSamples) : 0
            let isBandRow = rowDarkRatio >= 0.14
            if isBandRow, !previousBandRow {
                rowBandClusters += 1
            }
            previousBandRow = isBandRow
        }

        guard totalSamples > 0 else { return .zero }

        let transitionBaseline = Float(max(1, ((y1 - y0) / yStep) * 8))
        return SlabRegionMetrics(
            redDominantRatio: Float(redDominantSamples) / Float(totalSamples),
            brightRatio: Float(brightSamples) / Float(totalSamples),
            darkRatio: Float(darkSamples) / Float(totalSamples),
            transitionConfidence: min(1, Float(transitionCount) / transitionBaseline),
            textBandConfidence: min(1, Float(rowBandClusters) / 3.0)
        )
    }

    private func withRenderedRGBA<T>(
        _ cgImage: CGImage,
        _ body: (_ pixels: UnsafeBufferPointer<UInt8>, _ width: Int, _ height: Int, _ bytesPerRow: Int) -> T
    ) -> T? {
        let width = cgImage.width
        let height = cgImage.height
        let bytesPerRow = width * 4
        var pixels = [UInt8](repeating: 0, count: height * bytesPerRow)
        let pixelCount = pixels.count

        return pixels.withUnsafeMutableBytes { rawBuffer in
            guard let baseAddress = rawBuffer.baseAddress,
                  let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
                  let context = CGContext(
                    data: baseAddress,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: colorSpace,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
                  ) else {
                return nil
            }

            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
            let buffer = UnsafeBufferPointer(
                start: rawBuffer.bindMemory(to: UInt8.self).baseAddress,
                count: pixelCount
            )
            return body(buffer, width, height, bytesPerRow)
        }
    }

    private func detectVerificationPayloads(in image: CGImage, regions: [CGRect]) throws -> [String] {
        var payloads: [String] = []

        for region in regions {
            guard let regionImage = cropToRect(image, region: region) else { continue }

            let request = VNDetectBarcodesRequest()
            request.symbologies = [.qr, .code128, .code39, .code93, .dataMatrix, .aztec, .ean13]

            let handler = VNImageRequestHandler(cgImage: regionImage, options: [:])
            try handler.perform([request])

            for observation in request.results ?? [] {
                guard let payload = observation.payloadStringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !payload.isEmpty else {
                    continue
                }
                print("  🔍 [OCR] Slab barcode payload: '\(payload)'")
                payloads.append(payload)
            }
        }

        var seen = Set<String>()
        return payloads.filter { payload in
            guard !seen.contains(payload) else { return false }
            seen.insert(payload)
            return true
        }
    }

    private func cropToRect(_ cgImage: CGImage, region: CGRect) -> CGImage? {
        let cropRect = CGRect(
            x: region.minX * CGFloat(cgImage.width),
            y: region.minY * CGFloat(cgImage.height),
            width: region.width * CGFloat(cgImage.width),
            height: region.height * CGFloat(cgImage.height)
        ).integral

        guard cropRect.width > 0, cropRect.height > 0 else { return nil }
        return cgImage.cropping(to: cropRect)
    }

    private func upscale(_ cgImage: CGImage, factor: CGFloat) -> CGImage? {
        guard factor > 1 else { return cgImage }

        let requestedWidth = CGFloat(cgImage.width) * factor
        let requestedHeight = CGFloat(cgImage.height) * factor
        let maxLongestSide: CGFloat = 4096
        let longestSide = max(requestedWidth, requestedHeight)
        let clampedScale = longestSide > maxLongestSide
            ? maxLongestSide / longestSide
            : 1.0

        let width = Int((requestedWidth * clampedScale).rounded(.toNearestOrAwayFromZero))
        let height = Int((requestedHeight * clampedScale).rounded(.toNearestOrAwayFromZero))

        guard width > 0, height > 0,
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else {
            return nil
        }

        context.interpolationQuality = .high
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }

    private func saveDebugImage(_ cgImage: CGImage, label: String) {
        let image = UIImage(cgImage: cgImage)

        PHPhotoLibrary.requestAuthorization { status in
            guard status == .authorized else {
                print("  ⚠️ [DEBUG] Photos permission denied")
                return
            }

            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.creationRequestForAsset(from: image)
            }) { success, error in
                if success {
                    print("  💾 [DEBUG] Saved \(label) region to Photos library")
                } else if let error = error {
                    print("  ❌ [DEBUG] Failed to save \(label): \(error.localizedDescription)")
                }
            }
        }
    }
}

private struct SlabRegionMetrics {
    let redDominantRatio: Float
    let brightRatio: Float
    let darkRatio: Float
    let transitionConfidence: Float
    let textBandConfidence: Float

    static let zero = SlabRegionMetrics(
        redDominantRatio: 0,
        brightRatio: 0,
        darkRatio: 0,
        transitionConfidence: 0,
        textBandConfidence: 0
    )
}

// MARK: - Supporting Types

enum AnalysisError: LocalizedError {
    case invalidImage

    var errorDescription: String? {
        switch self {
        case .invalidImage:
            "The selected image could not be processed."
        }
    }
}

extension UIImage {
    func normalizedOrientation() -> UIImage {
        guard imageOrientation != .up else { return self }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        if #available(iOS 12.0, *) {
            format.preferredRange = .standard
        }

        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            draw(in: CGRect(origin: .zero, size: size))
        }
    }
}
