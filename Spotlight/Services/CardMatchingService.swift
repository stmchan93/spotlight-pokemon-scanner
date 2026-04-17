import Foundation
import UIKit

protocol CardMatchingService: Sendable {
    func match(analysis: AnalyzedCapture) async throws -> ScanMatchResponse
    func matchVisualStart(payload: ScanVisualStartRequestPayload) async throws -> ScanMatchResponse
    func matchRerank(payload: ScanRerankRequestPayload) async throws -> ScanMatchResponse
    func search(query: String) async -> [CardCandidate]
    func fetchCardDetail(cardID: String, slabContext: SlabContext?) async -> CardDetail?
    func fetchCardMarketHistory(cardID: String, slabContext: SlabContext?, days: Int, variant: String?, condition: String?) async -> CardMarketHistory?
    func fetchGradedCardComps(cardID: String, slabContext: SlabContext?, selectedGrade: String?) async -> GradedCardComps?
    func fetchPortfolioHistory(range: PortfolioHistoryRange) async -> PortfolioHistory?
    func fetchPortfolioLedger(range: PortfolioHistoryRange) async -> PortfolioLedger?
    func refreshCardDetail(cardID: String, slabContext: SlabContext?, forceRefresh: Bool) async throws -> CardDetail?
    func hydrateCandidatePricing(cardIDs: [String], maxRefreshCount: Int, slabContext: SlabContext?) async -> [CardDetail]
    func fetchDeckEntries() async -> [DeckEntryPayload]?
    func updateDeckEntryCondition(_ payload: DeckEntryConditionUpdateRequestPayload) async throws
    func updateDeckEntryPurchasePrice(_ payload: DeckEntryPurchasePriceUpdateRequestPayload) async throws
    func updatePortfolioBuyPrice(transactionID: String, payload: PortfolioTransactionPriceUpdateRequestPayload) async throws
    func updatePortfolioSalePrice(transactionID: String, payload: PortfolioTransactionPriceUpdateRequestPayload) async throws
    func uploadScanArtifacts(_ payload: ScanArtifactUploadRequestPayload) async throws
    func addDeckEntry(_ payload: DeckEntryCreateRequestPayload) async throws
    func createPortfolioBuy(_ payload: PortfolioBuyCreateRequestPayload) async throws -> PortfolioBuyCreateResponsePayload
    func createPortfolioSale(_ payload: PortfolioSaleCreateRequestPayload) async throws -> PortfolioSaleCreateResponsePayload
    func submitFeedback(
        scanID: UUID,
        selectedCardID: String?,
        wasTopPrediction: Bool,
        correctionType: CorrectionType
    ) async
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

    func primeLocalNetworkPermissionIfNeeded() async -> Bool {
        guard baseURL.requiresLocalNetworkPermissionPrompt else {
            return true
        }

        var components = URLComponents(url: baseURL.appending(path: "api/v1/health"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "prewarm", value: "visual")]
        let endpoint = components?.url ?? baseURL.appending(path: "api/v1/health")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "GET"
        request.timeoutInterval = 5.0
        request.cachePolicy = .reloadIgnoringLocalCacheData

        print("🌐 [APP] Priming local backend connection for local-network permission")

        do {
            let (_, response) = try await session.data(for: request)
            if let httpResponse = response as? HTTPURLResponse {
                print("✅ [APP] Local backend warmup completed (\(httpResponse.statusCode))")
            } else {
                print("✅ [APP] Local backend warmup completed")
            }
            return true
        } catch {
            print("⚠️ [APP] Local backend warmup failed: \(error.localizedDescription)")
            return false
        }
    }

    func match(analysis: AnalyzedCapture) async throws -> ScanMatchResponse {
        let payload = makeFullPayload(payload: makeRerankPayload(analysis: analysis))
        return try await performMatch(
            payload: payload,
            endpointPath: "api/v1/scan/match",
            stage: "one_shot"
        )
    }

