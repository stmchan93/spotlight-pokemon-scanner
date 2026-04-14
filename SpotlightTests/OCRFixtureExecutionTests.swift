import XCTest
import UIKit
import Vision
@testable import Spotlight

private struct OCRFixtureManifest: Decodable {
    let fixtureName: String
    let selectedMode: String
    let sourceImage: String
    let tags: [String]
    let expects: OCRFixtureExpectations
}

private struct OCRFixtureExpectations: Codable {
    let cardName: String
    let collectorNumber: String?
    let setName: String?
    let setCodeHint: String?
    let confidenceBucket: String
    let preserveLowConfidenceEvidence: Bool
}

private struct OCRFixtureExecutionSummary: Codable {
    let fixtureName: String
    let selectedMode: String
    let sourceImage: String
    let scanID: String
    let ocrPipelineVersion: String?
    let ocrSelectedMode: String?
    let ocrRequestedGeometryKind: String?
    let ocrUsedFallback: Bool?
    let ocrTargetQualityScore: Double?
    let ocrLooksLikeRawScore: Double?
    let ocrLooksLikeSlabScore: Double?
    let ocrModeWarnings: [String]
    let normalizedImageWidth: Double
    let normalizedImageHeight: Double
    let cropConfidence: Double
    let collectorNumber: String?
    let setHintTokens: [String]
    let fullRecognizedText: String
    let metadataStripRecognizedText: String
    let topLabelRecognizedText: String
    let bottomLeftRecognizedText: String
    let bottomRightRecognizedText: String
    let slabGrader: String?
    let slabGrade: String?
    let slabCertNumber: String?
    let slabCardNumberRaw: String?
    let slabParsedLabelText: [String]
    let slabClassifierReasons: [String]
    let warnings: [String]
    let shouldRetryWithStillPhoto: Bool
    let stillPhotoRetryReason: String?
    let resolverModeHint: String
    let expected: OCRFixtureExpectations
}

private struct OCRFixtureExecutionIndex: Codable {
    let generatedAt: String
    let fixtureCount: Int
    let fixtures: [String]
}

final class OCRFixtureExecutionTests: XCTestCase {
    private let fileManager = FileManager.default

    private var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private var fixturesRoot: URL {
        repoRoot.appendingPathComponent("qa/ocr-fixtures", isDirectory: true)
    }

    private var outputRoot: URL {
        repoRoot.appendingPathComponent("qa/ocr-golden/simulator-legacy-v1", isDirectory: true)
    }

