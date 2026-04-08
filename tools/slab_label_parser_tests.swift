import Foundation

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

func pikachuReferenceSignals() -> SlabVisualSignals {
    SlabVisualSignals(
        redBandConfidence: 0.93,
        barcodeRegionConfidence: 0.82,
        rightColumnConfidence: 0.71,
        whitePanelConfidence: 0.88
    )
}

func charizardReferenceSignals() -> SlabVisualSignals {
    SlabVisualSignals(
        redBandConfidence: 0.96,
        barcodeRegionConfidence: 0.80,
        rightColumnConfidence: 0.76,
        whitePanelConfidence: 0.84
    )
}

func cgcReferenceSignals() -> SlabVisualSignals {
    SlabVisualSignals(
        redBandConfidence: 0.04,
        barcodeRegionConfidence: 0.78,
        rightColumnConfidence: 0.74,
        whitePanelConfidence: 0.70
    )
}

func testExtractsPSAGuideSignals() {
    let analysis = SlabLabelParser.analyze(
        labelText: "2024 POKEMON SSP EN-SURGING SPARKS #238 PIKACHU ex SPECIAL ILLUSTRATION RARE PSA MINT 9 110045344",
        visualSignals: charizardReferenceSignals()
    )

    require(analysis.grader == "PSA", "should classify PSA labels")
    require(analysis.graderConfidence >= 0.99, "explicit PSA token should carry max confidence")
    require(analysis.grade == "9", "should parse PSA grade")
    require(analysis.certNumber == "110045344", "should parse 9-digit PSA cert numbers")
    require(analysis.verificationMethod == .certOCR, "should mark OCR cert extraction when no barcode is present")
    require(analysis.recommendedLookupPath == .psaCert, "explicit PSA labels should use cert lookup")
}

func testPrefersBarcodeCertWhenAvailable() {
    let analysis = SlabLabelParser.analyze(
        labelText: "PSA MINT 9 11004534A",
        barcodePayloads: ["https://www.psacard.com/cert/110045344"],
        visualSignals: charizardReferenceSignals()
    )

    require(analysis.certNumber == "110045344", "should prefer barcode-derived cert numbers over noisy OCR text")
    require(analysis.verificationMethod == .barcode, "should mark barcode verification when barcode payloads are available")
    require(analysis.certConfidence >= 0.99, "barcode certs should be trusted strongly")
}

func testClassifiesCGCVerificationPayloads() {
    let analysis = SlabLabelParser.analyze(
        labelText: "CGC PRISTINE 10 CHARIZARD",
        barcodePayloads: ["https://www.cgccards.com/certlookup/4259123007/"]
    )

    require(analysis.grader == "CGC", "should classify CGC verification payloads")
    require(analysis.certNumber == "4259123007", "should extract cert numbers from CGC verification URLs")
}

func testDetectsSlabLikeTextWithoutCert() {
    let analysis = SlabLabelParser.analyze(
        labelText: "1999 POKEMON GAME CHARIZARD HOLO PSA MINT 9"
    )

    require(analysis.isLikelySlab, "should treat grader-driven label text as slab-like even without a cert number")
    require(analysis.recommendedLookupPath == .labelTextSearch, "no cert should stay on label-text search")
}

func testParsesReferencePikachuYellowCheeksWithoutExplicitPSAToken() {
    let analysis = SlabLabelParser.analyze(
        labelText: "1999 POKEMON GAME #58 PIKACHU NM YELLOW CHEEKS 7 101048532",
        visualSignals: pikachuReferenceSignals()
    )

    require(analysis.grader == "PSA", "should infer PSA from scored Pikachu reference signals")
    require(analysis.graderConfidence >= 0.62, "Pikachu reference should meet PSA confidence threshold")
    require(analysis.grade == "7", "should parse PSA grade from NM 7 cert layout")
    require(analysis.certNumber == "101048532", "should extract yellow cheeks cert number")
    require(analysis.cardNumberRaw == "58", "should keep raw card number from label")
    require(analysis.recommendedLookupPath == .psaCert, "strong Pikachu label should route through cert lookup")
    require(analysis.reasons.contains("psa_red_band_detected"), "visual reasons should include red band")
    require(analysis.reasons.contains("barcode_region_detected"), "visual reasons should include barcode region")
}

