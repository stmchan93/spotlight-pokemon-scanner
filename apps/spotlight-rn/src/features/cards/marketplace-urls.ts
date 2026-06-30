// Pokémon TCG name glyphs → the words real eBay/TCGplayer listings use. Curated
// from a scan of every catalog card name. Without this the cleaners below strip
// the glyph and the search loses the signal that identifies the card (e.g. a
// Gold Star / Delta Species / Prism Star / gender variant), returning zero solds.
const NAME_GLYPH_REPLACEMENTS: [RegExp, string][] = [
  [/[★☆]/g, ' Gold Star '],
  [/δ/g, ' Delta Species '],
  [/◇/g, ' Prism Star '],
  [/♀/g, ' Female '],
  [/♂/g, ' Male '],
  [/α/g, ' Alpha '],
  [/β/g, ' Beta '],
  [/γ/g, ' Gamma '],
  [/’/g, "'"], // curly → straight apostrophe (TCGplayer keeps it; eBay drops either)
];

function expandNameGlyphs(value: string): string {
  return NAME_GLYPH_REPLACEMENTS.reduce((out, [pattern, words]) => out.replace(pattern, words), value);
}

// Decompose + drop combining marks so accented Latin survives the eBay cleaner
// (é→e). The TCGplayer cleaner already NFD-normalizes; this matches it for eBay.
function stripCombiningAccents(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function cleanedMarketplaceToken(value: string | null | undefined) {
  // Expand name glyphs + strip accents first (so ☆/δ/◇/♀/♂/é survive), then keep
  // a decimal point ONLY between two digits so half-grades survive ("9.5" must not
  // become "9 5", which searches eBay for an unrelated "9 5"); every other period
  // (and all other punctuation) becomes a space.
  return stripCombiningAccents(expandNameGlyphs(value ?? ''))
    .replace(/[^A-Za-z0-9. ]+/g, ' ')
    .replace(/\.+/g, (match, offset: number, source: string) => {
      const before = source[offset - 1] ?? '';
      const after = source[offset + match.length] ?? '';
      return /\d/.test(before) && /\d/.test(after) ? '.' : ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanedTcgPlayerToken(value: string | null | undefined) {
  // Decompose accented chars (é→e), lowercase, keep apostrophes and slashes
  const normalized = expandNameGlyphs(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Strip a redundant "pokemon" prefix so set names like "Pokémon Card 151" don't double up
  return normalized
    .replace(/[^a-z0-9/' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^pokemon\s+/, '');
}

// TCGplayer's Condition filter accepts these display values verbatim.
function normalizeTcgPlayerCondition(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case 'nm':
    case 'near mint':
    case 'near_mint':
      return 'Near Mint';
    case 'lp':
    case 'lightly played':
    case 'lightly_played':
      return 'Lightly Played';
    case 'mp':
    case 'moderately played':
    case 'moderately_played':
      return 'Moderately Played';
    case 'hp':
    case 'heavily played':
    case 'heavily_played':
      return 'Heavily Played';
    case 'd':
    case 'dmg':
    case 'damaged':
      return 'Damaged';
    default:
      return null;
  }
}

// TCGplayer's Printing filter values. Skip if we can't confidently map — over-filtering
// to an unknown printing would zero out results.
function normalizeTcgPlayerPrinting(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase().replace(/_/g, ' ');
  if (!normalized) return null;
  switch (normalized) {
    case 'normal':
      return 'Normal';
    case 'holo':
    case 'holofoil':
      return 'Holofoil';
    case 'reverse holo':
    case 'reverse holofoil':
      return 'Reverse Holofoil';
    case '1st edition normal':
    case 'first edition normal':
      return '1st Edition Normal';
    case '1st edition holofoil':
    case 'first edition holofoil':
      return '1st Edition Holofoil';
    case 'unlimited holofoil':
      return 'Unlimited Holofoil';
    default:
      return null;
  }
}

export function buildTcgPlayerSearchUrl(params: {
  cardNumber: string;
  name: string;
  setName: string;
  condition?: string | null;
  printing?: string | null;
}) {
  const query = [
    'pokemon',
    cleanedTcgPlayerToken(params.setName),
    cleanedTcgPlayerToken(params.name),
    cleanedTcgPlayerToken(params.cardNumber.replace(/^#/, '')),
  ]
    .filter(Boolean)
    .join(' ');

  // "pokemon" alone means all three fields were empty
  if (!query || query === 'pokemon') {
    return null;
  }

  // Encode manually: spaces as "+", slashes and apostrophes unencoded (matches TCGPlayer's own format)
  const encodedQ = encodeURIComponent(query)
    .replace(/%20/g, '+')
    .replace(/%2F/g, '/')
    .replace(/%27/g, "'");

  const condition = normalizeTcgPlayerCondition(params.condition);
  const printing = normalizeTcgPlayerPrinting(params.printing);
  const filterParts: string[] = [];
  if (condition) filterParts.push(`Condition=${encodeURIComponent(condition).replace(/%20/g, '+')}`);
  if (printing) filterParts.push(`Printing=${encodeURIComponent(printing).replace(/%20/g, '+')}`);
  const filterSuffix = filterParts.length > 0 ? `&${filterParts.join('&')}` : '';

  return `https://www.tcgplayer.com/search/all/product?q=${encodedQ}&view=grid${filterSuffix}`;
}

// Minimal shape of a Scrydex sourcePayload variant as exposed to the client.
// Defensive: every field is optional because the upstream payload is untyped JSON.
export type TcgPlayerSourceVariant = {
  name?: string | null;
  marketplaces?: ({
    name?: string | null;
    product_id?: string | number | null;
  } | null)[] | null;
};

// Normalize a printing/variant label for matching: lowercase, trim, and collapse
// runs of spaces/underscores to a single space so "Reverse_Holofoil",
// "reverse holofoil", and "Reverse  Holofoil" all compare equal.
function normalizeVariantMatchKey(value: string | null | undefined) {
  // The PDP's variant labels are humanized ("Unlimited Holofoil") while the
  // Scrydex sourcePayload keys are camelCase ("unlimitedHolofoil"). Insert a
  // boundary before an interior capital so both collapse to the same key
  // ("unlimited holofoil"); otherwise the match fails and we fall back to the
  // first (wrong) printing's product_id.
  return (value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')
    .trim();
}

// Pull the tcgplayer product_id off a single variant, if present. Defensive
// against missing/oddly-shaped `marketplaces` and non-string ids.
function tcgPlayerProductIdFromVariant(variant: TcgPlayerSourceVariant | null | undefined): string | null {
  const marketplaces = variant?.marketplaces;
  if (!Array.isArray(marketplaces)) {
    return null;
  }
  for (const marketplace of marketplaces) {
    if (!marketplace || typeof marketplace !== 'object') {
      continue;
    }
    if (normalizeVariantMatchKey(marketplace.name) !== 'tcgplayer') {
      continue;
    }
    const productId = marketplace.product_id;
    if (typeof productId === 'number' && Number.isFinite(productId)) {
      return String(productId);
    }
    const text = typeof productId === 'string' ? productId.trim() : '';
    if (text) {
      return text;
    }
  }
  return null;
}

/**
 * Resolve the TCGplayer product_id for the SELECTED printing/variant.
 *
 * Multi-printing vintage cards (e.g. Base Charizard) carry a different
 * product_id per printing, and the FIRST variant is often the wrong printing,
 * so we match the variant whose name equals the label currently shown on the
 * PDP. Falls back to the first variant that has a tcgplayer product_id, then
 * to null. Defensive against undefined/oddly-shaped data.
 */
export function resolveTcgPlayerProductId(
  variants: TcgPlayerSourceVariant[] | null | undefined,
  selectedVariantLabel: string | null | undefined,
): string | null {
  if (!Array.isArray(variants) || variants.length === 0) {
    return null;
  }

  const selectedKey = normalizeVariantMatchKey(selectedVariantLabel);
  if (selectedKey) {
    for (const variant of variants) {
      if (!variant || typeof variant !== 'object') {
        continue;
      }
      if (normalizeVariantMatchKey(variant.name) !== selectedKey) {
        continue;
      }
      const productId = tcgPlayerProductIdFromVariant(variant);
      if (productId) {
        return productId;
      }
    }
  }

  // Fall back to the first variant that carries a tcgplayer product_id.
  for (const variant of variants) {
    const productId = tcgPlayerProductIdFromVariant(variant);
    if (productId) {
      return productId;
    }
  }

  return null;
}

/**
 * Build a deep link to the EXACT TCGplayer product page for a known product_id,
 * optionally filtered to a condition. Returns null when no product_id is given
 * so callers can fall back to {@link buildTcgPlayerSearchUrl}.
 */
export function buildTcgPlayerProductUrl(params: {
  productId: string;
  condition?: string | null;
}): string | null {
  const productId = params.productId?.trim();
  if (!productId) {
    return null;
  }

  const condition = normalizeTcgPlayerCondition(params.condition);
  // Encode the space as "+" to match the existing search-URL formatting.
  const conditionSuffix = condition
    ? `?Condition=${encodeURIComponent(condition).replace(/%20/g, '+')}`
    : '';

  return `https://www.tcgplayer.com/product/${encodeURIComponent(productId)}${conditionSuffix}`;
}

// Fold the selected printing/edition into the eBay keyword string so the recent
// sales don't mix 1st Edition and Unlimited comps:
//   - "first edition"/"1st edition" → add a positive `1st Edition` keyword.
//   - "unlimited" → add the NEGATIVE token `-"1st Edition"`. Unlimited listings
//     rarely say "Unlimited" in the title, so the only reliable filter is to
//     EXCLUDE the 1st-edition phrase. eBay web search honors `-"phrase"`; the
//     URLSearchParams encoder preserves the `-`, quotes, and spaces inside _nkw.
//   - anything else (modern Holofoil/Normal/Reverse) → no change.
function editionKeywordToken(variant: string | null | undefined): string | null {
  const normalized = (variant ?? '').toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes('first edition') || normalized.includes('1st edition')) {
    return '1st Edition';
  }
  if (normalized.includes('unlimited')) {
    return '-"1st Edition"';
  }
  return null;
}

export function buildEbaySearchUrl(params: {
  cardNumber: string;
  name: string;
  setName: string;
  grader?: string | null;
  grade?: string | null;
  /** Selected printing/edition label, e.g. "First Edition Holofoil" or "Unlimited Holofoil". */
  variant?: string | null;
  /** Card language ('english' | 'japanese'); scopes the query for JP cards. */
  language?: string | null;
}) {
  const graderToken = cleanedMarketplaceToken(params.grader);
  const gradeToken = cleanedMarketplaceToken(params.grade);
  const editionToken = editionKeywordToken(params.variant);
  const isJapanese = (params.language ?? '').toLowerCase() === 'japanese';

  // For Japanese cards add a "Japanese" keyword — US eBay listings of JP cards
  // almost always say so, and it's what separates e.g. a JP Shiny Collection
  // Growlithe from the famous ENGLISH Base Set 1st-Edition Growlithe (which the
  // name+edition query would otherwise collide with). The JP set name is in
  // Japanese script and gets stripped from keywords, so "Japanese" + the number
  // carry the disambiguation instead.
  const languageToken = isJapanese ? 'Japanese' : null;

  // Drop the collector number for VINTAGE ENGLISH GRADED cards (edition + grade
  // present): slab sellers title those by name+set+grade and omit the number, so
  // requiring it zeroes the search. But KEEP it for Japanese graded (JP slab
  // titles include "004/020") and for modern graded (separates alt-art prints).
  const dropCollectorNumber = !isJapanese && Boolean(editionToken && gradeToken);
  const numberToken = dropCollectorNumber
    ? null
    : cleanedMarketplaceToken(params.cardNumber.replace(/^#/, ''));

  // Quote the grader+grade as an EXACT phrase (e.g. "PSA 3") so eBay matches the grade
  // strictly. As loose keywords, eBay relaxes the low-signal grade number — a bare "3"
  // collides with card numbers ("215/203") and gets dropped, backfilling the page with
  // high-volume PSA 10 solds. A quoted "PSA 3" can't match a "PSA 10" title. Only quote
  // when both are present; a lone bare number quoted would over-filter.
  const gradeTerm =
    graderToken && gradeToken
      ? `"${graderToken} ${gradeToken}"`
      : [graderToken, gradeToken].filter(Boolean).join(' ');

  const query = [
    // Grader + grade first so the search lands on graded sales of this exact card.
    gradeTerm,
    cleanedMarketplaceToken(params.name),
    languageToken,
    numberToken,
    cleanedMarketplaceToken(params.setName),
    // Edition qualifier LAST, appended raw (not through cleanedMarketplaceToken,
    // which would strip the leading "-" and the quotes the exclusion relies on).
    editionToken,
  ]
    .filter(Boolean)
    .join(' ');

  if (!query) {
    return null;
  }

  const searchParams = new URLSearchParams({
    _nkw: query,
    // Sold + completed listings so the page shows the recent SALES for this card,
    // sorted most-recent-first (_sop=13 = "ended recently").
    LH_Sold: '1',
    LH_Complete: '1',
    _sop: '13',
  });

  return `https://www.ebay.com/sch/i.html?${searchParams.toString()}`;
}