    func testLegacyOCRFixtures() async throws {
        let manifests = try fixtureManifestURLs()
        XCTAssertFalse(manifests.isEmpty, "expected at least one OCR fixture")

        try recreateDirectory(at: outputRoot)

        var completedFixtureNames: [String] = []

        for manifestURL in manifests {
            let fixture = try decodeFixtureManifest(at: manifestURL)
            guard fixture.selectedMode == "slab" else { continue }
            let sourceImageURL = manifestURL.deletingLastPathComponent().appendingPathComponent(fixture.sourceImage)

            XCTAssertTrue(fileManager.fileExists(atPath: sourceImageURL.path), "missing source image for \(fixture.fixtureName)")
            guard let sourceImage = UIImage(contentsOfFile: sourceImageURL.path) else {
                XCTFail("unable to load source image for \(fixture.fixtureName)")
                continue
            }

            let capture = ScanCaptureInput(
                originalImage: sourceImage,
                searchImage: sourceImage,
                fallbackImage: sourceImage,
                captureSource: .importedPhoto
            )

            let scanID = UUID()
            let scanner = SlabScanner(
                config: SlabScanConfiguration(
                    labelOCR: .default,
                    debug: .disabled
                )
            )
            let analyzed = try await scanner.analyze(
                scanID: scanID,
                capture: capture,
                resolverModeHint: .psaSlab
            )

            let outputDirectory = outputRoot.appendingPathComponent(fixture.fixtureName, isDirectory: true)
            try fileManager.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

            let rawEvidence = analyzed.ocrAnalysis?.rawEvidence
            let slabEvidence = analyzed.ocrAnalysis?.slabEvidence
            let fullRecognizedText = rawEvidence?.wholeCardText ?? slabEvidence?.labelWideText ?? ""
            let metadataStripRecognizedText = rawEvidence?.footerBandText ?? ""
            let topLabelRecognizedText = slabEvidence?.titleTextPrimary ?? ""

            let summary = OCRFixtureExecutionSummary(
                fixtureName: fixture.fixtureName,
                selectedMode: fixture.selectedMode,
                sourceImage: fixture.sourceImage,
                scanID: scanID.uuidString,
                ocrPipelineVersion: analyzed.ocrAnalysis?.pipelineVersion.rawValue,
                ocrSelectedMode: analyzed.ocrAnalysis?.selectedMode.rawValue,
                ocrRequestedGeometryKind: analyzed.ocrAnalysis?.normalizedTarget?.geometryKind,
                ocrUsedFallback: analyzed.ocrAnalysis?.normalizedTarget?.usedFallback,
                ocrTargetQualityScore: analyzed.ocrAnalysis?.normalizedTarget?.targetQuality.overallScore,
                ocrLooksLikeRawScore: analyzed.ocrAnalysis?.modeSanitySignals?.looksLikeRawScore,
                ocrLooksLikeSlabScore: analyzed.ocrAnalysis?.modeSanitySignals?.looksLikeSlabScore,
                ocrModeWarnings: analyzed.ocrAnalysis?.modeSanitySignals?.warnings ?? [],
                normalizedImageWidth: analyzed.normalizedImage.size.width,
                normalizedImageHeight: analyzed.normalizedImage.size.height,
                cropConfidence: analyzed.cropConfidence,
                collectorNumber: analyzed.collectorNumber,
                setHintTokens: analyzed.setHintTokens,
                fullRecognizedText: fullRecognizedText,
                metadataStripRecognizedText: metadataStripRecognizedText,
                topLabelRecognizedText: topLabelRecognizedText,
                bottomLeftRecognizedText: "",
                bottomRightRecognizedText: "",
                slabGrader: analyzed.slabGrader,
                slabGrade: analyzed.slabGrade,
                slabCertNumber: analyzed.slabCertNumber,
                slabCardNumberRaw: analyzed.slabCardNumberRaw,
                slabParsedLabelText: analyzed.slabParsedLabelText,
                slabClassifierReasons: analyzed.slabClassifierReasons,
                warnings: analyzed.warnings,
                shouldRetryWithStillPhoto: analyzed.shouldRetryWithStillPhoto,
                stillPhotoRetryReason: analyzed.stillPhotoRetryReason,
                resolverModeHint: analyzed.resolverModeHint.rawValue,
                expected: fixture.expects
            )

            try writeJSON(summary, to: outputDirectory.appendingPathComponent("legacy_analysis.json"))
            if let jpegData = analyzed.normalizedImage.jpegData(compressionQuality: 0.92) {
                try jpegData.write(to: outputDirectory.appendingPathComponent("normalized.jpg"), options: .atomic)
            }

            completedFixtureNames.append(fixture.fixtureName)
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        let index = OCRFixtureExecutionIndex(
            generatedAt: formatter.string(from: Date()),
            fixtureCount: completedFixtureNames.count,
            fixtures: completedFixtureNames
        )
        try writeJSON(index, to: outputRoot.appendingPathComponent("index.json"))
    }

    private func fixtureManifestURLs() throws -> [URL] {
        let directories = try fileManager.contentsOfDirectory(
            at: fixturesRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )

        return directories
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .map { $0.appendingPathComponent("fixture.json") }
            .filter { fileManager.fileExists(atPath: $0.path) }
            .sorted { $0.deletingLastPathComponent().lastPathComponent < $1.deletingLastPathComponent().lastPathComponent }
    }

    private func decodeFixtureManifest(at url: URL) throws -> OCRFixtureManifest {
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(OCRFixtureManifest.self, from: data)
    }

    private func recreateDirectory(at url: URL) throws {
        if fileManager.fileExists(atPath: url.path) {
            try fileManager.removeItem(at: url)
        }
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
    }

    private func writeJSON<T: Encodable>(_ value: T, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(value).write(to: url, options: .atomic)
    }
}

private struct SlabRegressionManifest: Decodable {
    let fixtureName: String
    let split: String
    let selectedMode: String
    let captureKind: String
    let sourceImage: String
    let tags: [String]
    let truth: SlabRegressionTruth
    let expects: SlabRegressionExpectations
    let notes: String?
}

private struct SlabRegressionTruth: Codable {
    let grader: String
    let grade: String
    let certNumber: String
    let cardID: String?
    let cardName: String
    let setName: String
    let cardNumber: String
    let pricingProvider: String
    let pricingLookup: SlabRegressionPricingLookup
}

private struct SlabRegressionPricingLookup: Codable {
    let mode: String
    let cardID: String?
    let grader: String
    let grade: String
}

private struct SlabRegressionExpectations: Codable {
    let certReadRequired: Bool
    let identityMustMatch: Bool
    let pricingMayBeUnavailable: Bool
}

private struct SlabRegressionFixtureSummary: Codable {
    let fixtureName: String
    let split: String
    let captureKind: String
    let sourceImage: String
    let scanID: String
    let normalizedGeometryKind: String?
    let usedFallback: Bool?
    let cropConfidence: Double
    let grader: String?
    let grade: String?
    let certNumber: String?
    let cardNumberRaw: String?
    let parsedLabelText: [String]
    let lookupPath: String?
    let warnings: [String]
    let truth: SlabRegressionTruth
    let expects: SlabRegressionExpectations
    let certExactMatch: Bool
    let graderExactMatch: Bool
    let gradeExactMatch: Bool
    let cardNumberExactMatch: Bool
}

private struct SlabRegressionScoreEntry: Codable {
    let fixtureName: String
    let split: String
    let captureKind: String
    let certExactMatch: Bool
    let graderExactMatch: Bool
    let gradeExactMatch: Bool
    let cardNumberExactMatch: Bool
    let lookupPath: String?
    let normalizedGeometryKind: String?
}

private struct SlabRegressionAggregate: Codable {
    let fixtureCount: Int
    let certExactMatches: Int
    let graderExactMatches: Int
    let gradeExactMatches: Int
    let cardNumberExactMatches: Int
    let certExactRate: Double
    let graderExactRate: Double
    let gradeExactRate: Double
    let cardNumberExactRate: Double
}

private struct SlabRegressionScorecard: Codable {
    let generatedAt: String
    let fixtureCount: Int
    let bySplit: [String: SlabRegressionAggregate]
    let byCaptureKind: [String: SlabRegressionAggregate]
    let fixtures: [SlabRegressionScoreEntry]
    let notes: [String]
}

final class SlabRegressionFixtureExecutionTests: XCTestCase {
    private let fileManager = FileManager.default

