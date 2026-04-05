import Foundation
import UIKit

protocol CardMatchingService: Sendable {
    func match(analysis: AnalyzedCapture) async throws -> ScanMatchResponse
    func search(query: String) async -> [CardCandidate]
    func fetchCardDetail(cardID: String, slabContext: SlabContext?) async -> CardDetail?
    func refreshCardDetail(cardID: String, slabContext: SlabContext?) async throws -> CardDetail?
    func submitFeedback(
        scanID: UUID,
        selectedCardID: String?,
        wasTopPrediction: Bool,
        correctionType: CorrectionType
    ) async
}

final class LocalPrototypeMatchingService: CardMatchingService, @unchecked Sendable {
    private let catalog = SamplePokemonCatalog.cards

    func match(analysis: AnalyzedCapture) async throws -> ScanMatchResponse {
        let recognizedText = normalizedText(analysis.fullRecognizedText)

        // This placeholder scorer is intentionally simple until the ANN-backed matcher exists.
        let scored = catalog.map { candidate -> InterimScore in
            let candidateNumber = normalizedText(candidate.number)
            let candidateName = normalizedText(candidate.name)
            let candidateSet = normalizedText(candidate.setName)
            let queryTokens = Set(recognizedText.split(separator: " ").map(String.init))
            let nameTokens = candidateName.split(separator: " ").map(String.init)

            var imageScore = 0.05
            var collectorNumberScore = 0.0
            var nameScore = 0.0

            if let collectorNumber = analysis.collectorNumber {
                let normalizedNumber = normalizedText(collectorNumber)
                if normalizedNumber == candidateNumber {
                    collectorNumberScore = 0.75
                } else if candidateNumber.contains(normalizedNumber) || normalizedNumber.contains(candidateNumber) {
                    collectorNumberScore = 0.35
                }
            }

            let matchingNameTokens = nameTokens.filter(queryTokens.contains).count
            if !nameTokens.isEmpty {
                nameScore = Double(matchingNameTokens) / Double(nameTokens.count) * 0.5
            }

            if recognizedText.contains(candidateName) {
                imageScore += 0.18
            }

            if recognizedText.contains(candidateSet) {
                imageScore += 0.12
            }

            let finalScore = min(0.99, imageScore + collectorNumberScore + nameScore)
            return InterimScore(
                candidate: candidate,
                imageScore: imageScore,
                collectorNumberScore: collectorNumberScore,
                nameScore: nameScore,
                finalScore: finalScore
            )
        }
        .sorted { lhs, rhs in
            if lhs.finalScore == rhs.finalScore {
                return lhs.candidate.name < rhs.candidate.name
            }
            return lhs.finalScore > rhs.finalScore
        }
        .prefix(5)
        .enumerated()
        .map { index, score in
            ScoredCandidate(
                rank: index + 1,
                candidate: score.candidate,
                imageScore: score.imageScore,
                collectorNumberScore: score.collectorNumberScore,
                nameScore: score.nameScore,
                finalScore: score.finalScore
            )
        }

        guard !scored.isEmpty else {
            throw MatcherError.noCandidates
        }

        let confidence = confidenceLabel(for: scored, analysis: analysis)
        var ambiguityFlags = analysis.warnings

        if analysis.collectorNumber == nil {
            ambiguityFlags.append("Collector number missing")
        }

        if scored.count > 1, abs(scored[0].finalScore - scored[1].finalScore) < 0.08 {
            ambiguityFlags.append("Top matches are close together")
        }

        return ScanMatchResponse(
            scanID: analysis.scanID,
            topCandidates: scored,
            confidence: confidence,
            ambiguityFlags: Array(Set(ambiguityFlags)),
            matcherSource: .localPrototype,
            matcherVersion: "local-ocr-prototype-v1",
            resolverMode: analysis.resolverModeHint,
            resolverPath: nil,
            slabContext: nil,
            reviewDisposition: confidence == .low ? .needsReview : .ready,
            reviewReason: confidence == .low ? "Local fallback match needs review." : nil
        )
    }

    func search(query: String) async -> [CardCandidate] {
        let normalizedQuery = normalizedText(query)
        guard !normalizedQuery.isEmpty else { return [] }
        let queryTokens = Set(normalizedQuery.split(separator: " ").map(String.init))

        return catalog
            .filter { candidate in
                let haystack = normalizedText("\(candidate.name) \(candidate.setName) \(candidate.number) \(candidate.variant)")
                if haystack.contains(normalizedQuery) {
                    return true
                }

                let haystackTokens = Set(haystack.split(separator: " ").map(String.init))
                return queryTokens.allSatisfy(haystackTokens.contains)
            }
            .prefix(8)
            .map { $0 }
    }

