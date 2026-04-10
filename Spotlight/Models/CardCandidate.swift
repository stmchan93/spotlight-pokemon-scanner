import Foundation

struct SlabContext: Codable, Hashable, Sendable {
    let grader: String
    let grade: String?
    let certNumber: String?
    let variantName: String?
}

struct CardPricingSummary: Codable, Hashable, Sendable {
    let source: String
    let currencyCode: String
    let variant: String?
    let low: Double?
    let market: Double?
    let mid: Double?
    let high: Double?
    let directLow: Double?
    let trend: Double?
    let updatedAt: String?
    let refreshedAt: String?
    let sourceURL: String?
    let pricingMode: String?
    let snapshotAgeHours: Double?
    let freshnessWindowHours: Int?
    let isFresh: Bool?
    let grader: String?
    let grade: String?
    let pricingTier: String?
    let confidenceLabel: String?
    let confidenceLevel: Int?
    let compCount: Int?
    let recentCompCount: Int?
    let lastSoldPrice: Double?
    let lastSoldAt: String?
    let bucketKey: String?
    let methodologySummary: String?

    var sourceLabel: String {
        if source == "psa_comp_model" {
            return "PSA comps"
        }
        if source == "tcgplayer" {
            return "TCGplayer"
        }
        if source == "cardmarket" {
            return "Cardmarket"
        }
        if source == "scrydex" {
            return "Scrydex"
        }
        if source == "pricecharting" {
            return "PriceCharting"
        }
        if source == "pokemontcg_api" {
            return "Pokemon TCG API"
        }
        return source.capitalized
    }

    var sourceDetailLabel: String {
        guard let variant, !variant.isEmpty else { return sourceLabel }
        return "\(sourceLabel) • \(variant)"
    }

    var primaryDisplayPrice: Double? {
        market ?? mid ?? low ?? trend
    }

    var primaryLabel: String {
        if pricingMode == "psa_grade_estimate", let grader, let grade {
            return "\(grader) \(grade)"
        }
        if market != nil { return "Market" }
        if mid != nil { return "Mid" }
        if low != nil { return "Low" }
        return "Trend"
    }

    var pricingTierLabel: String? {
        switch pricingTier {
        case "exact_same_grade":
            return "Exact same grade"
        case "same_card_grade_ladder":
            return "Nearby grades"
        case "bucket_index_model":
            return "Bucket model"
        case "scrydex_exact_grade", "pricecharting_exact_grade":
            return "Live PSA pricing"
        default:
            return nil
        }
    }

    var refreshedDate: Date? {
        let formatter = ISO8601DateFormatter()
        return formatter.date(from: refreshedAt ?? "")
    }

    var sourceUpdatedDate: Date? {
        for formatter in Self.providerFormatters() {
            if let date = formatter.date(from: updatedAt ?? "") {
                return date
            }
        }
        return nil
    }

    var freshnessLabel: String {
        if freshnessState == .unavailable {
            return "Price unavailable"
        }
        guard let refreshedDate else { return "Snapshot timing unavailable" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        let relative = formatter.localizedString(for: refreshedDate, relativeTo: Date())

        switch freshnessState {
        case .cached:
            return "Cached from \(relative)"
        case .refreshedRecently:
            return "Refreshed \(relative)"
        case .stale:
            return "Stale snapshot from \(relative)"
        case .unavailable:
            return "Price unavailable"
        }
    }

    var freshnessState: PricingFreshnessState {
        guard primaryDisplayPrice != nil else { return .unavailable }
        if let isFresh {
            guard isFresh else { return .stale }
            if let snapshotAgeHours, snapshotAgeHours < 0.25 {
                return .refreshedRecently
            }
            if let refreshedDate, Date().timeIntervalSince(refreshedDate) < 15 * 60 {
                return .refreshedRecently
            }
            return .cached
        }
        guard let refreshedDate else { return .cached }
        let age = Date().timeIntervalSince(refreshedDate)
        if age < 15 * 60 { return .refreshedRecently }
        if age < 24 * 60 * 60 { return .cached }
        return .stale
    }

    var freshnessTone: PricingFreshnessTone {
        switch freshnessState {
        case .unavailable:
            return .stale
        case .cached:
            return .recent
        case .refreshedRecently:
            return .fresh
        case .stale:
            return .stale
        }
    }

    var freshnessBadgeLabel: String {
        switch freshnessState {
        case .unavailable:
            return "Unavailable"
        case .cached:
            return "Cached"
        case .refreshedRecently:
            return "Fresh"
        case .stale:
            return "Stale"
        }
    }

    var sourceUpdatedLabel: String? {
        guard let sourceUpdatedDate else { return nil }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return "Provider updated \(formatter.string(from: sourceUpdatedDate))"
    }

    var spreadText: String? {
        guard let low, let high else { return nil }
        return "\(Self.formatCurrency(low, currencyCode: currencyCode)) to \(Self.formatCurrency(high, currencyCode: currencyCode))"
    }

    private static func providerFormatters() -> [DateFormatter] {
        let plain = DateFormatter()
        plain.locale = Locale(identifier: "en_US_POSIX")
        plain.dateFormat = "yyyy/MM/dd"

        let timestamp = DateFormatter()
        timestamp.locale = Locale(identifier: "en_US_POSIX")
        timestamp.dateFormat = "yyyy/MM/dd HH:mm:ss"

        return [timestamp, plain]
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

enum PricingFreshnessTone: Equatable {
    case fresh
    case recent
    case stale
}

enum PricingFreshnessState: Equatable {
    case unavailable
    case cached
    case refreshedRecently
    case stale
}

struct CardDetail: Codable, Hashable, Sendable {
    let card: CardCandidate
    let slabContext: SlabContext?
    let source: String?
    let sourceRecordID: String?
    let setID: String?
    let setSeries: String?
    let setReleaseDate: String?
    let supertype: String?
    let artist: String?
    let regulationMark: String?
    let imageSmallURL: String?
    let imageLargeURL: String?

    var pricing: CardPricingSummary? {
        card.pricing
    }
}

struct CardCandidate: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let name: String
    let setName: String
    let number: String
    let rarity: String
    let variant: String
    let language: String
    let imageSmallURL: String?
    let imageLargeURL: String?
    let pricing: CardPricingSummary?

    var subtitle: String {
        "\(setName) • \(number)"
    }

    var detailLine: String {
        "\(rarity) • \(variant) • \(language)"
    }

    var pricingLine: String? {
        guard let pricing, let primaryPrice = pricing.primaryDisplayPrice else { return nil }
        return "\(pricing.primaryLabel) \(formattedPrice(primaryPrice, currencyCode: pricing.currencyCode)) • \(pricing.sourceLabel)"
    }

    private func formattedPrice(_ value: Double, currencyCode: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? "\(currencyCode) \(value)"
    }
}

struct ScoredCandidate: Identifiable, Codable, Hashable, Sendable {
    let rank: Int
    let candidate: CardCandidate
    let imageScore: Double
    let collectorNumberScore: Double
    let nameScore: Double
    let finalScore: Double

    var id: String { candidate.id }
}

enum MatchConfidence: String, Codable, Hashable, Sendable {
    case high
    case medium
    case low

    var title: String {
        rawValue.capitalized
    }
}

enum MatcherSource: String, Codable, Hashable, Sendable {
    case remotePrototype
    case remoteHybrid
}