    private var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private var fixturesRoot: URL {
        repoRoot.appendingPathComponent("qa/slab-regression", isDirectory: true)
    }

    private var outputRoot: URL {
        repoRoot.appendingPathComponent("qa/slab-regression/simulator-vision-v1", isDirectory: true)
    }

    func testSlabRegressionFixtures() async throws {
        let manifests = try fixtureManifestURLs()
        XCTAssertFalse(manifests.isEmpty, "expected at least one slab regression fixture")

        try recreateDirectory(at: outputRoot)

        let scanner = SlabScanner(
            config: SlabScanConfiguration(
                labelOCR: .default,
                debug: .disabled
            )
        )

        var scoreEntries: [SlabRegressionScoreEntry] = []

        for manifestURL in manifests {
            let fixture = try decodeFixtureManifest(at: manifestURL)
            guard fixture.selectedMode == "slab" else { continue }

            let sourceImageURL = manifestURL.deletingLastPathComponent().appendingPathComponent(fixture.sourceImage)
            XCTAssertTrue(fileManager.fileExists(atPath: sourceImageURL.path), "missing source image for \(fixture.fixtureName)")
            guard let sourceImage = UIImage(contentsOfFile: sourceImageURL.path) else {
                XCTFail("unable to load source image for \(fixture.fixtureName)")
                continue
            }
            let scanID = UUID()
            let analyzed = try await analyzeFixture(
                fixture: fixture,
                sourceImage: sourceImage,
                scanID: scanID,
                scanner: scanner
            )

            let certExactMatch = analyzed.slabCertNumber == fixture.truth.certNumber
            let graderExactMatch = normalizeComparison(analyzed.slabGrader) == normalizeComparison(fixture.truth.grader)
            let gradeExactMatch = normalizeComparison(analyzed.slabGrade) == normalizeComparison(fixture.truth.grade)
            let cardNumberExactMatch = normalizeCardNumber(analyzed.slabCardNumberRaw) == normalizeCardNumber(fixture.truth.cardNumber)

            let summary = SlabRegressionFixtureSummary(
                fixtureName: fixture.fixtureName,
                split: fixture.split,
                captureKind: fixture.captureKind,
                sourceImage: fixture.sourceImage,
                scanID: scanID.uuidString,
                normalizedGeometryKind: analyzed.ocrAnalysis?.normalizedTarget?.geometryKind,
                usedFallback: analyzed.ocrAnalysis?.normalizedTarget?.usedFallback,
                cropConfidence: analyzed.cropConfidence,
                grader: analyzed.slabGrader,
                grade: analyzed.slabGrade,
                certNumber: analyzed.slabCertNumber,
                cardNumberRaw: analyzed.slabCardNumberRaw,
                parsedLabelText: analyzed.slabParsedLabelText,
                lookupPath: analyzed.slabRecommendedLookupPath?.rawValue,
                warnings: analyzed.warnings,
                truth: fixture.truth,
                expects: fixture.expects,
                certExactMatch: certExactMatch,
                graderExactMatch: graderExactMatch,
                gradeExactMatch: gradeExactMatch,
                cardNumberExactMatch: cardNumberExactMatch
            )

            let outputDirectory = outputRoot
                .appendingPathComponent(fixture.split, isDirectory: true)
                .appendingPathComponent(fixture.fixtureName, isDirectory: true)
            try fileManager.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
            try writeJSON(summary, to: outputDirectory.appendingPathComponent("slab_regression_analysis.json"))
            if let jpegData = analyzed.normalizedImage.jpegData(compressionQuality: 0.92) {
                try jpegData.write(to: outputDirectory.appendingPathComponent("normalized.jpg"), options: .atomic)
            }

            scoreEntries.append(
                SlabRegressionScoreEntry(
                    fixtureName: fixture.fixtureName,
                    split: fixture.split,
                    captureKind: fixture.captureKind,
                    certExactMatch: certExactMatch,
                    graderExactMatch: graderExactMatch,
                    gradeExactMatch: gradeExactMatch,
                    cardNumberExactMatch: cardNumberExactMatch,
                    lookupPath: analyzed.slabRecommendedLookupPath?.rawValue,
                    normalizedGeometryKind: analyzed.ocrAnalysis?.normalizedTarget?.geometryKind
                )
            )
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]

        let scorecard = SlabRegressionScorecard(
            generatedAt: formatter.string(from: Date()),
            fixtureCount: scoreEntries.count,
            bySplit: aggregateByKey(scoreEntries, keyPath: \.split),
            byCaptureKind: aggregateByKey(scoreEntries, keyPath: \.captureKind),
            fixtures: scoreEntries.sorted { $0.fixtureName < $1.fixtureName },
            notes: [
                "This first slab regression runner is OCR-only. Backend identity/pricing scoring is not wired into this scorecard yet.",
                "Derived label-only crops are valid for tuning only and must not be used as held-out evidence."
            ]
        )

        try writeJSON(scorecard, to: outputRoot.appendingPathComponent("scorecard.json"))
    }

