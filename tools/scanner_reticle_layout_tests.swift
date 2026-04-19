import CoreGraphics
import Foundation

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

func requireNear(_ lhs: CGFloat, _ rhs: CGFloat, tolerance: CGFloat, _ message: String) {
    require(abs(lhs - rhs) <= tolerance, message + " (\(lhs) vs \(rhs))")
}

func testSlabReticleUsesSharedOuterFrame() {
    let container = CGSize(width: 390, height: 844)
    let raw = ScannerReticleLayout.make(
        containerSize: container,
        safeAreaTop: 59,
        safeAreaBottom: 34,
        mode: .raw
    )
    let slab = ScannerReticleLayout.make(
        containerSize: container,
        safeAreaTop: 59,
        safeAreaBottom: 34,
        mode: .slab
    )

    requireNear(slab.width, raw.width, tolerance: 0.01, "raw and slab should share the same outer width")
    requireNear(slab.height, raw.height, tolerance: 0.01, "raw and slab should share the same outer height")
}

func testRawReticleMatchesPhoneBaselineSize() {
    let raw = ScannerReticleLayout.make(
        containerSize: CGSize(width: 390, height: 844),
        safeAreaTop: 59,
        safeAreaBottom: 34,
        mode: .raw
    )

    requireNear(raw.width, 390.0, tolerance: 0.2, "raw reticle width should match the committed phone baseline")
    requireNear(raw.height, 544.76, tolerance: 0.2, "raw reticle height should match the committed phone baseline")
}

func testSlabModeKeepsTopAnchorAndControlsStable() {
    let container = CGSize(width: 390, height: 844)
    let raw = ScannerReticleLayout.make(
        containerSize: container,
        safeAreaTop: 59,
        safeAreaBottom: 34,
        mode: .raw
    )
    let slab = ScannerReticleLayout.make(
        containerSize: container,
        safeAreaTop: 59,
        safeAreaBottom: 34,
        mode: .slab
    )

    requireNear(slab.topSpacing, raw.topSpacing, tolerance: 0.01, "top anchor should stay stable across modes")
    let rawControlsTop = raw.topSpacing + raw.height + raw.controlsTopSpacing
    let slabControlsTop = slab.topSpacing + slab.height + slab.controlsTopSpacing
    requireNear(slabControlsTop, rawControlsTop, tolerance: 0.01, "slab mode should not move the controls lower than raw")
}

func testRawAndSlabUseSharedOuterAspectRatio() {
    let container = CGSize(width: 390, height: 844)
    let raw = ScannerReticleLayout.make(
        containerSize: container,
        safeAreaTop: 59,
        safeAreaBottom: 34,
        mode: .raw
    )
    let slab = ScannerReticleLayout.make(
        containerSize: container,
        safeAreaTop: 59,
        safeAreaBottom: 34,
        mode: .slab
    )

    requireNear(raw.height / raw.width, 88.0 / 63.0, tolerance: 0.01, "raw reticle should match card aspect ratio")
    requireNear(slab.height / slab.width, 88.0 / 63.0, tolerance: 0.01, "slab reticle should keep the shared outer frame aspect ratio")
}

func testReticleLayoutPreservesBottomControlAndTraySpacing() {
    let container = CGSize(width: 390, height: 844)
    let raw = ScannerReticleLayout.make(
        containerSize: container,
        safeAreaTop: 59,
        safeAreaBottom: 34,
        mode: .raw
    )
    let slab = ScannerReticleLayout.make(
        containerSize: container,
        safeAreaTop: 59,
        safeAreaBottom: 34,
        mode: .slab
    )

    for layout in [raw, slab] {
        require(layout.bottomClearance >= 20 + 34, "layout should preserve tray clearance")
        let consumedHeight = layout.topSpacing
            + layout.height
            + layout.controlsTopSpacing
            + layout.controlsHeight
            + layout.bottomClearance
        require(consumedHeight <= container.height + 0.5, "layout should fit within the available vertical space")
    }
}

func testRawReticleStaysFullWidthOnShorterPhoneBaseline() {
    let raw = ScannerReticleLayout.make(
        containerSize: CGSize(width: 390, height: 812),
        safeAreaTop: 47,
        safeAreaBottom: 34,
        mode: .raw
    )

    requireNear(raw.width, 390.0, tolerance: 0.2, "raw reticle should remain full width on the shorter phone baseline")
}

func testResolvedReticleCaptureRectUsesMeasuredReticleBoundsWhenValid() {
    let preferred = CGRect(x: 24, y: 140, width: 300, height: 420)
    let resolved = resolvedReticleCaptureRect(
        preferred: preferred,
        containerFrame: CGRect(x: 0, y: 0, width: 390, height: 844),
        layout: ScannerReticleLayout(
            width: 327.6,
            height: 457.28,
            topSpacing: 137,
            controlsTopSpacing: 16,
            controlsHeight: 36,
            bottomClearance: 152
        )
    )

    require(resolved.equalTo(preferred), "capture rect should reuse measured reticle bounds when available")
}

func testResolvedReticleCaptureRectFallsBackToLayoutFrameWhenBoundsMissing() {
    let layout = ScannerReticleLayout(
        width: 327.6,
        height: 457.28,
        topSpacing: 137,
        controlsTopSpacing: 16,
        controlsHeight: 36,
        bottomClearance: 152
    )
    let resolved = resolvedReticleCaptureRect(
        preferred: .zero,
        containerFrame: CGRect(x: 0, y: 0, width: 390, height: 844),
        layout: layout
    )

    requireNear(resolved.origin.x, 31.2, tolerance: 0.2, "fallback capture rect should stay horizontally centered")
    requireNear(resolved.origin.y, 137, tolerance: 0.2, "fallback capture rect should align to the reticle top spacing")
    requireNear(resolved.width, layout.width, tolerance: 0.01, "fallback capture rect should keep the layout width")
    requireNear(resolved.height, layout.height, tolerance: 0.01, "fallback capture rect should keep the layout height")
}

@main
struct ScannerReticleLayoutTestRunner {
    static func main() {
        testSlabReticleUsesSharedOuterFrame()
        testRawReticleMatchesPhoneBaselineSize()
        testSlabModeKeepsTopAnchorAndControlsStable()
        testRawAndSlabUseSharedOuterAspectRatio()
        testReticleLayoutPreservesBottomControlAndTraySpacing()
        testRawReticleStaysFullWidthOnShorterPhoneBaseline()
        testResolvedReticleCaptureRectUsesMeasuredReticleBoundsWhenValid()
        testResolvedReticleCaptureRectFallsBackToLayoutFrameWhenBoundsMissing()
        print("scanner_reticle_layout_tests: PASS")
    }
}
