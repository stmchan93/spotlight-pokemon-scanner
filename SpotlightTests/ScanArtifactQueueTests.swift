import XCTest
@testable import Spotlight

@MainActor
final class ScanArtifactQueueTests: XCTestCase {
    func testScanEventStoreLogPredictionQueuesArtifactUpload() async {
        let logStore = makeScanEventStore()
        let analysis = makeAnalyzedCapture(
            cropConfidence: 0.58,
            collectorNumber: "60/132",
            setHintTokens: ["gym1"],
            setBadgeHint: nil,
            rawEvidence: OCRRawEvidence(
                titleTextPrimary: "Sabrina's Slowbro",
                titleTextSecondary: nil,
                titleConfidence: makeFieldConfidence(0.72),
                collectorNumberExact: "60/132",
                collectorNumberPartial: nil,
                collectorConfidence: makeFieldConfidence(0.9),
                setBadgeHint: nil,
                setHints: ["gym1"],
                setConfidence: makeFieldConfidence(0.61),
                footerBandText: "Sabrina's Slowbro 60/132",
                wholeCardText: "Sabrina's Slowbro Gym Heroes 60/132",
                warnings: []
            )
        )

        await logStore.logPrediction(
            analysis: analysis,
            response: makeMatchResponse(confidence: .medium, reviewDisposition: .needsReview),
            captureSource: .livePreviewFrame,
            cameraZoomFactor: 1.5
        )

        let uploads = await logStore.pendingArtifactUploads()
        XCTAssertEqual(uploads.count, 1)
        XCTAssertEqual(uploads.first?.scanID, analysis.scanID)
        XCTAssertEqual(uploads.first?.captureSource, .livePreviewFrame)
        XCTAssertEqual(uploads.first?.cameraZoomFactor, 1.5)
        XCTAssertNotNil(uploads.first?.sourceImagePath)
        XCTAssertNotNil(uploads.first?.normalizedImagePath)
        XCTAssertTrue(FileManager.default.fileExists(atPath: uploads.first?.sourceImagePath ?? ""))
        XCTAssertTrue(FileManager.default.fileExists(atPath: uploads.first?.normalizedImagePath ?? ""))
    }

    func testScanEventStoreLogPredictionSkipsArtifactUploadQueueWhenDisabled() async {
        let rootURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
        addTeardownBlock {
            try? FileManager.default.removeItem(at: rootURL)
        }

        let logStore = ScanEventStore(baseDirectoryURL: rootURL)
        let analysis = makeAnalyzedCapture(
            cropConfidence: 0.58,
            collectorNumber: "60/132",
            setHintTokens: ["gym1"],
            setBadgeHint: nil,
            rawEvidence: OCRRawEvidence(
                titleTextPrimary: "Sabrina's Slowbro",
                titleTextSecondary: nil,
                titleConfidence: makeFieldConfidence(0.72),
                collectorNumberExact: "60/132",
                collectorNumberPartial: nil,
                collectorConfidence: makeFieldConfidence(0.9),
                setBadgeHint: nil,
                setHints: ["gym1"],
                setConfidence: makeFieldConfidence(0.61),
                footerBandText: "Sabrina's Slowbro 60/132",
                wholeCardText: "Sabrina's Slowbro Gym Heroes 60/132",
                warnings: []
            )
        )

        await logStore.logPrediction(
            analysis: analysis,
            response: makeMatchResponse(confidence: .medium, reviewDisposition: .needsReview),
            captureSource: .livePreviewFrame,
            cameraZoomFactor: 1.5,
            enqueueArtifactUpload: false
        )

        let uploads = await logStore.pendingArtifactUploads()
        let cropsURL = rootURL.appendingPathComponent("Spotlight", isDirectory: true)
            .appendingPathComponent("ScanCrops", isDirectory: true)
        let cropFiles = (try? FileManager.default.contentsOfDirectory(atPath: cropsURL.path)) ?? []

        XCTAssertTrue(uploads.isEmpty)
        XCTAssertTrue(cropFiles.isEmpty)
    }

    func testFlushPendingBackendQueuesUploadsArtifactPayloads() async {
        let matcher = RecordingCardMatchingService()
        let logStore = makeScanEventStore()
        let viewModel = makeScannerViewModel(matcher: matcher, logStore: logStore)
        let analysis = makeAnalyzedCapture(
            cropConfidence: 0.58,
            collectorNumber: "60/132",
            setHintTokens: ["gym1"],
            setBadgeHint: nil,
            rawEvidence: OCRRawEvidence(
                titleTextPrimary: "Sabrina's Slowbro",
                titleTextSecondary: nil,
                titleConfidence: makeFieldConfidence(0.72),
                collectorNumberExact: "60/132",
                collectorNumberPartial: nil,
                collectorConfidence: makeFieldConfidence(0.9),
                setBadgeHint: nil,
                setHints: ["gym1"],
                setConfidence: makeFieldConfidence(0.61),
                footerBandText: "Sabrina's Slowbro 60/132",
                wholeCardText: "Sabrina's Slowbro Gym Heroes 60/132",
                warnings: []
            )
        )

        await logStore.logPrediction(
            analysis: analysis,
            response: makeMatchResponse(confidence: .medium, reviewDisposition: .needsReview),
            captureSource: .liveStillPhoto,
            cameraZoomFactor: 1.5
        )

        await viewModel.flushPendingBackendQueues()

        let pendingUploads = await logStore.pendingArtifactUploads()
        XCTAssertTrue(pendingUploads.isEmpty)

        let uploadedPayloads = await matcher.uploadedArtifactPayloads()
        XCTAssertEqual(uploadedPayloads.count, 1)
        XCTAssertEqual(uploadedPayloads.first?.scanID, analysis.scanID)
        XCTAssertEqual(uploadedPayloads.first?.captureSource, .liveStillPhoto)
        XCTAssertEqual(uploadedPayloads.first?.cameraZoomFactor, 1.5)
        XCTAssertNotNil(uploadedPayloads.first?.sourceImage.jpegBase64)
        XCTAssertNotNil(uploadedPayloads.first?.normalizedImage.jpegBase64)
    }

    func testRecordDeckAdditionFlushesBackendConfirmationUsingSelectionMetadata() async {
        let matcher = RecordingCardMatchingService()
        let logStore = makeScanEventStore()
        let viewModel = makeScannerViewModel(matcher: matcher, logStore: logStore)
        var item = makeScanStackItem(resolverMode: .rawCard, reviewDisposition: .needsReview)
        item.selectedRank = 2
        item.wasTopPrediction = false
        item.selectionSource = .alternatePrediction
        viewModel.scannedItems = [item]

        guard let card = item.card else {
            XCTFail("Expected test card")
            return
        }

        viewModel.recordDeckAddition(itemID: item.id, card: card, slabContext: nil)

        for _ in 0..<20 {
            if await matcher.deckEntryPayloads().count == 1 {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        let payloads = await matcher.deckEntryPayloads()
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(payloads.first?.cardID, card.id)
        XCTAssertEqual(payloads.first?.sourceScanID, item.scanID)
        XCTAssertEqual(payloads.first?.selectionSource, .alternatePrediction)
        XCTAssertEqual(payloads.first?.selectedRank, 2)
        XCTAssertEqual(payloads.first?.wasTopPrediction, false)
        XCTAssertNil(payloads.first?.condition)

        let pendingConfirmations = await logStore.pendingDeckConfirmations()
        XCTAssertTrue(pendingConfirmations.isEmpty)
    }
}