    func testDerivedLabelOnlyFixtureDirectOCRReadsDracozoltPSALabel() throws {
        let manifestURL = fixturesRoot
            .appendingPathComponent("tuning", isDirectory: true)
            .appendingPathComponent("psa-dracozolt-vmax-210-evolving-skies-secret-80533912-label-only-derived", isDirectory: true)
            .appendingPathComponent("fixture.json")
        let fixture = try decodeFixtureManifest(at: manifestURL)
        let sourceImageURL = manifestURL.deletingLastPathComponent().appendingPathComponent(fixture.sourceImage)
        guard let sourceImage = UIImage(contentsOfFile: sourceImageURL.path) else {
            XCTFail("unable to load source image for \(fixture.fixtureName)")
            return
        }

        let analyzed = try analyzeLabelOnlyFixture(
            scanID: UUID(),
            sourceImage: sourceImage
        )

        XCTAssertEqual(normalizeComparison(analyzed.slabGrade), "10")
        XCTAssertEqual(analyzed.slabCertNumber, "80533912")
        XCTAssertEqual(analyzed.slabCardNumberRaw, "210")
        XCTAssertTrue(
            analyzed.slabParsedLabelText.joined(separator: " ").contains("DRACOZOLT VMAX"),
            "expected parsed label text to retain Dracozolt VMAX"
        )
    }

