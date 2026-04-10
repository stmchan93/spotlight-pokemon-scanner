import Foundation
import UIKit

struct ScanDebugPoint: Codable {
    let x: Double
    let y: Double

    init(_ point: CGPoint) {
        self.x = Double(point.x)
        self.y = Double(point.y)
    }
}

struct ScanDebugRect: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ rect: CGRect) {
        self.x = Double(rect.origin.x)
        self.y = Double(rect.origin.y)
        self.width = Double(rect.size.width)
        self.height = Double(rect.size.height)
    }
}

struct ScanStageRawRegionArtifact: Codable {
    let label: String
    let normalizedRect: ScanDebugRect
    let text: String
    let averageConfidence: Double
    let tokens: [RecognizedToken]
}

private struct ScanStageCaptureArtifactManifest: Codable {
    let stage: String
    let source: ScanCaptureSource
    let exactCropRectNormalized: ScanDebugRect
    let searchCropRectNormalized: ScanDebugRect
}

private struct ScanStageSelectionArtifactManifest: Codable {
    let stage: String
    let mode: OCRTargetMode
    let source: ScanCaptureSource
    let chosenCandidateIndex: Int?
    let fallbackReason: String?
    let normalizedGeometryKind: OCRTargetGeometryKind
    let normalizationReason: String?
    let candidates: [OCRTargetCandidateSummary]
}

private struct ScanStageRawDecisionArtifactManifest: Codable {
    let stage: String
    let cropConfidence: Double
    let fallbackReason: String?
    let regions: [ScanStageRawRegionArtifact]
    let coarseCandidates: [RawCandidateHypothesis]
    let finalCandidates: [RawCandidateHypothesis]
    let finalCollectorNumber: String?
    let finalSetHintTokens: [String]
}

private struct ScanStageEncodedArtifact<T: Encodable>: Encodable {
    let stage: String
    let payload: T
}

enum ScanStageArtifactWriter {
    private static let logQueue = DispatchQueue(label: "ScanStageArtifactWriter.logQueue")
    nonisolated(unsafe) private static var loggedDirectoryPaths: Set<String> = []
    nonisolated(unsafe) private static var debugExportsEnabled = true

    static func setDebugExportsEnabled(_ enabled: Bool) {
        logQueue.sync {
            debugExportsEnabled = enabled
            if !enabled {
                loggedDirectoryPaths.removeAll()
            }
        }
    }

    static func isDebugExportsEnabled() -> Bool {
        logQueue.sync { debugExportsEnabled }
    }

