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

private struct RawFooterLayoutRuntimeSummary: Codable {
    let fixtureName: String
    let scanID: String
    let ocrRequestedGeometryKind: String?
    let ocrUsedFallback: Bool?
    let ocrTargetQualityScore: Double?
    let ocrTargetQualityReasons: [String]
    let contentRectNormalized: OCRNormalizedRect?
    let normalizedImageWidth: Double
    let normalizedImageHeight: Double
    let collectorNumber: String?
    let setHintTokens: [String]
    let collectorConfidenceScore: Double?
    let collectorConfidenceReasons: [String]
    let setConfidenceScore: Double?
    let setConfidenceReasons: [String]
    let footerRouting: RawFooterRoutingContext
    let stage1AssessmentReasons: [String]
    let passSummaries: [RawFooterLayoutRuntimePassSummary]
    let warnings: [String]
}

private struct RawFooterLayoutRuntimePassSummary: Codable {
    let label: String
    let kind: String
    let footerFamily: String?
    let footerRole: String?
    let normalizedRect: OCRNormalizedRect
    let text: String
    let tokens: [RecognizedToken]
}

private struct RawFooterLayoutTruth: Codable {
    let cardName: String
    let collectorNumber: String
    let setCode: String?
    let layoutBias: String?
    let footerFamily: String?
    let collectorBoxCanonical: OCRNormalizedRect?
    let setBadgeBoxCanonical: OCRNormalizedRect?
    let runtimeValidation: RawFooterLayoutRuntimeValidation?
}

private struct RawFooterLayoutRuntimeValidation: Codable {
    let enabled: Bool
    let requireCollectorExact: Bool?
    let requireCollectorFromExpectedFamily: Bool?
    let requiredSetHintTokens: [String]?
}

private struct RawFooterLayoutSeedScorecard: Codable {
    let generatedAt: String
    let validatedFixtureCount: Int
    let passedFixtureCount: Int
    let fixtures: [RawFooterLayoutSeedScoreEntry]
}

private struct RawFooterLayoutSeedScoreEntry: Codable {
    let fixtureName: String
    let expectedCollector: String
    let actualCollector: String?
    let collectorExactMatch: Bool
    let expectedFooterFamily: String?
    let collectorFamilyMatched: Bool?
    let requiredSetHintTokens: [String]
    let actualSetHintTokens: [String]
    let setHintMatched: Bool?
    let passed: Bool
}

final class OCRRewriteStage2FixtureTests: XCTestCase {
    private let fileManager = FileManager.default
    private let identifierParser = CardIdentifierParser()

    private var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private var fixturesRoot: URL {
        return repoRoot.appendingPathComponent("qa/ocr-fixtures", isDirectory: true)
    }

    private var outputRoot: URL {
        return repoRoot.appendingPathComponent("qa/ocr-golden/simulator-rewrite-v1-raw-stage2", isDirectory: true)
    }

    private var rawFooterLayoutCheckRoot: URL {
        return repoRoot.appendingPathComponent("qa/raw-footer-layout-check", isDirectory: true)
    }

    func testRawFooterBroadPlanUsesCardRelativeFooterBandForBareCards() {
        let planner = RawROIPlanner()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: false,
            targetQualityScore: 0.86,
            warnings: []
        )

