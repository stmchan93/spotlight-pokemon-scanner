import Foundation
import UIKit

protocol CardMatchingService: Sendable {
    func match(analysis: AnalyzedCapture) async throws -> ScanMatchResponse
    func search(query: String) async -> [CardCandidate]
    func fetchCardDetail(cardID: String, slabContext: SlabContext?) async -> CardDetail?
    func refreshCardDetail(cardID: String, slabContext: SlabContext?, forceRefresh: Bool) async throws -> CardDetail?
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
    private static let slabMatchingFeatureFlagEnvKey = "SPOTLIGHT_ENABLE_SLAB_MATCHING"
    private static let slabMatchingDisabledReason = "Slab backend matching is disabled by feature flag."

    private let baseURL: URL
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let slabMatchRequestsEnabled: Bool

    init(baseURL: URL, session: URLSession? = nil, slabMatchRequestsEnabled: Bool? = nil) {
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
        self.slabMatchRequestsEnabled = slabMatchRequestsEnabled
            ?? Self.boolEnv(Self.slabMatchingFeatureFlagEnvKey)
            ?? false
    }

    func primeLocalNetworkPermissionIfNeeded() async {
        guard baseURL.requiresLocalNetworkPermissionPrompt else {
            return
        }

        let endpoint = baseURL.appending(path: "api/v1/health")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "GET"
        request.timeoutInterval = 1.5
        request.cachePolicy = .reloadIgnoringLocalCacheData

        print("🌐 [APP] Priming local backend connection for local-network permission")

        do {
            let (_, response) = try await session.data(for: request)
            if let httpResponse = response as? HTTPURLResponse {
                print("✅ [APP] Local backend warmup completed (\(httpResponse.statusCode))")
            } else {
                print("✅ [APP] Local backend warmup completed")
            }
        } catch {
            print("⚠️ [APP] Local backend warmup failed: \(error.localizedDescription)")
        }
    }

    func match(analysis: AnalyzedCapture) async throws -> ScanMatchResponse {
        let payload = makePayload(analysis: analysis)
        if payload.resolverModeHint == .psaSlab, !slabMatchRequestsEnabled {
            print("⚠️ [MATCH] Skipping slab POST /api/v1/scan/match because slab matching is feature-flagged off")
            return slabMatchingDisabledResponse(for: payload)
        }

        return try await performMatch(payload: payload)
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

    private func makePayload(analysis: AnalyzedCapture) -> ScanMatchRequestPayload {
        ScanMatchRequestPayload(
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
            cropConfidence: analysis.cropConfidence,
            warnings: analysis.warnings,
            ocrAnalysis: analysis.ocrAnalysis
        )
    }

    private func slabMatchingDisabledResponse(for payload: ScanMatchRequestPayload) -> ScanMatchResponse {
        let slabContext = payload.slabGrader.map {
            SlabContext(
                grader: $0,
                grade: payload.slabGrade,
                certNumber: payload.slabCertNumber,
                variantName: nil
            )
        }
        return ScanMatchResponse(
            scanID: payload.scanID,
            topCandidates: [],
            confidence: .low,
            ambiguityFlags: ["slab_backend_match_disabled"],
            matcherSource: .remoteHybrid,
            matcherVersion: "frontend_slab_feature_flag_disabled",
            resolverMode: payload.resolverModeHint,
            resolverPath: nil,
            slabContext: slabContext,
            reviewDisposition: .unsupported,
            reviewReason: Self.slabMatchingDisabledReason
        )
    }

    private func performMatch(payload: ScanMatchRequestPayload) async throws -> ScanMatchResponse {
        let endpoint = baseURL.appending(path: "api/v1/scan/match")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(payload)

        print(
            "🌐 [MATCH] POST \(endpoint.path): "
            + "scanID=\(payload.scanID.uuidString) "
            + "mode=\(payload.resolverModeHint.rawValue) "
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

        let decoded = try decoder.decode(ScanMatchResponse.self, from: data)
        print(
            "🌐 [MATCH] Decoded response: "
            + "scanID=\(decoded.scanID.uuidString) "
            + "confidence=\(decoded.confidence.rawValue) "
            + "resolverPath=\(decoded.resolverPath?.rawValue ?? "n/a") "
            + "review=\(decoded.reviewDisposition?.rawValue ?? "n/a") "
            + "topCount=\(decoded.topCandidates.count)"
        )
        return decoded
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

    private static func boolEnv(_ key: String, processInfo: ProcessInfo = .processInfo) -> Bool? {
        guard let value = processInfo.environment[key] else {
            return nil
        }

        switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "1", "true", "yes", "on":
            return true
        case "0", "false", "no", "off":
            return false
        default:
            return nil
        }
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