    static func clearAllArtifacts() -> Int {
        let fileManager = FileManager.default
        guard let rootURL = artifactRootURL() else {
            return 0
        }

        let children = (try? fileManager.contentsOfDirectory(
            at: rootURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []

        var removedCount = 0
        for child in children {
            do {
                try fileManager.removeItem(at: child)
                removedCount += 1
            } catch {
                print("  ⚠️ [DEBUG] Failed to remove scan artifact item: \(child.path) (\(error.localizedDescription))")
            }
        }

        logQueue.sync {
            loggedDirectoryPaths.removeAll()
        }
        return removedCount
    }

    static func artifactRootPath() -> String? {
        artifactRootURL()?.path
    }

    static func recordCaptureArtifacts(
        scanID: UUID,
        source: ScanCaptureSource,
        originalImage: UIImage,
        searchImage: UIImage,
        fallbackImage: UIImage,
        exactCropRectNormalized: CGRect,
        searchCropRectNormalized: CGRect
    ) {
        let manifest = ScanStageCaptureArtifactManifest(
            stage: "capture",
            source: source,
            exactCropRectNormalized: ScanDebugRect(exactCropRectNormalized),
            searchCropRectNormalized: ScanDebugRect(searchCropRectNormalized)
        )

        write(image: originalImage, named: "01_full_camera_frame.jpg", scanID: scanID)
        write(image: searchImage, named: "02_expanded_search_crop.jpg", scanID: scanID)
        write(image: fallbackImage, named: "03_exact_reticle_crop.jpg", scanID: scanID)
        write(json: manifest, named: "capture_manifest.json", scanID: scanID)
    }

    static func recordSelectionArtifacts(
        scanID: UUID,
        mode: OCRTargetMode,
        source: ScanCaptureSource,
        searchImage: UIImage,
        candidateOverlayImage: UIImage,
        normalizedImage: UIImage,
        chosenCandidateIndex: Int?,
        candidates: [OCRTargetCandidateSummary],
        fallbackReason: String?,
        normalizedGeometryKind: OCRTargetGeometryKind,
        normalizationReason: String?
    ) {
        let manifest = ScanStageSelectionArtifactManifest(
            stage: "selection",
            mode: mode,
            source: source,
            chosenCandidateIndex: chosenCandidateIndex,
            fallbackReason: fallbackReason,
            normalizedGeometryKind: normalizedGeometryKind,
            normalizationReason: normalizationReason,
            candidates: candidates
        )

        write(image: searchImage, named: "04_selection_search_input.jpg", scanID: scanID)
        write(image: candidateOverlayImage, named: "05_selection_candidate_overlay.jpg", scanID: scanID)
        write(image: normalizedImage, named: "06_normalized_ocr_input.jpg", scanID: scanID)
        write(json: manifest, named: "selection_manifest.json", scanID: scanID)
    }

    static func recordRawRegionImage(scanID: UUID, image: UIImage, named filename: String) {
        write(image: image, named: filename, scanID: scanID)
    }

    static func recordRawAnalysisArtifacts(
        scanID: UUID,
        cropConfidence: Double,
        regions: [ScanStageRawRegionArtifact],
        coarseCandidates: [RawCandidateHypothesis],
        finalCandidates: [RawCandidateHypothesis],
        finalCollectorNumber: String?,
        finalSetHintTokens: [String],
        fallbackReason: String?
    ) {
        let manifest = ScanStageRawDecisionArtifactManifest(
            stage: "raw_analysis",
            cropConfidence: cropConfidence,
            fallbackReason: fallbackReason,
            regions: regions,
            coarseCandidates: Array(coarseCandidates.prefix(3)),
            finalCandidates: Array(finalCandidates.prefix(3)),
            finalCollectorNumber: finalCollectorNumber,
            finalSetHintTokens: finalSetHintTokens
        )

        write(json: manifest, named: "raw_analysis_manifest.json", scanID: scanID)
    }

    static func recordSynthesizedEvidenceArtifact<T: Encodable>(
        scanID: UUID,
        stage: String,
        payload: T
    ) {
        let manifest = ScanStageEncodedArtifact(stage: stage, payload: payload)
        write(json: manifest, named: "\(stage).json", scanID: scanID)
    }

    static func recordFinalDecisionArtifact<T: Encodable>(
        scanID: UUID,
        stage: String = "final_decision",
        payload: T
    ) {
        let manifest = ScanStageEncodedArtifact(stage: stage, payload: payload)
        write(json: manifest, named: "\(stage).json", scanID: scanID)
    }

    private static func write(image: UIImage, named filename: String, scanID: UUID) {
        guard let data = image.jpegData(compressionQuality: 0.9) else {
            return
        }
        write(data: data, named: filename, scanID: scanID)
    }

    private static func write<T: Encodable>(json payload: T, named filename: String, scanID: UUID) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(payload) else {
            return
        }
        write(data: data, named: filename, scanID: scanID)
    }

    private static func write(data: Data, named filename: String, scanID: UUID) {
        guard isDebugExportsEnabled() else {
            return
        }
        guard let directoryURL = scanDirectoryURL(for: scanID) else {
            return
        }
        let fileURL = directoryURL.appendingPathComponent(filename)
        try? data.write(to: fileURL, options: .atomic)
    }

    private static func scanDirectoryURL(for scanID: UUID) -> URL? {
        guard let rootURL = artifactRootURL() else {
            return nil
        }

        let directoryURL = rootURL.appendingPathComponent(scanID.uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        logDirectoryOnce(directoryURL)
        return directoryURL
    }

    private static func artifactRootURL() -> URL? {
        guard isDebugExportsEnabled() else {
            return nil
        }
        let fileManager = FileManager.default
        guard let documentsURL = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return nil
        }

        let directoryURL = documentsURL.appendingPathComponent("ScanDebugExports", isDirectory: true)
        try? fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        return directoryURL
    }

    private static func logDirectoryOnce(_ directoryURL: URL) {
        let shouldLog = logQueue.sync {
            loggedDirectoryPaths.insert(directoryURL.path).inserted
        }
        guard shouldLog else { return }
        print("  🧪 [DEBUG] Scan artifacts directory: \(directoryURL.path)")
    }
}
