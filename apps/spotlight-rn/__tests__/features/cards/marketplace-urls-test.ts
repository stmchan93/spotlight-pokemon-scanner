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

  it('expands the δ Delta Species glyph in the name token', () => {
    const url = buildTcgPlayerSearchUrl({
      setName: 'EX Delta Species',
      name: 'Aerodactyl δ',
      cardNumber: '1/113',
    })!;
    expect(url).toContain('aerodactyl+delta+species');
  });

  it('expands the ◇ Prism Star glyph in the name token', () => {
    const url = buildTcgPlayerSearchUrl({
      setName: 'Ultra Prism',
      name: 'Arceus ◇',
      cardNumber: '95/156',
    })!;
    expect(url).toContain('arceus+prism+star');
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

  it('returns null (no guess) when no label matches and there are multiple distinct ids', () => {
    // Guessing the first printing here can deep-link to the WRONG printing — or,
    // on a Scrydex mis-map, an entirely different card. Caller falls back to search.
    expect(resolveTcgPlayerProductId(variants, 'Cosmos Holo')).toBeNull();
    expect(resolveTcgPlayerProductId(variants, null)).toBeNull();
  });

  it('falls back only when the card resolves to a single distinct product_id', () => {
    // One printing (or several printings sharing ONE id) → unambiguous → use it.
    const single = [
      { name: 'holofoil', marketplaces: [{ name: 'tcgplayer', product_id: '699875' }] },
    ];
    expect(resolveTcgPlayerProductId(single, 'Cosmos Holo')).toBe('699875');
    expect(resolveTcgPlayerProductId(single, null)).toBe('699875');

    const sameIdTwice = [
      { name: 'holofoil', marketplaces: [{ name: 'tcgplayer', product_id: '642163' }] },
      { name: 'reverseHolofoil', marketplaces: [{ name: 'tcgplayer', product_id: '642163' }] },
    ];
    expect(resolveTcgPlayerProductId(sameIdTwice, 'Nonexistent')).toBe('642163');
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

  // The "Lowest Listed" panel needs LIVE listings, cheapest first — the inverse
  // of the sold-comps page every other caller wants.
  it('builds an active-listings search sorted cheapest-first', () => {
    const url = buildEbaySearchUrl({
      setName: 'Base Set',
      name: 'Charizard',
      cardNumber: '4/102',
      grader: 'PSA',
      grade: '10',
      listingType: 'active',
    });

    expect(url).toContain('ebay.com/sch/i.html');
    // These two are what restrict eBay to ENDED listings, so both must be gone.
    expect(url).not.toContain('LH_Sold');
    expect(url).not.toContain('LH_Complete');
    // 15 = price + shipping, lowest first.
    expect(url).toContain('_sop=15');
  });

  it('builds the same keywords for active and sold — only the listing filters differ', () => {
    const params = {
      setName: 'Base Set',
      name: 'Charizard',
      cardNumber: '4/102',
      grader: 'PSA',
      grade: '10',
    };
    const sold = new URL(buildEbaySearchUrl(params)!);
    const active = new URL(buildEbaySearchUrl({ ...params, listingType: 'active' })!);

    expect(active.searchParams.get('_nkw')).toBe(sold.searchParams.get('_nkw'));
  });

  // Every pre-existing caller passes no listingType and must keep the sold page.
  it('defaults to sold listings when no listingType is given', () => {
    const params = { setName: 'Base Set', name: 'Charizard', cardNumber: '4/102' };

    expect(buildEbaySearchUrl(params)).toBe(
      buildEbaySearchUrl({ ...params, listingType: 'sold' }),
    );
  });

  it('leads the query with one plain grader + grade pair and sorts by most-recently-sold', () => {
    const url = buildEbaySearchUrl({
      setName: 'XY Promos',
      name: 'Ditto',
      cardNumber: '#XY177',
      grader: 'PSA',
      grade: '10',
    });
    /*
      Exactly `PSA 10 Ditto …` — UNQUOTED, a product call (2026-08-12): the
      search box should read like something a person typed. The quotes used to
      stop eBay relaxing a low-signal grade number; that trade is accepted and
      recorded at buildEbayGradeTerm.
    */
    const nkw = decodeURIComponent(new URL(url!).searchParams.get('_nkw')!);
    expect(nkw).toMatch(/^PSA 10 Ditto/);
    expect(nkw).not.toContain('"');
    expect(nkw).not.toContain('(');
    expect(url).toContain('LH_Sold=1');
    expect(url).toContain('_sop=13');
  });

  // The number was the other half of the unreadable query, and slab titles
  // word it inconsistently anyway — the quoted grade + name + set pin the card.
  it('drops the collector number from every English graded search', () => {
    const url = buildEbaySearchUrl({
      setName: 'Obsidian Flames',
      name: 'Charizard ex',
      cardNumber: '125/197',
      grader: 'PSA',
      grade: '10',
    });
    const nkw = decodeURIComponent(new URL(url!).searchParams.get('_nkw')!);
    expect(nkw).toBe('PSA 10 Charizard ex Obsidian Flames');
  });

  it('adds a "Japanese" keyword and keeps the number for a Japanese graded card', () => {
    // Regression: a JP Shiny Collection Growlithe 1st-Ed previously searched
    // `"PSA 10" Growlithe 1st Edition` (set name is Japanese script → stripped),
    // colliding with the ENGLISH Base Set 1st-Ed Growlithe. "Japanese" + the
    // number scope it to the right card.
    const url = buildEbaySearchUrl({
      setName: 'シャイニーコレクション',
      name: 'Growlithe',
      cardNumber: '004/020',
      grader: 'PSA',
      grade: '10',
      variant: 'First Edition Holofoil',
      language: 'japanese',
    });
    const nkw = decodeURIComponent(new URL(url!).searchParams.get('_nkw')!);
    expect(nkw).toContain('Japanese');
    // Number kept for JP (the set name is stripped script, so it carries the
    // disambiguation) — as the single de-zeroed form, not the old OR-group.
    expect(nkw).toContain('4/20');
    expect(nkw).not.toContain('1st'); // no edition keyword (mixed-edition comps)
    expect(nkw).toContain('PSA 10');
  });

  // The low grade rides unquoted too — the accepted trade at buildEbayGradeTerm.
  it('keeps a low grade as a plain pair (PSA 3, no quotes)', () => {
    const url = buildEbaySearchUrl({
      setName: 'Evolving Skies',
      name: 'Umbreon VMAX',
      cardNumber: '215/203',
      grader: 'PSA',
      grade: '3',
    });
    expect(url).toContain('_nkw=PSA+3+Umbreon');
  });

  it('preserves a half-grade in the pair ("9.5" not "9 5")', () => {
    const url = buildEbaySearchUrl({
      setName: 'XY Promos',
      name: 'Ditto',
      cardNumber: '#XY177',
      grader: 'CGC',
      grade: '9.5',
    });
    expect(url).toContain('_nkw=CGC+9.5+Ditto');
    expect(url).not.toContain('9+5');
  });

  it('adds no grade phrase when there is no grade (raw card sold search stays loose)', () => {
    const url = buildEbaySearchUrl({
      setName: 'Base Set',
      name: 'Charizard',
      cardNumber: '4/102',
    });
    const nkw = decodeURIComponent(new URL(url!).searchParams.get('_nkw')!);
    expect(nkw).not.toContain('PSA');
    expect(url).toContain('_nkw=Charizard');
    // The collector number is an OR-group of its common wordings.
    // The single readable fraction form, not the old ("4/102",4) OR-group.
    expect(nkw).toContain('4/102');
    expect(nkw).not.toContain('(');
  });

  it('returns null when all fields are empty', () => {
    expect(buildEbaySearchUrl({ setName: '', name: '', cardNumber: '' })).toBeNull();
  });

  it('does NOT add an edition keyword for a First Edition variant', () => {
    // We deliberately omit edition: a vintage 1st-Ed card is often a $$$ rarity
    // with no sold comps in eBay's 90-day window, so requiring an edition term
    // just zeroes the search and eBay backfills with junk. Show mixed-edition
    // comps instead. The variant is still used to DROP the over-constraining
    // collector number (see the vintage number tests below).
    const url = buildEbaySearchUrl({
      setName: 'Base Set',
      name: 'Charizard',
      cardNumber: '4/102',
      grader: 'PSA',
      grade: '10',
      variant: 'First Edition Holofoil',
    })!;
    const nkw = decodeURIComponent(new URL(url).searchParams.get('_nkw')!);
    expect(nkw).not.toContain('1st');
    expect(nkw.toLowerCase()).not.toContain('edition');
  });

  it('does NOT add an edition keyword for a Unlimited variant (no -1st exclusion)', () => {
    const url = buildEbaySearchUrl({
      setName: 'Base Set',
      name: 'Charizard',
      cardNumber: '4/102',
      grader: 'PSA',
      grade: '10',
      variant: 'Unlimited Holofoil',
    })!;
    const nkw = decodeURIComponent(new URL(url).searchParams.get('_nkw')!);
    // The confusing-looking negative exclusion is gone entirely.
    expect(nkw).not.toContain('-1st');
    expect(nkw.toLowerCase()).not.toContain('edition');
    expect(nkw).not.toContain('unlimited');
  });

  it('leaves a modern Holofoil/Normal printing unchanged (no edition qualifier)', () => {
    const holo = buildEbaySearchUrl({
      setName: 'Evolving Skies',
      name: 'Umbreon VMAX',
      cardNumber: '215/203',
      grader: 'PSA',
      grade: '10',
      variant: 'Holofoil',
    })!;
    expect(holo).not.toContain('1st');
    expect(holo).not.toContain('Edition');

    const normal = buildEbaySearchUrl({
      setName: 'Base Set',
      name: 'Machop',
      cardNumber: '52/102',
      variant: 'Normal',
    })!;
    expect(normal).not.toContain('1st');
    expect(normal).not.toContain('Edition');
  });

  it('leaves the query unchanged when no variant is provided', () => {
    const withVariant = buildEbaySearchUrl({
      setName: 'Base Set',
      name: 'Charizard',
      cardNumber: '4/102',
    });
    expect(withVariant).not.toContain('1st');
    expect(withVariant).not.toContain('Edition');
  });

  it('drops the collector number for a vintage 1st Edition graded card', () => {
    const url = buildEbaySearchUrl({
      name: 'Lugia',
      setName: 'Neo Genesis',
      cardNumber: '9/111',
      grader: 'PSA',
      grade: '10',
      variant: '1st Edition Holofoil',
    })!;
    expect(decodeURIComponent(new URL(url).searchParams.get('_nkw')!)).toContain('PSA 10');
    expect(url).toContain('Lugia');
    expect(url).toContain('Neo+Genesis');
    // No edition keyword (mixed-edition comps by design).
    expect(decodeURIComponent(new URL(url).searchParams.get('_nkw')!)).not.toContain('1st');
    // The number is dropped for vintage graded: eBay AND-requires "9" AND "111",
    // and requiring both (on top of the set name) over-constrains and zeroes the
    // search. Name + set + grade is tight enough for vintage.
    expect(url).not.toContain('111');
  });

  it('drops the collector number for a modern English graded card too', () => {
    // The drop used to be vintage-only. Slab titles word the number
    // inconsistently or omit it, and the quoted grade + name + set already pin
    // the card — the number was the other half of the unreadable query.
    const url = buildEbaySearchUrl({
      setName: 'Evolving Skies',
      name: 'Umbreon VMAX',
      cardNumber: '215/203',
      grader: 'PSA',
      grade: '10',
    });
    const nkw = decodeURIComponent(new URL(url!).searchParams.get('_nkw')!);
    expect(nkw).toBe('PSA 10 Umbreon VMAX Evolving Skies');
  });

  it('drops the collector number for a vintage Unlimited graded card (no edition exclusion)', () => {
    const url = buildEbaySearchUrl({
      name: 'Charizard',
      setName: 'Base Set',
      cardNumber: '4/102',
      grader: 'PSA',
      grade: '10',
      variant: 'Unlimited Holofoil',
    })!;
    const nkw = decodeURIComponent(new URL(url).searchParams.get('_nkw')!);
    // No edition keyword/exclusion at all; number dropped for vintage graded.
    expect(nkw).not.toContain('-1st');
    expect(nkw.toLowerCase()).not.toContain('edition');
    expect(url).not.toContain('102');
  });

  it('keeps the collector number for a raw vintage card (no grade ⇒ not graded)', () => {
    const url = buildEbaySearchUrl({
      name: 'Charizard',
      setName: 'Base Set',
      cardNumber: '4/102',
      variant: '1st Edition Holofoil',
    })!;
    expect(url).toContain('102');
  });

  it('expands the δ Delta Species glyph to words instead of dropping it', () => {
    const url = buildEbaySearchUrl({
      setName: 'EX Delta Species',
      name: 'Aerodactyl δ',
      cardNumber: '1/113',
    })!;
    expect(url).toContain('Aerodactyl+Delta+Species');
    expect(url).not.toContain('%CE%B4');
  });

  it('expands the ◇ Prism Star glyph to words', () => {
    const url = buildEbaySearchUrl({
      setName: 'Ultra Prism',
      name: 'Arceus ◇',
      cardNumber: '95/156',
    })!;
    expect(url).toContain('Arceus+Prism+Star');
    expect(url).not.toContain('%E2%97%87');
  });

  it('expands the ☆ Gold Star glyph to words', () => {
    const url = buildEbaySearchUrl({
      setName: 'EX Team Rocket Returns',
      name: 'Alakazam ☆',
      cardNumber: '108/109',
      grader: 'PSA',
      grade: '10',
    })!;
    expect(url).toContain('Alakazam+Gold+Star');
    expect(url).not.toContain('%E2%98%86');
  });

  it('expands the ♂ gender glyph to a word', () => {
    const url = buildEbaySearchUrl({
      setName: 'Gym Challenge',
      name: "Giovanni's Nidoran ♂",
      cardNumber: '83/132',
    })!;
    expect(url).toContain('Nidoran+Male');
  });

  it('strips accents so accented Latin names survive (é→e)', () => {
    const url = buildEbaySearchUrl({
      setName: 'Promo',
      name: 'Café Master',
      cardNumber: '1',
    })!;
    expect(url).toContain('Cafe');
    expect(url).not.toContain('%C3%A9');
  });
});

/**
 * Game scoping.
 *
 * The bug this locks down: `buildTcgPlayerSearchUrl` hardcoded 'pokemon' as the
 * leading search token, so a One Piece card searched TCGplayer for
 * "pokemon OP16-001 …" and found nothing. Every Pokémon assertion above is the
 * other half of this contract — those URLs must not move.
 */
describe('marketplace URLs are scoped to the card game', () => {
  it('leads a One Piece TCGplayer search with "one piece", never "pokemon"', () => {
    const url = buildTcgPlayerSearchUrl({
      setName: 'The Time Of Battle',
      name: 'Portgas.D.Ace',
      cardNumber: 'OP16-001',
      game: 'onepiece',
    })!;
    expect(url).not.toContain('pokemon');
    // The existing cleaner turns "Portgas.D.Ace" / "OP16-001" into spaced
    // tokens, exactly as it does for Pokémon names — unchanged by this work.
    expect(url).toContain('q=one+piece+the+time+of+battle+portgas+d+ace+op16+001');
  });

  it.each(['lorcana', 'riftbound', 'gundam'] as const)(
    'leads a %s TCGplayer search with its own keyword',
    (game) => {
      const url = buildTcgPlayerSearchUrl({
        setName: 'Some Set',
        name: 'Some Card',
        cardNumber: '001',
        game,
      })!;
      expect(url).not.toContain('pokemon');
      expect(url).toContain(`q=${game}+some+set+some+card+001`);
    },
  );

  it('keeps the Pokémon keyword when no game is given (older payloads)', () => {
    // Absent game means Pokémon. Dropping the keyword here would silently widen
    // every existing search on any payload from a pre-multi-game backend.
    const url = buildTcgPlayerSearchUrl({
      setName: 'Base Set',
      name: 'Charizard',
      cardNumber: '4/102',
    })!;
    expect(url).toContain('q=pokemon+base+set+charizard+4/102');
  });

  it('returns null when only the game keyword would remain', () => {
    // The empty-field guard has to compare against the GAME'S keyword — a
    // literal 'pokemon' check would let "one piece" through as a real query.
    expect(
      buildTcgPlayerSearchUrl({ setName: '', name: '', cardNumber: '', game: 'onepiece' }),
    ).toBeNull();
    expect(
      buildTcgPlayerSearchUrl({ setName: ' ', name: ' ', cardNumber: ' ', game: 'lorcana' }),
    ).toBeNull();
  });

  it('does not double up a game keyword already leading the set name', () => {
    const url = buildTcgPlayerSearchUrl({
      setName: 'One Piece Card Game Romance Dawn',
      name: 'Monkey.D.Luffy',
      cardNumber: 'OP01-001',
      game: 'onepiece',
    })!;
    expect(url).toContain('q=one+piece+card+game+romance+dawn');
    expect(url.match(/one\+piece/g)).toHaveLength(1);
  });

  it('adds a game keyword to a non-Pokémon eBay search', () => {
    const url = buildEbaySearchUrl({
      setName: 'Romance Dawn',
      name: 'Monkey.D.Luffy',
      cardNumber: 'OP01-001',
      game: 'onepiece',
    })!;
    expect(url).toContain('one+piece');
    expect(url).not.toContain('pokemon');
  });

  it('adds NO game keyword to a Pokémon eBay search, with or without the game', () => {
    // eBay AND-requires every keyword, so a token is not free: Pokémon's queries
    // are tuned around not having one, and these two URLs must stay identical.
    const params = {
      setName: 'Base Set',
      name: 'Charizard',
      cardNumber: '4/102',
      grader: 'PSA',
      grade: '10',
    };
    const withoutGame = buildEbaySearchUrl(params)!;
    const withGame = buildEbaySearchUrl({ ...params, game: 'pokemon' })!;
    expect(withGame).toBe(withoutGame);
    expect(withoutGame).not.toContain('pokemon');
  });

  it('prefers an exact product page over a keyword search when a product id resolves', () => {
    // Every One Piece card carries a TCGplayer product id (2,633/2,633), so the
    // PDP should essentially never fall back to guessing with keywords.
    const productId = resolveTcgPlayerProductId(
      [{ name: 'normal', marketplaces: [{ name: 'tcgplayer', product_id: '693417' }] }],
      'normal',
    );
    expect(productId).toBe('693417');
    expect(buildTcgPlayerProductUrl({ productId: productId!, condition: 'Near Mint' })).toBe(
      'https://www.tcgplayer.com/product/693417?Condition=Near+Mint',
    );
  });
});
