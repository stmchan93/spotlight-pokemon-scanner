import XCTest

@MainActor
final class ScanTrayVisibilityUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testScannerTrayTotalPillIsVisibleAboveBottomEdge() throws {
        let app = XCUIApplication()
        app.launchEnvironment["SPOTLIGHT_UI_TEST_MODE"] = "1"
        app.launchEnvironment["SPOTLIGHT_UI_TEST_BYPASS_AUTH"] = "1"
        app.launch()

        let tray = app.otherElements["scannerTray"]
        XCTAssertTrue(tray.waitForExistence(timeout: 5))

        let totalPill = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "$0.00"))
            .firstMatch
        XCTAssertTrue(totalPill.waitForExistence(timeout: 5))

        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 5))

        XCTAssertGreaterThan(totalPill.frame.height, 0)
        XCTAssertGreaterThan(totalPill.frame.minY, window.frame.minY)
        XCTAssertLessThan(totalPill.frame.maxY, window.frame.maxY - 24)
        XCTAssertGreaterThanOrEqual(totalPill.frame.minY, tray.frame.minY)
    }
}