func testParsesReferencePikachuYellowCheeksWithWeakPSALogoOCR() {
    let analysis = SlabLabelParser.analyze(
        labelText: "1999 POKEMON GAME #58 PIKACHU NM YELLOW CHEEKS 7 FEA 101048532",
        visualSignals: pikachuReferenceSignals()
    )

    require(analysis.grader == "PSA", "weak logo OCR should still infer PSA from scored signals")
    require(analysis.grade == "7", "weak logo OCR should still preserve grade parsing")
    require(analysis.recommendedLookupPath == .psaCert, "weak logo OCR should still route to cert lookup")
}

func testParsesReferenceCharizardLabel() {
    let analysis = SlabLabelParser.analyze(
        labelText: "1999 POKEMON GAME #4 CHARIZARD-HOLO PSA MINT 9 27319756",
        visualSignals: charizardReferenceSignals()
    )

    require(analysis.grader == "PSA", "Charizard reference should classify as PSA")
    require(analysis.grade == "9", "Charizard reference should parse grade 9")
    require(analysis.certNumber == "27319756", "Charizard reference should extract cert")
    require(analysis.recommendedLookupPath == .psaCert, "Charizard reference should use cert lookup")
}

func testParsesReferenceCgcNinetalesLabel() {
    let analysis = SlabLabelParser.analyze(
        labelText: "YACGC CERTIFIED GUARANTY COMPANY Ninetales Pokémon (1999) GEM MINT Base Set - Unlimited - 12/102 10 Holo 4236460045",
        barcodePayloads: ["4236460045"],
        visualSignals: cgcReferenceSignals()
    )

    require(analysis.grader == "CGC", "Ninetales reference should classify CGC")
    require(analysis.grade == "10", "Ninetales reference should parse grade 10")
    require(analysis.certNumber == "4236460045", "Ninetales reference should extract cert")
    require(analysis.cardNumberRaw == "12/102", "Ninetales reference should extract slash card number")
    require(analysis.recommendedLookupPath == .labelTextSearch, "CGC labels should route to label text search")
}

func testParsesReferenceCgcGyaradosLabel() {
    let analysis = SlabLabelParser.analyze(
        labelText: "CGC UNIVERSAL GRADE NM/Mint+ Gyarados 8.5 Pokémon (1999) Base Set - Shadowless - 6/102 Holo",
        visualSignals: cgcReferenceSignals()
    )

    require(analysis.grader == "CGC", "Gyarados reference should classify CGC")
    require(analysis.grade == "8.5", "Gyarados reference should parse grade 8.5")
    require(analysis.cardNumberRaw == "6/102", "Gyarados reference should extract slash card number")
    require(analysis.recommendedLookupPath == .labelTextSearch, "graded CGC label without cert should still use label text search")
}

func testNeedsReviewWhenSignalsAreWeakAndGraderMissing() {
    let analysis = SlabLabelParser.analyze(
        labelText: "1999 POKEMON GAME #58 PIKACHU YELLOW CHEEKS 101048532",
        visualSignals: .none
    )

    require(analysis.grader == nil, "weak label should not silently infer grader")
    require(analysis.recommendedLookupPath == .needsReview, "weak label should ask for review")
}

@main
struct SlabLabelParserTestRunner {
    static func main() {
        testExtractsPSAGuideSignals()
        testPrefersBarcodeCertWhenAvailable()
        testClassifiesCGCVerificationPayloads()
        testDetectsSlabLikeTextWithoutCert()
        testParsesReferencePikachuYellowCheeksWithoutExplicitPSAToken()
        testParsesReferencePikachuYellowCheeksWithWeakPSALogoOCR()
        testParsesReferenceCharizardLabel()
        testParsesReferenceCgcNinetalesLabel()
        testParsesReferenceCgcGyaradosLabel()
        testNeedsReviewWhenSignalsAreWeakAndGraderMissing()
        print("slab_label_parser_tests: PASS")
    }
}
