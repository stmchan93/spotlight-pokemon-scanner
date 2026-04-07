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

@main
struct CardIdentifierParserTestRunner {
    static func main() {
        testParsesExactPrefixedCollectorNumber()
        testRecoversNoisyPrefixedCollectorNumber()
        testParsesJapaneseSecretRareCollectorNumber()
        testParsesPromoCollectorNumberWithoutSlash()
        print("card_identifier_parser_tests: PASS")
    }
}
