import Foundation

enum FixtureRunnerError: Error, CustomStringConvertible {
    case usage(String)
    case invalidFixture(String)

    var description: String {
        switch self {
        case .usage(let message):
            return message
        case .invalidFixture(let message):
            return message
        }
    }
}

struct OCRFixtureManifest: Codable {
    let fixtureName: String
    let selectedMode: String
    let sourceImage: String
    let tags: [String]
    let expects: OCRFixtureExpectations
}

struct OCRFixtureExpectations: Codable {
    let cardName: String
    let collectorNumber: String?
    let setName: String?
    let setCodeHint: String?
    let confidenceBucket: String
    let preserveLowConfidenceEvidence: Bool
}

struct OCRFixtureBaselineRecord: Codable {
    let fixtureName: String
    let selectedMode: String
    let sourceImage: String
    let copiedSourceImage: String
    let tags: [String]
    let expects: OCRFixtureExpectations
    let baselineVersion: String
}

struct OCRFixtureBaselineIndex: Codable {
    let baselineVersion: String
    let generatedAt: String
    let fixtureCount: Int
    let fixtures: [OCRFixtureBaselineRecord]
}

struct CLIOptions {
    let fixturesRoot: URL
    let goldenRoot: URL
}

private let baselineVersion = "phase2_fixture_baseline_v1"

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() {
        throw FixtureRunnerError.invalidFixture(message)
    }
}

func parseArguments() throws -> CLIOptions {
    let arguments = Array(CommandLine.arguments.dropFirst())
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)

    var fixturesRoot = cwd.appendingPathComponent("qa/ocr-fixtures", isDirectory: true)
    var goldenRoot = cwd.appendingPathComponent("qa/ocr-golden/phase2-baseline", isDirectory: true)

    var index = 0
    while index < arguments.count {
        let argument = arguments[index]
        switch argument {
        case "--fixtures-root":
            index += 1
            guard index < arguments.count else {
                throw FixtureRunnerError.usage("missing value for --fixtures-root")
            }
            fixturesRoot = URL(fileURLWithPath: arguments[index], isDirectory: true)
        case "--golden-root":
            index += 1
            guard index < arguments.count else {
                throw FixtureRunnerError.usage("missing value for --golden-root")
            }
            goldenRoot = URL(fileURLWithPath: arguments[index], isDirectory: true)
        case "--help", "-h":
            throw FixtureRunnerError.usage(
                """
                usage: ocr_fixture_runner.swift [--fixtures-root <path>] [--golden-root <path>]
                """
            )
        default:
            throw FixtureRunnerError.usage("unknown argument: \(argument)")
        }
        index += 1
    }

    return CLIOptions(fixturesRoot: fixturesRoot, goldenRoot: goldenRoot)
}

func sortedFixtureManifestURLs(in fixturesRoot: URL) throws -> [URL] {
    let contents = try FileManager.default.contentsOfDirectory(
        at: fixturesRoot,
        includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles]
    )

    return contents
        .filter { url in
            (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
        }
        .map { $0.appendingPathComponent("fixture.json") }
        .filter { FileManager.default.fileExists(atPath: $0.path) }
        .sorted { $0.deletingLastPathComponent().lastPathComponent < $1.deletingLastPathComponent().lastPathComponent }
}

func decodeFixtureManifest(at url: URL) throws -> OCRFixtureManifest {
    let data = try Data(contentsOf: url)
    return try JSONDecoder().decode(OCRFixtureManifest.self, from: data)
}

