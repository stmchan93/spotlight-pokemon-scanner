import AppKit
import Foundation

struct OverlayNormalizedRect: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    func imageRect(for imageSize: CGSize) -> CGRect {
        CGRect(
            x: x * imageSize.width,
            y: (1.0 - y - height) * imageSize.height,
            width: width * imageSize.width,
            height: height * imageSize.height
        )
    }
}

struct OverlayBox: Codable {
    let label: String
    let role: String
    let normalizedRect: OverlayNormalizedRect
    let colorHex: String
    let dashed: Bool
    let lineWidth: Double
}

struct OverlayVariant: Codable {
    let name: String
    let description: String
    let boxes: [OverlayBox]
}

struct OverlayManifest: Codable {
    let stage: String
    let imageFilename: String
    let imageWidth: Int
    let imageHeight: Int
    let variants: [OverlayVariant]
}

enum FooterOverlayDiagnostic {
    static let preferredNormalizedFilenames = [
        "06_ocr_input_normalized.jpg",
        "normalized.jpg",
        "source_scan.jpg",
    ]
    static let manifestFilename = "footer_subroi_layouts.json"

    static let referenceBoxes: [OverlayBox] = [
        OverlayBox(
            label: "current footerLeft",
            role: "reference",
            normalizedRect: OverlayNormalizedRect(x: 0.075, y: 0.868, width: 0.398, height: 0.088),
            colorHex: "#F59E0B",
            dashed: true,
            lineWidth: 2.0
        ),
        OverlayBox(
            label: "current footerRight",
            role: "reference",
            normalizedRect: OverlayNormalizedRect(x: 0.600, y: 0.845, width: 0.310, height: 0.108),
            colorHex: "#A855F7",
            dashed: true,
            lineWidth: 2.0
        )
    ]

