function cleanedMarketplaceToken(value: string | null | undefined) {
  return (value ?? '').replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function buildTcgPlayerSearchUrl(params: {
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
    q: query,
    view: 'grid',
  });

  return `https://www.tcgplayer.com/search/pokemon/product?${searchParams.toString()}`;
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
