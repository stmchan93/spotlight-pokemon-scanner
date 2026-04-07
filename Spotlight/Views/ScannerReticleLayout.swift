import CoreGraphics

enum ScannerPresentationMode: String, Equatable {
    case raw
    case slab

    var title: String {
        switch self {
        case .raw:
            return "Scanning: Raw"
        case .slab:
            return "Scanning: Slab"
        }
    }

    mutating func toggle() {
        self = self == .raw ? .slab : .raw
    }

    fileprivate var aspectRatio: CGFloat {
        switch self {
        case .raw:
            return 88.0 / 63.0
        case .slab:
            return 5.375 / 3.25
        }
    }

    fileprivate static var tallestAspectRatio: CGFloat {
        5.375 / 3.25
    }
}

struct ScannerReticleLayout: Equatable {
    let width: CGFloat
    let height: CGFloat
    let topSpacing: CGFloat
    let controlsTopSpacing: CGFloat
    let controlsHeight: CGFloat
    let bottomClearance: CGFloat

    var centerY: CGFloat {
        topSpacing + (height / 2)
    }

    static func make(
        containerSize: CGSize,
        safeAreaTop: CGFloat,
        safeAreaBottom: CGFloat,
        mode: ScannerPresentationMode
    ) -> ScannerReticleLayout {
        let topSpacing = max(safeAreaTop + 78, 128)
        let controlsTopSpacing: CGFloat = 16
        let controlsHeight: CGFloat = 36
        let bottomClearance = max(containerSize.height * 0.14, 118) + safeAreaBottom
        let maxHeight = max(
            220,
            containerSize.height - topSpacing - controlsTopSpacing - controlsHeight - bottomClearance
        )
        // Keep width stable between raw/slab modes; slab should grow by height, not shrink by width.
        let widthFromTallestMode = maxHeight / ScannerPresentationMode.tallestAspectRatio
        let width = min(containerSize.width * 0.84, 400, widthFromTallestMode)
        let height = width * mode.aspectRatio

        return ScannerReticleLayout(
            width: width,
            height: height,
            topSpacing: topSpacing,
            controlsTopSpacing: controlsTopSpacing,
            controlsHeight: controlsHeight,
            bottomClearance: bottomClearance
        )
    }
}