    private func fixtureManifestURLs() throws -> [URL] {
        let roots = [
            fixturesRoot.appendingPathComponent("tuning", isDirectory: true),
            fixturesRoot.appendingPathComponent("heldout", isDirectory: true),
        ]

        var manifests: [URL] = []
        for root in roots where fileManager.fileExists(atPath: root.path) {
            let directories = try fileManager.contentsOfDirectory(
                at: root,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            )
            manifests += directories
                .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
                .map { $0.appendingPathComponent("fixture.json") }
                .filter { fileManager.fileExists(atPath: $0.path) }
        }

        return manifests.sorted { lhs, rhs in
            lhs.deletingLastPathComponent().lastPathComponent < rhs.deletingLastPathComponent().lastPathComponent
        }
    }

    private func decodeFixtureManifest(at url: URL) throws -> SlabRegressionManifest {
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(SlabRegressionManifest.self, from: data)
    }

    private func recreateDirectory(at url: URL) throws {
        if fileManager.fileExists(atPath: url.path) {
            try fileManager.removeItem(at: url)
        }
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
    }

    private func writeJSON<T: Encodable>(_ value: T, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(value).write(to: url, options: .atomic)
    }

    private func aggregateByKey(
        _ entries: [SlabRegressionScoreEntry],
        keyPath: KeyPath<SlabRegressionScoreEntry, String>
    ) -> [String: SlabRegressionAggregate] {
        let grouped = Dictionary(grouping: entries, by: { $0[keyPath: keyPath] })
        return grouped.mapValues(aggregate)
    }

    private func aggregate(_ entries: [SlabRegressionScoreEntry]) -> SlabRegressionAggregate {
        let fixtureCount = entries.count
        let certExactMatches = entries.filter(\.certExactMatch).count
        let graderExactMatches = entries.filter(\.graderExactMatch).count
        let gradeExactMatches = entries.filter(\.gradeExactMatch).count
        let cardNumberExactMatches = entries.filter(\.cardNumberExactMatch).count

        func rate(_ matches: Int) -> Double {
            guard fixtureCount > 0 else { return 0 }
            return Double(matches) / Double(fixtureCount)
        }

        return SlabRegressionAggregate(
            fixtureCount: fixtureCount,
            certExactMatches: certExactMatches,
            graderExactMatches: graderExactMatches,
            gradeExactMatches: gradeExactMatches,
            cardNumberExactMatches: cardNumberExactMatches,
            certExactRate: rate(certExactMatches),
            graderExactRate: rate(graderExactMatches),
            gradeExactRate: rate(gradeExactMatches),
            cardNumberExactRate: rate(cardNumberExactMatches)
        )
    }

    private func normalizeComparison(_ value: String?) -> String? {
        value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
    }

    private func normalizeCardNumber(_ value: String?) -> String? {
        guard let value else { return nil }
        return value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
            .replacingOccurrences(of: " ", with: "")
    }

    private func analyzeFixture(
        fixture: SlabRegressionManifest,
        sourceImage: UIImage,
        scanID: UUID,
        scanner: SlabScanner
    ) async throws -> AnalyzedCapture {
        if fixture.captureKind == "label_only" {
            return try analyzeLabelOnlyFixture(
                scanID: scanID,
                sourceImage: sourceImage
            )
        }

        let capture = ScanCaptureInput(
            originalImage: sourceImage,
            searchImage: sourceImage,
            fallbackImage: sourceImage,
            captureSource: .importedPhoto
        )
        return try await scanner.analyze(
            scanID: scanID,
            capture: capture,
            resolverModeHint: .psaSlab
        )
    }

