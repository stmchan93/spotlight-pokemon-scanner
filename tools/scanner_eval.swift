import CoreGraphics
import Foundation
import ImageIO
import Vision

enum EvalResolverPath: String, Codable {
    case directLookup = "direct_lookup"
    case psaLabel = "psa_label"
    case visualFallback = "visual_fallback"
}

enum EvalResolverMode: String, Codable {
    case rawCard = "raw_card"
    case psaSlab = "psa_slab"
    case unknownFallback = "unknown_fallback"
}

struct EvalRecognizedToken: Codable {
    let text: String
    let confidence: Float
}

struct EvalSlabContext: Codable {
    let grader: String
    let grade: String?
    let certNumber: String?
}

struct EvalCardPricingSummary: Codable {
    let source: String
    let pricingMode: String?
    let pricingTier: String?
    let grader: String?
    let grade: String?
    let market: Double?
}

struct EvalAnalysis {
    let recognizedTokens: [EvalRecognizedToken]
    let fullRecognizedText: String
    let metadataStripRecognizedText: String
    let topLabelRecognizedText: String
    let bottomLeftRecognizedText: String
    let bottomRightRecognizedText: String
    let collectorNumber: String?
    let setHintTokens: [String]
    let promoCodeHint: String?
    let slabGrader: String?
    let slabGrade: String?
    let slabCertNumber: String?
    let slabBarcodePayloads: [String]
    let slabGraderConfidence: Double?
    let slabGradeConfidence: Double?
    let slabCertConfidence: Double?
    let slabCardNumberRaw: String?
    let slabParsedLabelText: [String]
    let slabClassifierReasons: [String]
    let slabRecommendedLookupPath: String?
    let directLookupLikely: Bool
    let resolverModeHint: EvalResolverMode
    let cropConfidence: Double
    let warnings: [String]
    let croppedImageSize: CGSize
    let imageBase64: String?
}

struct EvalClientContext: Codable {
    let platform: String
    let appVersion: String
    let buildNumber: String
    let localeIdentifier: String
    let timeZoneIdentifier: String
}

struct EvalImagePayload: Codable {
    let jpegBase64: String?
    let width: Int
    let height: Int
}

struct EvalMatchRequestPayload: Codable {
    let scanID: UUID
    let capturedAt: Date
    let clientContext: EvalClientContext
    let image: EvalImagePayload
    let recognizedTokens: [EvalRecognizedToken]
    let fullRecognizedText: String
    let metadataStripRecognizedText: String
    let topLabelRecognizedText: String
    let bottomLeftRecognizedText: String
    let bottomRightRecognizedText: String
    let collectorNumber: String?
    let setHintTokens: [String]
    let promoCodeHint: String?
    let slabGrader: String?
    let slabGrade: String?
    let slabCertNumber: String?
    let slabBarcodePayloads: [String]
    let slabGraderConfidence: Double?
    let slabGradeConfidence: Double?
    let slabCertConfidence: Double?
    let slabCardNumberRaw: String?
    let slabParsedLabelText: [String]
    let slabClassifierReasons: [String]
    let slabRecommendedLookupPath: String?
    let directLookupLikely: Bool
    let resolverModeHint: EvalResolverMode
    let cropConfidence: Double
    let warnings: [String]
}

struct EvalCardCandidate: Codable {
    let id: String
    let name: String
    let setName: String
    let number: String
    let rarity: String
    let variant: String
    let language: String
    let pricing: EvalCardPricingSummary?
}

struct EvalScoredCandidate: Codable {
    let rank: Int
    let candidate: EvalCardCandidate
    let imageScore: Double
    let collectorNumberScore: Double
    let nameScore: Double
    let finalScore: Double
}

struct EvalMatchResponse: Codable {
    let scanID: UUID
    let topCandidates: [EvalScoredCandidate]
    let confidence: String
    let ambiguityFlags: [String]
    let matcherSource: String
    let matcherVersion: String
    let resolverMode: EvalResolverMode
    let resolverPath: EvalResolverPath?
    let slabContext: EvalSlabContext?
    let reviewDisposition: String?
}

struct EvalCase: Codable {
    let name: String
    let imagePath: String
    let expectedCardID: String?
    let acceptedCardIDs: [String]?
    let expectedCardName: String?
    let expectedSetName: String?
    let expectedNumber: String?
    let acceptedSetNames: [String]?
    let acceptedNumbers: [String]?
    let expectedConfidence: String?
    let acceptedConfidences: [String]?
    let expectedResolverPath: String?
    let acceptedResolverPaths: [String]?
    let expectedResolverMode: String?
    let acceptedResolverModes: [String]?
    let expectPricingAvailable: Bool?
    let expectedPricingMode: String?
    let expectedPricingTier: String?
}

struct EvalBenchmarkSample {
    let name: String
    let analysisMs: Double
    let matchMs: Double
    let pricingMs: Double
    let totalMs: Double
    let wasReady: Bool
}

struct EvalCardDetail: Codable {
    let card: EvalCardCandidate
    let slabContext: EvalSlabContext?
}