    static let candidateVariants: [OverlayVariant] = [
        OverlayVariant(
            name: "left_metadata_compact",
            description: "Compact left-biased badge/collector split plus a narrow right fallback for modern layouts.",
            boxes: [
                OverlayBox(
                    label: "left set badge",
                    role: "set_badge_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.055, y: 0.905, width: 0.14, height: 0.065),
                    colorHex: "#22C55E",
                    dashed: false,
                    lineWidth: 3.0
                ),
                OverlayBox(
                    label: "left collector",
                    role: "collector_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.18, y: 0.905, width: 0.24, height: 0.065),
                    colorHex: "#0EA5E9",
                    dashed: false,
                    lineWidth: 3.0
                ),
                OverlayBox(
                    label: "right metadata fallback",
                    role: "right_fallback",
                    normalizedRect: OverlayNormalizedRect(x: 0.58, y: 0.895, width: 0.22, height: 0.075),
                    colorHex: "#EF4444",
                    dashed: false,
                    lineWidth: 3.0
                )
            ]
        ),
        OverlayVariant(
            name: "left_metadata_generous",
            description: "More forgiving left-biased split intended to reveal whether one fixed left layout can cover multiple eras.",
            boxes: [
                OverlayBox(
                    label: "left set badge",
                    role: "set_badge_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.040, y: 0.890, width: 0.17, height: 0.090),
                    colorHex: "#22C55E",
                    dashed: false,
                    lineWidth: 3.0
                ),
                OverlayBox(
                    label: "left collector",
                    role: "collector_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.165, y: 0.890, width: 0.30, height: 0.090),
                    colorHex: "#0EA5E9",
                    dashed: false,
                    lineWidth: 3.0
                ),
                OverlayBox(
                    label: "right metadata fallback",
                    role: "right_fallback",
                    normalizedRect: OverlayNormalizedRect(x: 0.545, y: 0.885, width: 0.29, height: 0.095),
                    colorHex: "#EF4444",
                    dashed: false,
                    lineWidth: 3.0
                )
            ]
        ),
        OverlayVariant(
            name: "right_metadata_generous",
            description: "Right-biased fallback layout for older cards whose footer identity fields shift away from the left corner.",
            boxes: [
                OverlayBox(
                    label: "left collector probe",
                    role: "collector_probe",
                    normalizedRect: OverlayNormalizedRect(x: 0.145, y: 0.892, width: 0.24, height: 0.088),
                    colorHex: "#0EA5E9",
                    dashed: false,
                    lineWidth: 3.0
                ),
                OverlayBox(
                    label: "right metadata primary",
                    role: "right_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.520, y: 0.885, width: 0.32, height: 0.100),
                    colorHex: "#EF4444",
                    dashed: false,
                    lineWidth: 3.0
                )
            ]
        ),
        OverlayVariant(
            name: "left_metadata_shifted",
            description: "Adjusted left-biased layout from fixture review: move badge and collector slightly up and right relative to the generous variant.",
            boxes: [
                OverlayBox(
                    label: "left set badge",
                    role: "set_badge_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.075, y: 0.868, width: 0.16, height: 0.088),
                    colorHex: "#22C55E",
                    dashed: false,
                    lineWidth: 3.0
                ),
                OverlayBox(
                    label: "left collector",
                    role: "collector_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.188, y: 0.870, width: 0.285, height: 0.086),
                    colorHex: "#0EA5E9",
                    dashed: false,
                    lineWidth: 3.0
                ),
                OverlayBox(
                    label: "right metadata fallback",
                    role: "right_fallback",
                    normalizedRect: OverlayNormalizedRect(x: 0.565, y: 0.872, width: 0.27, height: 0.095),
                    colorHex: "#EF4444",
                    dashed: false,
                    lineWidth: 3.0
                )
            ]
        ),
        OverlayVariant(
            name: "right_metadata_shifted",
            description: "Older/right-biased layout from fixture review: set symbol lives mid-right and collector number sits deeper in the bottom-right corner.",
            boxes: [
                OverlayBox(
                    label: "right set badge",
                    role: "set_badge_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.60, y: 0.845, width: 0.15, height: 0.105),
                    colorHex: "#22C55E",
                    dashed: false,
                    lineWidth: 3.0
                ),
                OverlayBox(
                    label: "right collector",
                    role: "collector_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.73, y: 0.858, width: 0.18, height: 0.095),
                    colorHex: "#0EA5E9",
                    dashed: false,
                    lineWidth: 3.0
                )
            ]
        ),
        OverlayVariant(
            name: "left_metadata_refined",
            description: "Second-wave left-family layout: move the badge up and right, and lift the collector slightly while trimming far-left noise.",
            boxes: [
                OverlayBox(
                    label: "left set badge",
                    role: "set_badge_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.100, y: 0.855, width: 0.150, height: 0.095),
                    colorHex: "#22C55E",
                    dashed: false,
                    lineWidth: 3.0
                ),
                OverlayBox(
                    label: "left collector",
                    role: "collector_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.178, y: 0.858, width: 0.282, height: 0.090),
                    colorHex: "#0EA5E9",
                    dashed: false,
                    lineWidth: 3.0
                ),
                OverlayBox(
                    label: "right metadata fallback",
                    role: "right_fallback",
                    normalizedRect: OverlayNormalizedRect(x: 0.570, y: 0.868, width: 0.265, height: 0.095),
                    colorHex: "#EF4444",
                    dashed: false,
                    lineWidth: 3.0
                )
            ]
        ),
        OverlayVariant(
            name: "right_metadata_mid_badge",
            description: "Second-wave right-family variant for older cards whose set badge sits mid-right while the collector remains in the lower-right corner.",
            boxes: [
                OverlayBox(
                    label: "right set badge",
                    role: "set_badge_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.630, y: 0.840, width: 0.145, height: 0.105),
                    colorHex: "#22C55E",
                    dashed: false,
                    lineWidth: 3.0
                ),
                OverlayBox(
                    label: "right collector",
                    role: "collector_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.720, y: 0.850, width: 0.185, height: 0.100),
                    colorHex: "#0EA5E9",
                    dashed: false,
                    lineWidth: 3.0
                )
            ]
        ),
        OverlayVariant(
            name: "right_metadata_corner_badge",
            description: "Second-wave right-family variant for cards whose set badge sits closer to the bottom-right corner than the mid-right layout.",
            boxes: [
                OverlayBox(
                    label: "right set badge",
                    role: "set_badge_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.675, y: 0.845, width: 0.135, height: 0.100),
                    colorHex: "#22C55E",
                    dashed: false,
                    lineWidth: 3.0
                ),
                OverlayBox(
                    label: "right collector",
                    role: "collector_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.720, y: 0.850, width: 0.185, height: 0.100),
                    colorHex: "#0EA5E9",
                    dashed: false,
                    lineWidth: 3.0
                )
            ]
        ),
        OverlayVariant(
            name: "left_metadata_balanced",
            description: "Third-wave left-family candidate: shift the badge farther right, lift both boxes slightly, and pull the collector back left from the overrun cases.",
            boxes: [
                OverlayBox(
                    label: "left set badge",
                    role: "set_badge_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.118, y: 0.845, width: 0.138, height: 0.098),
                    colorHex: "#22C55E",
                    dashed: false,
                    lineWidth: 3.0
                ),
                OverlayBox(
                    label: "left collector",
                    role: "collector_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.170, y: 0.850, width: 0.275, height: 0.092),
                    colorHex: "#0EA5E9",
                    dashed: false,
                    lineWidth: 3.0
                ),
                OverlayBox(
                    label: "right metadata fallback",
                    role: "right_fallback",
                    normalizedRect: OverlayNormalizedRect(x: 0.570, y: 0.868, width: 0.265, height: 0.095),
                    colorHex: "#EF4444",
                    dashed: false,
                    lineWidth: 3.0
                )
            ]
        ),
        OverlayVariant(
            name: "right_metadata_mid_badge_refined",
            description: "Third-wave right-mid candidate: move the badge farther right while keeping the collector near the same successful lower-right lane.",
            boxes: [
                OverlayBox(
                    label: "right set badge",
                    role: "set_badge_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.665, y: 0.842, width: 0.125, height: 0.102),
                    colorHex: "#22C55E",
                    dashed: false,
                    lineWidth: 3.0
                ),
                OverlayBox(
                    label: "right collector",
                    role: "collector_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.720, y: 0.850, width: 0.185, height: 0.100),
                    colorHex: "#0EA5E9",
                    dashed: false,
                    lineWidth: 3.0
                )
            ]
        ),
        OverlayVariant(
            name: "right_metadata_corner_badge_refined",
            description: "Third-wave right-corner candidate: push the badge into the corner lane and lift the collector slightly up and left for RC-era cases.",
            boxes: [
                OverlayBox(
                    label: "right set badge",
                    role: "set_badge_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.705, y: 0.836, width: 0.115, height: 0.105),
                    colorHex: "#22C55E",
                    dashed: false,
                    lineWidth: 3.0
                ),
                OverlayBox(
                    label: "right collector",
                    role: "collector_primary",
                    normalizedRect: OverlayNormalizedRect(x: 0.705, y: 0.842, width: 0.190, height: 0.102),
                    colorHex: "#0EA5E9",
                    dashed: false,
                    lineWidth: 3.0
                )
            ]
        )
    ]
}

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("error: \(message)\n", stderr)
        exit(1)
    }
}