func validateFixtureManifest(_ fixture: OCRFixtureManifest, manifestURL: URL) throws -> URL {
    let fixtureDirectoryName = manifestURL.deletingLastPathComponent().lastPathComponent
    try require(fixture.fixtureName == fixtureDirectoryName, "fixture name mismatch in \(manifestURL.path)")
    try require(["raw", "slab"].contains(fixture.selectedMode), "unsupported selectedMode in \(manifestURL.path)")
    try require(["high", "medium", "low"].contains(fixture.expects.confidenceBucket), "unsupported confidenceBucket in \(manifestURL.path)")
    try require(!fixture.expects.cardName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "cardName must not be empty in \(manifestURL.path)")

    let sourceImageURL = manifestURL.deletingLastPathComponent().appendingPathComponent(fixture.sourceImage)
    try require(FileManager.default.fileExists(atPath: sourceImageURL.path), "missing source image for \(fixture.fixtureName): \(sourceImageURL.path)")
    return sourceImageURL
}

func recreateDirectory(at url: URL) throws {
    let fileManager = FileManager.default
    if fileManager.fileExists(atPath: url.path) {
        try fileManager.removeItem(at: url)
    }
    try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
}

func ensureDirectory(at url: URL) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
}

func copyFixtureSourceImage(from sourceURL: URL, to destinationDirectory: URL) throws -> String {
    let destinationURL = destinationDirectory.appendingPathComponent(sourceURL.lastPathComponent)
    if FileManager.default.fileExists(atPath: destinationURL.path) {
        try FileManager.default.removeItem(at: destinationURL)
    }
    try FileManager.default.copyItem(at: sourceURL, to: destinationURL)
    return destinationURL.lastPathComponent
}

func writeJSON<T: Encodable>(_ value: T, to url: URL) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try encoder.encode(value)
    try data.write(to: url)
}

func runFixtureBaseline(options: CLIOptions) throws {
    let manifests = try sortedFixtureManifestURLs(in: options.fixturesRoot)
    try require(!manifests.isEmpty, "no fixture manifests found under \(options.fixturesRoot.path)")

    try recreateDirectory(at: options.goldenRoot)

    var indexRecords: [OCRFixtureBaselineRecord] = []

    for manifestURL in manifests {
        let fixture = try decodeFixtureManifest(at: manifestURL)
        let sourceImageURL = try validateFixtureManifest(fixture, manifestURL: manifestURL)

        let fixtureOutputDirectory = options.goldenRoot.appendingPathComponent(fixture.fixtureName, isDirectory: true)
        try ensureDirectory(at: fixtureOutputDirectory)

        let copiedSourceImage = try copyFixtureSourceImage(from: sourceImageURL, to: fixtureOutputDirectory)

        let baselineRecord = OCRFixtureBaselineRecord(
            fixtureName: fixture.fixtureName,
            selectedMode: fixture.selectedMode,
            sourceImage: fixture.sourceImage,
            copiedSourceImage: copiedSourceImage,
            tags: fixture.tags,
            expects: fixture.expects,
            baselineVersion: baselineVersion
        )

        try writeJSON(fixture, to: fixtureOutputDirectory.appendingPathComponent("fixture.json"))
        try writeJSON(baselineRecord, to: fixtureOutputDirectory.appendingPathComponent("baseline.json"))
        indexRecords.append(baselineRecord)

        print("fixture: \(fixture.fixtureName) mode=\(fixture.selectedMode) source=\(sourceImageURL.lastPathComponent)")
    }

    let isoFormatter = ISO8601DateFormatter()
    isoFormatter.formatOptions = [.withInternetDateTime]

    let index = OCRFixtureBaselineIndex(
        baselineVersion: baselineVersion,
        generatedAt: isoFormatter.string(from: Date()),
        fixtureCount: indexRecords.count,
        fixtures: indexRecords
    )

    try writeJSON(index, to: options.goldenRoot.appendingPathComponent("index.json"))
    print("ocr_fixture_runner: PASS (\(index.fixtureCount) fixtures)")
}

@main
struct OCRFixtureRunnerMain {
    static func main() {
        do {
            let options = try parseArguments()
            try runFixtureBaseline(options: options)
        } catch let error as FixtureRunnerError {
            fputs("ERROR: \(error.description)\n", stderr)
            exit(1)
        } catch {
            fputs("ERROR: \(error)\n", stderr)
            exit(1)
        }
    }
}