    func matchVisualStart(payload: ScanVisualStartRequestPayload) async throws -> ScanMatchResponse {
        let fullPayload = makeFullPayload(payload: payload)
        return try await performMatch(
            payload: fullPayload,
            endpointPath: "api/v1/scan/visual-match",
            stage: "visual_start"
        )
    }

    func matchRerank(payload: ScanRerankRequestPayload) async throws -> ScanMatchResponse {
        let fullPayload = makeFullPayload(payload: payload)
        return try await performMatch(
            payload: fullPayload,
            endpointPath: "api/v1/scan/rerank",
            stage: "rerank"
        )
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
        if let detail = await fetchCardDetailFromServer(cardID: cardID, slabContext: slabContext) {
            return detail
        }

        guard await importCatalogCard(cardID: cardID) else {
            return nil
        }

        return await fetchCardDetailFromServer(cardID: cardID, slabContext: slabContext)
    }

    func fetchCardMarketHistory(
        cardID: String,
        slabContext: SlabContext?,
        days: Int,
        variant: String?,
        condition: String?
    ) async -> CardMarketHistory? {
        guard var components = URLComponents(
            url: baseURL.appending(path: "api/v1/cards/\(cardID)/market-history"),
            resolvingAgainstBaseURL: false
        ) else {
            return nil
        }
        var queryItems = detailQueryItems(for: slabContext)
        queryItems.append(URLQueryItem(name: "days", value: String(max(7, min(days, 90)))))
        if let variant, !variant.isEmpty {
            queryItems.append(URLQueryItem(name: "variant", value: variant))
        }
        if let condition, !condition.isEmpty {
            queryItems.append(URLQueryItem(name: "condition", value: condition))
        }
        components.queryItems = queryItems
        guard let endpoint = components.url else { return nil }

        do {
            let (data, response) = try await session.data(from: endpoint)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return nil
            }
            return try decoder.decode(CardMarketHistory.self, from: data)
        } catch {
            return nil
        }
    }

    func fetchGradedCardComps(
        cardID: String,
        slabContext: SlabContext?,
        selectedGrade: String?
    ) async -> GradedCardComps? {
        guard !cardID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }

        let endpointPaths = [
            "api/v1/cards/\(cardID)/ebay-listings",
            "api/v1/cards/\(cardID)/graded-comps",
            "api/v1/cards/\(cardID)/ebay-comps",
            "api/v1/cards/\(cardID)/comps"
        ]

        for path in endpointPaths {
            if let payload = await fetchGradedCardCompsFromServer(
                path: path,
                slabContext: slabContext,
                selectedGrade: selectedGrade
            ) {
                return payload
            }
        }

        guard await importCatalogCard(cardID: cardID) else {
            return nil
        }

        for path in endpointPaths {
            if let payload = await fetchGradedCardCompsFromServer(
                path: path,
                slabContext: slabContext,
                selectedGrade: selectedGrade
            ) {
                return payload
            }
        }

        return nil
    }

    func fetchPortfolioHistory(range: PortfolioHistoryRange) async -> PortfolioHistory? {
        guard var components = URLComponents(
            url: baseURL.appending(path: "api/v1/portfolio/history"),
            resolvingAgainstBaseURL: false
        ) else {
            return nil
        }
        components.queryItems = [
            URLQueryItem(name: "range", value: range.rawValue),
            URLQueryItem(name: "timeZone", value: TimeZone.current.identifier),
        ]
        guard let endpoint = components.url else { return nil }

        do {
            let (data, response) = try await session.data(from: endpoint)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return nil
            }
            return try decoder.decode(PortfolioHistory.self, from: data)
        } catch {
            return nil
        }
    }

    func fetchPortfolioLedger(range: PortfolioHistoryRange) async -> PortfolioLedger? {
        guard var components = URLComponents(
            url: baseURL.appending(path: "api/v1/portfolio/ledger"),
            resolvingAgainstBaseURL: false
        ) else {
            return nil
        }
        components.queryItems = [
            URLQueryItem(name: "range", value: range.rawValue),
            URLQueryItem(name: "timeZone", value: TimeZone.current.identifier),
        ]
        guard let endpoint = components.url else { return nil }

        do {
            let (data, response) = try await session.data(from: endpoint)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return nil
            }
            return try decoder.decode(PortfolioLedger.self, from: data)
        } catch {
            return nil
        }
    }

    func refreshCardDetail(cardID: String, slabContext: SlabContext?, forceRefresh: Bool) async throws -> CardDetail? {
        if let refreshedDetail = try await refreshCardDetailFromServer(
            cardID: cardID,
            slabContext: slabContext,
            forceRefresh: forceRefresh
        ) {
            return refreshedDetail
        }

        return await fetchCardDetailFromServer(cardID: cardID, slabContext: slabContext)
    }

    func hydrateCandidatePricing(cardIDs: [String], maxRefreshCount: Int, slabContext: SlabContext?) async -> [CardDetail] {
        let normalizedCardIDs = Array(
            NSOrderedSet(array: cardIDs.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) })
        )
            .compactMap { $0 as? String }
            .filter { !$0.isEmpty }
        guard !normalizedCardIDs.isEmpty else { return [] }

        let endpoint = baseURL.appending(path: "api/v1/cards/hydrate-pricing")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        do {
            request.httpBody = try encoder.encode(
                CandidatePricingHydrationRequestPayload(
                    cardIDs: normalizedCardIDs,
                    maxRefreshCount: max(0, maxRefreshCount),
                    forceRefresh: false,
                    slabContext: slabContext
                )
            )
            let (data, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return []
            }

            return try decoder.decode(CandidatePricingHydrationResponsePayload.self, from: data).cards
        } catch {
            return []
        }
    }

    func fetchDeckEntries() async -> [DeckEntryPayload]? {
        let endpoint = baseURL.appending(path: "api/v1/deck/entries")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData

        do {
            let (data, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return nil
            }

            if let wrapper = try? decoder.decode(DeckEntriesResponsePayload.self, from: data) {
                return wrapper.entries
            }

            return try? decoder.decode([DeckEntryPayload].self, from: data)
        } catch {
            return nil
        }
    }

    func updateDeckEntryCondition(_ payload: DeckEntryConditionUpdateRequestPayload) async throws {
        let endpoint = baseURL.appending(path: "api/v1/deck/entries/condition")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(payload)

        let (_, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            throw MatcherError.server(message: "Deck condition update failed.")
        }
    }

    func updateDeckEntryPurchasePrice(_ payload: DeckEntryPurchasePriceUpdateRequestPayload) async throws {
        let endpoint = baseURL.appending(path: "api/v1/deck/entries/purchase-price")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(payload)

        let (_, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            throw MatcherError.server(message: "Deck purchase price update failed.")
        }
    }

    func updatePortfolioBuyPrice(transactionID: String, payload: PortfolioTransactionPriceUpdateRequestPayload) async throws {
        let encodedID = transactionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? transactionID
        let endpoint = baseURL.appending(path: "api/v1/portfolio/buys/\(encodedID)/price")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(payload)

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            throw MatcherError.server(message: serverErrorMessage(from: data, fallback: "Buy price update failed."))
        }
    }

    func updatePortfolioSalePrice(transactionID: String, payload: PortfolioTransactionPriceUpdateRequestPayload) async throws {
        let encodedID = transactionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? transactionID
        let endpoint = baseURL.appending(path: "api/v1/portfolio/sales/\(encodedID)/price")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(payload)

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            throw MatcherError.server(message: serverErrorMessage(from: data, fallback: "Sale price update failed."))
        }
    }

    private func fetchCardDetailFromServer(cardID: String, slabContext: SlabContext?) async -> CardDetail? {
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

    private func fetchGradedCardCompsFromServer(
        path: String,
        slabContext: SlabContext?,
        selectedGrade: String?
    ) async -> GradedCardComps? {
        guard let endpoint = gradedCompsEndpointURL(
            path: path,
            slabContext: slabContext,
            selectedGrade: selectedGrade
        ) else {
            return nil
        }

        do {
            let (data, response) = try await session.data(from: endpoint)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                return nil
            }

            return try decoder.decode(GradedCardComps.self, from: data)
        } catch {
            return nil
        }
    }

    func gradedCompsEndpointURL(
        path: String,
        slabContext: SlabContext?,
        selectedGrade: String?
    ) -> URL? {
        guard var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.queryItems = gradedCompsQueryItems(for: slabContext, selectedGrade: selectedGrade)
        return components.url
    }

    private func refreshCardDetailFromServer(
        cardID: String,
        slabContext: SlabContext?,
        forceRefresh: Bool
    ) async throws -> CardDetail? {
        guard var components = URLComponents(url: baseURL.appending(path: "api/v1/cards/\(cardID)/refresh-pricing"), resolvingAgainstBaseURL: false) else {
            throw MatcherError.invalidServerResponse
        }
        components.queryItems = detailQueryItems(for: slabContext, forceRefresh: forceRefresh)
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

        if httpResponse.statusCode == 404 {
            return nil
        }

        guard (200..<300).contains(httpResponse.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "Pricing refresh failed."
            throw MatcherError.server(message: message)
        }

        return try decoder.decode(CardDetail.self, from: data)
    }

    private func importCatalogCard(cardID: String) async -> Bool {
        let endpoint = baseURL.appending(path: "api/v1/catalog/import-card")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        struct ImportCardPayload: Codable {
            let cardID: String
        }

        do {
            request.httpBody = try encoder.encode(ImportCardPayload(cardID: cardID))
            let (_, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return false
            }
            return (200..<300).contains(httpResponse.statusCode)
        } catch {
            return false
        }
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

    func uploadScanArtifacts(_ payload: ScanArtifactUploadRequestPayload) async throws {
        let endpoint = baseURL.appending(path: "api/v1/scan-artifacts")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(payload)

        let (_, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            throw MatcherError.server(message: "Artifact upload failed.")
        }
    }

    func addDeckEntry(_ payload: DeckEntryCreateRequestPayload) async throws {
        let endpoint = baseURL.appending(path: "api/v1/deck/entries")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(payload)

        let (_, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            throw MatcherError.server(message: "Deck entry submission failed.")
        }
    }

    func createPortfolioSale(_ payload: PortfolioSaleCreateRequestPayload) async throws -> PortfolioSaleCreateResponsePayload {
        let endpoint = baseURL.appending(path: "api/v1/portfolio/sales")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(payload)

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "Sale submission failed."
            throw MatcherError.server(message: message)
        }
        return try decoder.decode(PortfolioSaleCreateResponsePayload.self, from: data)
    }

    func createPortfolioBuy(_ payload: PortfolioBuyCreateRequestPayload) async throws -> PortfolioBuyCreateResponsePayload {
        let endpoint = baseURL.appending(path: "api/v1/portfolio/buys")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(payload)

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "Buy submission failed."
            throw MatcherError.server(message: message)
        }
        return try decoder.decode(PortfolioBuyCreateResponsePayload.self, from: data)
    }

    private func makeRerankPayload(analysis: AnalyzedCapture) -> ScanRerankRequestPayload {
        ScanRerankRequestPayload(
            scanID: analysis.scanID,
            capturedAt: Date(),
            clientContext: .current(),
            image: ScanImagePayload(
                jpegBase64: analysis.normalizedImage.downscaledJPEGBase64(maxDimension: 960, compressionQuality: 0.72),
                width: Int(analysis.normalizedImage.size.width.rounded()),
                height: Int(analysis.normalizedImage.size.height.rounded())
            ),
            recognizedTokens: analysis.recognizedTokens,
            collectorNumber: analysis.collectorNumber,
            setHintTokens: analysis.setHintTokens,
            setBadgeHint: analysis.setBadgeHint,
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
            resolverModeHint: analysis.resolverModeHint,
            rawResolverMode: analysis.resolverModeHint.runtimeRawResolverMode,
            cropConfidence: analysis.cropConfidence,
            warnings: analysis.warnings,
            ocrAnalysis: analysis.ocrAnalysis
        )
    }

    private func makeFullPayload(payload: ScanVisualStartRequestPayload) -> ScanMatchRequestPayload {
        ScanMatchRequestPayload(
            scanID: payload.scanID,
            capturedAt: payload.capturedAt,
            clientContext: payload.clientContext,
            image: payload.image,
            recognizedTokens: [],
            collectorNumber: nil,
            setHintTokens: [],
            setBadgeHint: nil,
            promoCodeHint: nil,
            slabGrader: nil,
            slabGrade: nil,
            slabCertNumber: nil,
            slabBarcodePayloads: [],
            slabGraderConfidence: nil,
            slabGradeConfidence: nil,
            slabCertConfidence: nil,
            slabCardNumberRaw: nil,
            slabParsedLabelText: [],
            slabClassifierReasons: [],
            slabRecommendedLookupPath: nil,
            resolverModeHint: payload.resolverModeHint,
            rawResolverMode: payload.rawResolverMode,
            cropConfidence: payload.cropConfidence,
            warnings: payload.warnings,
            ocrAnalysis: nil
        )
    }

    private func makeFullPayload(payload: ScanRerankRequestPayload) -> ScanMatchRequestPayload {
        ScanMatchRequestPayload(
            scanID: payload.scanID,
            capturedAt: payload.capturedAt,
            clientContext: payload.clientContext,
            image: payload.image,
            recognizedTokens: payload.recognizedTokens,
            collectorNumber: payload.collectorNumber,
            setHintTokens: payload.setHintTokens,
            setBadgeHint: payload.setBadgeHint,
            promoCodeHint: payload.promoCodeHint,
            slabGrader: payload.slabGrader,
            slabGrade: payload.slabGrade,
            slabCertNumber: payload.slabCertNumber,
            slabBarcodePayloads: payload.slabBarcodePayloads,
            slabGraderConfidence: payload.slabGraderConfidence,
            slabGradeConfidence: payload.slabGradeConfidence,
            slabCertConfidence: payload.slabCertConfidence,
            slabCardNumberRaw: payload.slabCardNumberRaw,
            slabParsedLabelText: payload.slabParsedLabelText,
            slabClassifierReasons: payload.slabClassifierReasons,
            slabRecommendedLookupPath: payload.slabRecommendedLookupPath,
            resolverModeHint: payload.resolverModeHint,
            rawResolverMode: payload.rawResolverMode,
            cropConfidence: payload.cropConfidence,
            warnings: payload.warnings,
            ocrAnalysis: payload.ocrAnalysis
        )
    }

    private func performMatch(
        payload: ScanMatchRequestPayload,
        endpointPath: String,
        stage: String
    ) async throws -> ScanMatchResponse {
        let endpoint = baseURL.appending(path: endpointPath)
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(payload)

        print(
            "🌐 [MATCH] POST \(endpoint.path): "
            + "stage=\(stage) "
            + "scanID=\(payload.scanID.uuidString) "
            + "mode=\(payload.resolverModeHint.rawValue) "
            + "rawResolver=\(payload.rawResolverMode?.rawValue ?? "n/a") "
            + "pipeline=\(payload.ocrAnalysis?.pipelineVersion.rawValue ?? "none") "
            + "collector=\(payload.collectorNumber ?? "<none>") "
            + "setHints=\(payload.setHintTokens) "
            + "tokens=\(payload.recognizedTokens.count) "
            + "image=\(payload.image.width)x\(payload.image.height)"
        )

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw MatcherError.invalidServerResponse
        }

        guard (200..<300).contains(httpResponse.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "The scan service is unavailable."
            print(
                "❌ [MATCH] Non-2xx response: "
                + "status=\(httpResponse.statusCode) "
                + "scanID=\(payload.scanID.uuidString) "
                + "body=\(message.prefix(400))"
            )
            throw MatcherError.server(message: message)
        }

        let decoded: ScanMatchResponse
        do {
            decoded = try decoder.decode(ScanMatchResponse.self, from: data)
        } catch {
            let body = String(data: data, encoding: .utf8) ?? "<non-utf8>"
            print(
                "❌ [MATCH] Decode failed: "
                + "stage=\(stage) "
                + "scanID=\(payload.scanID.uuidString) "
                + "error=\(error.localizedDescription) "
                + "body=\(body.prefix(1200))"
            )
            throw error
        }
        print(
            "🌐 [MATCH] Decoded response: "
            + "stage=\(stage) "
            + "scanID=\(decoded.scanID.uuidString) "
            + "confidence=\(decoded.confidence.rawValue) "
            + "resolverPath=\(decoded.resolverPath?.rawValue ?? "n/a") "
            + "review=\(decoded.reviewDisposition?.rawValue ?? "n/a") "
            + "topCount=\(decoded.topCandidates.count)"
        )
        return decoded
    }

    private func serverErrorMessage(from data: Data, fallback: String) -> String {
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let error = object["error"] as? String {
            let trimmed = error.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed
            }
        }

        if let message = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !message.isEmpty {
            return message
        }

        return fallback
    }

    private func detailQueryItems(for slabContext: SlabContext?, forceRefresh: Bool = false) -> [URLQueryItem] {
        var items: [URLQueryItem] = []
        if let slabContext {
            items.append(URLQueryItem(name: "grader", value: slabContext.grader))
            if let grade = slabContext.grade {
                items.append(URLQueryItem(name: "grade", value: grade))
            }
            if let certNumber = slabContext.certNumber, !certNumber.isEmpty {
                items.append(URLQueryItem(name: "cert", value: certNumber))
            }
            if let variantName = slabContext.variantName, !variantName.isEmpty {
                items.append(URLQueryItem(name: "variant", value: variantName))
            }
        }
        if forceRefresh {
            items.append(URLQueryItem(name: "forceRefresh", value: "1"))
        }
        return items
    }

    private func gradedCompsQueryItems(for slabContext: SlabContext?, selectedGrade: String?) -> [URLQueryItem] {
        var items = detailQueryItems(for: slabContext)
        if let selectedGrade = selectedGrade?.trimmingCharacters(in: .whitespacesAndNewlines), !selectedGrade.isEmpty {
            items.removeAll { $0.name == "grade" }
            items.append(URLQueryItem(name: "grade", value: selectedGrade))
        }
        return items
    }

}

