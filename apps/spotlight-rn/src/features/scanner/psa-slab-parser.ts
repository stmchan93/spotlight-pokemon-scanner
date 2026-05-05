export type PSASlabEvidenceSource = 'barcode' | 'cert_ocr' | 'label_ocr' | 'none';

export type PSASlabRecommendedLookupPath = 'psa_cert' | 'label_text_search' | 'needs_review';

export type PSASlabUnsupportedReason =
  | 'non_psa_slab_not_supported_yet'
  | 'psa_label_not_confident_enough';

export type PSASlabVisualSignals = {
  redBandConfidence: number;
  barcodeRegionConfidence: number;
  rightColumnConfidence: number;
  whitePanelConfidence: number;
};

export type PSASlabBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PSASlabTextBlockObservation = {
  text: string;
  boundingBox?: PSASlabBoundingBox | null;
};

export type PSASlabBarcodeObservation = {
  rawValue: string;
  format?: string | null;
  boundingBox?: PSASlabBoundingBox | null;
};

export type PSASlabNativeAnalysis = {
  width: number;
  height: number;
  textBlocks: PSASlabTextBlockObservation[];
  barcodes: PSASlabBarcodeObservation[];
};

export type ParsedPSASlabLabel = {
  parsedLabelText: string[];
  normalizedLabelText: string;
  grader: 'PSA' | null;
  graderConfidence: number;
  grade: string | null;
  gradeRaw: string | null;
  gradeConfidence: number;
  certNumber: string | null;
  certNumberRaw: string | null;
  certConfidence: number;
  cardNumberRaw: string | null;
  barcodePayloads: string[];
  evidenceSource: PSASlabEvidenceSource;
  visualSignals: PSASlabVisualSignals;
  reasons: string[];
  recommendedLookupPath: PSASlabRecommendedLookupPath;
  isPSAConfident: boolean;
  isLikelySlab: boolean;
  unsupportedReason: PSASlabUnsupportedReason | null;
  explicitNonPSAGrader: 'CGC' | 'BGS' | 'TAG' | 'SGC' | null;
};

export type PSASlabScannerMatchFields = {
  slabGrader: 'PSA' | null;
  slabGrade: string | null;
  slabCertNumber: string | null;
  slabBarcodePayloads: string[];
  slabGraderConfidence: number | null;
  slabGradeConfidence: number | null;
  slabCertConfidence: number | null;
  slabCardNumberRaw: string | null;
  slabParsedLabelText: string[];
  slabClassifierReasons: string[];
  slabRecommendedLookupPath: PSASlabRecommendedLookupPath | null;
  ocrAnalysis: Record<string, unknown>;
};

export const emptyPSASlabVisualSignals: PSASlabVisualSignals = {
  redBandConfidence: 0,
  barcodeRegionConfidence: 0,
  rightColumnConfidence: 0,
  whitePanelConfidence: 0,
};

type SlabFieldCandidate = {
  rawValue: string | null;
  normalizedValue: string | null;
  confidence: number;
  reasons: string[];
  source: PSASlabEvidenceSource;
};

type ParsePSASlabLabelInput = {
  labelTexts: string[];
  barcodePayloads?: string[];
  visualSignals?: Partial<PSASlabVisualSignals>;
};

function dedupe(values: string[]) {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  }

  return ordered;
}

