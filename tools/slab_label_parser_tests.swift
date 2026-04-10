import Foundation

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

func testParsesPSAGradeWithNoisyTokenBeforePSALogo() {
    let analysis = SlabLabelParser.analyze(
        labelTexts: [
            "2022 POKEMON GO #010 CHARIZARD-HOLO NM 7 111 PSA 103377816",
            "#010 NM"
        ],
        barcodePayloads: [],
        visualSignals: .none
    )

    require(analysis.grader == "PSA", "should detect PSA grader")
    require(analysis.grade == "7", "should recover grade 7 despite noisy token before PSA")
    require(analysis.certNumber == "103377816", "should detect the PSA cert number")
    require(analysis.cardNumberRaw == "010", "should keep the slab label card number")
    require(analysis.recommendedLookupPath == .psaCert, "should prefer the PSA cert lookup path")
}

@main
struct SlabLabelParserTestRunner {
    static func main() {
        testParsesPSAGradeWithNoisyTokenBeforePSALogo()
        print("slab_label_parser_tests: PASS")
    }
}
