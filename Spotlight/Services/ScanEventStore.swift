import Foundation
import SQLite3
import UIKit

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

actor ScanEventStore {
    private let encoder: JSONEncoder
    private let databaseURL: URL
    private let cropsDirectoryURL: URL
    private var isBootstrapped = false

    init(fileManager: FileManager = .default) {
        encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .iso8601

        let baseURL = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
        let directoryURL = baseURL.appendingPathComponent("Spotlight", isDirectory: true)
        let cropsDirectoryURL = directoryURL.appendingPathComponent("ScanCrops", isDirectory: true)

        try? fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        try? fileManager.createDirectory(at: cropsDirectoryURL, withIntermediateDirectories: true)

        databaseURL = directoryURL.appendingPathComponent("scan_telemetry.sqlite")
        self.cropsDirectoryURL = cropsDirectoryURL
    }

    func logPrediction(analysis: AnalyzedCapture, response: ScanMatchResponse) async {
        do {
            try ensureBootstrappedIfNeeded()
            let imagePath = try persistNormalizedImage(analysis.normalizedImage, scanID: analysis.scanID)
            let requestPayload = ScanMatchRequestPayload(
                scanID: analysis.scanID,
                capturedAt: Date(),
                clientContext: .current(),
                image: ScanImagePayload(
                    jpegBase64: nil,
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

            let requestJSON = try jsonString(for: requestPayload)
            let responseJSON = try jsonString(for: response)
            let createdAt = iso8601String(for: Date())

            try withConnection { database in
                try Self.execute(
                    """
                    INSERT OR REPLACE INTO scan_events (
                        scan_id,
                        created_at,
                        image_path,
                        request_json,
                        response_json,
                        collector_number,
                        crop_confidence,
                        confidence,
                        matcher_source,
                        matcher_version
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    bindings: [
                        .text(analysis.scanID.uuidString),
                        .text(createdAt),
                        .text(imagePath),
                        .text(requestJSON),
                        .text(responseJSON),
                        .text(analysis.collectorNumber),
                        .double(analysis.cropConfidence),
                        .text(response.confidence.rawValue),
                        .text(response.matcherSource.rawValue),
                        .text(response.matcherVersion)
                    ],
                    in: database
                )

                try Self.execute(
                    "DELETE FROM scan_candidates WHERE scan_id = ?",
                    bindings: [.text(analysis.scanID.uuidString)],
                    in: database
                )

                for candidate in response.topCandidates {
                    try Self.execute(
                        """
                        INSERT INTO scan_candidates (
                            scan_id,
                            rank,
                            card_id,
                            candidate_json,
                            image_score,
                            collector_number_score,
                            name_score,
                            final_score
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        bindings: [
                            .text(analysis.scanID.uuidString),
                            .integer(Int64(candidate.rank)),
                            .text(candidate.candidate.id),
                            .text(try jsonString(for: candidate.candidate)),
                            .double(candidate.imageScore),
                            .double(candidate.collectorNumberScore),
                            .double(candidate.nameScore),
                            .double(candidate.finalScore)
                        ],
                        in: database
                    )
                }
            }
        } catch {
            #if DEBUG
            print("Scan telemetry write failed:", error.localizedDescription)
            #endif
        }
    }

    func logSelection(
        scanID: UUID,
        selectedCardID: String?,
        wasTopPrediction: Bool,
        correctionType: CorrectionType
    ) async {
        do {
            try ensureBootstrappedIfNeeded()
            let completedAt = iso8601String(for: Date())

            try withConnection { database in
                try Self.execute(
                    """
                    UPDATE scan_events
                    SET selected_card_id = ?, was_top_prediction = ?, correction_type = ?, completed_at = ?
                    WHERE scan_id = ?
                    """,
                    bindings: [
                        .text(selectedCardID),
                        .integer(wasTopPrediction ? 1 : 0),
                        .text(correctionType.rawValue),
                        .text(completedAt),
                        .text(scanID.uuidString)
                    ],
                    in: database
                )

                try Self.execute(
                    """
                    INSERT INTO scan_feedback (
                        scan_id,
                        selected_card_id,
                        was_top_prediction,
                        correction_type,
                        submitted_at
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    bindings: [
                        .text(scanID.uuidString),
                        .text(selectedCardID),
                        .integer(wasTopPrediction ? 1 : 0),
                        .text(correctionType.rawValue),
                        .text(completedAt)
                    ],
                    in: database
                )
            }
        } catch {
            #if DEBUG
            print("Scan telemetry feedback write failed:", error.localizedDescription)
            #endif
        }
    }

    private func ensureBootstrappedIfNeeded() throws {
        guard !isBootstrapped else { return }
        try Self.bootstrapDatabaseIfNeeded(at: databaseURL)
        isBootstrapped = true
    }

    private static func bootstrapDatabaseIfNeeded(at databaseURL: URL) throws {
        try withConnection(at: databaseURL) { database in
            try execute(
                    """
                    CREATE TABLE IF NOT EXISTS scan_events (
                        scan_id TEXT PRIMARY KEY,
                        created_at TEXT NOT NULL,
                        image_path TEXT,
                        request_json TEXT NOT NULL,
                        response_json TEXT NOT NULL,
                        collector_number TEXT,
                        crop_confidence REAL NOT NULL,
                        confidence TEXT NOT NULL,
                        matcher_source TEXT NOT NULL,
                        matcher_version TEXT NOT NULL,
                        selected_card_id TEXT,
                        was_top_prediction INTEGER,
                        correction_type TEXT,
                        completed_at TEXT
                    )
                    """,
                    in: database
                )

            try execute(
                    """
                    CREATE TABLE IF NOT EXISTS scan_candidates (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        scan_id TEXT NOT NULL,
                        rank INTEGER NOT NULL,
                        card_id TEXT NOT NULL,
                        candidate_json TEXT NOT NULL,
                        image_score REAL NOT NULL,
                        collector_number_score REAL NOT NULL,
                        name_score REAL NOT NULL,
                        final_score REAL NOT NULL
                    )
                    """,
                    in: database
                )

            try execute(
                    """
                    CREATE TABLE IF NOT EXISTS scan_feedback (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        scan_id TEXT NOT NULL,
                        selected_card_id TEXT,
                        was_top_prediction INTEGER NOT NULL,
                        correction_type TEXT NOT NULL,
                        submitted_at TEXT NOT NULL
                    )
                    """,
                    in: database
                )

            try execute(
                "CREATE INDEX IF NOT EXISTS idx_scan_candidates_scan_id ON scan_candidates(scan_id)",
                in: database
            )

            try execute(
                "CREATE INDEX IF NOT EXISTS idx_scan_feedback_scan_id ON scan_feedback(scan_id)",
                in: database
            )
        }
    }

    private func persistNormalizedImage(_ image: UIImage, scanID: UUID) throws -> String? {
        guard let data = image.jpegData(compressionQuality: 0.8) else {
            return nil
        }

        let fileURL = cropsDirectoryURL.appendingPathComponent("\(scanID.uuidString).jpg")
        try data.write(to: fileURL, options: [.atomic])
        return fileURL.path
    }

    private func jsonString<T: Encodable>(for value: T) throws -> String {
        let data = try encoder.encode(value)
        guard let string = String(data: data, encoding: .utf8) else {
            throw ScanEventStoreError.encodingFailed
        }
        return string
    }

    private func iso8601String(for date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private func withConnection<T>(_ operation: (OpaquePointer) throws -> T) throws -> T {
        try Self.withConnection(at: databaseURL, operation)
    }

    private static func withConnection<T>(at databaseURL: URL, _ operation: (OpaquePointer) throws -> T) throws -> T {
        var database: OpaquePointer?
        guard sqlite3_open(databaseURL.path, &database) == SQLITE_OK, let database else {
            defer { sqlite3_close(database) }
            throw ScanEventStoreError.databaseOpenFailed
        }

        defer { sqlite3_close(database) }
        return try operation(database)
    }

    private static func execute(_ sql: String, bindings: [SQLiteBinding] = [], in database: OpaquePointer) throws {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw sqliteError(in: database)
        }

        defer { sqlite3_finalize(statement) }

        try bind(bindings, to: statement)

        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw sqliteError(in: database)
        }
    }

    private static func bind(_ bindings: [SQLiteBinding], to statement: OpaquePointer) throws {
        for (index, binding) in bindings.enumerated() {
            let parameterIndex = Int32(index + 1)

            switch binding {
            case .text(let value):
                if let value {
                    sqlite3_bind_text(statement, parameterIndex, value, -1, sqliteTransient)
                } else {
                    sqlite3_bind_null(statement, parameterIndex)
                }
            case .double(let value):
                sqlite3_bind_double(statement, parameterIndex, value)
            case .integer(let value):
                sqlite3_bind_int64(statement, parameterIndex, value)
            }
        }
    }

    private static func sqliteError(in database: OpaquePointer) -> Error {
        let message = sqlite3_errmsg(database).map(String.init(cString:)) ?? "Unknown SQLite error"
        return ScanEventStoreError.sqlite(message)
    }
}

private enum SQLiteBinding {
    case text(String?)
    case double(Double)
    case integer(Int64)
}

private enum ScanEventStoreError: LocalizedError {
    case databaseOpenFailed
    case encodingFailed
    case sqlite(String)

    var errorDescription: String? {
        switch self {
        case .databaseOpenFailed:
            "The scan telemetry database could not be opened."
        case .encodingFailed:
            "The scan telemetry payload could not be encoded."
        case .sqlite(let message):
            message
        }
    }
}