func color(from hex: String) -> NSColor {
    let cleaned = hex.replacingOccurrences(of: "#", with: "")
    guard cleaned.count == 6, let value = Int(cleaned, radix: 16) else {
        return .systemPink
    }

    let red = CGFloat((value >> 16) & 0xFF) / 255.0
    let green = CGFloat((value >> 8) & 0xFF) / 255.0
    let blue = CGFloat(value & 0xFF) / 255.0
    return NSColor(calibratedRed: red, green: green, blue: blue, alpha: 1.0)
}

func discoverScanDirectories(from inputPaths: [String]) -> [URL] {
    let fileManager = FileManager.default
    var results: [URL] = []
    var seen: Set<String> = []

    for inputPath in inputPaths {
        let expandedPath = NSString(string: inputPath).expandingTildeInPath
        let inputURL = URL(fileURLWithPath: expandedPath)
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: inputURL.path, isDirectory: &isDirectory) else {
            fputs("warning: path does not exist, skipping: \(inputURL.path)\n", stderr)
            continue
        }

        if !isDirectory.boolValue {
            continue
        }

        if resolvedNormalizedImageURL(in: inputURL) != nil {
            if seen.insert(inputURL.path).inserted {
                results.append(inputURL)
            }
            continue
        }

        let enumerator = fileManager.enumerator(
            at: inputURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )

        while let descendant = enumerator?.nextObject() as? URL {
            if !FooterOverlayDiagnostic.preferredNormalizedFilenames.contains(descendant.lastPathComponent) {
                continue
            }
            let directoryURL = descendant.deletingLastPathComponent()
            if seen.insert(directoryURL.path).inserted {
                results.append(directoryURL)
            }
        }
    }

    return results.sorted { $0.path < $1.path }
}

