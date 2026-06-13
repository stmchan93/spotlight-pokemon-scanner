import { buildTcgPlayerSearchUrl, buildEbaySearchUrl } from '@/features/cards/marketplace-urls';

describe('buildTcgPlayerSearchUrl', () => {
  it('matches the Rare Candy format for an English card with apostrophe in name', () => {
    expect(
      buildTcgPlayerSearchUrl({
        setName: 'Gym Heroes',
        name: "Sabrina's Slowbro",
        cardNumber: '60/132',
      }),
    ).toBe(
      "https://www.tcgplayer.com/search/all/product?q=pokemon+gym+heroes+sabrina's+slowbro+60/132&view=grid",
    );
  });

  it('strips accents and deduplicates the pokemon prefix for sets named "Pokémon ..."', () => {
    expect(
      buildTcgPlayerSearchUrl({
        setName: 'Pokémon Card 151',
        name: 'Mega Charizard X ex',
        cardNumber: '110/080',
      }),
    ).toBe(
      'https://www.tcgplayer.com/search/all/product?q=pokemon+card+151+mega+charizard+x+ex+110/080&view=grid',
    );
  });

  it('preserves the slash in card numbers', () => {
    const url = buildTcgPlayerSearchUrl({
      setName: 'Base Set',
      name: 'Charizard',
      cardNumber: '4/102',
    });
    expect(url).toContain('4/102');
    expect(url).not.toContain('4%2F102');
  });

  it('strips the leading # from card numbers', () => {
    const url = buildTcgPlayerSearchUrl({
      setName: 'Base Set',
      name: 'Charizard',
      cardNumber: '#4/102',
    });
    expect(url).toContain('charizard+4/102');
  });

  it('uses /search/all/product (not /search/pokemon/product)', () => {
    const url = buildTcgPlayerSearchUrl({
      setName: 'Base Set',
      name: 'Charizard',
      cardNumber: '4/102',
    });
    expect(url).toContain('/search/all/product');
  });

  it('orders tokens as: pokemon <set> <name> <number>', () => {
    const url = buildTcgPlayerSearchUrl({
      setName: 'Jungle',
      name: 'Scyther',
      cardNumber: '10/64',
    })!;
    expect(url).toMatch(/q=pokemon\+jungle\+scyther\+10\/64/);
  });

  it('strips Japanese characters', () => {
    const url = buildTcgPlayerSearchUrl({
      setName: 'Pokémon Card 151',
      name: 'Mega Charizard X ex インフェルノX',
      cardNumber: '110/080',
    })!;
    expect(url).not.toMatch(/[^\x00-\x7F]/);
  });

  it('lowercases the query', () => {
    const url = buildTcgPlayerSearchUrl({
      setName: 'Fossil',
      name: 'Lapras',
      cardNumber: '10/62',
    })!;
    const q = new URL(url.replace(/\+/g, '%20')).searchParams.get('q');
    expect(q).toBe(q?.toLowerCase());
  });

  it('returns null when all fields are empty', () => {
    expect(buildTcgPlayerSearchUrl({ setName: '', name: '', cardNumber: '' })).toBeNull();
  });

  it('returns null when fields are whitespace only', () => {
    expect(buildTcgPlayerSearchUrl({ setName: '  ', name: '  ', cardNumber: ' ' })).toBeNull();
  });

  it('returns a url when only name is provided', () => {
    expect(
      buildTcgPlayerSearchUrl({ setName: '', name: 'Pikachu', cardNumber: '' }),
    ).toContain('pokemon+pikachu');
  });

  it('appends a Condition filter when a known condition label is passed', () => {
    const url = buildTcgPlayerSearchUrl({
      setName: 'Base Set',
      name: 'Charizard',
      cardNumber: '4/102',
      condition: 'Near Mint',
    });
    expect(url).toContain('&Condition=Near+Mint');
  });

  it('accepts short condition codes (NM, LP, MP, HP, D)', () => {
    expect(
      buildTcgPlayerSearchUrl({ setName: 'Base Set', name: 'Charizard', cardNumber: '4/102', condition: 'NM' }),
    ).toContain('&Condition=Near+Mint');
    expect(
      buildTcgPlayerSearchUrl({ setName: 'Base Set', name: 'Charizard', cardNumber: '4/102', condition: 'LP' }),
    ).toContain('&Condition=Lightly+Played');
    expect(
      buildTcgPlayerSearchUrl({ setName: 'Base Set', name: 'Charizard', cardNumber: '4/102', condition: 'MP' }),
    ).toContain('&Condition=Moderately+Played');
    expect(
      buildTcgPlayerSearchUrl({ setName: 'Base Set', name: 'Charizard', cardNumber: '4/102', condition: 'HP' }),
    ).toContain('&Condition=Heavily+Played');
    expect(
      buildTcgPlayerSearchUrl({ setName: 'Base Set', name: 'Charizard', cardNumber: '4/102', condition: 'D' }),
    ).toContain('&Condition=Damaged');
  });

  it('accepts normalized condition ids (near_mint, lightly_played)', () => {
    expect(
      buildTcgPlayerSearchUrl({ setName: 'Base Set', name: 'Charizard', cardNumber: '4/102', condition: 'near_mint' }),
    ).toContain('&Condition=Near+Mint');
    expect(
      buildTcgPlayerSearchUrl({ setName: 'Base Set', name: 'Charizard', cardNumber: '4/102', condition: 'lightly_played' }),
    ).toContain('&Condition=Lightly+Played');
  });

  it('skips Condition filter when condition is unknown, null, or undefined', () => {
    expect(
      buildTcgPlayerSearchUrl({ setName: 'Base Set', name: 'Charizard', cardNumber: '4/102', condition: null }),
    ).not.toContain('Condition=');
    expect(
      buildTcgPlayerSearchUrl({ setName: 'Base Set', name: 'Charizard', cardNumber: '4/102' }),
    ).not.toContain('Condition=');
    expect(
      buildTcgPlayerSearchUrl({ setName: 'Base Set', name: 'Charizard', cardNumber: '4/102', condition: 'Brand New' }),
    ).not.toContain('Condition=');
  });

  it('appends a Printing filter for known printings (Holofoil, Normal, Reverse Holofoil)', () => {
    expect(
      buildTcgPlayerSearchUrl({ setName: 'Base Set', name: 'Charizard', cardNumber: '4/102', printing: 'Holofoil' }),
    ).toContain('&Printing=Holofoil');
    expect(
      buildTcgPlayerSearchUrl({ setName: 'Base Set', name: 'Charizard', cardNumber: '4/102', printing: 'Normal' }),
    ).toContain('&Printing=Normal');
    expect(
      buildTcgPlayerSearchUrl({ setName: 'Base Set', name: 'Charizard', cardNumber: '4/102', printing: 'Reverse Holofoil' }),
    ).toContain('&Printing=Reverse+Holofoil');
  });

  it('maps "First Edition Holofoil" to "1st Edition Holofoil"', () => {
    expect(
      buildTcgPlayerSearchUrl({
        setName: 'Base Set',
        name: 'Charizard',
        cardNumber: '4/102',
        printing: 'First Edition Holofoil',
      }),
    ).toContain('&Printing=1st+Edition+Holofoil');
  });

  it('skips Printing filter when printing is unknown or null (avoids zero-result over-filtering)', () => {
    expect(
      buildTcgPlayerSearchUrl({ setName: 'Base Set', name: 'Charizard', cardNumber: '4/102', printing: 'Cosmos Holo' }),
    ).not.toContain('Printing=');
    expect(
      buildTcgPlayerSearchUrl({ setName: 'Base Set', name: 'Charizard', cardNumber: '4/102', printing: null }),
    ).not.toContain('Printing=');
  });

  it('combines Condition and Printing filters in order on the same url', () => {
    const url = buildTcgPlayerSearchUrl({
      setName: 'Base Set',
      name: 'Charizard',
      cardNumber: '4/102',
      condition: 'Near Mint',
      printing: 'Holofoil',
    });
    expect(url).toContain('&Condition=Near+Mint&Printing=Holofoil');
  });
});

describe('buildEbaySearchUrl', () => {
  it('returns a sold-listings eBay search url', () => {
    const url = buildEbaySearchUrl({
      setName: 'Base Set',
      name: 'Charizard',
      cardNumber: '4/102',
    });
    expect(url).toContain('ebay.com/sch/i.html');
    expect(url).toContain('LH_Sold=1');
    expect(url).toContain('LH_Complete=1');
  });

  it('leads the query with grader + grade and sorts by most-recently-sold', () => {
    const url = buildEbaySearchUrl({
      setName: 'XY Promos',
      name: 'Ditto',
      cardNumber: '#XY177',
      grader: 'PSA',
      grade: '10',
    });
    // grader + grade first so the sold search is scoped to the graded card.
    expect(url).toContain('_nkw=PSA+10+Ditto');
    expect(url).toContain('LH_Sold=1');
    expect(url).toContain('_sop=13');
  });

  it('returns null when all fields are empty', () => {
    expect(buildEbaySearchUrl({ setName: '', name: '', cardNumber: '' })).toBeNull();
  });
});
