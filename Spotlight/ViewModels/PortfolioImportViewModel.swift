import Foundation

@MainActor
final class PortfolioImportViewModel: ObservableObject {
    @Published private(set) var job: PortfolioImportJobPayload?
    @Published private(set) var isLoadingPreview = false
    @Published private(set) var isRefreshing = false
    @Published private(set) var isResolving = false
    @Published private(set) var isCommitting = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var bannerMessage: String?
    @Published var selectedFilter: PortfolioImportRowFilter = .all

    let selectedFile: PortfolioImportSelectedFile

    private let previewRequest: @Sendable (PortfolioImportPreviewRequestPayload) async throws -> PortfolioImportJobPayload
    private let fetchJobRequest: @Sendable (String) async throws -> PortfolioImportJobPayload
    private let resolveRowRequest: @Sendable (String, PortfolioImportResolveRequestPayload) async throws -> PortfolioImportJobPayload
    private let commitJobRequest: @Sendable (String) async throws -> PortfolioImportCommitResponsePayload
    private let refreshCollection: @MainActor @Sendable () async -> Void
    private let searchCatalog: @MainActor @Sendable (String, Int) async -> [CardCandidate]
    private var hasLoaded = false

    init(
        selectedFile: PortfolioImportSelectedFile,
        previewRequest: @escaping @Sendable (PortfolioImportPreviewRequestPayload) async throws -> PortfolioImportJobPayload,
        fetchJobRequest: @escaping @Sendable (String) async throws -> PortfolioImportJobPayload,
        resolveRowRequest: @escaping @Sendable (String, PortfolioImportResolveRequestPayload) async throws -> PortfolioImportJobPayload,
        commitJobRequest: @escaping @Sendable (String) async throws -> PortfolioImportCommitResponsePayload,
        refreshCollection: @escaping @MainActor @Sendable () async -> Void,
        searchCatalog: @escaping @MainActor @Sendable (String, Int) async -> [CardCandidate]
    ) {
        self.selectedFile = selectedFile
        self.previewRequest = previewRequest
        self.fetchJobRequest = fetchJobRequest
        self.resolveRowRequest = resolveRowRequest
        self.commitJobRequest = commitJobRequest
        self.refreshCollection = refreshCollection
        self.searchCatalog = searchCatalog
    }

    var sourceType: PortfolioImportSourceType {
        job?.sourceType ?? selectedFile.sourceType
    }

    var sourceFileName: String {
        let trimmed = job?.sourceFileName.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? selectedFile.fileName : trimmed
    }

    var status: PortfolioImportJobStatus {
        job?.status ?? .previewing
    }

    var summary: PortfolioImportSummaryPayload {
        job?.summary ?? .empty
    }

    var filteredRows: [PortfolioImportRowPayload] {
        rows(for: selectedFilter)
    }

    var readyRowCount: Int {
        let summaryCount = summary.readyToCommitCount
        if summaryCount > 0 {
            return summaryCount
        }
        return job?.rows.filter { $0.matchState.isReadyToCommit }.count ?? 0
    }

    var hasRows: Bool {
        !(job?.rows.isEmpty ?? true)
    }

    var canCommit: Bool {
        readyRowCount > 0 && !isCommitting
    }

    func loadIfNeeded() async {
        guard !hasLoaded else { return }
        hasLoaded = true
        await previewImport()
    }

    func retryPreview() async {
        hasLoaded = false
        bannerMessage = nil
        job = nil
        await loadIfNeeded()
    }