func resolvedNormalizedImageURL(in scanDirectory: URL) -> URL? {
    let fileManager = FileManager.default
    for candidateName in FooterOverlayDiagnostic.preferredNormalizedFilenames {
        let candidateURL = scanDirectory.appendingPathComponent(candidateName)
        if fileManager.fileExists(atPath: candidateURL.path) {
            return candidateURL
        }
    }
    return nil
}

func drawOverlay(
    on baseImage: NSImage,
    imageSize: CGSize,
    variant: OverlayVariant
) -> NSImage {
    let outputImage = NSImage(size: imageSize)
    outputImage.lockFocus()

    baseImage.draw(
        in: CGRect(origin: .zero, size: imageSize),
        from: CGRect(origin: .zero, size: imageSize),
        operation: .sourceOver,
        fraction: 1.0
    )

    guard let context = NSGraphicsContext.current?.cgContext else {
        outputImage.unlockFocus()
        return outputImage
    }

    context.setShouldAntialias(true)

    for box in FooterOverlayDiagnostic.referenceBoxes + variant.boxes {
        let rect = box.normalizedRect.imageRect(for: imageSize)
        let strokeColor = color(from: box.colorHex).cgColor
        context.setStrokeColor(strokeColor)
        context.setLineWidth(CGFloat(box.lineWidth))
        if box.dashed {
            context.setLineDash(phase: 0, lengths: [10, 6])
        } else {
            context.setLineDash(phase: 0, lengths: [])
        }
        context.stroke(rect)
        drawLabel(box.label, colorHex: box.colorHex, at: rect, imageSize: imageSize)
    }

    drawVariantTitle(variant, imageSize: imageSize)

    outputImage.unlockFocus()
    return outputImage
}

func drawVariantTitle(_ variant: OverlayVariant, imageSize: CGSize) {
    let title = "\(variant.name): \(variant.description)"
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byTruncatingTail

    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedSystemFont(ofSize: 15, weight: .bold),
        .foregroundColor: NSColor.white,
        .paragraphStyle: paragraph
    ]

    let badgeRect = CGRect(x: 12, y: imageSize.height - 34, width: imageSize.width - 24, height: 22)
    let backgroundPath = NSBezierPath(roundedRect: badgeRect.insetBy(dx: -6, dy: -4), xRadius: 8, yRadius: 8)
    NSColor.black.withAlphaComponent(0.72).setFill()
    backgroundPath.fill()
    title.draw(in: badgeRect, withAttributes: attrs)
}

func drawLabel(_ text: String, colorHex: String, at rect: CGRect, imageSize: CGSize) {
    let labelAttrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .semibold),
        .foregroundColor: NSColor.white
    ]

    let labelOrigin = CGPoint(
        x: max(8, rect.minX + 6),
        y: min(imageSize.height - 18, rect.maxY + 4)
    )
    let textSize = (text as NSString).size(withAttributes: labelAttrs)
    let backgroundRect = CGRect(
        x: labelOrigin.x - 4,
        y: labelOrigin.y - 2,
        width: textSize.width + 8,
        height: textSize.height + 4
    )

    let path = NSBezierPath(roundedRect: backgroundRect, xRadius: 6, yRadius: 6)
    color(from: colorHex).withAlphaComponent(0.80).setFill()
    path.fill()

    text.draw(at: labelOrigin, withAttributes: labelAttrs)
}

