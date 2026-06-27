import {
  buildEbaySearchUrl,
  buildTcgPlayerProductUrl,
  buildTcgPlayerSearchUrl,
  resolveTcgPlayerProductId,
} from '@/features/cards/marketplace-urls';

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

describe('buildTcgPlayerProductUrl', () => {
  it('builds the exact product page url without a condition filter', () => {
    expect(buildTcgPlayerProductUrl({ productId: '12345' })).toBe(
      'https://www.tcgplayer.com/product/12345',
    );
  });

  it('appends ?Condition=Near+Mint when a known condition is passed', () => {
    expect(buildTcgPlayerProductUrl({ productId: '12345', condition: 'Near Mint' })).toBe(
      'https://www.tcgplayer.com/product/12345?Condition=Near+Mint',
    );
  });

  it('accepts short/normalized condition codes', () => {
    expect(buildTcgPlayerProductUrl({ productId: '12345', condition: 'NM' })).toBe(
      'https://www.tcgplayer.com/product/12345?Condition=Near+Mint',
    );
    expect(buildTcgPlayerProductUrl({ productId: '12345', condition: 'lightly_played' })).toBe(
      'https://www.tcgplayer.com/product/12345?Condition=Lightly+Played',
    );
  });

  it('omits the condition filter when the condition is unknown or null', () => {
    expect(buildTcgPlayerProductUrl({ productId: '12345', condition: 'Brand New' })).toBe(
      'https://www.tcgplayer.com/product/12345',
    );
    expect(buildTcgPlayerProductUrl({ productId: '12345', condition: null })).toBe(
      'https://www.tcgplayer.com/product/12345',
    );
  });

  it('returns null when productId is empty or whitespace', () => {
    expect(buildTcgPlayerProductUrl({ productId: '' })).toBeNull();
    expect(buildTcgPlayerProductUrl({ productId: '   ' })).toBeNull();
  });
});

describe('resolveTcgPlayerProductId', () => {
  const variants = [
    {
      name: 'holofoil',
      marketplaces: [{ name: 'tcgplayer', product_id: '111' }],
    },
    {
      name: 'reverse holofoil',
      marketplaces: [{ name: 'tcgplayer', product_id: '222' }],
    },
    {
      name: 'unlimited holofoil',
      marketplaces: [{ name: 'tcgplayer', product_id: '333' }],
    },
  ];

  it('picks the reverse-holo product_id over the first when reverse holo is selected', () => {
    expect(resolveTcgPlayerProductId(variants, 'Reverse Holofoil')).toBe('222');
  });

  it('matches case/space/underscore-insensitively', () => {
    expect(resolveTcgPlayerProductId(variants, 'reverse_holofoil')).toBe('222');
    expect(resolveTcgPlayerProductId(variants, '  REVERSE   HOLOFOIL ')).toBe('222');
  });

  it('coerces a numeric product_id to a string', () => {
    const numericVariants = [{ name: 'holofoil', marketplaces: [{ name: 'tcgplayer', product_id: 999 }] }];
    expect(resolveTcgPlayerProductId(numericVariants, 'Holofoil')).toBe('999');
  });

  it('falls back to the first variant with a tcgplayer id when no label matches', () => {
    expect(resolveTcgPlayerProductId(variants, 'Cosmos Holo')).toBe('111');
    expect(resolveTcgPlayerProductId(variants, null)).toBe('111');
  });

  it('bridges camelCase payload keys to the humanized PDP label (live Base Charizard)', () => {
    // sourcePayload names are camelCase; the PDP label is humanized + spaced.
    // Without the camelCase bridge this falls back to the first id (the WRONG
    // printing), which is the bug this guards against.
    const baseCharizard = [
      { name: 'firstEditionShadowlessHolofoil', marketplaces: [{ name: 'tcgplayer', product_id: '106999' }] },
      { name: 'jumbo', marketplaces: [{ name: 'tcgplayer', product_id: '179079' }] },
      { name: 'metal', marketplaces: [{ name: 'tcgplayer', product_id: '252517' }] },
      { name: 'unlimitedHolofoil', marketplaces: [{ name: 'tcgplayer', product_id: '42382' }] },
    ];
    expect(resolveTcgPlayerProductId(baseCharizard, 'Unlimited Holofoil')).toBe('42382');
    expect(resolveTcgPlayerProductId(baseCharizard, 'First Edition Shadowless Holofoil')).toBe('106999');
    expect(resolveTcgPlayerProductId(baseCharizard, 'Metal')).toBe('252517');
  });

  it('returns null when no variant has a tcgplayer marketplace', () => {
    const noTcg = [
      { name: 'holofoil', marketplaces: [{ name: 'cardmarket', product_id: 'abc' }] },
      { name: 'normal', marketplaces: [] },
    ];
    expect(resolveTcgPlayerProductId(noTcg, 'Holofoil')).toBeNull();
  });

  it('is defensive against undefined / empty / oddly-shaped data', () => {
    expect(resolveTcgPlayerProductId(undefined, 'Holofoil')).toBeNull();
    expect(resolveTcgPlayerProductId([], 'Holofoil')).toBeNull();
    expect(
      resolveTcgPlayerProductId(
        [null, { name: 'holofoil' }, { name: 'normal', marketplaces: null }] as never,
        'Holofoil',
      ),
    ).toBeNull();
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

  it('leads the query with a QUOTED grader + grade phrase and sorts by most-recently-sold', () => {
    const url = buildEbaySearchUrl({
      setName: 'XY Promos',
      name: 'Ditto',
      cardNumber: '#XY177',
      grader: 'PSA',
      grade: '10',
    });
    // grader + grade first, as an exact phrase, so eBay can't relax the grade number
    // and backfill with the high-volume grade ("%22" is the encoded double-quote).
    expect(url).toContain('_nkw=%22PSA+10%22+Ditto');
    expect(url).toContain('LH_Sold=1');
    expect(url).toContain('_sop=13');
  });

  it('quotes a low grade so eBay does not backfill with high-grade solds (PSA 3 ≠ PSA 10)', () => {
    const url = buildEbaySearchUrl({
      setName: 'Evolving Skies',
      name: 'Umbreon VMAX',
      cardNumber: '215/203',
      grader: 'PSA',
      grade: '3',
    });
    expect(url).toContain('_nkw=%22PSA+3%22+Umbreon');
  });

  it('preserves a half-grade inside the quoted phrase ("9.5" not "9 5")', () => {
    const url = buildEbaySearchUrl({
      setName: 'XY Promos',
      name: 'Ditto',
      cardNumber: '#XY177',
      grader: 'CGC',
      grade: '9.5',
    });
    expect(url).toContain('_nkw=%22CGC+9.5%22+Ditto');
    expect(url).not.toContain('9+5');
  });

  it('does not quote when there is no grade (raw card sold search stays loose)', () => {
    const url = buildEbaySearchUrl({
      setName: 'Base Set',
      name: 'Charizard',
      cardNumber: '4/102',
    });
    expect(url).not.toContain('%22');
    expect(url).toContain('_nkw=Charizard');
  });

  it('returns null when all fields are empty', () => {
    expect(buildEbaySearchUrl({ setName: '', name: '', cardNumber: '' })).toBeNull();
  });
});
