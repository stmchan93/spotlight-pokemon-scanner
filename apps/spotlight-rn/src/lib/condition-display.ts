import type { DeckConditionCode } from '@spotlight/api-client';

function conditionLabelFromCode(code?: DeckConditionCode | null) {
  switch (code) {
    case 'near_mint':
      return 'Near Mint';
    case 'lightly_played':
      return 'Lightly Played';
    case 'moderately_played':
      return 'Moderately Played';
    case 'heavily_played':
      return 'Heavily Played';
    case 'damaged':
      return 'Damaged';
    default:
      return null;
  }
}

function conditionLabelFromShortLabel(shortLabel?: string | null) {
  switch (shortLabel?.trim().toUpperCase()) {
    case 'NM':
      return 'Near Mint';
    case 'LP':
      return 'Lightly Played';
    case 'MP':
      return 'Moderately Played';
    case 'HP':
      return 'Heavily Played';
    case 'DMG':
    case 'D':
      return 'Damaged';
    default:
      return null;
  }
}

export function resolveConditionDisplayLabel({
  conditionCode,
  conditionLabel,
  conditionShortLabel,
  fallback = 'Raw',
}: {
  conditionCode?: DeckConditionCode | null;
  conditionLabel?: string | null;
  conditionShortLabel?: string | null;
  fallback?: string;
}) {
  return conditionLabel
    ?? conditionLabelFromCode(conditionCode)
    ?? conditionLabelFromShortLabel(conditionShortLabel)
    ?? fallback;
}
