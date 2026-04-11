import Foundation

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

func testParsesExactPrefixedCollectorNumber() {
    let parser = CardIdentifierParser()
    let parsed = parser.parse(text: "TG29/TG30 *", sourceRegion: "bottom-left")

    require(parsed?.identifier == "TG29/TG30", "should preserve exact prefixed collector numbers")
}

func testRecoversNoisyPrefixedCollectorNumber() {
    let parser = CardIdentifierParser()
    let parsed = parser.parse(text: "ТG29/1630 *", sourceRegion: "bottom-left")

    require(parsed?.identifier == "TG29/TG30", "should recover noisy prefixed collector numbers")
}

func testParsesJapaneseSecretRareCollectorNumber() {
    let parser = CardIdentifierParser()
    let parsed = parser.parse(text: "F 077/071 CHR", sourceRegion: "bottom-left")

    require(parsed?.identifier == "077/071", "should preserve secret rare collector numbers")
}

func testParsesPromoCollectorNumberWithoutSlash() {
    let parser = CardIdentifierParser()
    let parsed = parser.parse(text: "© SWSH286", sourceRegion: "bottom-left")

    require(parsed?.identifier == "SWSH286", "should parse promo collector numbers without slash")
}

func testPrefersExactStandardCollectorNumberOverWeaknessNoise() {
    let parser = CardIdentifierParser()
    let parsed = parser.parse(text: "x2 011/078 2972 Na", sourceRegion: "bottom-left")

    require(parsed?.identifier == "011/078", "should prefer exact standard collector numbers over x2 weakness noise")
}

func testRepairsSplitLeadingZeroStandardCollectorNumber() {
    let parser = CardIdentifierParser()
    let parsed = parser.parse(text: "01 1/078 20021", sourceRegion: "bottom-left")

    require(parsed?.identifier == "011/078", "should repair split leading-zero standard collector numbers")
}

func testCollapsesRepeatedSlashInStandardCollectorNumber() {
    let parser = CardIdentifierParser()
    let parsed = parser.parse(text: "U DRIM 199//182", sourceRegion: "bottom-left")

    require(parsed?.identifier == "199/182", "should collapse repeated slashes in standard collector numbers")
}

@main
struct CardIdentifierParserTestRunner {
    static func main() {
        testParsesExactPrefixedCollectorNumber()
        testRecoversNoisyPrefixedCollectorNumber()
        testParsesJapaneseSecretRareCollectorNumber()
        testParsesPromoCollectorNumberWithoutSlash()
        testPrefersExactStandardCollectorNumberOverWeaknessNoise()
        testRepairsSplitLeadingZeroStandardCollectorNumber()
        testCollapsesRepeatedSlashInStandardCollectorNumber()
        print("card_identifier_parser_tests: PASS")
    }
}