        let footerBand = broadPlanItem(planner: planner, sceneTraits: sceneTraits)
        XCTAssertEqual(footerBand.normalizedRect.x, 0.0, accuracy: 0.0001)
        XCTAssertEqual(footerBand.normalizedRect.y, 0.78, accuracy: 0.0001)
        XCTAssertEqual(footerBand.normalizedRect.width, 1.0, accuracy: 0.0001)
        XCTAssertEqual(footerBand.normalizedRect.height, 0.22, accuracy: 0.0001)
    }

    func testRawFooterBroadPlanRespectsLetterboxedContentRect() {
        let planner = RawROIPlanner()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: false,
            targetQualityScore: 0.86,
            normalizedContentRect: OCRNormalizedRect(
                x: 0.0,
                y: 0.01765,
                width: 1.0,
                height: 0.9647
            ),
            warnings: []
        )

        let footerBand = broadPlanItem(planner: planner, sceneTraits: sceneTraits)
        XCTAssertEqual(footerBand.normalizedRect.x, 0.0, accuracy: 0.0001)
        XCTAssertEqual(footerBand.normalizedRect.y, 0.770116, accuracy: 0.001)
        XCTAssertEqual(footerBand.normalizedRect.width, 1.0, accuracy: 0.0001)
        XCTAssertEqual(footerBand.normalizedRect.height, 0.212234, accuracy: 0.001)
    }

    func testRawFooterTightPlanAnchorsModernLeftCollectorAroundBandDetection() {
        let planner = RawROIPlanner()
        let sceneTraits = RawSceneTraits(
            holderLikely: false,
            usedFallback: false,
            targetQualityScore: 0.86,
            warnings: []
        )
        let routing = RawFooterRoutingContext(
            collectorAnchor: OCRNormalizedRect(x: 0.22, y: 0.87, width: 0.10, height: 0.03),
            anchorIdentifier: "200/165",
            reasons: ["unit_test_anchor"]
        )

        let collector = tightPlanItem(
            family: .modernLeft,
            role: .collector,
            planner: planner,
            sceneTraits: sceneTraits,
            routing: routing
        )
        let setBadge = tightPlanItem(
            family: .modernLeft,
            role: .setBadge,
            planner: planner,
            sceneTraits: sceneTraits,
            routing: routing
        )

        XCTAssertEqual(collector.normalizedRect.x, 0.1325, accuracy: 0.001)
        XCTAssertEqual(collector.normalizedRect.y, 0.839, accuracy: 0.005)
        XCTAssertEqual(collector.normalizedRect.width, 0.275, accuracy: 0.001)
        XCTAssertEqual(collector.normalizedRect.height, 0.092, accuracy: 0.001)
        XCTAssertLessThan(setBadge.normalizedRect.x, collector.normalizedRect.x)
        XCTAssertLessThanOrEqual(setBadge.normalizedRect.y, collector.normalizedRect.y + 0.01)
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
            let rawEvidence = analyzed.ocrAnalysis?.rawEvidence

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
                fullRecognizedText: rawEvidence?.wholeCardText ?? "",
                metadataStripRecognizedText: rawEvidence?.footerBandText ?? "",
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

    func testRawFooterLayoutCheckFixturesEmitRuntimeSelectionSummary() async throws {
        let fixtureDirectories = try fileManager.contentsOfDirectory(
            at: rawFooterLayoutCheckRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }

        XCTAssertFalse(fixtureDirectories.isEmpty, "expected raw footer layout check fixtures")

        for directory in fixtureDirectories {
            let sourceImageURL = directory.appendingPathComponent("source_scan.jpg")
            guard fileManager.fileExists(atPath: sourceImageURL.path) else {
                continue
            }
            guard let sourceImage = UIImage(contentsOfFile: sourceImageURL.path) else {
                XCTFail("unable to load source image for \(directory.lastPathComponent)")
                continue
            }

            let debugSnapshot = try await analyzeRawFooterLayoutFixture(
                sourceImage: sourceImage
            )
            let summary = makeRuntimeSummary(
                fixtureName: directory.lastPathComponent,
                debugSnapshot: debugSnapshot
            )

            try writeJSON(summary, to: directory.appendingPathComponent("runtime_selection_summary.json"))
            if let jpegData = debugSnapshot.analyzedCapture.normalizedImage.jpegData(compressionQuality: 0.92) {
                try jpegData.write(
                    to: directory.appendingPathComponent("runtime_normalized.jpg"),
                    options: .atomic
                )
            }
        }
    }

    func testRawFooterLayoutCheckSeedFixturesEmitScorecard() async throws {
        let fixtureDirectories = try fileManager.contentsOfDirectory(
            at: rawFooterLayoutCheckRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }

        var validatedFixtureCount = 0
        var scoreEntries: [RawFooterLayoutSeedScoreEntry] = []

        for directory in fixtureDirectories {
            let truthURL = directory.appendingPathComponent("truth.json")
            guard fileManager.fileExists(atPath: truthURL.path) else { continue }
            let truth = try decodeRawFooterTruth(at: truthURL)
            guard truth.runtimeValidation?.enabled == true else { continue }

            let sourceImageURL = directory.appendingPathComponent("source_scan.jpg")
            guard let sourceImage = UIImage(contentsOfFile: sourceImageURL.path) else {
                XCTFail("unable to load source image for \(directory.lastPathComponent)")
                continue
            }

            let debugSnapshot = try await analyzeRawFooterLayoutFixture(sourceImage: sourceImage)
            let analyzed = debugSnapshot.analyzedCapture
            let validation = truth.runtimeValidation
            validatedFixtureCount += 1

            let collectorExactMatch: Bool = {
                guard validation?.requireCollectorExact ?? false else { return true }
                return normalizedCollectorIdentifier(analyzed.collectorNumber) ==
                    normalizedCollectorIdentifier(truth.collectorNumber)
            }()

            let collectorFamilyMatched: Bool? = {
                guard validation?.requireCollectorFromExpectedFamily == true,
                      let expectedFamily = truth.footerFamily else {
                    return nil
                }
                return debugSnapshot.stage1TightPassResults.contains(where: {
                    $0.footerRole == .collector &&
                    $0.footerFamily?.rawValue == expectedFamily &&
                    parsedCollectorIdentifier(from: $0.text) == normalizedCollectorIdentifier(truth.collectorNumber)
                })
            }()

            let setHintMatched: Bool? = {
                guard let requiredSetHints = validation?.requiredSetHintTokens, !requiredSetHints.isEmpty else {
                    return nil
                }
                let normalizedHints = Set(analyzed.setHintTokens.map(normalizedComparable))
                let expectedHints = Set(requiredSetHints.map(normalizedComparable))
                return !normalizedHints.intersection(expectedHints).isEmpty
            }()

            let passed =
                collectorExactMatch &&
                (collectorFamilyMatched ?? true) &&
                (setHintMatched ?? true)

            scoreEntries.append(
                RawFooterLayoutSeedScoreEntry(
                    fixtureName: directory.lastPathComponent,
                    expectedCollector: truth.collectorNumber,
                    actualCollector: analyzed.collectorNumber,
                    collectorExactMatch: collectorExactMatch,
                    expectedFooterFamily: truth.footerFamily,
                    collectorFamilyMatched: collectorFamilyMatched,
                    requiredSetHintTokens: validation?.requiredSetHintTokens ?? [],
                    actualSetHintTokens: analyzed.setHintTokens,
                    setHintMatched: setHintMatched,
                    passed: passed
                )
            )
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        let scorecard = RawFooterLayoutSeedScorecard(
            generatedAt: formatter.string(from: Date()),
            validatedFixtureCount: validatedFixtureCount,
            passedFixtureCount: scoreEntries.filter(\.passed).count,
            fixtures: scoreEntries
        )
        try writeJSON(
            scorecard,
            to: rawFooterLayoutCheckRoot.appendingPathComponent("runtime_seed_scorecard.json")
        )

        XCTAssertGreaterThan(validatedFixtureCount, 0, "expected at least one seed footer fixture")
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

    private func decodeRawFooterTruth(at url: URL) throws -> RawFooterLayoutTruth {
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(RawFooterLayoutTruth.self, from: data)
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

    private func analyzeRawFooterLayoutFixture(sourceImage: UIImage) async throws -> RawPipelineDebugSnapshot {
        let capture = ScanCaptureInput(
            originalImage: sourceImage,
            searchImage: sourceImage,
            fallbackImage: sourceImage,
            captureSource: .importedPhoto
        )

        return try await RawPipeline().analyzeDebug(
            scanID: UUID(),
            capture: capture,
            resolverModeHint: .rawCard
        )
    }

    private func makeRuntimeSummary(
        fixtureName: String,
        debugSnapshot: RawPipelineDebugSnapshot
    ) -> RawFooterLayoutRuntimeSummary {
        let analyzed = debugSnapshot.analyzedCapture
        let normalizedTarget = analyzed.ocrAnalysis?.normalizedTarget
        let rawEvidence = analyzed.ocrAnalysis?.rawEvidence

        return RawFooterLayoutRuntimeSummary(
            fixtureName: fixtureName,
            scanID: analyzed.scanID.uuidString,
            ocrRequestedGeometryKind: normalizedTarget?.geometryKind,
            ocrUsedFallback: normalizedTarget?.usedFallback,
            ocrTargetQualityScore: normalizedTarget?.targetQuality.overallScore,
            ocrTargetQualityReasons: normalizedTarget?.targetQuality.reasons ?? [],
            contentRectNormalized: normalizedTarget?.contentRectNormalized,
            normalizedImageWidth: analyzed.normalizedImage.size.width,
            normalizedImageHeight: analyzed.normalizedImage.size.height,
            collectorNumber: analyzed.collectorNumber,
            setHintTokens: analyzed.setHintTokens,
            collectorConfidenceScore: rawEvidence?.collectorConfidence?.score,
            collectorConfidenceReasons: rawEvidence?.collectorConfidence?.reasons ?? [],
            setConfidenceScore: rawEvidence?.setConfidence?.score,
            setConfidenceReasons: rawEvidence?.setConfidence?.reasons ?? [],
            footerRouting: debugSnapshot.footerRouting,
            stage1AssessmentReasons: debugSnapshot.stage1Assessment.reasons,
            passSummaries: debugSnapshot.allPassResults.map { result in
                RawFooterLayoutRuntimePassSummary(
                    label: result.label,
                    kind: result.kind.rawValue,
                    footerFamily: result.footerFamily?.rawValue,
                    footerRole: result.footerRole?.rawValue,
                    normalizedRect: result.normalizedRect,
                    text: result.text,
                    tokens: result.tokens
                )
            },
            warnings: analyzed.warnings
        )
    }

    private func broadPlanItem(
        planner: RawROIPlanner,
        sceneTraits: RawSceneTraits
    ) -> RawROIPlanItem {
        guard let item = planner.stage1BroadPlan(for: sceneTraits).first else {
            XCTFail("missing footer band stage1 ROI")
            fatalError("missing footer band stage1 ROI")
        }
        return item
    }

    private func tightPlanItem(
        family: RawFooterFamily,
        role: RawFooterFieldRole,
        planner: RawROIPlanner,
        sceneTraits: RawSceneTraits,
        routing: RawFooterRoutingContext
    ) -> RawROIPlanItem {
        guard let item = planner.stage1TightPlan(for: sceneTraits, routing: routing).first(where: {
            $0.footerFamily == family && $0.footerRole == role
        }) else {
            XCTFail("missing \(family.rawValue) \(role.rawValue) stage1 ROI")
            fatalError("missing \(family.rawValue) \(role.rawValue) stage1 ROI")
        }
        return item
    }

    private func stage1PlanItem(
        _ kind: RawROIKind,
        planner: RawROIPlanner,
        sceneTraits: RawSceneTraits
    ) -> RawROIPlanItem {
        let routing = RawFooterRoutingContext.none
        if kind == .footerBandWide {
            return broadPlanItem(planner: planner, sceneTraits: sceneTraits)
        }
        guard let item = planner.stage1TightPlan(for: sceneTraits, routing: routing).first(where: { $0.kind == kind }) else {
            XCTFail("missing \(kind.rawValue) stage1 ROI")
            fatalError("missing \(kind.rawValue) stage1 ROI")
        }
        return item
    }

    private func parsedCollectorIdentifier(from text: String) -> String? {
        identifierParser
            .parse(text: text, sourceRegion: "fixture_pass")
            .flatMap { normalizedCollectorIdentifier($0.identifier) }
    }

    private func normalizedCollectorIdentifier(_ identifier: String?) -> String? {
        guard let identifier else { return nil }
        return identifier
            .replacingOccurrences(of: " ", with: "")
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .uppercased()
    }

    private func normalizedComparable(_ text: String) -> String {
        text
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .lowercased()
    }
}
