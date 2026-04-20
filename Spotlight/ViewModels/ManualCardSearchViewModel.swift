import Foundation

enum ManualCardSearchScope: String, CaseIterable, Identifiable, Sendable {
    case all
    case name
    case set
    case number

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all:
            return "All"
        case .name:
            return "Name"
        case .set:
            return "Set"
        case .number:
            return "Number"
        }
    }

    var queryPrefix: String? {
        switch self {
        case .all:
            return nil
        case .name:
            return "name"
        case .set:
            return "set"
        case .number:
            return "number"
        }
    }

    func structuredQuery(for query: String) -> String {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let queryPrefix else { return trimmed }
        return "\(queryPrefix):\(trimmed)"
    }
}

@MainActor
final class ManualCardSearchViewModel: ObservableObject {
    @Published var query: String = ""
    @Published private(set) var selectedScope: ManualCardSearchScope = .all
    @Published private(set) var results: [CardCandidate] = []
    @Published private(set) var isSearching = false
    @Published private(set) var errorMessage: String?

    private let resultLimit: Int
    private let search: @MainActor @Sendable (String, Int) async -> [CardCandidate]
    private var searchTask: Task<Void, Never>?

    init(
        resultLimit: Int = 20,
        search: @escaping @MainActor @Sendable (String, Int) async -> [CardCandidate]
    ) {
        self.resultLimit = max(1, min(resultLimit, 50))
        self.search = search
    }

    func updateQuery(_ newValue: String) {
        query = newValue
        scheduleSearch()
    }

    func selectScope(_ scope: ManualCardSearchScope) {
        guard selectedScope != scope else { return }
        selectedScope = scope
        scheduleSearch(immediate: true)
    }

    func submitCurrentQuery() {
        scheduleSearch(immediate: true)
    }

    func clearResults() {
        searchTask?.cancel()
        results = []
        isSearching = false
        errorMessage = nil
    }

    private func scheduleSearch(immediate: Bool = false) {
        searchTask?.cancel()

        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmedQuery.count >= 2 else {
            results = []
            isSearching = false
            errorMessage = nil
            return
        }

        isSearching = true
        errorMessage = nil

        let resultLimit = self.resultLimit
        let search = self.search
        let scope = selectedScope
        let structuredQuery = scope.structuredQuery(for: trimmedQuery)
        searchTask = Task { [structuredQuery, trimmedQuery, immediate, scope] in
            if !immediate {
                try? await Task.sleep(for: .milliseconds(275))
            }
            guard !Task.isCancelled else { return }

            let results = await search(structuredQuery, resultLimit)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self.results = Self.filteredResults(results, query: trimmedQuery, scope: scope)
                self.isSearching = false
                self.errorMessage = nil
            }
        }
    }

    private static func filteredResults(
        _ results: [CardCandidate],
        query: String,
        scope: ManualCardSearchScope
    ) -> [CardCandidate] {
        guard scope != .all else { return results }

        let normalizedQuery = normalizedSearchText(query)
        guard !normalizedQuery.isEmpty else { return results }

        return results.filter { candidate in
            switch scope {
            case .all:
                return true
            case .name:
                return normalizedSearchText(candidate.name).contains(normalizedQuery)
            case .set:
                return normalizedSearchText(candidate.setName).contains(normalizedQuery)
            case .number:
                return normalizedNumberText(candidate.number).contains(normalizedNumberText(query))
            }
        }
    }

    private static func normalizedSearchText(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    private static func normalizedNumberText(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "#", with: "")
            .replacingOccurrences(of: " ", with: "")
    }
}
