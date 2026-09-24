import type { MarketHistoryOption } from '@spotlight/api-client';

/*
  A watch is (card, printing). The server keys printings by TCGplayer label
  ('Holofoil', 'Reverse Holofoil'); '' is "the card's main printing" — sealed
  products and watches made before printings existed. The PDP picker speaks
  labels, so these helpers translate between the two.
*/

/** The main printing's label: the lane the server priced by default, else Normal, else the first. */
export function resolveMainPrintingLabel(
  options: readonly MarketHistoryOption[],
  serverDefaultVariant: string | null | undefined,
): string | null {
  if (options.length === 0) {
    return null;
  }
  const serverDefault = serverDefaultVariant
    ? options.find((option) => option.id === serverDefaultVariant || option.label === serverDefaultVariant)
    : undefined;
  const normal = options.find((option) => option.label.trim().toLowerCase() === 'normal');
  return (serverDefault ?? normal ?? options[0]).label;
}

/**
 * The stored watch key that covers `printingLabel`, or undefined when that
 * printing is not watched. A legacy '' watch covers the main printing only.
 */
export function matchWatchedPrinting(
  printingLabel: string | null,
  watchedVariants: readonly string[],
  mainPrintingLabel: string | null,
): string | undefined {
  if (printingLabel == null) {
    // No printings (sealed) or options not loaded yet: only the main watch applies.
    return watchedVariants.includes('') ? '' : undefined;
  }
  if (watchedVariants.includes(printingLabel)) {
    return printingLabel;
  }
  if (watchedVariants.includes('') && printingLabel === mainPrintingLabel) {
    return '';
  }
  return undefined;
}

/** Watched printings OTHER than the selected one, as picker labels, in picker order. */
export function otherWatchedPrintingLabels(
  selectedLabel: string | null,
  watchedVariants: readonly string[],
  options: readonly MarketHistoryOption[],
  mainPrintingLabel: string | null,
): string[] {
  const watchedLabels = new Set(
    watchedVariants.map((variant) => (variant === '' ? mainPrintingLabel : variant)),
  );
  // Picker order, and only printings the picker can actually switch to.
  return options
    .map((option) => option.label)
    .filter((label) => label !== selectedLabel && watchedLabels.has(label));
}

/** Request field for a stored key: '' (main printing) goes out as "no variant". */
export function watchVariantForKey(key: string): string | null {
  return key === '' ? null : key;
}
