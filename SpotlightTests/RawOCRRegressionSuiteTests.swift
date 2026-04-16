import XCTest
import UIKit
@testable import Spotlight

private struct RawOCRRegressionTruth: Decodable, Encodable {
    let cardName: String
    let collectorNumber: String
    let setCode: String?
}

private struct RawOCRRegressionOCRSummary: Codable {
    let titleTextPrimary: String?
    let collectorNumberExact: String?
    let collectorNumberPartial: String?
    let promoCodeHint: String?
    let setHintTokens: [String]
    let cropConfidence: Double
    let titleConfidenceScore: Double?
    let collectorConfidenceScore: Double?
    let setConfidenceScore: Double?
    let warnings: [String]
}

private struct RawOCRRegressionDebugSummary: Codable {
    let requestedGeometryKind: String?
    let usedFallback: Bool?
    let targetQualityScore: Double?
    let contentRectNormalized: OCRNormalizedRect?
    let footerRoutingReasons: [String]
    let stage1AssessmentReasons: [String]
    let passSummaries: [RawOCRRegressionPassSummary]
}

private struct RawOCRRegressionPassSummary: Codable {
    let label: String
    let kind: String
    let footerFamily: String?
    let footerRole: String?
    let normalizedRect: OCRNormalizedRect
    let text: String
}

private struct RawOCRRegressionChecks: Codable {
    let exactCollectorPass: Bool
    let setHintPass: Bool?
    let titlePass: Bool
    let collectorNearMiss: Bool
    let backendRecoverablePass: Bool
    let backendRecoverableReasons: [String]
}

private struct RawOCRRegressionFixtureResult: Codable {
    let fixtureName: String
    let sourceImage: String
    let truth: RawOCRRegressionTruth
    let ocr: RawOCRRegressionOCRSummary
    let checks: RawOCRRegressionChecks
    let debug: RawOCRRegressionDebugSummary
}

private struct RawOCRRegressionScoreEntry: Codable {
    let fixtureName: String
    let expectedCollector: String
    let actualCollectorExact: String?
    let actualCollectorPartial: String?
    let expectedSetCode: String?
    let actualSetHintTokens: [String]
    let exactCollectorPass: Bool
    let setHintPass: Bool?
    let titlePass: Bool
    let collectorNearMiss: Bool
    let backendRecoverablePass: Bool
    let backendRecoverableReasons: [String]
}

private struct RawOCRRegressionScorecard: Codable {
    let generatedAt: String
    let processedFixtureCount: Int
    let exactCollectorPassCount: Int
    let setHintEligibleFixtureCount: Int
    let setHintPassCount: Int
    let titlePassCount: Int
    let collectorNearMissCount: Int
    let backendRecoverablePassCount: Int
    let exactCollectorPassRate: Double
    let setHintPassRate: Double?
    let backendRecoverablePassRate: Double
    let fixtures: [RawOCRRegressionScoreEntry]
}

final class RawOCRRegressionSuiteTests: XCTestCase {
    private let fileManager = FileManager.default
    private static let regressionBucketCount = 10
    private static let cleanupEnvironmentKey = "RAW_OCR_REGRESSION_CLEANUP"
    private let minimumProcessedFixtureCount = 60
    private let minimumExactCollectorPassRate = 0.50
    private let minimumSetHintPassCount = 5
    private let minimumTitlePassCount = 20
    private let minimumBackendRecoverablePassRate = 0.30

    private var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private var rawRegressionRoot: URL {
        repoRoot.appendingPathComponent("qa/raw-footer-layout-check", isDirectory: true)
    }

    override class func setUp() {
        super.setUp()
        guard shouldCleanupGeneratedRegressionOutputs else { return }
        cleanupGeneratedRegressionOutputs()
    }

    private static func cleanupGeneratedRegressionOutputs() {
        let fileManager = FileManager.default
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("qa/raw-footer-layout-check", isDirectory: true)

        let discoveredDirectories = try? fileManager.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        let fixtureDirectories = (discoveredDirectories ?? [])
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }

        for directory in fixtureDirectories {
            try? fileManager.removeItem(at: directory.appendingPathComponent("raw_ocr_regression_result.json"))
        }

        try? fileManager.removeItem(at: root.appendingPathComponent("raw_ocr_regression_scorecard.json"))
        for bucketIndex in 0..<regressionBucketCount {
            let bucketName = String(format: "bucket_%02d", bucketIndex + 1)
            try? fileManager.removeItem(
                at: root.appendingPathComponent("raw_ocr_regression_scorecard_\(bucketName).json")
            )
        }
    }

    private static var shouldCleanupGeneratedRegressionOutputs: Bool {
        let value = ProcessInfo.processInfo.environment[cleanupEnvironmentKey]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        switch value {
        case nil, "", "1", "true", "yes":
            return true
        default:
            return false
        }
    }

    func testRawFooterLayoutCheckBucket01EmitRegressionBaseline() async throws {
        try await runRegressionBucket(bucketIndex: 0)
    }

    func testRawFooterLayoutCheckBucket02EmitRegressionBaseline() async throws {
        try await runRegressionBucket(bucketIndex: 1)
    }

    func testRawFooterLayoutCheckBucket03EmitRegressionBaseline() async throws {
        try await runRegressionBucket(bucketIndex: 2)
    }

    func testRawFooterLayoutCheckBucket04EmitRegressionBaseline() async throws {
        try await runRegressionBucket(bucketIndex: 3)
    }

    func testRawFooterLayoutCheckBucket05EmitRegressionBaseline() async throws {
        try await runRegressionBucket(bucketIndex: 4)
    }

    func testRawFooterLayoutCheckBucket06EmitRegressionBaseline() async throws {
        try await runRegressionBucket(bucketIndex: 5)
    }

    func testRawFooterLayoutCheckBucket07EmitRegressionBaseline() async throws {
        try await runRegressionBucket(bucketIndex: 6)
    }

    func testRawFooterLayoutCheckBucket08EmitRegressionBaseline() async throws {
        try await runRegressionBucket(bucketIndex: 7)
    }

    func testRawFooterLayoutCheckBucket09EmitRegressionBaseline() async throws {
        try await runRegressionBucket(bucketIndex: 8)
    }

    func testRawFooterLayoutCheckBucket10EmitRegressionBaseline() async throws {
        try await runRegressionBucket(bucketIndex: 9)
    }

    func testRawFooterLayoutCheckBucket99AggregateScorecardMeetsThresholds() throws {
        let fixtureDirectories = try regressionFixtureDirectories()
        let scoreEntries = try fixtureDirectories.compactMap(loadGeneratedScoreEntry)

        XCTAssertEqual(
            scoreEntries.count,
            fixtureDirectories.count,
            "expected all raw OCR regression buckets to generate fresh result files before aggregate scoring"
        )

        let scorecard = makeScorecard(from: scoreEntries)
        assertScorecardThresholds(scorecard)

        try writeJSON(
            scorecard,
            to: rawRegressionRoot.appendingPathComponent("raw_ocr_regression_scorecard.json")
        )
    }

    private func runRegressionBucket(bucketIndex: Int) async throws {
        let buckets = try regressionBuckets()
        XCTAssertLessThan(bucketIndex, buckets.count, "requested OCR regression bucket outside available corpus")

        let fixtureDirectories = buckets[bucketIndex]
        XCTAssertFalse(fixtureDirectories.isEmpty, "expected raw OCR regression bucket fixtures")

        var scoreEntries: [RawOCRRegressionScoreEntry] = []

        for directory in fixtureDirectories {
            if let scoreEntry = try await processFixture(at: directory) {
                scoreEntries.append(scoreEntry)
            }
        }

        XCTAssertEqual(
            scoreEntries.count,
            fixtureDirectories.count,
            "expected bucket \(bucketIndex + 1) to process every assigned OCR fixture"
        )

        let scorecard = makeScorecard(from: scoreEntries)
        let bucketName = String(format: "bucket_%02d", bucketIndex + 1)
        try writeJSON(
            scorecard,
            to: rawRegressionRoot.appendingPathComponent("raw_ocr_regression_scorecard_\(bucketName).json")
        )
    }

    private func regressionFixtureDirectories() throws -> [URL] {
        try fileManager.contentsOfDirectory(
            at: rawRegressionRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .filter {
                fileManager.fileExists(atPath: $0.appendingPathComponent("truth.json").path) &&
                fileManager.fileExists(atPath: $0.appendingPathComponent("source_scan.jpg").path)
            }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    private func regressionBuckets() throws -> [[URL]] {
        let fixtureDirectories = try regressionFixtureDirectories()
        let chunkSize = max(
            1,
            Int(ceil(Double(fixtureDirectories.count) / Double(Self.regressionBucketCount)))
        )

        return stride(from: 0, to: fixtureDirectories.count, by: chunkSize).map { startIndex in
            Array(fixtureDirectories[startIndex..<min(startIndex + chunkSize, fixtureDirectories.count)])
        }
    }

    private func processFixture(at directory: URL) async throws -> RawOCRRegressionScoreEntry? {
        let truthURL = directory.appendingPathComponent("truth.json")
        let sourceImageURL = directory.appendingPathComponent("source_scan.jpg")

        guard let sourceImage = UIImage(contentsOfFile: sourceImageURL.path) else {
            XCTFail("unable to load source image for \(directory.lastPathComponent)")
            return nil
        }

        let truth = try decodeTruth(at: truthURL)
        let debugSnapshot = try await analyzeFixture(sourceImage: sourceImage)
        let result = makeFixtureResult(
            fixtureName: directory.lastPathComponent,
            sourceImageName: sourceImageURL.lastPathComponent,
            truth: truth,
            debugSnapshot: debugSnapshot
        )

        try writeJSON(result, to: directory.appendingPathComponent("raw_ocr_regression_result.json"))
        return makeScoreEntry(from: result)
    }

    private func loadGeneratedScoreEntry(from directory: URL) throws -> RawOCRRegressionScoreEntry? {
        let resultURL = directory.appendingPathComponent("raw_ocr_regression_result.json")
        guard fileManager.fileExists(atPath: resultURL.path) else {
            return nil
        }

        let data = try Data(contentsOf: resultURL)
        let result = try JSONDecoder().decode(RawOCRRegressionFixtureResult.self, from: data)
        return makeScoreEntry(from: result)
    }

    private func makeScorecard(from scoreEntries: [RawOCRRegressionScoreEntry]) -> RawOCRRegressionScorecard {
        let processedFixtureCount = scoreEntries.count
        let exactCollectorPassCount = scoreEntries.filter(\.exactCollectorPass).count
        let setHintEligibleFixtureCount = scoreEntries.filter { $0.expectedSetCode != nil }.count
        let setHintPassCount = scoreEntries.filter { $0.setHintPass == true }.count
        let titlePassCount = scoreEntries.filter(\.titlePass).count
        let collectorNearMissCount = scoreEntries.filter(\.collectorNearMiss).count
        let backendRecoverablePassCount = scoreEntries.filter(\.backendRecoverablePass).count

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return RawOCRRegressionScorecard(
            generatedAt: formatter.string(from: Date()),
            processedFixtureCount: processedFixtureCount,
            exactCollectorPassCount: exactCollectorPassCount,
            setHintEligibleFixtureCount: setHintEligibleFixtureCount,
            setHintPassCount: setHintPassCount,
            titlePassCount: titlePassCount,
            collectorNearMissCount: collectorNearMissCount,
            backendRecoverablePassCount: backendRecoverablePassCount,
            exactCollectorPassRate: rate(numerator: exactCollectorPassCount, denominator: processedFixtureCount),
            setHintPassRate: setHintEligibleFixtureCount > 0
                ? rate(numerator: setHintPassCount, denominator: setHintEligibleFixtureCount)
                : nil,
            backendRecoverablePassRate: rate(
                numerator: backendRecoverablePassCount,
                denominator: processedFixtureCount
            ),
            fixtures: scoreEntries
        )
    }

    private func assertScorecardThresholds(_ scorecard: RawOCRRegressionScorecard) {
        XCTAssertGreaterThan(scorecard.processedFixtureCount, 0, "expected at least one raw OCR regression fixture")
        XCTAssertGreaterThanOrEqual(
            scorecard.processedFixtureCount,
            minimumProcessedFixtureCount,
            "expected to process the full raw OCR regression corpus"
        )
        XCTAssertGreaterThanOrEqual(
            scorecard.exactCollectorPassRate,
            minimumExactCollectorPassRate,
            "exact collector OCR pass rate regressed"
        )
        XCTAssertGreaterThanOrEqual(
            scorecard.titlePassCount,
            minimumTitlePassCount,
            "title OCR recovery regressed"
        )
        XCTAssertGreaterThanOrEqual(
            scorecard.backendRecoverablePassRate,
            minimumBackendRecoverablePassRate,
            "backend-recoverable OCR pass rate regressed"
        )
        XCTAssertGreaterThanOrEqual(
            scorecard.setHintPassCount,
            minimumSetHintPassCount,
            "set hint OCR coverage regressed"
        )
    }

    private func decodeTruth(at url: URL) throws -> RawOCRRegressionTruth {
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(RawOCRRegressionTruth.self, from: data)
    }

    private func analyzeFixture(sourceImage: UIImage) async throws -> RawPipelineDebugSnapshot {
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

    private func makeFixtureResult(
        fixtureName: String,
        sourceImageName: String,
        truth: RawOCRRegressionTruth,
        debugSnapshot: RawPipelineDebugSnapshot
    ) -> RawOCRRegressionFixtureResult {
        let analyzed = debugSnapshot.analyzedCapture
        let rawEvidence = analyzed.ocrAnalysis?.rawEvidence
        let observedCollector = analyzed.collectorNumber ?? rawEvidence?.collectorNumberPartial
        let exactCollectorPass =
            normalizedCollectorIdentifier(analyzed.collectorNumber) ==
            normalizedCollectorIdentifier(truth.collectorNumber)
        let setHintPass = matchesExpectedSetHint(
            actualHints: analyzed.setHintTokens,
            expectedSetCode: truth.setCode
        )
        let titlePass = matchesExpectedTitle(
            actualTitle: rawEvidence?.titleTextPrimary,
            expectedCardName: truth.cardName
        )
        let collectorNearMiss =
            !exactCollectorPass &&
            collectorLooksBackendRecoverable(
                actualIdentifier: observedCollector,
                expectedIdentifier: truth.collectorNumber
            )

        let backendRecoverableReasons = backendRecoverableReasons(
            exactCollectorPass: exactCollectorPass,
            setHintPass: setHintPass,
            titlePass: titlePass,
            collectorNearMiss: collectorNearMiss,
            expectedSetCode: truth.setCode
        )

        return RawOCRRegressionFixtureResult(
            fixtureName: fixtureName,
            sourceImage: sourceImageName,
            truth: truth,
            ocr: RawOCRRegressionOCRSummary(
                titleTextPrimary: rawEvidence?.titleTextPrimary,
                collectorNumberExact: analyzed.collectorNumber,
                collectorNumberPartial: rawEvidence?.collectorNumberPartial,
                promoCodeHint: analyzed.promoCodeHint,
                setHintTokens: analyzed.setHintTokens,
                cropConfidence: analyzed.cropConfidence,
                titleConfidenceScore: rawEvidence?.titleConfidence?.score,
                collectorConfidenceScore: rawEvidence?.collectorConfidence?.score,
                setConfidenceScore: rawEvidence?.setConfidence?.score,
                warnings: analyzed.warnings
            ),
            checks: RawOCRRegressionChecks(
                exactCollectorPass: exactCollectorPass,
                setHintPass: setHintPass,
                titlePass: titlePass,
                collectorNearMiss: collectorNearMiss,
                backendRecoverablePass: !backendRecoverableReasons.isEmpty,
                backendRecoverableReasons: backendRecoverableReasons
            ),
            debug: RawOCRRegressionDebugSummary(
                requestedGeometryKind: analyzed.ocrAnalysis?.normalizedTarget?.geometryKind,
                usedFallback: analyzed.ocrAnalysis?.normalizedTarget?.usedFallback,
                targetQualityScore: analyzed.ocrAnalysis?.normalizedTarget?.targetQuality.overallScore,
                contentRectNormalized: analyzed.ocrAnalysis?.normalizedTarget?.contentRectNormalized,
                footerRoutingReasons: debugSnapshot.footerRouting.reasons,
                stage1AssessmentReasons: debugSnapshot.stage1Assessment.reasons,
                passSummaries: debugSnapshot.allPassResults.map {
                    RawOCRRegressionPassSummary(
                        label: $0.label,
                        kind: $0.kind.rawValue,
                        footerFamily: $0.footerFamily?.rawValue,
                        footerRole: $0.footerRole?.rawValue,
                        normalizedRect: $0.normalizedRect,
                        text: $0.text
                    )
                }
            )
        )
    }

    private func makeScoreEntry(from result: RawOCRRegressionFixtureResult) -> RawOCRRegressionScoreEntry {
        RawOCRRegressionScoreEntry(
            fixtureName: result.fixtureName,
            expectedCollector: result.truth.collectorNumber,
            actualCollectorExact: result.ocr.collectorNumberExact,
            actualCollectorPartial: result.ocr.collectorNumberPartial,
            expectedSetCode: result.truth.setCode,
            actualSetHintTokens: result.ocr.setHintTokens,
            exactCollectorPass: result.checks.exactCollectorPass,
            setHintPass: result.checks.setHintPass,
            titlePass: result.checks.titlePass,
            collectorNearMiss: result.checks.collectorNearMiss,
            backendRecoverablePass: result.checks.backendRecoverablePass,
            backendRecoverableReasons: result.checks.backendRecoverableReasons
        )
    }

    private func matchesExpectedSetHint(actualHints: [String], expectedSetCode: String?) -> Bool? {
        guard let expectedSetCode, !expectedSetCode.isEmpty else { return nil }
        let normalizedExpected = collapsedAlphanumeric(expectedSetCode)
        return actualHints
            .map(collapsedAlphanumeric)
            .contains(where: { $0 == normalizedExpected || $0.contains(normalizedExpected) || normalizedExpected.contains($0) })
    }

    private func matchesExpectedTitle(actualTitle: String?, expectedCardName: String) -> Bool {
        guard let actualTitle, !actualTitle.isEmpty else { return false }

        let normalizedActual = normalizedComparable(actualTitle)
        let normalizedExpected = normalizedComparable(expectedCardName)
        if normalizedActual.contains(normalizedExpected) || normalizedExpected.contains(normalizedActual) {
            return true
        }

        let actualTokenSet = Set(significantTokens(in: actualTitle))
        let expectedTokens = significantTokens(in: expectedCardName)
        let overlapCount = expectedTokens.filter { actualTokenSet.contains($0) }.count
        if overlapCount >= minTitleTokenOverlap(for: expectedTokens.count) {
            return true
        }

        return levenshteinDistance(
            between: collapsedAlphanumeric(actualTitle),
            and: collapsedAlphanumeric(expectedCardName)
        ) <= 2
    }

    private func collectorLooksBackendRecoverable(
        actualIdentifier: String?,
        expectedIdentifier: String
    ) -> Bool {
        guard let actualNormalized = normalizedCollectorIdentifier(actualIdentifier),
              let expectedNormalized = normalizedCollectorIdentifier(expectedIdentifier),
              actualNormalized != expectedNormalized else {
            return false
        }

        let directDistance = levenshteinDistance(between: actualNormalized, and: expectedNormalized)
        if directDistance <= 1 {
            return true
        }

        let actualParts = actualNormalized.split(separator: "/", maxSplits: 1).map(String.init)
        let expectedParts = expectedNormalized.split(separator: "/", maxSplits: 1).map(String.init)
        guard actualParts.count == 2, expectedParts.count == 2 else {
            return false
        }

        let actualLeft = actualParts[0]
        let actualRight = actualParts[1]
        let expectedLeft = expectedParts[0]
        let expectedRight = expectedParts[1]

        if actualRight == expectedRight && levenshteinDistance(between: actualLeft, and: expectedLeft) <= 1 {
            return true
        }

        if actualLeft == expectedLeft && levenshteinDistance(between: actualRight, and: expectedRight) <= 1 {
            return true
        }

        return false
    }

    private func backendRecoverableReasons(
        exactCollectorPass: Bool,
        setHintPass: Bool?,
        titlePass: Bool,
        collectorNearMiss: Bool,
        expectedSetCode: String?
    ) -> [String] {
        let hasSetHint = setHintPass == true

        if exactCollectorPass && (hasSetHint || titlePass) {
            return hasSetHint ? ["exact_collector_plus_set_hint"] : ["exact_collector_plus_title"]
        }

        if expectedSetCode == nil && exactCollectorPass {
            return ["exact_collector_without_set_requirement"]
        }

        if hasSetHint && titlePass {
            return ["set_hint_plus_title"]
        }

        if hasSetHint && collectorNearMiss {
            return ["set_hint_plus_near_miss_collector"]
        }

        if titlePass && collectorNearMiss {
            return ["title_plus_near_miss_collector"]
        }

        return []
    }

    private func normalizedCollectorIdentifier(_ identifier: String?) -> String? {
        guard let identifier else { return nil }
        return normalizeConfusableLatinCharacters(in: identifier)
            .replacingOccurrences(of: " ", with: "")
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .uppercased()
    }

    private func normalizedComparable(_ text: String) -> String {
        text
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .lowercased()
            .replacingOccurrences(of: #"[^a-z0-9]+"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func collapsedAlphanumeric(_ text: String) -> String {
        normalizeConfusableLatinCharacters(in: text)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .uppercased()
            .replacingOccurrences(of: #"[^A-Z0-9]+"#, with: "", options: .regularExpression)
    }

    private func significantTokens(in text: String) -> [String] {
        normalizedComparable(text)
            .split(separator: " ")
            .map(String.init)
            .filter { $0.count >= 2 || $0 == "ex" || $0 == "gx" || $0 == "v" || $0 == "vmax" }
    }

    private func minTitleTokenOverlap(for expectedTokenCount: Int) -> Int {
        switch expectedTokenCount {
        case ...1:
            return 1
        case 2:
            return 1
        default:
            return expectedTokenCount - 1
        }
    }

    private func levenshteinDistance(between lhs: String, and rhs: String) -> Int {
        let lhsScalars = Array(lhs)
        let rhsScalars = Array(rhs)

        if lhsScalars.isEmpty { return rhsScalars.count }
        if rhsScalars.isEmpty { return lhsScalars.count }

        var previousRow = Array(0...rhsScalars.count)

        for (lhsIndex, lhsChar) in lhsScalars.enumerated() {
            var currentRow = [lhsIndex + 1]
            currentRow.reserveCapacity(rhsScalars.count + 1)

            for (rhsIndex, rhsChar) in rhsScalars.enumerated() {
                let insertion = currentRow[rhsIndex] + 1
                let deletion = previousRow[rhsIndex + 1] + 1
                let substitution = previousRow[rhsIndex] + (lhsChar == rhsChar ? 0 : 1)
                currentRow.append(min(insertion, deletion, substitution))
            }

            previousRow = currentRow
        }

        return previousRow[rhsScalars.count]
    }

    private func rate(numerator: Int, denominator: Int) -> Double {
        guard denominator > 0 else { return 0 }
        return Double(numerator) / Double(denominator)
    }

    private func writeJSON<T: Encodable>(_ value: T, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(value).write(to: url, options: .atomic)
    }
}