private extension URL {
    var requiresLocalNetworkPermissionPrompt: Bool {
        guard let host else { return false }
        let lowercasedHost = host.lowercased()

        if lowercasedHost == "localhost" || lowercasedHost == "127.0.0.1" {
            return false
        }

        if lowercasedHost.hasSuffix(".local") {
            return true
        }

        let octets = lowercasedHost.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4 else { return false }

        if octets[0] == 10 {
            return true
        }

        if octets[0] == 192, octets[1] == 168 {
            return true
        }

        if octets[0] == 172, (16...31).contains(octets[1]) {
            return true
        }

        return false
    }
}

extension UIImage {
    func downscaledJPEGPayload(maxDimension: CGFloat, compressionQuality: CGFloat) -> ScanImagePayload? {
        let longestSide = max(size.width, size.height)
        let scale = min(1, maxDimension / max(longestSide, 1))
        let targetSize = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: targetSize)
        let resizedImage = renderer.image { _ in
            draw(in: CGRect(origin: .zero, size: targetSize))
        }
        guard let data = resizedImage.jpegData(compressionQuality: compressionQuality) else {
            return nil
        }
        return ScanImagePayload(
            jpegBase64: data.base64EncodedString(),
            width: Int(targetSize.width.rounded()),
            height: Int(targetSize.height.rounded())
        )
    }

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
