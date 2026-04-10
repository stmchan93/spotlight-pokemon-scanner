import Foundation

enum LiveScanStackItemPhase: String, Codable, Hashable, Sendable {
    case pending
    case needsReview
    case unsupported
    case resolved
    case failed
}

struct ScanTrayMetricInput: Equatable, Sendable {
    let phase: LiveScanStackItemPhase
    let pricing: CardPricingSummary?
}

struct ScanTrayMetrics: Equatable, Sendable {
    let totalValue: Double
    let currencyCode: String?
    let totalCount: Int
    let resolvedCount: Int
    let pendingCount: Int
    let hasMixedCurrencies: Bool

    var totalLabel: String {
        guard let currencyCode else { return hasMixedCurrencies ? "Mixed" : "$0.00" }
        return Self.formatCurrency(totalValue, currencyCode: currencyCode)
    }

    var countLabel: String {
        "\(resolvedCount) \(resolvedCount == 1 ? "card" : "cards")"
    }

    private static func formatCurrency(_ value: Double, currencyCode: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? "\(currencyCode) \(value)"
    }
}

enum ScanTrayCalculator {
    static func metrics(for inputs: [ScanTrayMetricInput]) -> ScanTrayMetrics {
        let pricedInputs = inputs.filter { input in
            guard input.pricing?.primaryDisplayPrice != nil else { return false }
            return input.phase == .resolved || input.phase == .needsReview
        }
        let pendingCount = inputs.filter { input in
            switch input.phase {
            case .pending, .unsupported:
                return true
            case .needsReview:
                return input.pricing?.primaryDisplayPrice == nil
            case .resolved, .failed:
                return false
            }
        }.count

        let currencies: Set<String> = Set(pricedInputs.compactMap { input in
            guard let pricing = input.pricing,
                  pricing.primaryDisplayPrice != nil else {
                return nil
            }
            return pricing.currencyCode
        })

        let hasMixedCurrencies = currencies.count > 1
        let chosenCurrency = currencies.count == 1 ? currencies.first ?? nil : pricedInputs.compactMap(\.pricing?.currencyCode).first

        let totalValue = pricedInputs.reduce(into: 0.0) { partialResult, input in
            guard let pricing = input.pricing,
                  let value = pricing.primaryDisplayPrice else { return }
            if hasMixedCurrencies {
                guard pricing.currencyCode == chosenCurrency else { return }
            }
            partialResult += value
        }

        return ScanTrayMetrics(
            totalValue: totalValue,
            currencyCode: chosenCurrency,
            totalCount: inputs.count,
            resolvedCount: pricedInputs.count,
            pendingCount: pendingCount,
            hasMixedCurrencies: hasMixedCurrencies
        )
    }

    static func shouldAutoRefresh(pricing: CardPricingSummary?) -> Bool {
        guard let pricing else { return true }
        if let isFresh = pricing.isFresh {
            return !isFresh
        }
        return pricing.freshnessTone == .stale
    }

    static func initialStatusMessage(for pricing: CardPricingSummary?) -> String {
        guard let pricing else {
            return "Cached price unavailable"
        }
        return pricing.freshnessLabel
    }
}
