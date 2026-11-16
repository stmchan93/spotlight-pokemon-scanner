/** Below this, "browsing now" reads as empty rather than busy. */
export const MIN_BROWSING_SHOWN = 3;

export type BoothTickerItem = {
  key: string;
  text: string;
  /** The vendor a tap selects; null for items about the whole show. */
  vendorId: string | null;
};

/**
 * The live ticker: only how many people are browsing the show. Busy-booth,
 * posted and booth-setup lines were removed (user, 2026-11-16).
 */
export function buildBoothTickerItems({ browsingNow }: { browsingNow: number | null }): BoothTickerItem[] {
  return browsingNow != null && browsingNow >= MIN_BROWSING_SHOWN
    ? [{ key: 'browsing', text: `👀 ${browsingNow} people browsing`, vendorId: null }]
    : [];
}
