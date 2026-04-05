import Foundation
import ImageIO
import Vision

private struct FeaturePrintPayload: Codable {
    let modelID: String
    let dimension: Int
    let width: Int
    let height: Int
    let vector: [Float]
}

private enum FeaturePrintError: LocalizedError {
    case invalidArguments
    case imageLoadFailed
    case featurePrintUnavailable
    case rawDataUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            "Usage: vision_featureprint --image /absolute/path/to/image.png"
        case .imageLoadFailed:
            "The image could not be loaded."
        case .featurePrintUnavailable:
            "Vision did not return a feature print for the image."
        case .rawDataUnavailable:
            "Vision did not expose raw feature-print data."
        }
    }
}

private func parseArguments() throws -> String {
    var iterator = CommandLine.arguments.dropFirst().makeIterator()
    while let argument = iterator.next() {
        if argument == "--image", let imagePath = iterator.next() {
            return imagePath
        }
    }

    throw FeaturePrintError.invalidArguments
}

private func buildPayload(forImageAtPath imagePath: String) throws -> FeaturePrintPayload {
    let imageURL = URL(fileURLWithPath: imagePath)
    guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
          let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw FeaturePrintError.imageLoadFailed
    }

    let request = VNGenerateImageFeaturePrintRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])

    guard let observation = request.results?.first else {
        throw FeaturePrintError.featurePrintUnavailable
    }

    guard let rawData = observation.value(forKey: "data") as? Data else {
        throw FeaturePrintError.rawDataUnavailable
    }

    let vector: [Float] = rawData.withUnsafeBytes { rawBuffer in
        let floatBuffer = rawBuffer.bindMemory(to: Float.self)
        return Array(floatBuffer)
    }

    return FeaturePrintPayload(
        modelID: "apple-vision-featureprint-v1",
        dimension: vector.count,
        width: cgImage.width,
        height: cgImage.height,
        vector: normalized(vector)
    )
}

private func normalized(_ vector: [Float]) -> [Float] {
    let norm = sqrt(vector.reduce(Float.zero) { partial, value in
        partial + value * value
    })

    guard norm > 0 else { return vector }
    return vector.map { $0 / norm }
}

do {
    let imagePath = try parseArguments()
    let payload = try buildPayload(forImageAtPath: imagePath)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(payload))
} catch {
    let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    FileHandle.standardError.write(Data((message + "\n").utf8))
    Foundation.exit(1)
}