    func fetchCardDetail(cardID: String, slabContext: SlabContext?) async -> CardDetail? {
        guard let candidate = catalog.first(where: { $0.id == cardID }) else { return nil }
        return CardDetail(
            card: candidate,
            slabContext: slabContext,
            source: "local_sample",
            sourceRecordID: cardID,
            setID: nil,
            setSeries: nil,
            setReleaseDate: nil,
            supertype: nil,
            artist: nil,
            regulationMark: nil,
            imageSmallURL: nil,
            imageLargeURL: nil
        )
    }

    func refreshCardDetail(cardID: String, slabContext: SlabContext?) async throws -> CardDetail? {
        await fetchCardDetail(cardID: cardID, slabContext: slabContext)
    }

    func submitFeedback(
        scanID: UUID,
        selectedCardID: String?,
        wasTopPrediction: Bool,
        correctionType: CorrectionType
    ) async {
        // No-op for the local fallback matcher.
    }

    private func confidenceLabel(for candidates: [ScoredCandidate], analysis: AnalyzedCapture) -> MatchConfidence {
        guard let top = candidates.first else { return .low }
        let delta = candidates.count > 1 ? top.finalScore - candidates[1].finalScore : top.finalScore

        if top.finalScore >= 0.75 && delta >= 0.14 && analysis.collectorNumber != nil {
            return .high
        }

        if top.finalScore >= 0.42 && delta >= 0.06 {
            return .medium
        }

        return .low
    }

    private func normalizedText(_ value: String) -> String {
        value
            .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
            .lowercased()
            .replacingOccurrences(of: #"[^a-z0-9/]+"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum MatcherError: LocalizedError {
    case noCandidates
    case invalidServerResponse
    case server(message: String)

    var errorDescription: String? {
        switch self {
        case .noCandidates:
            "No likely matches were found."
        case .invalidServerResponse:
            "The scan service returned an invalid response."
        case .server(let message):
            message
        }
    }
}

final class RemoteScanMatchingService: CardMatchingService, @unchecked Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(baseURL: URL, session: URLSession? = nil) {
        self.baseURL = baseURL

        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.timeoutIntervalForRequest = 30  // Allow 30s for complex image processing
            configuration.timeoutIntervalForResource = 60  // Allow 60s total including retries
            self.session = URLSession(configuration: configuration)
        }

        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601

        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    func match(analysis: AnalyzedCapture) async throws -> ScanMatchResponse {
        let lightweightFirst = analysis.directLookupLikely
        let initialResponse = try await performMatch(
            payload: makePayload(analysis: analysis, includeImage: !lightweightFirst)
        )

        if lightweightFirst,
           shouldRetryWithVisualFallback(initialResponse) {
            return try await performMatch(
                payload: makePayload(analysis: analysis, includeImage: true)
            )
        }

        return initialResponse
    }

    func search(query: String) async -> [CardCandidate] {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedQuery.isEmpty else { return [] }

        guard var components = URLComponents(url: baseURL.appending(path: "api/v1/cards/search"), resolvingAgainstBaseURL: false) else {
            return []
        }
        components.queryItems = [URLQueryItem(name: "q", value: trimmedQuery)]

        guard let url = components.url else { return [] }

        do {
            let (data, response) = try await session.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return []
            }

            return try decoder.decode(SearchResultsPayload.self, from: data).results
        } catch {
            return []
        }
    }

    func fetchCardDetail(cardID: String, slabContext: SlabContext?) async -> CardDetail? {
        guard var components = URLComponents(url: baseURL.appending(path: "api/v1/cards/\(cardID)"), resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.queryItems = detailQueryItems(for: slabContext)
        guard let endpoint = components.url else { return nil }

        do {
            let (data, response) = try await session.data(from: endpoint)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return nil
            }

            return try decoder.decode(CardDetail.self, from: data)
        } catch {
            return nil
        }
    }

    func refreshCardDetail(cardID: String, slabContext: SlabContext?) async throws -> CardDetail? {
        guard var components = URLComponents(url: baseURL.appending(path: "api/v1/cards/\(cardID)/refresh-pricing"), resolvingAgainstBaseURL: false) else {
            throw MatcherError.invalidServerResponse
        }
        components.queryItems = detailQueryItems(for: slabContext)
        guard let endpoint = components.url else {
            throw MatcherError.invalidServerResponse
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw MatcherError.invalidServerResponse
        }

        guard (200..<300).contains(httpResponse.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "Pricing refresh failed."
            throw MatcherError.server(message: message)
        }

        return try decoder.decode(CardDetail.self, from: data)
    }

