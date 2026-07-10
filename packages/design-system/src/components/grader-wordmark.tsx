import { Image, StyleSheet, Text } from 'react-native';

import { fontFamilies, colors } from '../tokens';

/**
 * Official grader brand mark for slab rows/tiles (the Collectr-style meta
 * line: `[PSA] 10 (GEM-MT)`). The mark is ALWAYS keyed by the entry's own
 * grader — a CGC card never shows the PSA mark. Unknown graders (ACE, SGC, …)
 * fall back to the grader's name as bold text so nothing ever breaks.
 *
 * Logo assets are the graders' official marks (nominative use — identifying
 * whose slab this is, the same way the app shows TCGplayer/eBay marks) sourced
 * at 96px tall; width follows each asset's native aspect ratio.
 */

type GraderAsset = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  source: any;
  aspectRatio: number; // width / height of the bundled asset
};

const GRADER_ASSETS: Record<string, GraderAsset> = {
  psa: {
    source: require('../../assets/graders/psa.png'),
    aspectRatio: 214 / 96,
  },
  cgc: {
    source: require('../../assets/graders/cgc.png'),
    aspectRatio: 311 / 96,
  },
  beckett: {
    source: require('../../assets/graders/beckett.png'),
    aspectRatio: 90 / 96,
  },
  tag: {
    source: require('../../assets/graders/tag.png'),
    aspectRatio: 260 / 96,
  },
};

// Grader-string spellings seen in slabContext.grader → asset key.
function normalizeGrader(grader: string): string {
  const key = grader.trim().toLowerCase();
  if (key === 'bgs' || key === 'beckett') {
    return 'beckett';
  }
  return key;
}

/**
 * PSA's grade descriptors (the "(GEM-MT)" in `PSA 10 (GEM-MT)`). PSA-ONLY —
 * other graders use different scales/labels, so they show the bare grade.
 */
export function psaGradeDescriptor(grade: string): string | null {
  const key = grade.trim();
  const map: Record<string, string> = {
    '10': 'GEM-MT',
    '9': 'MINT',
    '8.5': 'NM-MT+',
    '8': 'NM-MT',
    '7.5': 'NM+',
    '7': 'NM',
    '6.5': 'EX-MT+',
    '6': 'EX-MT',
    '5.5': 'EX+',
    '5': 'EX',
    '4.5': 'VG-EX+',
    '4': 'VG-EX',
    '3.5': 'VG+',
    '3': 'VG',
    '2.5': 'GOOD+',
    '2': 'GOOD',
    '1.5': 'FR',
    '1': 'PR',
  };
  return map[key] ?? null;
}

/** True when we have an official mark for this grader (else callers may keep
 * their existing plain-text treatment). */
export function hasGraderWordmark(grader: string | null | undefined): boolean {
  return grader != null && normalizeGrader(grader) in GRADER_ASSETS;
}

export type GraderWordmarkSize = 'sm' | 'md';

const MARK_HEIGHTS: Record<GraderWordmarkSize, number> = {
  sm: 12, // tile meta line
  md: 16, // list-row grade line
};

type GraderWordmarkProps = {
  grader: string;
  size?: GraderWordmarkSize;
  testID?: string;
};

export function GraderWordmark({ grader, size = 'md', testID }: GraderWordmarkProps) {
  const asset = GRADER_ASSETS[normalizeGrader(grader)];
  const height = MARK_HEIGHTS[size];

  if (!asset) {
    return (
      <Text style={[styles.fallback, { fontSize: height - 2, lineHeight: height }]} testID={testID}>
        {grader.trim().toUpperCase()}
      </Text>
    );
  }

  return (
    <Image
      accessibilityLabel={grader}
      resizeMode="contain"
      source={asset.source}
      style={{ height, width: Math.round(height * asset.aspectRatio) }}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create({
  fallback: {
    color: colors.gray900,
    fontFamily: fontFamilies.bodyBold,
  },
});