private func runCLI() async -> Int32 {
    do {
        let arguments = try Arguments.parse(from: CommandLine.arguments)
        let runner = EvalRunner(serverBaseURL: arguments.serverBaseURL)

        switch arguments.mode {
        case .single(let imagePath, let expectedCardID):
            let passed = try await runner.runSingle(
                named: URL(fileURLWithPath: imagePath).lastPathComponent,
                imagePath: imagePath,
                expectedCardID: expectedCardID,
                acceptedCardIDs: nil,
                expectedCardName: nil,
                expectedSetName: nil,
                expectedNumber: nil,
                acceptedSetNames: nil,
                acceptedNumbers: nil,
                expectedConfidence: nil,
                acceptedConfidences: nil,
                expectedResolverPath: nil,
                acceptedResolverPaths: nil,
                expectedResolverMode: nil,
                acceptedResolverModes: nil,
                expectPricingAvailable: nil,
                expectedPricingMode: nil,
                expectedPricingTier: nil
            )
            return passed ? 0 : 1
        case .manifest(let manifestPath):
            let passed = try await runner.runManifest(at: manifestPath)
            return passed ? 0 : 1
        case .benchmark(let manifestPath, let iterations, let maxTotalAverageMs, let maxTotalP95Ms):
            try await runner.runBenchmarkManifest(
                at: manifestPath,
                iterations: iterations,
                maxTotalAverageMs: maxTotalAverageMs,
                maxTotalP95Ms: maxTotalP95Ms
            )
            return 0
        }
    } catch {
        fputs("scanner_eval error: \(error.localizedDescription)\n", stderr)
        return 1
    }
}

private final class EvalRunner {
    private let analyzer = CommandLineCardAnalyzer()
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let serverBaseURL: URL?