    func submitFeedback(
        scanID: UUID,
        selectedCardID: String?,
        wasTopPrediction: Bool,
        correctionType: CorrectionType
    ) async {
        let endpoint = baseURL.appending(path: "api/v1/scan/feedback")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let payload = ScanFeedbackRequestPayload(
            scanID: scanID,
            selectedCardID: selectedCardID,
            wasTopPrediction: wasTopPrediction,
            correctionType: correctionType,
            submittedAt: Date()
        )

        do {
            request.httpBody = try encoder.encode(payload)
            _ = try await session.data(for: request)
        } catch {
            // Keep feedback best-effort so the scanner flow stays fast.
        }
    }

    private func makePayload(analysis: AnalyzedCapture, includeImage: Bool) -> ScanMatchRequestPayload {
        ScanMatchRequestPayload(
            scanID: analysis.scanID,
            capturedAt: Date(),
            clientContext: .current(),
            image: ScanImagePayload(
                jpegBase64: includeImage
                    ? analysis.normalizedImage.downscaledJPEGBase64(maxDimension: 960, compressionQuality: 0.72)
                    : nil,
                width: Int(analysis.normalizedImage.size.width.rounded()),
                height: Int(analysis.normalizedImage.size.height.rounded())
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
            directLookupLikely: analysis.directLookupLikely,
            resolverModeHint: analysis.resolverModeHint,
            cropConfidence: analysis.cropConfidence,
            warnings: analysis.warnings
        )
    }

    private func performMatch(payload: ScanMatchRequestPayload) async throws -> ScanMatchResponse {
        let endpoint = baseURL.appending(path: "api/v1/scan/match")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(payload)

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw MatcherError.invalidServerResponse
        }

        guard (200..<300).contains(httpResponse.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "The scan service is unavailable."
            throw MatcherError.server(message: message)
        }

        return try decoder.decode(ScanMatchResponse.self, from: data)
    }

    private func shouldRetryWithVisualFallback(_ response: ScanMatchResponse) -> Bool {
        // Only retry if not direct lookup, ignore confidence
        if response.resolverPath != .directLookup {
            return true
        }

        return false
    }

    private func detailQueryItems(for slabContext: SlabContext?) -> [URLQueryItem] {
        guard let slabContext else { return [] }
        var items = [URLQueryItem(name: "grader", value: slabContext.grader)]
        if let grade = slabContext.grade {
            items.append(URLQueryItem(name: "grade", value: grade))
        }
        return items
    }
}

final class HybridCardMatchingService: CardMatchingService, @unchecked Sendable {
    private let primary: CardMatchingService
    private let fallback: CardMatchingService

    init(primary: CardMatchingService, fallback: CardMatchingService) {
        self.primary = primary
        self.fallback = fallback
    }

    func match(analysis: AnalyzedCapture) async throws -> ScanMatchResponse {
        do {
            print("🌐 [HYBRID] Attempting primary (remote) backend match...")
            let result = try await primary.match(analysis: analysis)
            print("✅ [HYBRID] Primary backend succeeded")
            return result
        } catch {
            print("❌ [HYBRID] Primary backend failed: \(error.localizedDescription)")
            print("🔄 [HYBRID] Falling back to local matcher")
            return try await fallback.match(analysis: analysis)
        }
    }

    func search(query: String) async -> [CardCandidate] {
        let primaryResults = await primary.search(query: query)
        if !primaryResults.isEmpty {
            return primaryResults
        }

        return await fallback.search(query: query)
    }

    func fetchCardDetail(cardID: String, slabContext: SlabContext?) async -> CardDetail? {
        if let detail = await primary.fetchCardDetail(cardID: cardID, slabContext: slabContext) {
            return detail
        }

        return await fallback.fetchCardDetail(cardID: cardID, slabContext: slabContext)
    }

    func refreshCardDetail(cardID: String, slabContext: SlabContext?) async throws -> CardDetail? {
        do {
            if let detail = try await primary.refreshCardDetail(cardID: cardID, slabContext: slabContext) {
                return detail
            }
        } catch {
            return try await fallback.refreshCardDetail(cardID: cardID, slabContext: slabContext)
        }

        return try await fallback.refreshCardDetail(cardID: cardID, slabContext: slabContext)
    }

    func submitFeedback(
        scanID: UUID,
        selectedCardID: String?,
        wasTopPrediction: Bool,
        correctionType: CorrectionType
    ) async {
        await primary.submitFeedback(
            scanID: scanID,
            selectedCardID: selectedCardID,
            wasTopPrediction: wasTopPrediction,
            correctionType: correctionType
        )
    }
}

private struct InterimScore {
    let candidate: CardCandidate
    let imageScore: Double
    let collectorNumberScore: Double
    let nameScore: Double
    let finalScore: Double
}