function normalizeLabelText(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\r?\n/g, ' ')
    .replace(/[|]/g, '1')
    .replace(/[^A-Z0-9#./:&+\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstCapturedGroup(value: string, pattern: RegExp) {
  const match = value.match(pattern);
  return match?.[1] ?? null;
}

function containsMatch(value: string, pattern: RegExp) {
  return pattern.test(value);
}

function containsBeckettSubgradeLayout(normalizedText: string) {
  if (normalizedText.length === 0) {
    return false;
  }

  const subgradeTokens = ['CENTERING', 'CORNERS', 'EDGES', 'SURFACE'];
  const subgradeHits = subgradeTokens.filter((token) => normalizedText.includes(token)).length;
  return subgradeHits >= 2;
}

function containsPSAGradeAdjective(normalizedText: string) {
  return containsMatch(
    normalizedText,
    /\b(?:GEM MT|GEM MINT|MINT|NM MT|NM-MT|EX MT|EX-MT|VG EX|VG-EX|GOOD|FAIR|PR)\b/i,
  );
}

function containsPSAGradeLayout(normalizedText: string) {
  return containsMatch(
    normalizedText,
    /\b(?:GEM MT|GEM MINT|MINT|NM MT|NM-MT|EX MT|EX-MT|VG EX|VG-EX|GOOD|FAIR|PR)\b(?:\s+[A-Z][A-Z-]*){0,4}\s+(10|[1-9](?:\.5)?)\b/i,
  );
}

function normalizeGrade(value: string) {
  const cleaned = value.trim();
  return cleaned.endsWith('.0') ? cleaned.slice(0, -2) : cleaned;
}

function firstCapturedField(
  value: string,
  patterns: Array<{ pattern: RegExp; confidence: number; reason: string }>,
): SlabFieldCandidate | null {
  for (const entry of patterns) {
    const match = firstCapturedGroup(value, entry.pattern);
    if (!match) {
      continue;
    }
    return {
      rawValue: match,
      normalizedValue: normalizeGrade(match),
      confidence: entry.confidence,
      reasons: [entry.reason],
      source: 'label_ocr',
    };
  }

  return null;
}

function visualReasons(signals: PSASlabVisualSignals) {
  const reasons: string[] = [];

  if (signals.redBandConfidence >= 0.55) {
    reasons.push('psa_red_band_detected');
  }
  if (signals.barcodeRegionConfidence >= 0.45) {
    reasons.push('barcode_region_detected');
  }
  if (signals.rightColumnConfidence >= 0.45) {
    reasons.push('right_column_layout_detected');
  }
  if (signals.whitePanelConfidence >= 0.45) {
    reasons.push('white_label_panel_detected');
  }

  return reasons;
}

function psaStyleConfidence(signals: PSASlabVisualSignals) {
  return Math.min(
    1,
    (signals.redBandConfidence * 0.45)
      + (signals.barcodeRegionConfidence * 0.3)
      + (signals.rightColumnConfidence * 0.15)
      + (signals.whitePanelConfidence * 0.1),
  );
}

function parseExplicitGrader(normalizedText: string): SlabFieldCandidate | null {
  if (normalizedText.length === 0) {
    return null;
  }

  if (normalizedText.includes('PSA') || normalizedText.includes('PSACARD')) {
    return {
      rawValue: 'PSA',
      normalizedValue: 'PSA',
      confidence: 1,
      reasons: ['explicit_grader_psa'],
      source: 'label_ocr',
    };
  }

  if (containsMatch(normalizedText, /\bP(?:EA|A|S)\b(?=\s+\d{7,10}\b)/i)) {
    return {
      rawValue: 'PSA',
      normalizedValue: 'PSA',
      confidence: 0.84,
      reasons: ['partial_grader_psa_token'],
      source: 'label_ocr',
    };
  }

  if (containsMatch(normalizedText, /\bP[:;.\-]?A\b(?=\s+\d{7,10}\b)/i)) {
    return {
      rawValue: 'PSA',
      normalizedValue: 'PSA',
      confidence: 0.84,
      reasons: ['noisy_partial_grader_psa_token'],
      source: 'label_ocr',
    };
  }

  return null;
}

function detectExplicitNonPSAGrader(normalizedText: string) {
  if (normalizedText.length === 0) {
    return null;
  }

  if (normalizedText.includes('CGC') || normalizedText.includes('CGCCARDS')) {
    return 'CGC' as const;
  }
  if (normalizedText.includes('BGS') || normalizedText.includes('BECKETT')) {
    return 'BGS' as const;
  }
  if (containsBeckettSubgradeLayout(normalizedText)) {
    return 'BGS' as const;
  }
  if (containsMatch(normalizedText, /\bTAG\b/i) && !normalizedText.includes('TAG TEAM')) {
    return 'TAG' as const;
  }
  if (normalizedText.includes('SGC')) {
    return 'SGC' as const;
  }

  return null;
}

export function extractPSACertNumber(value: string) {
  const normalized = normalizeLabelText(value);
  if (normalized.length === 0) {
    return null;
  }

  const patterns = [
    /(?:PSACARD|PSA)[^0-9]{0,24}(\d{7,10})/i,
    /(?:CERT|CERTIFICATE|CERTNUMBER|VERIFY)[^0-9]{0,12}(\d{7,10})/i,
    /\/CERT\/(\d{7,10})/i,
    /\b(\d{7,10})\b/i,
  ];

  for (const pattern of patterns) {
    const match = firstCapturedGroup(normalized, pattern);
    if (match) {
      return match;
    }
  }

  return null;
}

function extractCardNumber(normalizedText: string) {
  const patterns = [
    /#\s*([A-Z]{0,4}\d{1,4}(?:[/-][A-Z]{0,4}\d{1,4})?)\b/i,
    /\bNO\.?\s*([A-Z]{0,4}\d{1,4}(?:[/-][A-Z]{0,4}\d{1,4})?)\b/i,
    /\b([A-Z]{0,4}\d{1,4}(?:[/-][A-Z]{0,4}\d{1,4})?)\b/i,
  ];

  for (const pattern of patterns) {
    const match = firstCapturedGroup(normalizedText, pattern);
    if (match) {
      return match;
    }
  }

  return null;
}

export function looksLikeSlabText(normalizedLabelText: string) {
  if (normalizedLabelText.length === 0) {
    return false;
  }

  if (parseExplicitGrader(normalizedLabelText)?.normalizedValue) {
    return true;
  }

  const hasCertLikeNumber = extractPSACertNumber(normalizedLabelText) != null;
  const slabKeywords = [
    'POKEMON',
    'MINT',
    'GEM MT',
    'NM MT',
    'PRISTINE',
    'PERFECT',
    'CERT',
    'GRADE',
  ];
  const keywordHits = slabKeywords.filter((keyword) => normalizedLabelText.includes(keyword)).length;

  return hasCertLikeNumber && keywordHits >= 1;
}

function inferredPSAConfidence(params: {
  normalizedText: string;
  certNumber: string | null;
  cardNumberRaw: string | null;
  visualSignals: PSASlabVisualSignals;
  includeGradeSignal: boolean;
}) {
  const { normalizedText, certNumber, cardNumberRaw, visualSignals, includeGradeSignal } = params;

  if (detectExplicitNonPSAGrader(normalizedText) != null) {
    return 0;
  }
  if (certNumber == null && !looksLikeSlabText(normalizedText)) {
    return 0;
  }

  let score = Math.max(0, psaStyleConfidence(visualSignals) * 0.48);

  if (certNumber != null) {
    score += 0.18;
  }
  if (cardNumberRaw != null && normalizedText.includes('POKEMON')) {
    score += 0.1;
  }
  if (containsPSAGradeAdjective(normalizedText)) {
    score += 0.1;
  }
  if (
    containsMatch(normalizedText, /\bP[5S]A\b/i)
    || containsMatch(normalizedText, /\bPSA?\b/i)
    || containsMatch(normalizedText, /\bP(?:EA|A|S)\b(?=\s+\d{7,10}\b)/i)
    || containsMatch(normalizedText, /\bP[:;.\-]?A\b(?=\s+\d{7,10}\b)/i)
    || normalizedText.includes('FEA')
  ) {
    score += 0.12;
  }
  if (
    includeGradeSignal
    && (
      containsPSAGradeLayout(normalizedText)
      || containsMatch(normalizedText, /\b\d{7,10}\b\s+(10|[1-9](?:\.5)?)\b/i)
    )
  ) {
    score += 0.18;
  }
  if (certNumber != null && containsPSAGradeAdjective(normalizedText)) {
    score += 0.08;
  }

  return Math.min(0.94, score);
}

function inferLikelyPSA(params: {
  normalizedText: string;
  certNumber: string | null;
  cardNumberRaw: string | null;
  visualSignals: PSASlabVisualSignals;
  gradeCandidate: SlabFieldCandidate | null;
}) {
  const { normalizedText, certNumber, cardNumberRaw, visualSignals, gradeCandidate } = params;

  if (detectExplicitNonPSAGrader(normalizedText) != null) {
    return null;
  }
  if (certNumber == null && !looksLikeSlabText(normalizedText)) {
    return null;
  }

  let score = Math.max(0, psaStyleConfidence(visualSignals) * 0.48);
  const reasons = visualReasons(visualSignals);

  if (certNumber != null) {
    score += 0.18;
    reasons.push('cert_number_present');
  }
  if (cardNumberRaw != null && normalizedText.includes('POKEMON')) {
    score += 0.1;
    reasons.push('pokemon_card_number_layout');
  }
  if (containsPSAGradeAdjective(normalizedText)) {
    score += 0.12;
    reasons.push('grade_adjective_detected');
  }
  if (
    containsPSAGradeLayout(normalizedText)
    || containsMatch(normalizedText, /\b\d{7,10}\b\s+(10|[1-9](?:\.5)?)\b/i)
  ) {
    score += 0.12;
    reasons.push('grade_layout_detected');
  }
  if (
    containsMatch(normalizedText, /\bP[5S]A\b/i)
    || containsMatch(normalizedText, /\bPSA?\b/i)
    || containsMatch(normalizedText, /\bP(?:EA|A|S)\b(?=\s+\d{7,10}\b)/i)
    || containsMatch(normalizedText, /\bP[:;.\-]?A\b(?=\s+\d{7,10}\b)/i)
    || normalizedText.includes('FEA')
  ) {
    score += 0.12;
    reasons.push('partial_psa_logo_token');
  }
  if (gradeCandidate?.normalizedValue) {
    score += Math.min(0.18, gradeCandidate.confidence * 0.22);
    reasons.push('psa_grade_layout_detected');
  }
  if (certNumber != null && gradeCandidate?.normalizedValue) {
    score += 0.16;
    reasons.push('cert_grade_alignment_detected');
  }

  const confidence = Math.min(0.94, score);
  if (confidence <= 0) {
    return null;
  }

  return {
    rawValue: 'PSA',
    normalizedValue: 'PSA',
    confidence,
    reasons: dedupe([...reasons, 'inferred_grader_psa']),
    source: 'label_ocr',
  } satisfies SlabFieldCandidate;
}

function resolveCertCandidate(params: {
  normalizedLabelText: string;
  barcodePayloads: string[];
}) {
  for (const payload of params.barcodePayloads) {
    const certNumber = extractPSACertNumber(payload);
    if (!certNumber) {
      continue;
    }
    return {
      rawValue: certNumber,
      normalizedValue: certNumber,
      confidence: 1,
      reasons: ['cert_from_barcode'],
      source: 'barcode',
    } satisfies SlabFieldCandidate;
  }

  const certNumber = extractPSACertNumber(params.normalizedLabelText);
  if (!certNumber) {
    return null;
  }

  const confidence = containsMatch(
    params.normalizedLabelText,
    /(?:PSACARD|PSA|CERT|VERIFY)[^0-9]{0,24}\d{7,10}/i,
  )
    ? 0.95
    : 0.88;

  return {
    rawValue: certNumber,
    normalizedValue: certNumber,
    confidence,
    reasons: ['cert_from_label_ocr'],
    source: 'label_ocr',
  } satisfies SlabFieldCandidate;
}

function resolveGradeCandidate(params: {
  normalizedText: string;
  grader: string | null;
  certNumber: string | null;
}) {
  const { normalizedText, grader, certNumber } = params;
  if (normalizedText.length === 0) {
    return null;
  }

  if (grader === 'PSA') {
    const explicit = firstCapturedField(normalizedText, [
      { pattern: /\b(10|[1-9](?:\.5)?)\b(?=\s+PSA\b)/i, confidence: 0.96, reason: 'grade_before_psa_token' },
      { pattern: /\b(10|[1-9](?:\.5)?)\b(?=\s+P(?:EA|A|S)\b(?:\s+\d{7,10}\b|$))/i, confidence: 0.95, reason: 'grade_before_partial_psa_token' },
      { pattern: /\b(10|[1-9](?:\.5)?)\b(?=\s+P[:;.\-]?A\b(?:\s+\d{7,10}\b|$))/i, confidence: 0.95, reason: 'grade_before_noisy_psa_token' },
      { pattern: /\b(10|[1-9](?:\.5)?)\b(?=\s+(?:[A-Z0-9]{1,4}\s+){1,2}PSA\b)/i, confidence: 0.94, reason: 'grade_before_psa_with_noise' },
      { pattern: /\b(10|[1-9](?:\.5)?)\b(?=\s+(?:[A-Z]{2,4}\s+)?\d{7,10}\b)/i, confidence: 0.91, reason: 'grade_before_cert_number' },
      { pattern: /\b(10|[1-9](?:\.5)?)\b(?=\s+(?:[A-Z0-9]{1,4}\s+){1,2}(?:[A-Z]{2,4}\s+)?\d{7,10}\b)/i, confidence: 0.89, reason: 'grade_before_cert_number_with_noise' },
      { pattern: /\b\d{7,10}\b\s+(10|[1-9](?:\.5)?)\b/i, confidence: 0.9, reason: 'grade_after_cert_number' },
      {
        pattern: /\bNM\b(?:\s+[A-Z][A-Z-]*){0,4}\s+(10|[1-9](?:\.5)?)\b(?:\s+[A-Z0-9]{1,4}){0,2}(?:\s+(?:PSA|[A-Z]{2,4})\b|\s+\d{7,10}\b|$)(?:\s+\d{7,10}\b|$)/i,
        confidence: 0.94,
        reason: 'grade_from_nm_layout',
      },
      { pattern: /\bGEM MT\s+(10|[1-9])\b/i, confidence: 0.92, reason: 'grade_from_psa_gem_mt' },
      { pattern: /\bGEM MINT\s+(10|[1-9])\b/i, confidence: 0.92, reason: 'grade_from_psa_gem_mint' },
      { pattern: /\bMINT\s+(10|[1-9])\b/i, confidence: 0.9, reason: 'grade_from_psa_mint' },
      { pattern: /\bNM MT\s+(10|[1-9])\b/i, confidence: 0.89, reason: 'grade_from_psa_nm_mt' },
      { pattern: /\bNM-MT\s+(10|[1-9])\b/i, confidence: 0.89, reason: 'grade_from_psa_nm_mt' },
      { pattern: /\bEX MT\s+(10|[1-9])\b/i, confidence: 0.87, reason: 'grade_from_psa_ex_mt' },
      { pattern: /\bEX-MT\s+(10|[1-9])\b/i, confidence: 0.87, reason: 'grade_from_psa_ex_mt' },
      { pattern: /\bVG EX\s+(10|[1-9])\b/i, confidence: 0.85, reason: 'grade_from_psa_vg_ex' },
      { pattern: /\bVG-EX\s+(10|[1-9])\b/i, confidence: 0.85, reason: 'grade_from_psa_vg_ex' },
      { pattern: /\bGOOD\s+(10|[1-9])\b/i, confidence: 0.83, reason: 'grade_from_psa_good' },
      { pattern: /\bFAIR\s+(10|[1-9](?:\.5)?)\b/i, confidence: 0.81, reason: 'grade_from_psa_fair' },
      { pattern: /\bPR\s+(10|[1-9])\b/i, confidence: 0.81, reason: 'grade_from_psa_poor' },
    ]);

    if (explicit) {
      return explicit;
    }

    const adjectiveOnlyMappings: Array<{ pattern: RegExp; mappedGrade: string }> = [
      { pattern: /\bGEM MT\b/i, mappedGrade: '10' },
      { pattern: /\bGEM MINT\b/i, mappedGrade: '10' },
      { pattern: /\bMINT\b/i, mappedGrade: '9' },
      { pattern: /\bNM MT\b/i, mappedGrade: '8' },
      { pattern: /\bNM-MT\b/i, mappedGrade: '8' },
      { pattern: /\bEX MT\b/i, mappedGrade: '6' },
      { pattern: /\bEX-MT\b/i, mappedGrade: '6' },
      { pattern: /\bVG EX\b/i, mappedGrade: '4' },
      { pattern: /\bVG-EX\b/i, mappedGrade: '4' },
      { pattern: /\bGOOD\b/i, mappedGrade: '2' },
      { pattern: /\bFAIR\b/i, mappedGrade: '1.5' },
      { pattern: /\bPR\b/i, mappedGrade: '1' },
    ];

    for (const mapping of adjectiveOnlyMappings) {
      if (!containsMatch(normalizedText, mapping.pattern)) {
        continue;
      }
      return {
        rawValue: mapping.mappedGrade,
        normalizedValue: mapping.mappedGrade,
        confidence: 0.72,
        reasons: ['grade_from_psa_adjective_only'],
        source: 'label_ocr',
      } satisfies SlabFieldCandidate;
    }
  }

  if (certNumber != null) {
    const inferred = firstCapturedField(normalizedText, [
      {
        pattern: /\b(?:NM|MINT|GEM MT|GEM MINT)\b(?:\s+[A-Z][A-Z-]*){0,4}\s+(10|[1-9](?:\.5)?)\b(?:\s+[A-Z0-9]{1,4}){0,2}(?:\s+[A-Z]{2,4}\b)?(?:\s+\d{7,10}\b|$)/i,
        confidence: 0.79,
        reason: 'grade_from_cert_aligned_layout',
      },
      { pattern: /\b\d{7,10}\b\s+(10|[1-9](?:\.5)?)\b/i, confidence: 0.82, reason: 'grade_from_post_cert_layout' },
    ]);

    if (inferred) {
      return inferred;
    }
  }

  return null;
}

function resolveGraderCandidate(params: {
  normalizedText: string;
  certNumber: string | null;
  cardNumberRaw: string | null;
  visualSignals: PSASlabVisualSignals;
  gradeCandidate: SlabFieldCandidate | null;
}) {
  if (detectExplicitNonPSAGrader(params.normalizedText) != null) {
    return null;
  }

  const explicit = parseExplicitGrader(params.normalizedText);
  if (explicit) {
    return explicit;
  }

  const inferred = inferLikelyPSA(params);
  if ((inferred?.confidence ?? 0) >= 0.62) {
    return inferred;
  }

  return null;
}

function recommendedLookupPath(params: {
  grader: string | null;
  graderConfidence: number;
  certNumber: string | null;
  certConfidence: number;
  grade: string | null;
  gradeConfidence: number;
  isPSAConfident: boolean;
}): PSASlabRecommendedLookupPath {
  if (!params.isPSAConfident) {
    return 'needs_review';
  }

  if (
    params.grader === 'PSA'
    && params.graderConfidence >= 0.62
    && params.certNumber != null
    && params.certConfidence >= 0.85
  ) {
    return 'psa_cert';
  }

  if (
    params.grader === 'PSA'
    && params.graderConfidence >= 0.62
    && (params.grade != null || params.certNumber != null || params.gradeConfidence >= 0.7)
  ) {
    return 'label_text_search';
  }

  return 'needs_review';
}

export function parsePSASlabLabel(input: ParsePSASlabLabelInput): ParsedPSASlabLabel {
  const visualSignals: PSASlabVisualSignals = {
    ...emptyPSASlabVisualSignals,
    ...(input.visualSignals ?? {}),
  };
  const normalizedSegments = dedupe(input.labelTexts.map(normalizeLabelText).filter(Boolean));
  const normalizedLabelText = normalizedSegments.join(' ');
  const barcodePayloads = dedupe((input.barcodePayloads ?? []).map((value) => value.trim()).filter(Boolean));
  const normalizedBarcodeText = normalizeLabelText(barcodePayloads.join(' '));
  const combinedText = [normalizedLabelText, normalizedBarcodeText].filter(Boolean).join(' ');
  const explicitNonPSAGrader = detectExplicitNonPSAGrader(combinedText);

  const certCandidate = resolveCertCandidate({
    normalizedLabelText,
    barcodePayloads,
  });
  const cardNumberRaw = extractCardNumber(normalizedLabelText);
  const preliminaryPSAConfidence = inferredPSAConfidence({
    normalizedText: combinedText,
    certNumber: certCandidate?.normalizedValue ?? null,
    cardNumberRaw,
    visualSignals,
    includeGradeSignal: true,
  });
  const provisionalGrader = parseExplicitGrader(combinedText)?.normalizedValue
    ?? (preliminaryPSAConfidence >= 0.45 ? 'PSA' : null);
  const gradeCandidate = resolveGradeCandidate({
    normalizedText: combinedText,
    grader: provisionalGrader,
    certNumber: certCandidate?.normalizedValue ?? null,
  });
  const graderCandidate = resolveGraderCandidate({
    normalizedText: combinedText,
    certNumber: certCandidate?.normalizedValue ?? null,
    cardNumberRaw,
    visualSignals,
    gradeCandidate,
  });
  const isPSAConfident = explicitNonPSAGrader == null
    && graderCandidate?.normalizedValue === 'PSA'
    && (graderCandidate?.confidence ?? 0) >= 0.62;

  const evidenceSource: PSASlabEvidenceSource = certCandidate?.source === 'barcode'
    ? 'barcode'
    : certCandidate?.source === 'label_ocr'
      ? 'cert_ocr'
      : normalizedLabelText.length > 0
        ? 'label_ocr'
        : 'none';

  const lookupPath = recommendedLookupPath({
    grader: graderCandidate?.normalizedValue ?? null,
    graderConfidence: graderCandidate?.confidence ?? 0,
    certNumber: certCandidate?.normalizedValue ?? null,
    certConfidence: certCandidate?.confidence ?? 0,
    grade: gradeCandidate?.normalizedValue ?? null,
    gradeConfidence: gradeCandidate?.confidence ?? 0,
    isPSAConfident,
  });

  const unsupportedReason: PSASlabUnsupportedReason | null = explicitNonPSAGrader != null
    ? 'non_psa_slab_not_supported_yet'
    : !isPSAConfident
      ? 'psa_label_not_confident_enough'
      : null;

  const reasons = dedupe([
    ...(graderCandidate?.reasons ?? []),
    ...(certCandidate?.reasons ?? []),
    ...(gradeCandidate?.reasons ?? []),
    ...visualReasons(visualSignals),
    ...(cardNumberRaw ? [`card_number:${cardNumberRaw}`] : []),
    ...(explicitNonPSAGrader ? [`explicit_non_psa_grader:${explicitNonPSAGrader}`] : []),
    ...(unsupportedReason ? [`unsupported_reason:${unsupportedReason}`] : []),
    `lookup_path:${lookupPath}`,
  ]);

  return {
    parsedLabelText: normalizedSegments,
    normalizedLabelText,
    grader: explicitNonPSAGrader == null && graderCandidate?.normalizedValue === 'PSA' ? 'PSA' : null,
    graderConfidence: explicitNonPSAGrader == null ? (graderCandidate?.confidence ?? 0) : 0,
    grade: explicitNonPSAGrader == null ? (gradeCandidate?.normalizedValue ?? null) : null,
    gradeRaw: explicitNonPSAGrader == null ? (gradeCandidate?.rawValue ?? null) : null,
    gradeConfidence: explicitNonPSAGrader == null ? (gradeCandidate?.confidence ?? 0) : 0,
    certNumber: explicitNonPSAGrader == null ? (certCandidate?.normalizedValue ?? null) : null,
    certNumberRaw: explicitNonPSAGrader == null ? (certCandidate?.rawValue ?? null) : null,
    certConfidence: explicitNonPSAGrader == null ? (certCandidate?.confidence ?? 0) : 0,
    cardNumberRaw,
    barcodePayloads,
    evidenceSource,
    visualSignals,
    reasons,
    recommendedLookupPath: lookupPath,
    isPSAConfident,
    isLikelySlab: (
      (explicitNonPSAGrader != null)
      || (graderCandidate?.confidence ?? 0) >= 0.6
      || (certCandidate?.confidence ?? 0) >= 0.72
      || lookupPath !== 'needs_review'
      || looksLikeSlabText(normalizedLabelText)
    ),
    unsupportedReason,
    explicitNonPSAGrader,
  };
}

export function parsePSASlabNativeAnalysis(analysis: PSASlabNativeAnalysis) {
  return parsePSASlabLabel({
    labelTexts: analysis.textBlocks.map((block) => block.text),
    barcodePayloads: analysis.barcodes.map((barcode) => barcode.rawValue),
  });
}

export function buildPSASlabScannerMatchFields(params: {
  nativeAnalysis: PSASlabNativeAnalysis;
  parsed: ParsedPSASlabLabel;
}): PSASlabScannerMatchFields {
  const { nativeAnalysis, parsed } = params;
  const titleTextPrimary = parsed.parsedLabelText[0] ?? null;
  const titleTextSecondary = parsed.parsedLabelText[1] ?? null;
  const slabEvidence = {
    grader: parsed.grader,
    graderConfidence: parsed.graderConfidence,
    grade: parsed.grade,
    gradeRaw: parsed.gradeRaw,
    gradeConfidence: parsed.gradeConfidence,
    cert: parsed.certNumber,
    certRaw: parsed.certNumberRaw,
    certConfidence: parsed.certConfidence,
    cardNumber: parsed.cardNumberRaw,
    barcodePayloads: parsed.barcodePayloads,
    parsedLabelText: parsed.parsedLabelText,
    normalizedLabelText: parsed.normalizedLabelText,
    titleTextPrimary,
    titleTextSecondary,
    labelWideText: parsed.normalizedLabelText,
    setHints: [],
    evidenceSource: parsed.evidenceSource,
    reasons: parsed.reasons,
    recommendedLookupPath: parsed.recommendedLookupPath,
    isPSAConfident: parsed.isPSAConfident,
    isLikelySlab: parsed.isLikelySlab,
    explicitNonPSAGrader: parsed.explicitNonPSAGrader,
    unsupportedReason: parsed.unsupportedReason,
  };

  return {
    slabGrader: parsed.grader,
    slabGrade: parsed.grade,
    slabCertNumber: parsed.certNumber,
    slabBarcodePayloads: parsed.barcodePayloads,
    slabGraderConfidence: parsed.grader ? parsed.graderConfidence : null,
    slabGradeConfidence: parsed.grade ? parsed.gradeConfidence : null,
    slabCertConfidence: parsed.certNumber ? parsed.certConfidence : null,
    slabCardNumberRaw: parsed.cardNumberRaw,
    slabParsedLabelText: parsed.parsedLabelText,
    slabClassifierReasons: parsed.reasons,
    slabRecommendedLookupPath: parsed.recommendedLookupPath,
    ocrAnalysis: {
      engine: 'ios_native_vision_label_first_v1',
      imageSize: {
        width: nativeAnalysis.width,
        height: nativeAnalysis.height,
      },
      textBlocks: nativeAnalysis.textBlocks,
      barcodes: nativeAnalysis.barcodes,
      slabAnalysis: slabEvidence,
      slabEvidence,
    },
  };
}