    init(serverBaseURL: URL?) {
        self.serverBaseURL = serverBaseURL

        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601

        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    func runManifest(at manifestPath: String) async throws -> Bool {
        let manifestURL = URL(fileURLWithPath: manifestPath)
        let manifestData = try Data(contentsOf: manifestURL)
        let cases = try JSONDecoder().decode([EvalCase].self, from: manifestData)

        var passCount = 0
        for testCase in cases {
            let passed = try await runSingle(
                named: testCase.name,
                imagePath: testCase.imagePath,
                expectedCardID: testCase.expectedCardID,
                acceptedCardIDs: testCase.acceptedCardIDs,
                expectedCardName: testCase.expectedCardName,
                expectedSetName: testCase.expectedSetName,
                expectedNumber: testCase.expectedNumber,
                acceptedSetNames: testCase.acceptedSetNames,
                acceptedNumbers: testCase.acceptedNumbers,
                expectedConfidence: testCase.expectedConfidence,
                acceptedConfidences: testCase.acceptedConfidences,
                expectedResolverPath: testCase.expectedResolverPath,
                acceptedResolverPaths: testCase.acceptedResolverPaths,
                expectedResolverMode: testCase.expectedResolverMode,
                acceptedResolverModes: testCase.acceptedResolverModes,
                expectPricingAvailable: testCase.expectPricingAvailable,
                expectedPricingMode: testCase.expectedPricingMode,
                expectedPricingTier: testCase.expectedPricingTier
            )
            if passed {
                passCount += 1
            }
        }

        print("\nSummary: \(passCount)/\(cases.count) passed")
        return passCount == cases.count
    }

    func runBenchmarkManifest(
        at manifestPath: String,
        iterations: Int,
        maxTotalAverageMs: Double?,
        maxTotalP95Ms: Double?
    ) async throws {
        guard serverBaseURL != nil else {
            throw CLIError.invalidArguments
        }

        let manifestURL = URL(fileURLWithPath: manifestPath)
        let manifestData = try Data(contentsOf: manifestURL)
        let cases = try JSONDecoder().decode([EvalCase].self, from: manifestData)

        var samples: [EvalBenchmarkSample] = []

        for testCase in cases {
            for iteration in 1...max(iterations, 1) {
                let sample = try await benchmarkSingle(
                    named: testCase.name,
                    imagePath: testCase.imagePath
                )
                samples.append(sample)
                print(
                    "BENCHMARK \(testCase.name) [\(iteration)/\(max(iterations, 1))] "
                    + "analysis=\(formatMs(sample.analysisMs)) "
                    + "match=\(formatMs(sample.matchMs)) "
                    + "pricing=\(formatMs(sample.pricingMs)) "
                    + "total=\(formatMs(sample.totalMs))"
                )
            }
        }

        let overall = summarize(samples)
        let readySamples = samples.filter(\.wasReady)
        let readyOnly = summarize(readySamples)
        print("\n=== Benchmark Summary ===")
        print("Samples: \(samples.count)")
        print("Analysis avg: \(formatMs(overall.analysisAverageMs)) p95: \(formatMs(overall.analysisP95Ms))")
        print("Match avg: \(formatMs(overall.matchAverageMs)) p95: \(formatMs(overall.matchP95Ms))")
        print("Pricing avg: \(formatMs(overall.pricingAverageMs)) p95: \(formatMs(overall.pricingP95Ms))")
        print("Total avg: \(formatMs(overall.totalAverageMs)) p95: \(formatMs(overall.totalP95Ms))")
        if !readySamples.isEmpty {
            print("Ready samples: \(readySamples.count)")
            print("Ready total avg: \(formatMs(readyOnly.totalAverageMs)) p95: \(formatMs(readyOnly.totalP95Ms))")
        }

        let thresholdSummary = readySamples.isEmpty ? overall : readyOnly
        if let maxTotalAverageMs, thresholdSummary.totalAverageMs > maxTotalAverageMs {
            throw CLIError.performanceRegression(
                "Average total latency \(formatMs(thresholdSummary.totalAverageMs)) exceeded threshold \(formatMs(maxTotalAverageMs))."
            )
        }
        if let maxTotalP95Ms, thresholdSummary.totalP95Ms > maxTotalP95Ms {
            throw CLIError.performanceRegression(
                "P95 total latency \(formatMs(thresholdSummary.totalP95Ms)) exceeded threshold \(formatMs(maxTotalP95Ms))."
            )
        }
    }

    func benchmarkSingle(named name: String, imagePath: String) async throws -> EvalBenchmarkSample {
        let analysisStarted = Date().timeIntervalSinceReferenceDate
        let analysis = try analyzer.analyze(imageAtPath: imagePath)
        let analysisMs = (Date().timeIntervalSinceReferenceDate - analysisStarted) * 1000

        guard let serverBaseURL else {
            throw CLIError.invalidArguments
        }

        let matchStarted = Date().timeIntervalSinceReferenceDate
        let response = try await match(analysis: analysis, serverBaseURL: serverBaseURL)
        let matchMs = (Date().timeIntervalSinceReferenceDate - matchStarted) * 1000
        let shouldHydratePricing =
            response.reviewDisposition == "ready"
            && response.topCandidates.first?.candidate.pricing == nil
            && response.topCandidates.first?.candidate.id != nil
        let pricingMs: Double
        if shouldHydratePricing {
            let pricingStarted = Date().timeIntervalSinceReferenceDate
            _ = try await refreshCardDetail(
                cardID: response.topCandidates.first?.candidate.id,
                slabContext: response.slabContext,
                serverBaseURL: serverBaseURL
            )
            pricingMs = (Date().timeIntervalSinceReferenceDate - pricingStarted) * 1000
        } else {
            pricingMs = 0
        }
        let totalMs = analysisMs + matchMs + pricingMs

        return EvalBenchmarkSample(
            name: name,
            analysisMs: analysisMs,
            matchMs: matchMs,
            pricingMs: pricingMs,
            totalMs: totalMs,
            wasReady: response.reviewDisposition == "ready"
        )
    }

    func runSingle(
        named name: String,
        imagePath: String,
        expectedCardID: String?,
        acceptedCardIDs: [String]?,
        expectedCardName: String?,
        expectedSetName: String?,
        expectedNumber: String?,
        acceptedSetNames: [String]?,
        acceptedNumbers: [String]?,
        expectedConfidence: String?,
        acceptedConfidences: [String]?,
        expectedResolverPath: String?,
        acceptedResolverPaths: [String]?,
        expectedResolverMode: String?,
        acceptedResolverModes: [String]?,
        expectPricingAvailable: Bool?,
        expectedPricingMode: String?,
        expectedPricingTier: String?
    ) async throws -> Bool {
        let analysis = try analyzer.analyze(imageAtPath: imagePath)

        print("\n=== \(name) ===")
        print("Image: \(imagePath)")
        print("Crop confidence: \(String(format: "%.2f", analysis.cropConfidence))")
        print("Collector number: \(analysis.collectorNumber ?? "nil")")
        print("Resolver hint: \(analysis.resolverModeHint.rawValue)")
        print("Direct lookup likely: \(analysis.directLookupLikely ? "yes" : "no")")
        if !analysis.setHintTokens.isEmpty {
            print("Set hints: \(analysis.setHintTokens.joined(separator: ", "))")
        }
        if let promoCodeHint = analysis.promoCodeHint {
            print("Promo hint: \(promoCodeHint)")
        }
        if let slabGrader = analysis.slabGrader {
            print("Slab grader: \(slabGrader)")
        }
        if let slabGrade = analysis.slabGrade {
            print("Slab grade: \(slabGrade)")
        }
        if let slabCertNumber = analysis.slabCertNumber {
            print("Slab cert: \(slabCertNumber)")
        }
        if !analysis.topLabelRecognizedText.isEmpty {
            print("Top label OCR: \(analysis.topLabelRecognizedText)")
        }
        if !analysis.metadataStripRecognizedText.isEmpty {
            print("Bottom strip OCR: \(analysis.metadataStripRecognizedText)")
        }
        if !analysis.warnings.isEmpty {
            print("Warnings: \(analysis.warnings.joined(separator: " | "))")
        }
        if !analysis.recognizedTokens.isEmpty {
            print("Recognized text: \(analysis.recognizedTokens.map(\.text).joined(separator: " • "))")
        }

        guard let serverBaseURL else {
            print("Match skipped: no server URL provided")
            return true
        }

        let response = try await match(analysis: analysis, serverBaseURL: serverBaseURL)

        if let best = response.topCandidates.first {
            print("Best match: \(best.candidate.name) • \(best.candidate.setName) • \(best.candidate.number)")
            print("Confidence: \(response.confidence) (\(response.matcherSource) / \(response.matcherVersion))")
            print("Resolver mode: \(response.resolverMode.rawValue)")
            if let resolverPath = response.resolverPath {
                print("Resolver path: \(resolverPath.rawValue)")
            }
            if let pricing = best.candidate.pricing,
               let market = pricing.market {
                print("Candidate pricing: \(market) [\(pricing.source)]")
            }
        } else {
            print("Best match: none")
        }

        if !response.ambiguityFlags.isEmpty {
            print("Ambiguity: \(response.ambiguityFlags.joined(separator: " | "))")
        }

        let passed: Bool
        if expectedCardID != nil || acceptedCardIDs != nil || expectedCardName != nil || expectedSetName != nil || expectedNumber != nil || acceptedSetNames != nil || acceptedNumbers != nil || expectedConfidence != nil || acceptedConfidences != nil || expectedResolverPath != nil || acceptedResolverPaths != nil || expectedResolverMode != nil || acceptedResolverModes != nil || expectPricingAvailable != nil || expectedPricingMode != nil || expectedPricingTier != nil {
            let acceptedIDs = acceptedCardIDs ?? (expectedCardID.map { [$0] } ?? [])
            let bestCandidate = response.topCandidates.first?.candidate
            let actualID = bestCandidate?.id

            var checks: [Bool] = []
            if !acceptedIDs.isEmpty {
                checks.append(actualID.map { acceptedIDs.contains($0) } ?? false)
                print("Accepted IDs: \(acceptedIDs.joined(separator: ", "))")
            }
            if let expectedCardName {
                checks.append(bestCandidate?.name == expectedCardName)
                print("Expected name: \(expectedCardName)")
            }
            if let expectedSetName {
                checks.append(bestCandidate?.setName == expectedSetName)
                print("Expected set: \(expectedSetName)")
            }
            if let acceptedSetNames, !acceptedSetNames.isEmpty {
                checks.append(bestCandidate.map { acceptedSetNames.contains($0.setName) } ?? false)
                print("Accepted sets: \(acceptedSetNames.joined(separator: ", "))")
            }
            if let expectedNumber {
                checks.append(bestCandidate?.number == expectedNumber)
                print("Expected number: \(expectedNumber)")
            }
            if let acceptedNumbers, !acceptedNumbers.isEmpty {
                checks.append(bestCandidate.map { acceptedNumbers.contains($0.number) } ?? false)
                print("Accepted numbers: \(acceptedNumbers.joined(separator: ", "))")
            }
            let allowedConfidences = acceptedConfidences ?? (expectedConfidence.map { [$0] } ?? [])
            if !allowedConfidences.isEmpty {
                checks.append(allowedConfidences.contains(response.confidence))
                print("Accepted confidences: \(allowedConfidences.joined(separator: ", "))")
            }
            let allowedResolverPaths = acceptedResolverPaths ?? (expectedResolverPath.map { [$0] } ?? [])
            if !allowedResolverPaths.isEmpty {
                checks.append(response.resolverPath.map { allowedResolverPaths.contains($0.rawValue) } ?? false)
                print("Accepted resolver paths: \(allowedResolverPaths.joined(separator: ", "))")
            }
            let allowedResolverModes = acceptedResolverModes ?? (expectedResolverMode.map { [$0] } ?? [])
            if !allowedResolverModes.isEmpty {
                checks.append(allowedResolverModes.contains(response.resolverMode.rawValue))
                print("Accepted resolver modes: \(allowedResolverModes.joined(separator: ", "))")
            }

            if let shouldExpectPricing = expectPricingAvailable {
                let detail = try await fetchCardDetail(
                    cardID: actualID,
                    slabContext: response.slabContext,
                    serverBaseURL: serverBaseURL
                )
                let hasPricing = detail?.card.pricing != nil
                checks.append(hasPricing == shouldExpectPricing)
                print("Expected pricing available: \(shouldExpectPricing ? "yes" : "no")")
                if let pricing = detail?.card.pricing {
                    print("Detail pricing mode: \(pricing.pricingMode ?? "nil")")
                    print("Detail pricing tier: \(pricing.pricingTier ?? "nil")")
                    print("Detail pricing source: \(pricing.source)")
                    if let market = pricing.market {
                        print("Detail market: \(market)")
                    }
                    if let expectedPricingMode {
                        checks.append(pricing.pricingMode == expectedPricingMode)
                        print("Expected pricing mode: \(expectedPricingMode)")
                    }
                    if let expectedPricingTier {
                        checks.append(pricing.pricingTier == expectedPricingTier)
                        print("Expected pricing tier: \(expectedPricingTier)")
                    }
                } else {
                    if let expectedPricingMode {
                        checks.append(false)
                        print("Expected pricing mode: \(expectedPricingMode)")
                    }
                    if let expectedPricingTier {
                        checks.append(false)
                        print("Expected pricing tier: \(expectedPricingTier)")
                    }
                }
            }

            passed = !checks.contains(false)
            print("Result: \(passed ? "PASS" : "FAIL")")
        } else {
            passed = true
        }

        return passed
    }

    private func match(analysis: EvalAnalysis, serverBaseURL: URL) async throws -> EvalMatchResponse {
        try await performMatch(
            payload: makePayload(analysis: analysis),
            serverBaseURL: serverBaseURL
        )
    }

    private func makePayload(analysis: EvalAnalysis) -> EvalMatchRequestPayload {
        EvalMatchRequestPayload(
            scanID: UUID(),
            capturedAt: Date(),
            clientContext: EvalClientContext(
                platform: "macOS-cli",
                appVersion: "0",
                buildNumber: "0",
                localeIdentifier: Locale.current.identifier,
                timeZoneIdentifier: TimeZone.current.identifier
            ),
            image: EvalImagePayload(
                jpegBase64: analysis.imageBase64,
                width: Int(analysis.croppedImageSize.width.rounded()),
                height: Int(analysis.croppedImageSize.height.rounded())
            ),
            recognizedTokens: analysis.recognizedTokens,
            fullRecognizedText: analysis.fullRecognizedText,
            metadataStripRecognizedText: analysis.metadataStripRecognizedText,
            topLabelRecognizedText: analysis.topLabelRecognizedText,
            bottomLeftRecognizedText: analysis.bottomLeftRecognizedText,
            bottomRightRecognizedText: analysis.bottomRightRecognizedText,
            collectorNumber: analysis.collectorNumber,
            setHintTokens: analysis.setHintTokens,
            promoCodeHint: analysis.promoCodeHint,
            slabGrader: analysis.slabGrader,
            slabGrade: analysis.slabGrade,
            slabCertNumber: analysis.slabCertNumber,
            slabBarcodePayloads: analysis.slabBarcodePayloads,
            slabGraderConfidence: analysis.slabGraderConfidence,
            slabGradeConfidence: analysis.slabGradeConfidence,
            slabCertConfidence: analysis.slabCertConfidence,
            slabCardNumberRaw: analysis.slabCardNumberRaw,
            slabParsedLabelText: analysis.slabParsedLabelText,
            slabClassifierReasons: analysis.slabClassifierReasons,
            slabRecommendedLookupPath: analysis.slabRecommendedLookupPath,
            directLookupLikely: analysis.directLookupLikely,
            resolverModeHint: analysis.resolverModeHint,
            cropConfidence: analysis.cropConfidence,
            warnings: analysis.warnings
        )
    }

    private func performMatch(payload: EvalMatchRequestPayload, serverBaseURL: URL) async throws -> EvalMatchResponse {
        var request = URLRequest(url: serverBaseURL.appending(path: "api/v1/scan/match"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(payload)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
            throw CLIError.httpFailure
        }

        return try decoder.decode(EvalMatchResponse.self, from: data)
    }

    private func refreshCardDetail(cardID: String?, slabContext: EvalSlabContext?, serverBaseURL: URL) async throws -> EvalCardDetail? {
        guard let cardID else { return nil }
        guard var components = URLComponents(
            url: serverBaseURL.appending(path: "api/v1/cards/\(cardID)/refresh-pricing"),
            resolvingAgainstBaseURL: false
        ) else {
            return nil
        }
        var queryItems: [URLQueryItem] = []
        if let slabContext {
            queryItems.append(URLQueryItem(name: "grader", value: slabContext.grader))
            if let grade = slabContext.grade {
                queryItems.append(URLQueryItem(name: "grade", value: grade))
            }
        }
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components.url else { return nil }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
            return nil
        }

        return try decoder.decode(EvalCardDetail.self, from: data)
    }

    private func fetchCardDetail(cardID: String?, slabContext: EvalSlabContext?, serverBaseURL: URL) async throws -> EvalCardDetail? {
        guard let cardID else { return nil }
        guard var components = URLComponents(url: serverBaseURL.appending(path: "api/v1/cards/\(cardID)"), resolvingAgainstBaseURL: false) else {
            return nil
        }
        var queryItems: [URLQueryItem] = []
        if let slabContext {
            queryItems.append(URLQueryItem(name: "grader", value: slabContext.grader))
            if let grade = slabContext.grade {
                queryItems.append(URLQueryItem(name: "grade", value: grade))
            }
        }
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components.url else { return nil }

        let (data, response) = try await URLSession.shared.data(from: url)
        guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
            return nil
        }

        return try decoder.decode(EvalCardDetail.self, from: data)
    }

}