private enum SamplePokemonCatalog {
    static let cards: [CardCandidate] = [
        CardCandidate(
            id: "pokemon-charizard-ex-223-197",
            name: "Charizard ex",
            setName: "Obsidian Flame",
            number: "223/197",
            rarity: "Hyper Rare",
            variant: "Raw",
            language: "English",
            pricing: samplePricing(
                low: 87.99,
                market: 114.95,
                mid: 129.95,
                high: 999.99,
                directLow: 127.06,
                updatedAt: "2026/04/03"
            )
        ),
        CardCandidate(
            id: "pokemon-charizard-ex-125-197",
            name: "Charizard ex",
            setName: "Obsidian Flame",
            number: "125/197",
            rarity: "Ultra Rare",
            variant: "Raw",
            language: "English",
            pricing: samplePricing(
                low: 3.00,
                market: 5.83,
                mid: 6.01,
                high: 99.00,
                directLow: 5.98,
                updatedAt: "2026/04/03"
            )
        ),
        CardCandidate(
            id: "pokemon-charizard-ex-svp-056",
            name: "Charizard ex",
            setName: "Scarlet & Violet Promo",
            number: "SVP 056",
            rarity: "Promo",
            variant: "Raw",
            language: "English",
            pricing: samplePricing(
                low: 11.20,
                market: 13.98,
                mid: 15.98,
                high: nil,
                directLow: 16.79,
                updatedAt: "2026/04/03"
            )
        ),
        CardCandidate(
            id: "pokemon-pikachu-svp-160",
            name: "Pikachu",
            setName: "Scarlet & Violet Promo",
            number: "SVP 160",
            rarity: "Promo",
            variant: "Raw",
            language: "English",
            pricing: nil
        ),
        CardCandidate(
            id: "pokemon-umbreon-vmax-tg23",
            name: "Umbreon VMAX",
            setName: "Brilliant Stars Trainer Gallery",
            number: "TG23/TG30",
            rarity: "Trainer Gallery",
            variant: "Raw",
            language: "English",
            pricing: samplePricing(
                low: 75.67,
                market: 90.09,
                mid: 109.60,
                high: 999.00,
                directLow: 114.99,
                updatedAt: "2026/04/03"
            )
        ),
        CardCandidate(
            id: "pokemon-mew-ex-205-165",
            name: "Mew ex",
            setName: "151",
            number: "205/165",
            rarity: "Ultra Rare",
            variant: "Raw",
            language: "English",
            pricing: nil
        ),
        CardCandidate(
            id: "pokemon-iono-254-193",
            name: "Iono",
            setName: "Paldea Evolved",
            number: "254/193",
            rarity: "Special Illustration Rare",
            variant: "Raw",
            language: "English",
            pricing: samplePricing(
                low: 9.00,
                market: 11.92,
                mid: 13.50,
                high: 112.50,
                directLow: 11.63,
                updatedAt: "2026/04/03"
            )
        ),
        CardCandidate(
            id: "pokemon-basic-lightning-energy-257-198",
            name: "Basic Lightning Energy",
            setName: "Scarlet & Violet",
            number: "257/198",
            rarity: "Hyper Rare",
            variant: "Raw",
            language: "English",
            pricing: samplePricing(
                low: 2.99,
                market: 4.56,
                mid: 4.99,
                high: 96.90,
                directLow: 5.99,
                updatedAt: "2026/04/03"
            )
        )
    ]

    private static func samplePricing(
        low: Double?,
        market: Double?,
        mid: Double?,
        high: Double?,
        directLow: Double?,
        updatedAt: String
    ) -> CardPricingSummary {
        CardPricingSummary(
            source: "tcgplayer",
            currencyCode: "USD",
            variant: "normal",
            low: low,
            market: market,
            mid: mid,
            high: high,
            directLow: directLow,
            trend: nil,
            updatedAt: updatedAt,
            refreshedAt: ISO8601DateFormatter().string(from: Date()),
            sourceURL: nil,
            pricingMode: "raw_cached",
            grader: nil,
            grade: nil,
            pricingTier: nil,
            confidenceLabel: nil,
            confidenceLevel: nil,
            compCount: nil,
            recentCompCount: nil,
            lastSoldPrice: nil,
            lastSoldAt: nil,
            bucketKey: nil,
            methodologySummary: "Built-in sample snapshot"
        )
    }
}

private extension UIImage {
    func downscaledJPEGBase64(maxDimension: CGFloat, compressionQuality: CGFloat) -> String? {
        let longestSide = max(size.width, size.height)
        let scale = min(1, maxDimension / max(longestSide, 1))
        let targetSize = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: targetSize)
        let resizedImage = renderer.image { _ in
            draw(in: CGRect(origin: .zero, size: targetSize))
        }
        return resizedImage.jpegData(compressionQuality: compressionQuality)?.base64EncodedString()
    }
}