func jpegData(for image: NSImage) -> Data? {
    guard let tiffData = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiffData) else {
        return nil
    }

    return bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.92])
}

func writeManifest(for scanDirectory: URL, imageSize: CGSize) throws {
    guard let normalizedURL = resolvedNormalizedImageURL(in: scanDirectory) else {
        throw NSError(domain: "FooterOverlayDiagnostic", code: 4, userInfo: [
            NSLocalizedDescriptionKey: "No normalized image found in \(scanDirectory.path)"
        ])
    }

    let manifest = OverlayManifest(
        stage: "footer_metadata_subroi_diagnostic",
        imageFilename: normalizedURL.lastPathComponent,
        imageWidth: Int(imageSize.width.rounded()),
        imageHeight: Int(imageSize.height.rounded()),
        variants: FooterOverlayDiagnostic.candidateVariants.map { variant in
            OverlayVariant(
                name: variant.name,
                description: variant.description,
                boxes: FooterOverlayDiagnostic.referenceBoxes + variant.boxes
            )
        }
    )

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try encoder.encode(manifest)
    try data.write(to: scanDirectory.appendingPathComponent(FooterOverlayDiagnostic.manifestFilename), options: .atomic)
}

func process(scanDirectory: URL) throws {
    guard let normalizedURL = resolvedNormalizedImageURL(in: scanDirectory) else {
        throw NSError(domain: "FooterOverlayDiagnostic", code: 5, userInfo: [
            NSLocalizedDescriptionKey: "No normalized image found in \(scanDirectory.path)"
        ])
    }
    guard let baseImage = NSImage(contentsOf: normalizedURL) else {
        throw NSError(domain: "FooterOverlayDiagnostic", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Failed to load normalized image at \(normalizedURL.path)"
        ])
    }

    guard let rep = baseImage.representations.first else {
        throw NSError(domain: "FooterOverlayDiagnostic", code: 2, userInfo: [
            NSLocalizedDescriptionKey: "Failed to inspect image representation for \(normalizedURL.path)"
        ])
    }

    let imageSize = CGSize(width: rep.pixelsWide, height: rep.pixelsHigh)
    require(imageSize.width > 0 && imageSize.height > 0, "normalized image has invalid size: \(normalizedURL.path)")

    try writeManifest(for: scanDirectory, imageSize: imageSize)

    for (index, variant) in FooterOverlayDiagnostic.candidateVariants.enumerated() {
        let overlay = drawOverlay(on: baseImage, imageSize: imageSize, variant: variant)
        guard let data = jpegData(for: overlay) else {
            throw NSError(domain: "FooterOverlayDiagnostic", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode overlay for \(scanDirectory.path)"
            ])
        }

        let filename = String(format: "%02d_footer_subroi_overlay_%@.jpg", 16 + index, variant.name)
        try data.write(to: scanDirectory.appendingPathComponent(filename), options: .atomic)
        print("wrote \(scanDirectory.lastPathComponent)/\(filename)")
    }

    print("wrote \(scanDirectory.lastPathComponent)/\(FooterOverlayDiagnostic.manifestFilename)")
}

@main
struct FooterMetadataOverlayDiagnosticTool {
    static func main() throws {
        let inputPaths = Array(CommandLine.arguments.dropFirst())
        require(!inputPaths.isEmpty, "usage: footer_metadata_overlay_diagnostic <scan-folder-or-root> [more paths...]")

        let scanDirectories = discoverScanDirectories(from: inputPaths)
        require(
            !scanDirectories.isEmpty,
            "no scan folders containing \(FooterOverlayDiagnostic.preferredNormalizedFilenames.joined(separator: " or ")) were found"
        )

        for scanDirectory in scanDirectories {
            try process(scanDirectory: scanDirectory)
        }
    }
}
