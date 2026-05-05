import {
  buildPSASlabScannerMatchFields,
  parsePSASlabLabel,
  parsePSASlabNativeAnalysis,
} from '../src/features/scanner/psa-slab-parser';

describe('psa slab parser', () => {
  it('prefers a barcode cert and recommends the psa cert lookup path', () => {
    const parsed = parsePSASlabLabel({
      labelTexts: [
        '1999 POKEMON GAME CHARIZARD-HOLO',
        'GEM MT 10 PSA 12345678',
        '#4',
      ],
      barcodePayloads: ['https://www.psacard.com/cert/7654321'],
    });

    expect(parsed.grader).toBe('PSA');
    expect(parsed.grade).toBe('10');
    expect(parsed.certNumber).toBe('7654321');
    expect(parsed.certConfidence).toBe(1);
    expect(parsed.evidenceSource).toBe('barcode');
    expect(parsed.recommendedLookupPath).toBe('psa_cert');
    expect(parsed.unsupportedReason).toBeNull();
  });

  it('parses a noisy psa cert and grade from OCR-only label text', () => {
    const parsed = parsePSASlabLabel({
      labelTexts: [
        'P:A 24681012',
        'NM MT 8',
        'POKEMON',
        '#15',
      ],
    });

    expect(parsed.grader).toBe('PSA');
    expect(parsed.grade).toBe('8');
    expect(parsed.certNumber).toBe('24681012');
    expect(parsed.evidenceSource).toBe('cert_ocr');
    expect(parsed.recommendedLookupPath).toBe('psa_cert');
    expect(parsed.reasons).toContain('noisy_partial_grader_psa_token');
  });

  it('maps PSA adjective-only labels to a deterministic grade', () => {
    const parsed = parsePSASlabLabel({
      labelTexts: [
        '1999 POKEMON GAME',
        'GEM MT',
        'PSA 1234567',
      ],
    });

    expect(parsed.grade).toBe('10');
    expect(parsed.gradeConfidence).toBeCloseTo(0.72);
    expect(parsed.reasons).toContain('grade_from_psa_adjective_only');
  });

  it('infers a psa 6 from a vintage ex-mt slab label with a noisy grader token', () => {
    const parsed = parsePSASlabLabel({
      labelTexts: [
        '1996 P.M. JAPANESE BASIC',
        '#6',
        'CHARIZARD-HOLO',
        'EX-MT 6 RLA 136802072',
      ],
    });

    expect(parsed.grader).toBe('PSA');
    expect(parsed.grade).toBe('6');
    expect(parsed.certNumber).toBe('136802072');
    expect(parsed.recommendedLookupPath).toBe('psa_cert');
    expect(parsed.unsupportedReason).toBeNull();
    expect(parsed.isPSAConfident).toBe(true);
  });

  it('returns explicit non-PSA detection instead of forcing PSA parsing', () => {
    const parsed = parsePSASlabLabel({
      labelTexts: [
        'CGC PRISTINE 10',
        'POKEMON',
        '1234567',
      ],
    });

    expect(parsed.grader).toBeNull();
    expect(parsed.grade).toBeNull();
    expect(parsed.certNumber).toBeNull();
    expect(parsed.explicitNonPSAGrader).toBe('CGC');
    expect(parsed.unsupportedReason).toBe('non_psa_slab_not_supported_yet');
    expect(parsed.recommendedLookupPath).toBe('needs_review');
    expect(parsed.isLikelySlab).toBe(true);
  });

  it('treats beckett-style subgrade layouts as non-PSA even without a literal beckett token', () => {
    const parsed = parsePSASlabLabel({
      labelTexts: [
        '1999-02 BLACK STAR PROMOS',
        '#9 MEW HOLO',
        '9.5 GEM MINT',
        'CENTERING 9.5 CORNERS 9 EDGES 9.5 SURFACE 10',
        '0012842409',
      ],
    });

    expect(parsed.grader).toBeNull();
    expect(parsed.grade).toBeNull();
    expect(parsed.certNumber).toBeNull();
    expect(parsed.explicitNonPSAGrader).toBe('BGS');
    expect(parsed.unsupportedReason).toBe('non_psa_slab_not_supported_yet');
    expect(parsed.recommendedLookupPath).toBe('needs_review');
    expect(parsed.isLikelySlab).toBe(true);
  });

  it('builds scanner match fields and preserves native observations in ocrAnalysis', () => {
    const nativeAnalysis = {
      width: 1200,
      height: 500,
      textBlocks: [
        { text: 'PSA 12345678', boundingBox: { x: 100, y: 40, width: 300, height: 40 } },
        { text: 'MINT 9', boundingBox: { x: 100, y: 90, width: 160, height: 40 } },
      ],
      barcodes: [
        { rawValue: '12345678', format: 'code128', boundingBox: { x: 800, y: 60, width: 220, height: 80 } },
      ],
    };

    const parsed = parsePSASlabNativeAnalysis(nativeAnalysis);
    const scannerMatchFields = buildPSASlabScannerMatchFields({
      nativeAnalysis,
      parsed,
    });

    expect(scannerMatchFields.slabGrader).toBe('PSA');
    expect(scannerMatchFields.slabGrade).toBe('9');
    expect(scannerMatchFields.slabCertNumber).toBe('12345678');
    expect(scannerMatchFields.slabRecommendedLookupPath).toBe('psa_cert');
    expect(scannerMatchFields.ocrAnalysis.textBlocks).toEqual(nativeAnalysis.textBlocks);
    expect(scannerMatchFields.ocrAnalysis.slabAnalysis).toMatchObject({
      grader: 'PSA',
      cert: '12345678',
      grade: '9',
    });
  });
});
