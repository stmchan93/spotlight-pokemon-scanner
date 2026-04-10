import XCTest
import UIKit
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
    let directLookupLikely: Bool
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
            let analyzed: AnalyzedCapture

            if fixture.selectedMode == "raw" {
                let scanner = RawCardScanner()
                analyzed = try await scanner.analyze(
                    scanID: scanID,
                    capture: capture,
                    resolverModeHint: .rawCard
                )
            } else {
                let scanner = SlabScanner(
                    config: SlabScanConfiguration(
                        labelOCR: .default,
                        debug: .disabled
                    )
                )
                analyzed = try await scanner.analyze(
                    scanID: scanID,
                    capture: capture,
                    resolverModeHint: .psaSlab
                )
            }

            let outputDirectory = outputRoot.appendingPathComponent(fixture.fixtureName, isDirectory: true)
            try fileManager.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

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
                fullRecognizedText: analyzed.fullRecognizedText,
                metadataStripRecognizedText: analyzed.metadataStripRecognizedText,
                topLabelRecognizedText: analyzed.topLabelRecognizedText,
                bottomLeftRecognizedText: analyzed.bottomLeftRecognizedText,
                bottomRightRecognizedText: analyzed.bottomRightRecognizedText,
                slabGrader: analyzed.slabGrader,
                slabGrade: analyzed.slabGrade,
                slabCertNumber: analyzed.slabCertNumber,
                slabCardNumberRaw: analyzed.slabCardNumberRaw,
                slabParsedLabelText: analyzed.slabParsedLabelText,
                slabClassifierReasons: analyzed.slabClassifierReasons,
                warnings: analyzed.warnings,
                shouldRetryWithStillPhoto: analyzed.shouldRetryWithStillPhoto,
                stillPhotoRetryReason: analyzed.stillPhotoRetryReason,
                directLookupLikely: analyzed.directLookupLikely,
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
