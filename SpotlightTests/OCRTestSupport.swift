import Foundation
import UIKit
@testable import Spotlight

struct OCRTestFixtureManifest: Decodable {
    let fixtureName: String
    let selectedMode: String
    let sourceImage: String
    let tags: [String]
}

enum OCRTestSupport {
    static var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    static func loadFixtureManifest(named fixtureName: String) throws -> OCRTestFixtureManifest {
        let manifestURL = fixtureDirectory(named: fixtureName).appendingPathComponent("fixture.json")
        let data = try Data(contentsOf: manifestURL)
        return try JSONDecoder().decode(OCRTestFixtureManifest.self, from: data)
    }

    static func loadFixtureImage(named fixtureName: String) throws -> UIImage {
        let manifest = try loadFixtureManifest(named: fixtureName)
        let imageURL = fixtureDirectory(named: fixtureName).appendingPathComponent(manifest.sourceImage)
        guard let image = UIImage(contentsOfFile: imageURL.path) else {
            throw NSError(
                domain: "OCRTestSupport",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Unable to load fixture image at \(imageURL.path)"]
            )
        }
        return image
    }

    static func fixtureDirectory(named fixtureName: String) -> URL {
        repoRoot.appendingPathComponent("qa/ocr-fixtures", isDirectory: true)
            .appendingPathComponent(fixtureName, isDirectory: true)
    }

    static func makeCandidate(
        rank: Int,
        totalScore: Double,
        aspectScore: Double = 0.8,
        proximityScore: Double = 0.8,
        areaScore: Double = 0.7,
        confidence: Double = 0.8,
        areaCoverage: Double = 0.25,
        aspectRatio: Double = 0.715,
        centerDistance: Double = 0.15,
        geometryKind: OCRTargetGeometryKind = .rawCard,
        boundingBox: OCRNormalizedRect = OCRNormalizedRect(x: 0.18, y: 0.12, width: 0.64, height: 0.72)
    ) -> OCRTargetCandidateSummary {
        OCRTargetCandidateSummary(
            rank: rank,
            confidence: confidence,
            areaCoverage: areaCoverage,
            aspectRatio: aspectRatio,
            aspectScore: aspectScore,
            proximityScore: proximityScore,
            areaScore: areaScore,
            totalScore: totalScore,
            centerDistance: centerDistance,
            boundingBox: ScanDebugRect(boundingBox),
            quadrilateral: [
                ScanDebugPoint(CGPoint(x: boundingBox.x, y: boundingBox.y)),
                ScanDebugPoint(CGPoint(x: boundingBox.x + boundingBox.width, y: boundingBox.y)),
                ScanDebugPoint(CGPoint(x: boundingBox.x + boundingBox.width, y: boundingBox.y + boundingBox.height)),
                ScanDebugPoint(CGPoint(x: boundingBox.x, y: boundingBox.y + boundingBox.height)),
            ],
            geometryKind: geometryKind
        )
    }

    static func makeImage(
        size: CGSize,
        draw: (CGContext) -> Void
    ) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        if #available(iOS 12.0, *) {
            format.preferredRange = .standard
        }
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { context in
            draw(context.cgContext)
        }
    }

    static func normalizedTitleMatches(_ actualTitle: String?, expected expectedTitle: String) -> Bool {
        guard let actualTitle, !actualTitle.isEmpty else { return false }

        let normalizedActual = normalizedComparable(actualTitle)
        let normalizedExpected = normalizedComparable(expectedTitle)
        if normalizedActual.contains(normalizedExpected) || normalizedExpected.contains(normalizedActual) {
            return true
        }

        let actualTokens = Set(significantTokens(in: actualTitle))
        let expectedTokens = significantTokens(in: expectedTitle)
        let overlapCount = expectedTokens.filter { actualTokens.contains($0) }.count
        return overlapCount >= minTitleTokenOverlap(for: expectedTokens.count)
    }

    static func normalizedComparable(_ text: String) -> String {
        text
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .lowercased()
            .replacingOccurrences(of: #"[^a-z0-9]+"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func significantTokens(in text: String) -> [String] {
        normalizedComparable(text)
            .split(separator: " ")
            .map(String.init)
            .filter { $0.count >= 2 || $0 == "ex" || $0 == "gx" || $0 == "v" || $0 == "vmax" }
    }

    static func minTitleTokenOverlap(for expectedTokenCount: Int) -> Int {
        switch expectedTokenCount {
        case ...1:
            return 1
        case 2:
            return 1
        default:
            return expectedTokenCount - 1
        }
    }
}

func makeImage(
    size: CGSize,
    draw: (CGContext) -> Void
) -> UIImage {
    OCRTestSupport.makeImage(size: size, draw: draw)
}
