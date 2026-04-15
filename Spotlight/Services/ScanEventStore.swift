import Foundation
import SQLite3
import UIKit

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

struct PendingScanArtifactUpload: Sendable {
    let scanID: UUID
    let captureSource: ScanCaptureSource
    let cameraZoomFactor: Double?
    let sourceImagePath: String
    let normalizedImagePath: String
}

struct PendingDeckConfirmation: Sendable {
    let id: Int64
    let scanID: UUID
    let cardID: String
    let slabContext: SlabContext?
    let condition: DeckCardCondition?
    let selectionSource: ScanSelectionSource
    let selectedRank: Int?
    let wasTopPrediction: Bool
}

actor ScanEventStore {
    private let encoder: JSONEncoder
    private let databaseURL: URL
    private let cropsDirectoryURL: URL
    private var isBootstrapped = false

    init(fileManager: FileManager = .default, baseDirectoryURL: URL? = nil) {
        encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .iso8601

        let baseURL = baseDirectoryURL
            ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
        let directoryURL = baseURL.appendingPathComponent("Spotlight", isDirectory: true)
        let cropsDirectoryURL = directoryURL.appendingPathComponent("ScanCrops", isDirectory: true)

        try? fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        try? fileManager.createDirectory(at: cropsDirectoryURL, withIntermediateDirectories: true)

        databaseURL = directoryURL.appendingPathComponent("scan_telemetry.sqlite")
        self.cropsDirectoryURL = cropsDirectoryURL
    }

    func logPrediction(
        analysis: AnalyzedCapture,
        response: ScanMatchResponse,
        captureSource: ScanCaptureSource,
        cameraZoomFactor: Double?,
        enqueueArtifactUpload: Bool = true
    ) async {
        do {
            try ensureBootstrappedIfNeeded()
            let sourceImagePath = enqueueArtifactUpload ? try persistImage(
                analysis.originalImage,
                scanID: analysis.scanID,
                suffix: "source"
            ) : nil
            let normalizedImagePath = enqueueArtifactUpload ? try persistImage(
                analysis.normalizedImage,
                scanID: analysis.scanID,
                suffix: "normalized"
            ) : nil
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
                        .text(normalizedImagePath),
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

                if enqueueArtifactUpload,
                   let sourceImagePath,
                   let normalizedImagePath {
                    try Self.execute(
                        """
                        INSERT OR REPLACE INTO scan_artifact_uploads (
                            scan_id,
                            capture_source,
                            camera_zoom_factor,
                            source_image_path,
                            normalized_image_path,
                            upload_state,
                            retry_count
                        ) VALUES (?, ?, ?, ?, ?, 'pending', 0)
                        """,
                        bindings: [
                            .text(analysis.scanID.uuidString),
                            .text(captureSource.rawValue),
                            .doubleOptional(cameraZoomFactor),
                            .text(sourceImagePath),
                            .text(normalizedImagePath),
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

    func enqueueDeckConfirmation(
        scanID: UUID,
        cardID: String,
        slabContext: SlabContext?,
        condition: DeckCardCondition?,
        selectionSource: ScanSelectionSource,
        selectedRank: Int?,
        wasTopPrediction: Bool
    ) async {
        do {
            try ensureBootstrappedIfNeeded()
            try withConnection { database in
                try Self.execute(
                    """
                        INSERT INTO deck_confirmation_queue (
                            scan_id,
                            card_id,
                            slab_context_json,
                            condition,
                            selection_source,
                            selected_rank,
                            was_top_prediction,
                            state,
                            retry_count,
                            submitted_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
                        """,
                        bindings: [
                            .text(scanID.uuidString),
                            .text(cardID),
                            .text(try jsonString(for: slabContext)),
                            .text(condition?.rawValue),
                            .text(selectionSource.rawValue),
                            .integerOptional(selectedRank.map(Int64.init)),
                            .integer(wasTopPrediction ? 1 : 0),
                            .text(iso8601String(for: Date())),
                    ],
                    in: database
                )
            }
        } catch {
            #if DEBUG
            print("Deck confirmation queue write failed:", error.localizedDescription)
            #endif
        }
    }

    func updatePendingDeckConfirmationCondition(
        scanID: UUID,
        cardID: String,
        slabContext: SlabContext?,
        condition: DeckCardCondition
    ) async {
        do {
            try ensureBootstrappedIfNeeded()
            _ = slabContext
            try withConnection { database in
                try Self.execute(
                    """
                    UPDATE deck_confirmation_queue
                    SET condition = ?
                    WHERE scan_id = ?
                      AND card_id = ?
                      AND state != 'submitted'
                    """,
                    bindings: [
                        .text(condition.rawValue),
                        .text(scanID.uuidString),
                        .text(cardID),
                    ],
                    in: database
                )
            }
        } catch {
            #if DEBUG
            print("Deck confirmation condition update failed:", error.localizedDescription)
            #endif
        }
    }

    func pendingArtifactUploads(limit: Int = 10) async -> [PendingScanArtifactUpload] {
        do {
            try ensureBootstrappedIfNeeded()
            return try withConnection { database in
                try Self.query(
                    """
                    SELECT scan_id, capture_source, camera_zoom_factor, source_image_path, normalized_image_path
                    FROM scan_artifact_uploads
                    WHERE upload_state != 'uploaded'
                    ORDER BY COALESCE(last_attempt_at, '') ASC, scan_id ASC
                    LIMIT ?
                    """,
                    bindings: [.integer(Int64(limit))],
                    in: database
                ).compactMap { row in
                    guard let scanIDRaw = row["scan_id"] as? String,
                          let scanID = UUID(uuidString: scanIDRaw),
                          let captureSourceRaw = row["capture_source"] as? String,
                          let captureSource = ScanCaptureSource(rawValue: captureSourceRaw),
                          let sourceImagePath = row["source_image_path"] as? String,
                          let normalizedImagePath = row["normalized_image_path"] as? String else {
                        return nil
                    }
                    return PendingScanArtifactUpload(
                        scanID: scanID,
                        captureSource: captureSource,
                        cameraZoomFactor: row["camera_zoom_factor"] as? Double,
                        sourceImagePath: sourceImagePath,
                        normalizedImagePath: normalizedImagePath
                    )
                }
            }
        } catch {
            return []
        }
    }

    func markArtifactUploadAttempt(scanID: UUID, uploaded: Bool) async {
        do {
            try ensureBootstrappedIfNeeded()
            let now = iso8601String(for: Date())
            try withConnection { database in
                try Self.execute(
                    """
                    UPDATE scan_artifact_uploads
                    SET upload_state = ?, retry_count = retry_count + CASE WHEN ? = 'uploaded' THEN 0 ELSE 1 END,
                        last_attempt_at = ?, uploaded_at = CASE WHEN ? = 'uploaded' THEN ? ELSE uploaded_at END
                    WHERE scan_id = ?
                    """,
                    bindings: [
                        .text(uploaded ? "uploaded" : "pending"),
                        .text(uploaded ? "uploaded" : "pending"),
                        .text(now),
                        .text(uploaded ? "uploaded" : "pending"),
                        .text(now),
                        .text(scanID.uuidString),
                    ],
                    in: database
                )
            }
        } catch {}
    }

    func pendingDeckConfirmations(limit: Int = 10) async -> [PendingDeckConfirmation] {
        do {
            try ensureBootstrappedIfNeeded()
            return try withConnection { database in
                try Self.query(
                    """
                    SELECT id, scan_id, card_id, slab_context_json, condition, selection_source, selected_rank, was_top_prediction
                    FROM deck_confirmation_queue
                    WHERE state != 'submitted'
                    ORDER BY COALESCE(last_attempt_at, '') ASC, id ASC
                    LIMIT ?
                    """,
                    bindings: [.integer(Int64(limit))],
                    in: database
                ).compactMap { row in
                    guard let id = row["id"] as? Int64,
                          let scanIDRaw = row["scan_id"] as? String,
                          let scanID = UUID(uuidString: scanIDRaw),
                          let cardID = row["card_id"] as? String,
                          let selectionSourceRaw = row["selection_source"] as? String,
                          let selectionSource = ScanSelectionSource(rawValue: selectionSourceRaw) else {
                        return nil
                    }
                    let slabContext: SlabContext?
                    if let json = row["slab_context_json"] as? String, !json.isEmpty, json != "null" {
                        slabContext = try? JSONDecoder().decode(SlabContext.self, from: Data(json.utf8))
                    } else {
                        slabContext = nil
                    }
                    let rank = (row["selected_rank"] as? Int64).map(Int.init)
                    let wasTopPrediction = (row["was_top_prediction"] as? Int64) == 1
                    let condition = (row["condition"] as? String).flatMap(DeckCardCondition.init(rawValue:))
                    return PendingDeckConfirmation(
                        id: id,
                        scanID: scanID,
                        cardID: cardID,
                        slabContext: slabContext,
                        condition: condition,
                        selectionSource: selectionSource,
                        selectedRank: rank,
                        wasTopPrediction: wasTopPrediction
                    )
                }
            }
        } catch {
            return []
        }
    }

    func markDeckConfirmationAttempt(id: Int64, submitted: Bool) async {
        do {
            try ensureBootstrappedIfNeeded()
            let now = iso8601String(for: Date())
            try withConnection { database in
                try Self.execute(
                    """
                    UPDATE deck_confirmation_queue
                    SET state = ?, retry_count = retry_count + CASE WHEN ? = 'submitted' THEN 0 ELSE 1 END,
                        last_attempt_at = ?
                    WHERE id = ?
                    """,
                    bindings: [
                        .text(submitted ? "submitted" : "pending"),
                        .text(submitted ? "submitted" : "pending"),
                        .text(now),
                        .integer(id),
                    ],
                    in: database
                )
            }
        } catch {}
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
                    """
                    CREATE TABLE IF NOT EXISTS scan_artifact_uploads (
                        scan_id TEXT PRIMARY KEY,
                        capture_source TEXT NOT NULL,
                        camera_zoom_factor REAL,
                        source_image_path TEXT NOT NULL,
                        normalized_image_path TEXT NOT NULL,
                        upload_state TEXT NOT NULL,
                        retry_count INTEGER NOT NULL DEFAULT 0,
                        last_attempt_at TEXT,
                        uploaded_at TEXT
                    )
                    """,
                    in: database
                )

            try execute(
                    """
                    CREATE TABLE IF NOT EXISTS deck_confirmation_queue (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        scan_id TEXT NOT NULL,
                        card_id TEXT NOT NULL,
                        slab_context_json TEXT,
                        condition TEXT,
                        selection_source TEXT NOT NULL,
                        selected_rank INTEGER,
                        was_top_prediction INTEGER NOT NULL,
                        state TEXT NOT NULL,
                        retry_count INTEGER NOT NULL DEFAULT 0,
                        last_attempt_at TEXT,
                        submitted_at TEXT NOT NULL
                    )
                    """,
                    in: database
                )

            try addColumnIfMissing(
                table: "deck_confirmation_queue",
                column: "condition",
                sql: "TEXT",
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

            try execute(
                "CREATE INDEX IF NOT EXISTS idx_scan_artifact_uploads_state ON scan_artifact_uploads(upload_state)",
                in: database
            )

            try execute(
                "CREATE INDEX IF NOT EXISTS idx_deck_confirmation_queue_state ON deck_confirmation_queue(state)",
                in: database
            )
        }
    }

    private func persistImage(_ image: UIImage, scanID: UUID, suffix: String) throws -> String {
        guard let data = image.jpegData(compressionQuality: 0.8) else {
            throw ScanEventStoreError.encodingFailed
        }

        let fileURL = cropsDirectoryURL.appendingPathComponent("\(scanID.uuidString)-\(suffix).jpg")
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

    private static func addColumnIfMissing(
        table: String,
        column: String,
        sql: String,
        in database: OpaquePointer
    ) throws {
        let rows = try query("PRAGMA table_info(\(table))", in: database)
        let existingColumns = Set(rows.compactMap { $0["name"] as? String })
        guard !existingColumns.contains(column) else {
            return
        }
        try execute("ALTER TABLE \(table) ADD COLUMN \(column) \(sql)", in: database)
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

    private static func query(
        _ sql: String,
        bindings: [SQLiteBinding] = [],
        in database: OpaquePointer
    ) throws -> [[String: Any]] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw sqliteError(in: database)
        }

        defer { sqlite3_finalize(statement) }
        try bind(bindings, to: statement)

        var rows: [[String: Any]] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            var row: [String: Any] = [:]
            for index in 0..<sqlite3_column_count(statement) {
                let name = String(cString: sqlite3_column_name(statement, index))
                switch sqlite3_column_type(statement, index) {
                case SQLITE_INTEGER:
                    row[name] = sqlite3_column_int64(statement, index)
                case SQLITE_FLOAT:
                    row[name] = sqlite3_column_double(statement, index)
                case SQLITE_TEXT:
                    row[name] = String(cString: UnsafePointer(sqlite3_column_text(statement, index)))
                default:
                    row[name] = NSNull()
                }
            }
            rows.append(row)
        }
        return rows
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
            case .doubleOptional(let value):
                if let value {
                    sqlite3_bind_double(statement, parameterIndex, value)
                } else {
                    sqlite3_bind_null(statement, parameterIndex)
                }
            case .integer(let value):
                sqlite3_bind_int64(statement, parameterIndex, value)
            case .integerOptional(let value):
                if let value {
                    sqlite3_bind_int64(statement, parameterIndex, value)
                } else {
                    sqlite3_bind_null(statement, parameterIndex)
                }
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
    case doubleOptional(Double?)
    case integer(Int64)
    case integerOptional(Int64?)
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