    private func analyzeLabelOnlyFixture(
        scanID: UUID,
        sourceImage: UIImage
    ) throws -> AnalyzedCapture {
        let normalizedImage = sourceImage.normalizedOrientation()
        guard let cgImage = normalizedImage.cgImage else {
            throw AnalysisError.invalidImage
        }

        let topLabelText = try recognizeSlabFixtureText(
            in: cgImage,
            region: CGRect(x: 0, y: 0, width: 1, height: 1),
            minimumTextHeight: 0.006,
            upscaleFactor: 3.5
        )
        let certText = try recognizeSlabFixtureText(
            in: cgImage,
            region: CGRect(x: 0.42, y: 0.10, width: 0.56, height: 0.82),
            minimumTextHeight: 0.004,
            upscaleFactor: 4.0
        )
        let rightColumnText = try recognizeSlabFixtureText(
            in: cgImage,
            region: CGRect(x: 0.58, y: 0.02, width: 0.40, height: 0.96),
            minimumTextHeight: 0.006,
            upscaleFactor: 3.5
        )

        var labelTexts = [topLabelText]
        if !certText.isEmpty {
            labelTexts.append(certText)
        }
        if !rightColumnText.isEmpty {
            labelTexts.append(rightColumnText)
        }

        let slabLabelAnalysis = SlabLabelParser.analyze(labelTexts: labelTexts)
        let combinedText = labelTexts
            .filter { !$0.isEmpty }
            .reduce(into: [String]()) { unique, text in
                if !unique.contains(text) {
                    unique.append(text)
                }
            }
            .joined(separator: " ")

        let targetSelection = OCRTargetSelectionResult(
            normalizedImage: normalizedImage,
            normalizedContentRect: OCRNormalizedRect(x: 0, y: 0, width: 1, height: 1),
            selectionConfidence: 0.58,
            usedFallback: true,
            fallbackReason: "fixture_label_only_direct_ocr",
            chosenCandidateIndex: nil,
            candidates: [],
            normalizedGeometryKind: .slabLabel,
            normalizationReason: "fixture_label_only_direct_ocr"
        )
        let warnings = ["Used slab label-only OCR path"]
        let ocrAnalysis = buildLegacySlabOCRAnalysisEnvelope(
            targetSelection: targetSelection,
            topLabelText: topLabelText,
            combinedText: combinedText,
            slabLabelAnalysis: slabLabelAnalysis,
            warnings: warnings
        )

        return AnalyzedCapture(
            scanID: scanID,
            originalImage: sourceImage,
            normalizedImage: normalizedImage,
            recognizedTokens: [],
            collectorNumber: nil,
            setHintTokens: [],
            setBadgeHint: nil,
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
            resolverModeHint: .psaSlab,
            cropConfidence: 0.58,
            warnings: warnings,
            shouldRetryWithStillPhoto: false,
            stillPhotoRetryReason: nil,
            ocrAnalysis: ocrAnalysis
        )
    }

    private func recognizeSlabFixtureText(
        in sourceImage: CGImage,
        region: CGRect,
        minimumTextHeight: Float,
        upscaleFactor: CGFloat
    ) throws -> String {
        guard let cropped = cropFixtureImage(sourceImage, normalizedRect: region) else {
            return ""
        }
        let upscaled = upscaleFixtureImage(cropped, factor: upscaleFactor) ?? cropped

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

        return observations.compactMap { observation in
            observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        .joined(separator: " ")
    }

    private func cropFixtureImage(_ image: CGImage, normalizedRect: CGRect) -> CGImage? {
        let cropRect = CGRect(
            x: normalizedRect.minX * CGFloat(image.width),
            y: normalizedRect.minY * CGFloat(image.height),
            width: normalizedRect.width * CGFloat(image.width),
            height: normalizedRect.height * CGFloat(image.height)
        ).integral
        guard cropRect.width > 0,
              cropRect.height > 0 else {
            return nil
        }
        return image.cropping(to: cropRect)
    }

    private func upscaleFixtureImage(_ image: CGImage, factor: CGFloat) -> CGImage? {
        guard factor > 1 else { return image }
        let width = Int((CGFloat(image.width) * factor).rounded())
        let height = Int((CGFloat(image.height) * factor).rounded())
        guard width > 0, height > 0,
              let colorSpace = image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB),
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
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }
}
