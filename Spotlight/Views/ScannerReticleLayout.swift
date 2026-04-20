import CoreGraphics

enum PSASlabGuidance {
    // Keep the full slab in frame, but only treat the top band as the primary
    // OCR label zone.
    static let labelDividerRatio: CGFloat = 0.28
}

enum ScannerPresentationMode: String, Equatable {
    case raw
    case slab

    mutating func toggle() {
        self = self == .raw ? .slab : .raw
    }

    fileprivate static var sharedFrameAspectRatio: CGFloat {
        88.0 / 63.0
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
        minimumTopSpacing: CGFloat? = nil,
        bottomTrim: CGFloat = 0,
        verticalOffset: CGFloat = 0,
        mode: ScannerPresentationMode
    ) -> ScannerReticleLayout {
        _ = mode
        let baseTopSpacing = max(safeAreaTop + 6, 64)
        let resolvedMinimumTopSpacing = minimumTopSpacing ?? max(24, safeAreaTop - 10)
        let topSpacing = max(resolvedMinimumTopSpacing, baseTopSpacing + verticalOffset)
        let controlsTopSpacing: CGFloat = 8
        let controlsHeight: CGFloat = 36
        let bottomClearance = max(containerSize.height * 0.015, 20) + safeAreaBottom
        let maxHeight = max(
            220,
            containerSize.height - baseTopSpacing - controlsTopSpacing - controlsHeight - bottomClearance
        )
        // Keep the same outer frame for raw and slab. Slab mode uses an
        // internal label guide rather than resizing the reticle itself.
        let widthFromSharedFrame = maxHeight / ScannerPresentationMode.sharedFrameAspectRatio
        let width = min(containerSize.width, widthFromSharedFrame)
        let baseHeight = width * ScannerPresentationMode.sharedFrameAspectRatio
        let height = max(220, baseHeight - bottomTrim)

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

func scaledReticleMeasurement(
    baseValue: CGFloat,
    containerHeight: CGFloat,
    referenceHeight: CGFloat = 844
) -> CGFloat {
    let scale = min(max(containerHeight / referenceHeight, 0.92), 1.08)
    return round(baseValue * scale)
}

func scaledReticleBottomTrim(
    baseTrim: CGFloat,
    containerHeight: CGFloat,
    referenceHeight: CGFloat = 844
) -> CGFloat {
    scaledReticleMeasurement(
        baseValue: baseTrim,
        containerHeight: containerHeight,
        referenceHeight: referenceHeight
    )
}

func scaledReticleCornerLift(
    baseLift: CGFloat,
    containerHeight: CGFloat,
    referenceHeight: CGFloat = 844
) -> CGFloat {
    scaledReticleMeasurement(
        baseValue: baseLift,
        containerHeight: containerHeight,
        referenceHeight: referenceHeight
    )
}

func resolvedReticleCaptureRect(
    preferred: CGRect,
    containerFrame: CGRect,
    layout: ScannerReticleLayout
) -> CGRect {
    if isValidReticleCaptureRect(preferred) {
        return preferred
    }

    return CGRect(
        x: containerFrame.midX - (layout.width / 2),
        y: containerFrame.minY + layout.topSpacing,
        width: layout.width,
        height: layout.height
    )
}

func isValidReticleCaptureRect(_ rect: CGRect) -> Bool {
    guard rect.minX.isFinite,
          rect.minY.isFinite,
          rect.width.isFinite,
          rect.height.isFinite else {
        return false
    }
    return !rect.isEmpty && rect.width > 1 && rect.height > 1
}
