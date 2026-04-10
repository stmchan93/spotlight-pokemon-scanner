import XCTest
import UIKit
@testable import Spotlight

private struct OCRRewriteFixtureManifest: Decodable {
    let fixtureName: String
    let selectedMode: String
    let sourceImage: String
    let tags: [String]
    let expects: OCRRewriteFixtureExpectations
}

private struct OCRRewriteFixtureExpectations: Codable {
    let cardName: String
    let collectorNumber: String?
    let setName: String?
    let setCodeHint: String?
    let confidenceBucket: String
    let preserveLowConfidenceEvidence: Bool
}

private struct OCRRewriteFixtureExecutionSummary: Codable {
    let fixtureName: String
    let sourceImage: String
    let scanID: String
    let ocrPipelineVersion: String?
    let ocrSelectedMode: String?
    let ocrRequestedGeometryKind: String?
    let ocrUsedFallback: Bool?
    let ocrTargetQualityScore: Double?
    let titleTextPrimary: String?
    let collectorNumber: String?
    let setHintTokens: [String]
    let fullRecognizedText: String
    let metadataStripRecognizedText: String
    let cropConfidence: Double
    let warnings: [String]
    let shouldRetryWithStillPhoto: Bool
    let stillPhotoRetryReason: String?
    let expected: OCRRewriteFixtureExpectations
}

private struct OCRRewriteFixtureExecutionIndex: Codable {
    let generatedAt: String
    let fixtureCount: Int
    let fixtures: [String]
}

final class OCRRewriteStage2FixtureTests: XCTestCase {
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
        repoRoot.appendingPathComponent("qa/ocr-golden/simulator-rewrite-v1-raw-stage2", isDirectory: true)
    }

    func testRewriteRawStage2Fixtures() async throws {
        let manifests = try fixtureManifestURLs()
        XCTAssertFalse(manifests.isEmpty, "expected at least one OCR fixture")

        try recreateDirectory(at: outputRoot)

        let pipeline = RawPipeline()
        var completedFixtureNames: [String] = []

        for manifestURL in manifests {
            let fixture = try decodeFixtureManifest(at: manifestURL)
            guard fixture.selectedMode == "raw" else { continue }

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
            let analyzed = try await pipeline.analyze(
                scanID: scanID,
                capture: capture,
                resolverModeHint: .rawCard
            )

            XCTAssertEqual(analyzed.ocrAnalysis?.pipelineVersion, .rewriteV1)

            let outputDirectory = outputRoot.appendingPathComponent(fixture.fixtureName, isDirectory: true)
            try fileManager.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

            let summary = OCRRewriteFixtureExecutionSummary(
                fixtureName: fixture.fixtureName,
                sourceImage: fixture.sourceImage,
                scanID: scanID.uuidString,
                ocrPipelineVersion: analyzed.ocrAnalysis?.pipelineVersion.rawValue,
                ocrSelectedMode: analyzed.ocrAnalysis?.selectedMode.rawValue,
                ocrRequestedGeometryKind: analyzed.ocrAnalysis?.normalizedTarget?.geometryKind,
                ocrUsedFallback: analyzed.ocrAnalysis?.normalizedTarget?.usedFallback,
                ocrTargetQualityScore: analyzed.ocrAnalysis?.normalizedTarget?.targetQuality.overallScore,
                titleTextPrimary: analyzed.ocrAnalysis?.rawEvidence?.titleTextPrimary,
                collectorNumber: analyzed.collectorNumber,
                setHintTokens: analyzed.setHintTokens,
                fullRecognizedText: analyzed.fullRecognizedText,
                metadataStripRecognizedText: analyzed.metadataStripRecognizedText,
                cropConfidence: analyzed.cropConfidence,
                warnings: analyzed.warnings,
                shouldRetryWithStillPhoto: analyzed.shouldRetryWithStillPhoto,
                stillPhotoRetryReason: analyzed.stillPhotoRetryReason,
                expected: fixture.expects
            )

            try writeJSON(summary, to: outputDirectory.appendingPathComponent("rewrite_stage1_analysis.json"))
            if let jpegData = analyzed.normalizedImage.jpegData(compressionQuality: 0.92) {
                try jpegData.write(to: outputDirectory.appendingPathComponent("normalized.jpg"), options: .atomic)
            }

            completedFixtureNames.append(fixture.fixtureName)
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        let index = OCRRewriteFixtureExecutionIndex(
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

    private func decodeFixtureManifest(at url: URL) throws -> OCRRewriteFixtureManifest {
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(OCRRewriteFixtureManifest.self, from: data)
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