private struct Arguments {
    enum Mode {
        case single(imagePath: String, expectedCardID: String?)
        case manifest(path: String)
        case benchmark(path: String, iterations: Int, maxTotalAverageMs: Double?, maxTotalP95Ms: Double?)
    }

    let mode: Mode
    let serverBaseURL: URL?

    static func parse(from argv: [String]) throws -> Arguments {
        var imagePath: String?
        var manifestPath: String?
        var expectedCardID: String?
        var benchmarkManifestPath: String?
        var serverString = "http://127.0.0.1:8787/"
        var offline = false
        var iterations = 3
        var maxTotalAverageMs: Double?
        var maxTotalP95Ms: Double?

        var iterator = argv.dropFirst().makeIterator()
        while let argument = iterator.next() {
            switch argument {
            case "--image":
                imagePath = iterator.next()
            case "--manifest":
                manifestPath = iterator.next()
            case "--benchmark-manifest":
                benchmarkManifestPath = iterator.next()
            case "--expected":
                expectedCardID = iterator.next()
            case "--server":
                serverString = iterator.next() ?? serverString
            case "--iterations":
                iterations = Int(iterator.next() ?? "") ?? iterations
            case "--max-total-ms":
                maxTotalAverageMs = Double(iterator.next() ?? "")
            case "--max-total-p95-ms":
                maxTotalP95Ms = Double(iterator.next() ?? "")
            case "--offline":
                offline = true
            default:
                throw CLIError.invalidArguments
            }
        }

        let mode: Mode
        if let benchmarkManifestPath {
            mode = .benchmark(
                path: benchmarkManifestPath,
                iterations: iterations,
                maxTotalAverageMs: maxTotalAverageMs,
                maxTotalP95Ms: maxTotalP95Ms
            )
        } else if let manifestPath {
            mode = .manifest(path: manifestPath)
        } else if let imagePath {
            mode = .single(imagePath: imagePath, expectedCardID: expectedCardID)
        } else {
            throw CLIError.invalidArguments
        }

        return Arguments(
            mode: mode,
            serverBaseURL: offline ? nil : URL(string: serverString)
        )
    }
}

