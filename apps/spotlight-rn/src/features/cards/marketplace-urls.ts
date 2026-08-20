import {
  type CardGame,
  ebayKeywordForGame,
  marketplaceKeywordForGame,
} from '@spotlight/api-client';

// Pokémon TCG name glyphs → the words real eBay/TCGplayer listings use. Curated
// from a scan of every catalog card name. Deliberately Pokémon-ONLY: these are
// Pokémon set mechanics (Gold Star, Delta Species, Prism Star, gender variants).
// Other games simply never contain these characters, so they never hit the map —
// no per-game gating needed, and none should be added speculatively.
//
// Without this the cleaners below strip
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

function cleanedTcgPlayerToken(value: string | null | undefined, gameKeyword: string = 'pokemon') {
  // Decompose accented chars (é→e), lowercase, keep apostrophes and slashes
  const normalized = expandNameGlyphs(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const cleaned = normalized
    .replace(/[^a-z0-9/' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Strip a redundant game-name prefix so set names like "Pokémon Card 151" (or
  // "One Piece Card Game …") don't double up the keyword the query already
  // opens with. Keyword-driven rather than hardcoded to "pokemon", but a plain
  // prefix test rather than a built regex — the keywords are lowercase words.
  const prefix = `${gameKeyword} `;
  return cleaned.startsWith(prefix) ? cleaned.slice(prefix.length) : cleaned;
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

/**
 * Keyword search on TCGplayer, scoped to the card's game.
 *
 * Prefer {@link buildTcgPlayerProductUrl} whenever a `tcgplayer_id` resolves —
 * a product page is the exact card, a keyword search is a guess. This is the
 * fallback for cards with no product id (and for callers that only have preview
 * fields).
 */
export function buildTcgPlayerSearchUrl(params: {
  cardNumber: string;
  name: string;
  setName: string;
  condition?: string | null;
  printing?: string | null;
  /**
   * Which TCG the card is from. Absent means Pokémon — payloads from a backend
   * that predates multi-game carry no game, and the keyword must not vanish for
   * them. Asked of the capability table, never compared here.
   */
  game?: CardGame;
}) {
  // The game's own word, not a hardcoded "pokemon" — that literal is what made a
  // One Piece card search TCGplayer for "pokemon OP16-001" and find nothing.
  const gameKeyword = marketplaceKeywordForGame(params.game);
  const query = [
    gameKeyword,
    cleanedTcgPlayerToken(params.setName, gameKeyword),
    cleanedTcgPlayerToken(params.name, gameKeyword),
    cleanedTcgPlayerToken(params.cardNumber.replace(/^#/, ''), gameKeyword),
  ]
    .filter(Boolean)
    .join(' ');

  // The bare keyword alone means all three fields were empty
  if (!query || query === gameKeyword) {
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
 * PDP.
 *
 * On NO match we deliberately do NOT guess the first printing: with multiple
 * distinct product_ids, guessing can deep-link to the wrong printing — or, when
 * Scrydex mis-maps a product_id, to an ENTIRELY DIFFERENT card (observed live:
 * an ME-promo Oshawott whose phantom "Normal" printing pointed at an Archeops
 * product). We only fall back when the card carries exactly ONE distinct
 * product_id (no ambiguity); otherwise return null so the caller falls back to a
 * name/set/number SEARCH — always the right card, never a random one.
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

  // No label match: only fall back when the whole card resolves to a single
  // distinct product_id (unambiguous). Multiple distinct ids → null → search.
  const distinctIds = new Set<string>();
  for (const variant of variants) {
    const productId = tcgPlayerProductIdFromVariant(variant);
    if (productId) {
      distinctIds.add(productId);
    }
  }
  return distinctIds.size === 1 ? [...distinctIds][0] : null;
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

// True when the variant is a vintage-style edition split (1st Edition / Unlimited).
// ONE plain "<grader> <grade>" pair — deliberately no more than that.
//
// UNQUOTED, per an explicit product call (2026-08-12): the search box should
// read like something a person typed. Known trade accepted with it: as loose
// keywords eBay can relax a low-signal grade number (a bare "3" collides with
// card numbers and gets dropped), backfilling low-grade searches with
// high-volume PSA 10 solds — the failure the quotes used to prevent. If that
// resurfaces as a complaint, re-quote LOW grades only rather than all of them.
//
// Also long gone: the descriptor OR-group — ("PSA 10","PSA GEM MINT 10",
// "PSA GEM MT 10") — which made the search read as a wall of quotes/parens.
function buildEbayGradeTerm(graderToken: string | null, gradeToken: string | null): string | null {
  return [graderToken, gradeToken].filter(Boolean).join(' ') || null;
}

// The collector number as ONE readable token: the de-zeroed fraction
// ("004/020" → 4/20), or the cleaned raw form when it isn't a fraction.
//
// This replaced an OR-group of every common spelling — ("026/086","26/86",
// 026,26) — which widened recall but was most of what made the search box
// unreadable. The single de-zeroed form is how sellers most often word it;
// where it under-matches, the reader can now SEE the query and loosen it,
// which the paren soup made impossible.
function buildEbayCollectorNumberTerm(cardNumber: string): string | null {
  // Parse the fraction from the RAW number — cleanedMarketplaceToken strips
  // the slash ("4/102" → "4 102"), two independently-required tokens that
  // over-constrain the search.
  const raw = cardNumber.replace(/^#/, '').trim();
  const fraction = raw.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!fraction) {
    return cleanedMarketplaceToken(raw);
  }
  const [, numerator, denominator] = fraction;
  return `${Number.parseInt(numerator, 10)}/${Number.parseInt(denominator, 10)}`;
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
  /**
   * Which TCG the card is from. Absent means Pokémon. Pokémon adds NO game
   * keyword (see the capability table: eBay AND-requires every word, and its
   * queries are tuned around not having one); every other game adds its word,
   * because "Ace" or "Nami" on bare eBay is not a search, it's a collision.
   */
  game?: CardGame;
  /**
   * Which side of eBay to land on. Defaults to `'sold'` — the historical
   * behaviour every existing caller relies on.
   *
   * `'active'` is for the "Lowest Listed" surface: live listings sorted
   * cheapest-first. Note eBay's cheapest-first sort is price + SHIPPING, so a
   * $0.99 card with $12 postage can outrank a fairly-priced one — that is
   * eBay's own definition of lowest listed, and it matches what the panel says.
   */
  listingType?: 'sold' | 'active';
}) {
  const graderToken = cleanedMarketplaceToken(params.grader);
  const gradeToken = cleanedMarketplaceToken(params.grade);
  const isJapanese = (params.language ?? '').toLowerCase() === 'japanese';

  // For Japanese cards add a "Japanese" keyword — US eBay listings of JP cards
  // almost always say so, and it's what separates e.g. a JP Shiny Collection
  // Growlithe from the famous ENGLISH Base Set 1st-Edition Growlithe (which the
  // name+edition query would otherwise collide with). The JP set name is in
  // Japanese script and gets stripped from keywords, so "Japanese" + the number
  // carry the disambiguation instead.
  const languageToken = isJapanese ? 'Japanese' : null;

  // Collector number handling. eBay AND-requires EVERY keyword, and "9/111"
  // tokenizes into TWO required tokens ("9" AND "111"). Slab sellers word the
  // number inconsistently (9/111, #9, or omit it; the set total like "111"
  // appears in virtually no real titles), so on a vintage graded card requiring
  // both number tokens over-constrains and zeroes the search (observed live on
  // Neo Genesis Lugia 9/111). So DROP the number for VINTAGE ENGLISH GRADED;
  // name + set + grade is enough for vintage (same-name/same-set print variants
  // barely exist there) and reliably has sold comps. KEEP it where it actually
  // disambiguates and is reliably titled: modern graded (separates alt-art vs
  // regular same-set prints) and Japanese (the JP set name is non-Latin script
  // that gets stripped, so the number carries the disambiguation alongside the
  // "Japanese" keyword).
  /*
    Drop the number for EVERY English graded search, not just vintage. Slab
    titles word the number inconsistently (or omit it), the quoted grade + name
    + set already pin the card, and the number was the other half of the
    unreadable query. Kept where it genuinely carries the disambiguation:
    Japanese (the JP set name is non-Latin script and gets stripped, so
    "Japanese" + the number do that job) and ungraded/raw searches.
  */
  const dropCollectorNumber = !isJapanese && Boolean(gradeToken);
  const numberToken = dropCollectorNumber
    ? null
    : buildEbayCollectorNumberTerm(params.cardNumber);

  // Plain "PSA 10", unquoted — see buildEbayGradeTerm for the accepted trade.
  const gradeTerm = buildEbayGradeTerm(graderToken, gradeToken);

  const query = [
    // Grader + grade first so the search lands on graded sales of this exact card.
    gradeTerm,
    // Game keyword (null for Pokémon — its URLs are unchanged by this).
    ebayKeywordForGame(params.game),
    cleanedMarketplaceToken(params.name),
    languageToken,
    numberToken,
    cleanedMarketplaceToken(params.setName),
    // NOTE: no edition keyword — see isVintageEditionVariant. We intentionally show
    // mixed-edition comps rather than risk zeroing the search (eBay then backfills
    // with junk) on a sparse, expensive 1st-Edition card.
  ]
    .filter(Boolean)
    .join(' ');

  if (!query) {
    return null;
  }

  const searchParams =
    params.listingType === 'active'
      ? new URLSearchParams({
          _nkw: query,
          // No LH_Sold/LH_Complete: those two are what restrict the page to
          // ended listings, so an ACTIVE search simply omits them.
          // _sop=15 = "price + shipping: lowest first".
          _sop: '15',
        })
      : new URLSearchParams({
          _nkw: query,
          // Sold + completed listings so the page shows the recent SALES for this card,
          // sorted most-recent-first (_sop=13 = "ended recently").
          LH_Sold: '1',
          LH_Complete: '1',
          _sop: '13',
        });

  return `https://www.ebay.com/sch/i.html?${searchParams.toString()}`;
}
