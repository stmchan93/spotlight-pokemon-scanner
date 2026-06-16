function cleanedMarketplaceToken(value: string | null | undefined) {
  // Keep a decimal point ONLY between two digits so half-grades survive ("9.5"
  // must not become "9 5", which searches eBay for an unrelated "9 5"); every
  // other period (and all other punctuation) becomes a space.
  return (value ?? '')
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
  const normalized = (value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
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

export function buildEbaySearchUrl(params: {
  cardNumber: string;
  name: string;
  setName: string;
  grader?: string | null;
  grade?: string | null;
}) {
  const query = [
    // Grader + grade first (e.g. "PSA 10") so the search lands on graded sales of
    // this exact card when tapped from a graded price row.
    cleanedMarketplaceToken(params.grader),
    cleanedMarketplaceToken(params.grade),
    cleanedMarketplaceToken(params.name),
    cleanedMarketplaceToken(params.cardNumber.replace(/^#/, '')),
    cleanedMarketplaceToken(params.setName),
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
