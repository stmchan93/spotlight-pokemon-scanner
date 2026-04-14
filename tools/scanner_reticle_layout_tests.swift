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

func testSlabReticleUsesFullPSABox() {
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

    requireNear(slab.width, raw.width, tolerance: 0.01, "slab reticle should keep the same width as raw")
    require(slab.height > raw.height, "slab reticle should be taller than raw")
}

func testSlabModeKeepsTopAnchorStableAndPushesControlsLower() {
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
    require(slabControlsTop > rawControlsTop, "slab mode should push the controls lower than raw")
}

func testRawAndSlabAspectRatiosMatchTargets() {
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
    requireNear(slab.height / slab.width, 5.375 / 3.25, tolerance: 0.01, "slab reticle should match slab aspect ratio")
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
        require(layout.bottomClearance >= 118 + 34, "layout should preserve generous tray clearance")
        let consumedHeight = layout.topSpacing
            + layout.height
            + layout.controlsTopSpacing
            + layout.controlsHeight
            + layout.bottomClearance
        require(consumedHeight <= container.height + 0.5, "layout should fit within the available vertical space")
    }
}

@main
struct ScannerReticleLayoutTestRunner {
    static func main() {
        testSlabReticleUsesFullPSABox()
        testSlabModeKeepsTopAnchorStableAndPushesControlsLower()
        testRawAndSlabAspectRatiosMatchTargets()
        testReticleLayoutPreservesBottomControlAndTraySpacing()
        print("scanner_reticle_layout_tests: PASS")
    }
}
