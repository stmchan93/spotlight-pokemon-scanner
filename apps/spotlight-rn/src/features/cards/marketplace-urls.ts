function cleanedMarketplaceToken(value: string | null | undefined) {
  return (value ?? '').replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
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

export function buildTcgPlayerSearchUrl(params: {
  cardNumber: string;
  name: string;
  setName: string;
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
  return `https://www.tcgplayer.com/search/all/product?q=${encodedQ}&view=grid`;
}

export function buildEbaySearchUrl(params: {
  cardNumber: string;
  name: string;
  setName: string;
}) {
  const query = [
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
    LH_Sold: '1',
    LH_Complete: '1',
  });

  return `https://www.ebay.com/sch/i.html?${searchParams.toString()}`;
}
