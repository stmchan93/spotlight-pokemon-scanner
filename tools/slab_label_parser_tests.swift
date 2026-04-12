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

func testParsesLabelOnlyPSASlabText() {
    let analysis = SlabLabelParser.analyze(
        labelTexts: [
            "2002 POKEMON JAPANESE #007",
            "SQUIRTLE-HOLO GEM MT McDONALD'S 49377407 10"
        ],
        barcodePayloads: [],
        visualSignals: SlabVisualSignals(
            redBandConfidence: 0.90,
            barcodeRegionConfidence: 0.70,
            rightColumnConfidence: 0.78,
            whitePanelConfidence: 0.82
        )
    )

    require(analysis.grader == "PSA", "label-only path should still infer PSA")
    require(analysis.grade == "10", "label-only path should recover grade 10")
    require(analysis.certNumber == "49377407", "label-only path should recover cert")
    require(analysis.cardNumberRaw == "007", "label-only path should recover printed slab number")
    require(analysis.recommendedLookupPath == .psaCert, "label-only path should still prefer cert lookup")
}

func testIgnoresTagTeamTextOnPSASlab() {
    let analysis = SlabLabelParser.analyze(
        labelTexts: [
            "2019 P.M. SM BLACK STAR #SM168 PIKACHU & ZEKROM GX GEM MT PROMO-TAG TEAM TINS-FA 10 PSA 109121007",
            "LACK STAR #SM168 ROM GX GEM MT EAM TINS-FA 10 PA 109121007"
        ],
        barcodePayloads: [],
        visualSignals: .none
    )

    require(analysis.grader == "PSA", "TAG TEAM text should not suppress PSA grader detection")
    require(analysis.grade == "10", "should recover grade 10 from the PSA label")
    require(analysis.certNumber == "109121007", "should recover the cert number despite TAG TEAM text")
    require(analysis.cardNumberRaw == "SM168", "should preserve the SM promo card number")
    require(analysis.recommendedLookupPath == .psaCert, "PSA slab with a cert should stay on the cert path")
}

func testRecoversPSAFromPartialTokenNearCert() {
    let analysis = SlabLabelParser.analyze(
        labelTexts: [
            "2016 P.M. JPN. XY PROMO #230 PONCHO-WEAR.PIKACHU GEM MT RAYQUAZA P.W. PIKACHU BOX 10 PA 111274095",
            "XY PROMO #230 R.PIKACHU GEM MT N. PIKACHU BOX 10 PA 111274095"
        ],
        barcodePayloads: [],
        visualSignals: .none
    )

    require(analysis.grader == "PSA", "PA token before the cert should still infer PSA")
    require(analysis.grade == "10", "partial PSA token case should still recover grade 10")
    require(analysis.certNumber == "111274095", "partial PSA token case should still recover cert")
    require(analysis.recommendedLookupPath == .psaCert, "partial PSA token case should still prefer cert lookup")
}

func testPrefersCertAlignedGradeOverNoisyGemMtDigit() {
    let analysis = SlabLabelParser.analyze(
        labelTexts: [
            "2020 POKEMON SWSH #079 FA/CHARIZARD V GEM MT CHAMPION S PATH - SECRET 10 PSA 52300610",
            "ION SWSH #079 RD V GEM MT 5 PATH-SECRET 10 PA 52300610"
        ],
        barcodePayloads: [],
        visualSignals: .none
    )

    require(analysis.grade == "10", "grade should come from the cert-aligned PSA layout, not PATH noise")
    require(analysis.certNumber == "52300610", "grade noise case should still recover the cert")
}

func testPreservesSlashCardNumbers() {
    let analysis = SlabLabelParser.analyze(
        labelTexts: [
            "2013 POKEMON B & W #22/25 FA/RESHIRAM MINT LEG. TREAS. RADIANT COLL. 9 HIAA LI PEA 65147817",
            "ON B & W #22/25 L MINT ADIANT COLL. 9 FFA 65147817"
        ],
        barcodePayloads: [],
        visualSignals: .none
    )

    require(analysis.cardNumberRaw == "22/25", "slash card numbers should survive normalization")
    require(analysis.grade == "9", "slash card number case should still recover the grade")
    require(analysis.certNumber == "65147817", "slash card number case should still recover the cert")
}

@main
struct SlabLabelParserTestRunner {
    static func main() {
        testParsesPSAGradeWithNoisyTokenBeforePSALogo()
        testParsesLabelOnlyPSASlabText()
        testIgnoresTagTeamTextOnPSASlab()
        testRecoversPSAFromPartialTokenNearCert()
        testPrefersCertAlignedGradeOverNoisyGemMtDigit()
        testPreservesSlashCardNumbers()
        print("slab_label_parser_tests: PASS")
    }
}