    func refresh() async {
        guard let jobID = job?.id else {
            await retryPreview()
            return
        }

        isRefreshing = true
        defer { isRefreshing = false }

        do {
            let refreshedJob = try await fetchJobRequest(jobID)
            apply(job: refreshedJob, preserveFilter: true)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func searchCatalogCards(query: String, limit: Int) async -> [CardCandidate] {
        await searchCatalog(query, limit)
    }

    func resolve(row: PortfolioImportRowPayload, with candidate: CardCandidate) async -> Bool {
        guard let jobID = job?.id else { return false }
        isResolving = true
        defer { isResolving = false }

        do {
            let updatedJob = try await resolveRowRequest(
                jobID,
                PortfolioImportResolveRequestPayload(
                    rowID: row.id,
                    action: .match,
                    matchedCardID: candidate.id
                )
            )
            bannerMessage = "Matched row \(max(1, row.rowIndex)) to \(candidate.name)."
            apply(job: updatedJob, preserveFilter: true)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func skip(row: PortfolioImportRowPayload) async -> Bool {
        guard let jobID = job?.id else { return false }
        isResolving = true
        defer { isResolving = false }

        do {
            let updatedJob = try await resolveRowRequest(
                jobID,
                PortfolioImportResolveRequestPayload(
                    rowID: row.id,
                    action: .skip
                )
            )
            bannerMessage = "Skipped row \(max(1, row.rowIndex))."
            apply(job: updatedJob, preserveFilter: true)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func commitReadyRows() async -> Bool {
        guard let jobID = job?.id else { return false }
        isCommitting = true
        defer { isCommitting = false }

        do {
            let response = try await commitJobRequest(jobID)
            if let updatedJob = response.job {
                apply(job: updatedJob, preserveFilter: false)
            } else {
                do {
                    let refreshedJob = try await fetchJobRequest(jobID)
                    apply(job: refreshedJob, preserveFilter: false)
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
            await refreshCollection()
            bannerMessage = response.message ?? "Imported \(max(0, response.summary.committedCount)) row\(response.summary.committedCount == 1 ? "" : "s")."
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func filterCount(_ filter: PortfolioImportRowFilter) -> Int {
        switch filter {
        case .all:
            return summary.totalRowCount > 0 ? summary.totalRowCount : (job?.rows.count ?? 0)
        case .ready:
            return readyRowCount
        case .review:
            return summary.reviewCount
        case .unresolved:
            return summary.unresolvedCount
        case .unsupported:
            return summary.unsupportedCount
        case .committed:
            return summary.committedCount
        }
    }

    func rows(for filter: PortfolioImportRowFilter) -> [PortfolioImportRowPayload] {
        let rows = job?.rows ?? []
        switch filter {
        case .all:
            return rows
        case .ready:
            return rows.filter { $0.matchState.isReadyToCommit }
        case .review:
            return rows.filter { $0.matchState == .review }
        case .unresolved:
            return rows.filter { $0.matchState == .unresolved || $0.matchState == .failed || $0.matchState == .unknown }
        case .unsupported:
            return rows.filter { $0.matchState == .unsupported || $0.matchState == .skipped }
        case .committed:
            return rows.filter { $0.matchState == .committed }
        }
    }

    private func previewImport() async {
        isLoadingPreview = true
        errorMessage = nil
        defer { isLoadingPreview = false }

        do {
            let previewJob = try await previewRequest(
                PortfolioImportPreviewRequestPayload(
                    sourceType: selectedFile.sourceType,
                    fileName: selectedFile.fileName,
                    csvText: selectedFile.csvText
                )
            )
            apply(job: previewJob, preserveFilter: false)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func apply(job: PortfolioImportJobPayload, preserveFilter: Bool) {
        self.job = job
        errorMessage = nil

        let nextFilter: PortfolioImportRowFilter
        if preserveFilter, !rows(for: selectedFilter).isEmpty {
            nextFilter = selectedFilter
        } else {
            nextFilter = Self.defaultFilter(for: job)
        }
        selectedFilter = nextFilter
    }

    private static func defaultFilter(for job: PortfolioImportJobPayload) -> PortfolioImportRowFilter {
        if job.summary.reviewCount > 0 {
            return .review
        }
        if job.summary.unresolvedCount > 0 {
            return .unresolved
        }
        if job.summary.readyToCommitCount > 0 {
            return .ready
        }
        if job.summary.unsupportedCount > 0 {
            return .unsupported
        }
        if job.summary.committedCount > 0 {
            return .committed
        }
        return .all
    }
}