private enum CLIError: LocalizedError {
    case invalidArguments
    case imageLoadFailed
    case invalidImage
    case httpFailure
    case performanceRegression(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            """
            Usage:
              swift tools/scanner_eval.swift --image /abs/path/to/card.jpg [--expected card_id] [--server http://127.0.0.1:8787/]
              swift tools/scanner_eval.swift --manifest /abs/path/to/manifest.json [--server http://127.0.0.1:8787/]
              swift tools/scanner_eval.swift --benchmark-manifest /abs/path/to/manifest.json [--iterations 3] [--server http://127.0.0.1:8787/] [--max-total-ms 3000] [--max-total-p95-ms 3500]
              add --offline to skip backend matching and only inspect OCR/crop output
            """
        case .imageLoadFailed:
            "The image could not be loaded from disk."
        case .invalidImage:
            "The image could not be converted into a CGImage."
        case .httpFailure:
            "The scanner backend did not return a successful response."
        case .performanceRegression(let message):
            message
        }
    }
}

private struct EvalBenchmarkSummary {
    let analysisAverageMs: Double
    let analysisP95Ms: Double
    let matchAverageMs: Double
    let matchP95Ms: Double
    let pricingAverageMs: Double
    let pricingP95Ms: Double
    let totalAverageMs: Double
    let totalP95Ms: Double
}

private func summarize(_ samples: [EvalBenchmarkSample]) -> EvalBenchmarkSummary {
    func average(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0 }
        return values.reduce(0, +) / Double(values.count)
    }

    func p95(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let index = Int((Double(sorted.count - 1) * 0.95).rounded(.up))
        return sorted[min(index, sorted.count - 1)]
    }

    let analysisValues = samples.map(\.analysisMs)
    let matchValues = samples.map(\.matchMs)
    let pricingValues = samples.map(\.pricingMs)
    let totalValues = samples.map(\.totalMs)

    return EvalBenchmarkSummary(
        analysisAverageMs: average(analysisValues),
        analysisP95Ms: p95(analysisValues),
        matchAverageMs: average(matchValues),
        matchP95Ms: p95(matchValues),
        pricingAverageMs: average(pricingValues),
        pricingP95Ms: p95(pricingValues),
        totalAverageMs: average(totalValues),
        totalP95Ms: p95(totalValues)
    )
}

private func formatMs(_ value: Double) -> String {
    String(format: "%.1fms", value)
}

private struct CommandLineCardAnalyzer {
    func analyze(imageAtPath path: String) throws -> EvalAnalysis {
        let imageURL = URL(fileURLWithPath: path)
        guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil) else {
            throw CLIError.imageLoadFailed
        }
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
            throw CLIError.invalidImage
        }
        let maxPixelSize = max(
            properties[kCGImagePropertyPixelWidth] as? Int ?? 1600,
            properties[kCGImagePropertyPixelHeight] as? Int ?? 1600
        )
        let thumbnailOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize
        ]
        guard let baseImage = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary) else {
            throw CLIError.imageLoadFailed
        }

        var warnings: [String] = []
        var workingImage = baseImage
        var cropConfidence = 0.0

        if isLikelyCardFramed(baseImage) {
            cropConfidence = 1.0
        } else {
            if let rectangle = try detectCardRectangle(in: baseImage) {
                cropConfidence = Double(rectangle.confidence)
                if let cropped = crop(baseImage, to: rectangle) {
                    workingImage = cropped
                } else {
                    warnings.append("Detected the card, but the crop was imperfect.")
                }
            } else {
                warnings.append("Could not isolate one card cleanly. Results may be less reliable.")
            }
        }

        let fullCardTokens = try recognizeText(in: workingImage, minimumTextHeight: 0.01)
        let topLabelTokens = try recognizeText(
            in: baseImage,
            focusedOn: CGRect(x: 0.04, y: 0.00, width: 0.92, height: 0.22),
            minimumTextHeight: 0.006,
            upscaleFactor: 2.6
        )
        let topRightLabelTokens = try recognizeText(
            in: baseImage,
            focusedOn: CGRect(x: 0.60, y: 0.00, width: 0.36, height: 0.20),
            minimumTextHeight: 0.004,
            upscaleFactor: 4.0
        )
        let headerTokens = try recognizeText(
            in: workingImage,
            focusedOn: CGRect(x: 0.04, y: 0.00, width: 0.92, height: 0.18),
            minimumTextHeight: 0.012,
            upscaleFactor: 2.4
        )
        let nameplateTokens = try recognizeText(
            in: workingImage,
            focusedOn: CGRect(x: 0.16, y: 0.02, width: 0.62, height: 0.14),
            minimumTextHeight: 0.015,
            upscaleFactor: 2.2
        )
        let metadataStripTokens = try recognizeText(
            in: workingImage,
            focusedOn: CGRect(x: 0.08, y: 0.82, width: 0.84, height: 0.15),
            minimumTextHeight: 0.005,
            upscaleFactor: 3.2
        )
        let bottomLeftMetadataTokens = try recognizeText(
            in: workingImage,
            focusedOn: CGRect(x: 0.00, y: 0.80, width: 0.42, height: 0.18),
            minimumTextHeight: 0.004,
            upscaleFactor: 4.0
        )
        let bottomRightMetadataTokens = try recognizeText(
            in: workingImage,
            focusedOn: CGRect(x: 0.56, y: 0.80, width: 0.44, height: 0.18),
            minimumTextHeight: 0.004,
            upscaleFactor: 4.0
        )

        let recognizedTokens = mergedTokens(
            prioritizedGroups: [
                bottomLeftMetadataTokens,
                bottomRightMetadataTokens,
                metadataStripTokens,
                headerTokens,
                nameplateTokens,
                fullCardTokens
            ]
        )

        if recognizedTokens.isEmpty {
            warnings.append("Text recognition was weak. Expect more ambiguity.")
        }

        let joinedText = recognizedTokens.map(\.text).joined(separator: " ")
        let topLabelRecognizedText = mergedTokens(
            prioritizedGroups: [
                topRightLabelTokens,
                topLabelTokens
            ]
        )
        .map(\.text)
        .joined(separator: " ")
        let slabLabelAnalysis = SlabLabelParser.analyze(labelText: topLabelRecognizedText)
        let bottomLeftMetadataText = bottomLeftMetadataTokens.map(\.text).joined(separator: " ")
        let bottomRightMetadataText = bottomRightMetadataTokens.map(\.text).joined(separator: " ")
        let metadataText = metadataStripTokens.map(\.text).joined(separator: " ")
        let collectorNumber = extractCollectorNumber(from: bottomLeftMetadataText)
            ?? extractCollectorNumber(from: metadataText)
            ?? extractCollectorNumber(from: joinedText)
        let setHintTokens = extractSetHintTokens(from: [
            bottomLeftMetadataText,
            bottomRightMetadataText,
            metadataText
        ])
        let promoCodeHint = extractPromoCodeHint(from: collectorNumber)
        let directLookupLikely = (
            collectorNumber != nil
            && (!setHintTokens.isEmpty || promoCodeHint != nil)
            && cropConfidence >= 0.72
        ) || slabLabelAnalysis.certNumber != nil
        let resolverModeHint = inferResolverModeHint(
            slabLabelAnalysis: slabLabelAnalysis,
            topLabelRecognizedText: topLabelRecognizedText,
            fullRecognizedText: joinedText,
            collectorNumber: collectorNumber,
            cropConfidence: cropConfidence
        )

        if collectorNumber == nil {
            warnings.append("Could not read a collector number.")
        }

        return EvalAnalysis(
            recognizedTokens: recognizedTokens,
            fullRecognizedText: joinedText,
            metadataStripRecognizedText: metadataText,
            topLabelRecognizedText: topLabelRecognizedText,
            bottomLeftRecognizedText: bottomLeftMetadataText,
            bottomRightRecognizedText: bottomRightMetadataText,
            collectorNumber: collectorNumber,
            setHintTokens: setHintTokens,
            promoCodeHint: promoCodeHint,
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
            slabRecommendedLookupPath: slabLabelAnalysis.recommendedLookupPath.rawValue,
            directLookupLikely: directLookupLikely,
            resolverModeHint: resolverModeHint,
            cropConfidence: cropConfidence,
            warnings: warnings,
            croppedImageSize: CGSize(width: workingImage.width, height: workingImage.height),
            imageBase64: encodedJPEGBase64(for: workingImage, maxDimension: 960, compressionQuality: 0.72)
        )
    }

    private func detectCardRectangle(in cgImage: CGImage) throws -> VNRectangleObservation? {
        let request = VNDetectRectanglesRequest()
        request.maximumObservations = 1
        request.minimumConfidence = 0.45
        request.minimumAspectRatio = 0.6
        request.maximumAspectRatio = 0.85

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        try handler.perform([request])
        return request.results?.first
    }

    private func crop(_ cgImage: CGImage, to observation: VNRectangleObservation) -> CGImage? {
        let imageWidth = CGFloat(cgImage.width)
        let imageHeight = CGFloat(cgImage.height)
        let boundingBox = observation.boundingBox

        let cropRect = CGRect(
            x: boundingBox.minX * imageWidth,
            y: (1 - boundingBox.maxY) * imageHeight,
            width: boundingBox.width * imageWidth,
            height: boundingBox.height * imageHeight
        ).integral

        return cgImage.cropping(to: cropRect)
    }

    private func crop(_ cgImage: CGImage, toNormalizedRect normalizedRect: CGRect) -> CGImage? {
        let width = CGFloat(cgImage.width)
        let height = CGFloat(cgImage.height)
        let cropRect = CGRect(
            x: normalizedRect.minX * width,
            y: normalizedRect.minY * height,
            width: normalizedRect.width * width,
            height: normalizedRect.height * height
        ).integral

        guard cropRect.width > 0, cropRect.height > 0 else { return nil }
        return cgImage.cropping(to: cropRect)
    }

    private func upscale(_ cgImage: CGImage, factor: CGFloat) -> CGImage? {
        guard factor > 1 else { return cgImage }

        let width = Int(CGFloat(cgImage.width) * factor)
        let height = Int(CGFloat(cgImage.height) * factor)

        guard let colorSpace = cgImage.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB),
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

    private func recognizeText(
        in cgImage: CGImage,
        focusedOn normalizedRect: CGRect? = nil,
        minimumTextHeight: Float,
        upscaleFactor: CGFloat = 1
    ) throws -> [EvalRecognizedToken] {
        let targetImage: CGImage

        if let normalizedRect,
           let focusedImage = crop(cgImage, toNormalizedRect: normalizedRect) {
            targetImage = upscale(focusedImage, factor: upscaleFactor) ?? focusedImage
        } else {
            targetImage = cgImage
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.minimumTextHeight = minimumTextHeight

        let handler = VNImageRequestHandler(cgImage: targetImage, options: [:])
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
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let trimmed = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            return EvalRecognizedToken(text: trimmed, confidence: candidate.confidence)
        }
    }

    private func mergedTokens(prioritizedGroups: [[EvalRecognizedToken]]) -> [EvalRecognizedToken] {
        var merged: [EvalRecognizedToken] = []
        var seen = Set<String>()

        for group in prioritizedGroups {
            for token in group {
                let key = token.text
                    .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
                    .lowercased()

                guard !key.isEmpty, !seen.contains(key) else { continue }
                seen.insert(key)
                merged.append(token)
            }
        }

        return merged
    }

    private func extractCollectorNumber(from text: String) -> String? {
        let normalizedText = normalizedCollectorText(text)

        let directPatterns = [
            #"\b\d{1,3}/\d{1,3}\b"#,
            #"\b(?:SVP|SWSH|SM|XY|BW|DP|HGSS|POP|PR)\s?\d{1,3}\b"#,
            #"\b[A-Z]{1,3}\d{1,3}/[A-Z]{1,3}\d{1,3}\b"#
        ]

        for pattern in directPatterns {
            if let match = normalizedText.firstMatch(of: pattern, options: []) {
                return match
                    .replacingOccurrences(of: #"\s*/\s*"#, with: "/", options: .regularExpression)
                    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }

        if let compactNumber = normalizedText.firstMatch(of: #"\b\d{6}\b"#, options: []) {
            let prefix = compactNumber.prefix(3)
            let suffix = compactNumber.suffix(3)
            return "\(prefix)/\(suffix)"
        }

        return nil
    }

    private func normalizedCollectorText(_ text: String) -> String {
        text
            .uppercased()
            .replacingOccurrences(of: #"\b([A-Z]{2,4})\s*EN\s*(\d{1,3})\b"#, with: "$1 $2", options: .regularExpression)
            .replacingOccurrences(of: #"\b([A-Z]{2,4})EN\s*(\d{1,3})\b"#, with: "$1 $2", options: .regularExpression)
            .replacingOccurrences(of: #"(?<=\d)[I|L](?=\d)"#, with: "/", options: .regularExpression)
            .replacingOccurrences(of: #"(?<=\d)\s+(?=\d{3}\b)"#, with: "/", options: .regularExpression)
    }

    private func extractSetHintTokens(from texts: [String]) -> [String] {
        var hints = Set<String>()
        let patterns = [
            #"\b([A-Z]{2,5})\s*EN\b"#,
            #"\b([A-Z]{2,5})EN\b"#,
            #"\(([A-Z]{2,5})EN\)"#
        ]

        for text in texts {
            let normalized = normalizedCollectorText(text)
            for pattern in patterns {
                for match in normalized.captureGroups(in: pattern) {
                    hints.insert(match.lowercased())
                }
            }
        }

        return hints.sorted()
    }

    private func extractPromoCodeHint(from collectorNumber: String?) -> String? {
        guard let collectorNumber else { return nil }
        let normalized = normalizedCollectorText(collectorNumber)

        if let prefixed = normalized.captureGroups(in: #"\b([A-Z]{2,5})\s?\d{1,3}\b"#).first {
            return prefixed
        }

        if let prefixedPair = normalized.captureGroups(in: #"\b([A-Z]{1,5})\d{1,3}/[A-Z]{1,5}\d{1,3}\b"#).first {
            return prefixedPair
        }

        return nil
    }

    private func inferResolverModeHint(
        slabLabelAnalysis: SlabLabelAnalysis,
        topLabelRecognizedText: String,
        fullRecognizedText: String,
        collectorNumber: String?,
        cropConfidence: Double
    ) -> EvalResolverMode {
        if slabLabelAnalysis.isLikelySlab {
            return .psaSlab
        }

        let labelText = normalizedCollectorText(topLabelRecognizedText)
        let combinedText = normalizedCollectorText("\(topLabelRecognizedText) \(fullRecognizedText)")

        let slabSignals = [
            "PSA",
            "GEM MT",
            "MINT",
            "NM MT",
            "CERT",
            "1ST EDITION",
        ]

        let hasSlabKeyword = slabSignals.contains { labelText.contains($0) || combinedText.contains($0) }
        let hasCertLikeNumber = combinedText.firstMatch(of: #"\b\d{7,8}\b"#, options: []) != nil
        let hasPsaLabelShape = labelText.contains("POKEMON") && (labelText.contains("#") || hasCertLikeNumber)

        if hasSlabKeyword || hasPsaLabelShape {
            return .psaSlab
        }

        if collectorNumber != nil && cropConfidence >= 0.55 {
            return .rawCard
        }

        return .unknownFallback
    }

    private func encodedJPEGBase64(
        for cgImage: CGImage,
        maxDimension: CGFloat,
        compressionQuality: CGFloat
    ) -> String? {
        let preparedImage = downscaled(cgImage, maxDimension: maxDimension) ?? cgImage
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else {
            return nil
        }
        let options: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: compressionQuality
        ]
        CGImageDestinationAddImage(destination, preparedImage, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            return nil
        }
        return (data as Data).base64EncodedString()
    }

    private func downscaled(_ cgImage: CGImage, maxDimension: CGFloat) -> CGImage? {
        let width = CGFloat(cgImage.width)
        let height = CGFloat(cgImage.height)
        let largestDimension = max(width, height)

        guard largestDimension > maxDimension else { return cgImage }

        let scale = maxDimension / largestDimension
        let targetWidth = Int((width * scale).rounded())
        let targetHeight = Int((height * scale).rounded())

        guard let colorSpace = cgImage.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil,
                width: targetWidth,
                height: targetHeight,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else {
            return nil
        }

        context.interpolationQuality = .high
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
        return context.makeImage()
    }

    private func isLikelyCardFramed(_ cgImage: CGImage) -> Bool {
        let aspectRatio = CGFloat(cgImage.width) / CGFloat(max(cgImage.height, 1))
        let targetRatio: CGFloat = 0.716
        return abs(aspectRatio - targetRatio) <= 0.035
    }
}

private extension String {
    func firstMatch(of pattern: String, options: NSRegularExpression.Options = [.caseInsensitive]) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else {
            return nil
        }

        let range = NSRange(startIndex..., in: self)
        guard let match = regex.firstMatch(in: self, options: [], range: range),
              let matchRange = Range(match.range, in: self) else {
            return nil
        }

        return String(self[matchRange])
    }

    func captureGroups(in pattern: String, options: NSRegularExpression.Options = [.caseInsensitive]) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else {
            return []
        }

        let range = NSRange(startIndex..., in: self)
        return regex.matches(in: self, options: [], range: range).compactMap { match in
            guard match.numberOfRanges > 1,
                  let captureRange = Range(match.range(at: 1), in: self) else {
                return nil
            }

            return String(self[captureRange])
        }
    }
}

let semaphore = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0

Task {
    exitCode = await runCLI()
    semaphore.signal()
}

semaphore.wait()
Foundation.exit(exitCode)
