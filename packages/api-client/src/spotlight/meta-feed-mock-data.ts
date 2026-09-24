import type {
  CalendarFeed,
  HotCards,
  MetaCard,
  MetaExposure,
  MetaGroup,
  MetaGroupDetail,
  MetaPulse,
  NewsFeed,
  NewsItem,
  SetSpotlight,
  SetSpotlightCard,
} from './types';

/*
  Fixed meta feed payloads for the mock repository, dev screens and tests.
  Numbers and copy follow the Social feed mockup
  (docs/meta-feed-mockup/Main.dc.html) so a dev render reads like the design.
*/

const COMPUTED_AT = '2026-09-23T13:00:00.000Z';

function metaCard(overrides: Partial<MetaCard> & Pick<MetaCard, 'cardId' | 'name'>): MetaCard {
  return {
    game: 'pokemon',
    number: null,
    setName: null,
    imageUrl: null,
    lane: 'raw',
    grader: null,
    grade: null,
    population: null,
    priceNow: 0,
    priceThen: 0,
    changePercent: 0,
    currencyCode: 'USD',
    ...overrides,
  };
}

const IMG = 'https://images.pokemontcg.io';

// Cards reused across the groups, the exposure payload and the group page.
const latiosStar = metaCard({
  cardId: 'ex8-106', name: 'Latios ☆', number: '106', setName: 'Deoxys', imageUrl: `${IMG}/ex8/106.png`,
  lane: 'graded', grader: 'PSA', grade: '10', population: 27, priceNow: 11_800, priceThen: 9_008, changePercent: 31,
});
const hoOh = metaCard({
  cardId: 'ecard3-146', name: 'Ho-oh', number: '146', setName: 'Skyridge', imageUrl: `${IMG}/ecard3/146.png`,
  lane: 'graded', grader: 'PSA', grade: '10', population: 41, priceNow: 4_850, priceThen: 4_008, changePercent: 21,
});
const latiasStar = metaCard({
  cardId: 'ex8-105', name: 'Latias ☆', number: '105', setName: 'Deoxys', imageUrl: `${IMG}/ex8/105.png`,
  lane: 'graded', grader: 'PSA', grade: '10', population: 38, priceNow: 7_400, priceThen: 6_298, changePercent: 17.5,
});
const mortysGengar = metaCard({
  cardId: 'neo4-5', name: "Morty's Gengar", number: '5', setName: 'VS', imageUrl: `${IMG}/neo4/5.png`,
  lane: 'graded', grader: 'PSA', grade: '10', population: 33, priceNow: 1_120, priceThen: 981, changePercent: 14.2,
});
const rocketsRaikou = metaCard({
  cardId: 'ex7-107', name: "Rocket's Raikou ex", number: '107', setName: 'Team Rocket Returns', imageUrl: `${IMG}/ex7/107.png`,
  lane: 'graded', grader: 'PSA', grade: '10', population: 44, priceNow: 2_050, priceThen: 1_867, changePercent: 9.8,
});
const deoxysEx = metaCard({
  cardId: 'ex8-99', name: 'Deoxys ex', number: '99', setName: 'Deoxys', imageUrl: `${IMG}/ex8/99.png`,
  priceNow: 184, priceThen: 152, changePercent: 21,
});
const pikachuPromo = metaCard({
  cardId: 'jp-promo-pikachu', name: 'Pikachu (Promo)', setName: 'Japanese promos', imageUrl: `${IMG}/basep/1.png`,
  priceNow: 96, priceThen: 84, changePercent: 14.3,
});
const baseCharizard = metaCard({
  cardId: 'base1-4', name: 'Charizard', number: '4', setName: 'Base Set', imageUrl: `${IMG}/base1/4.png`,
  priceNow: 412, priceThen: 380, changePercent: 8.4,
});
const umbreonSecret = metaCard({
  cardId: 'sv8pt5-161', name: 'Umbreon ex', number: '161', setName: 'Prismatic Evolutions', imageUrl: `${IMG}/sv8pt5/161.png`,
  priceNow: 1_040, priceThen: 996, changePercent: 4.4,
});
const sirCharizard = metaCard({
  cardId: 'sv3pt5-199', name: 'Charizard ex', number: '199', setName: '151', imageUrl: `${IMG}/sv3pt5/199.png`,
  priceNow: 238, priceThen: 262, changePercent: -9.2,
});
const goldStarRayquaza = metaCard({
  cardId: 'ex7-111', name: 'Rayquaza ☆', number: '111', setName: 'Deoxys', imageUrl: `${IMG}/ex8/107.png`,
  priceNow: 1_480, priceThen: 1_560, changePercent: -5.1,
});
const irMew = metaCard({
  cardId: 'sv3pt5-193', name: 'Mew', number: '193', setName: '151', imageUrl: `${IMG}/sv3pt5/193.png`,
  priceNow: 21.5, priceThen: 22.8, changePercent: -5.7,
});

type MockGroupSeed = Pick<
  MetaGroup,
  'groupKey' | 'label' | 'lane' | 'description' | 'medianChangePercent' | 'valueChangeUsd' | 'cardCount' | 'topCards'
> & { valueNow: number };

function mockGroup(seed: MockGroupSeed): MetaGroup {
  const steps = 8;
  const end = 100 + seed.medianChangePercent;
  // A slightly uneven climb/slide so the sparklines don't read as rulers.
  const wobble = [0, 0.3, -0.2, 0.4, -0.1, 0.2, -0.3, 0];
  const sparkPoints = Array.from({ length: steps }, (_, index) =>
    Math.round((100 + ((end - 100) * index) / (steps - 1) + wobble[index] * Math.sign(seed.medianChangePercent)) * 10) / 10);
  sparkPoints[steps - 1] = end;
  return {
    ...seed,
    valueThen: seed.valueNow - seed.valueChangeUsd,
    movedCardCount: Math.round(seed.cardCount * 0.4),
    sparkPoints,
  };
}

export const mockMetaGroups: MetaGroup[] = [
  mockGroup({
    groupKey: 'vintage:graded:psa10:pop_le_50',
    label: 'Vintage PSA 10 · low pop',
    lane: 'graded',
    description: 'PSA 10s from before 2003 with 50 or fewer graded',
    medianChangePercent: 18.4,
    valueNow: 2_650_000,
    valueChangeUsd: 412_000,
    cardCount: 1840,
    topCards: [latiosStar, hoOh, latiasStar, mortysGengar, rocketsRaikou],
  }),
  mockGroup({
    groupKey: 'ex_era:raw:nm',
    label: 'EX era',
    lane: 'raw',
    description: 'EX-series sets, 2003–2007 · NM',
    medianChangePercent: 12.4,
    valueNow: 870_000,
    valueChangeUsd: 96_000,
    cardCount: 3_210,
    topCards: [deoxysEx],
  }),
  mockGroup({
    groupKey: 'promos:raw:jp',
    label: 'Japanese promos',
    lane: 'raw',
    description: 'Japanese promo cards · NM',
    medianChangePercent: 8.1,
    valueNow: 547_000,
    valueChangeUsd: 41_000,
    cardCount: 2_480,
    topCards: [pikachuPromo],
  }),
  mockGroup({
    groupKey: 'vintage:raw:nm',
    label: 'Vintage raw',
    lane: 'raw',
    description: 'pre-2003 · NM · 9,600 cards',
    medianChangePercent: 6.3,
    valueNow: 6_040_000,
    valueChangeUsd: 238_000,
    cardCount: 9_600,
    topCards: [baseCharizard],
  }),
  mockGroup({
    groupKey: 'modern:raw:secret',
    label: 'Secret rares',
    lane: 'raw',
    description: 'Scarlet & Violet secret rares · NM',
    medianChangePercent: 4,
    valueNow: 572_000,
    valueChangeUsd: 22_000,
    cardCount: 640,
    topCards: [umbreonSecret],
  }),
  mockGroup({
    groupKey: 'modern:raw:ir',
    label: 'Illustration Rare',
    lane: 'raw',
    description: 'Scarlet & Violet · NM · 1,120 cards',
    medianChangePercent: -2.1,
    valueNow: 1_030_000,
    valueChangeUsd: -22_000,
    cardCount: 1_120,
    topCards: [irMew],
  }),
  mockGroup({
    groupKey: 'vintage:raw:gold_star',
    label: 'Gold Star ☆',
    lane: 'raw',
    description: 'EX-era Gold Stars · NM · 31 cards',
    medianChangePercent: -4,
    valueNow: 1_464_000,
    valueChangeUsd: -61_000,
    cardCount: 31,
    topCards: [goldStarRayquaza],
  }),
  mockGroup({
    groupKey: 'modern:raw:sir',
    label: 'Special Illustration Rare',
    lane: 'raw',
    description: 'Scarlet & Violet · NM · 412 cards',
    medianChangePercent: -4.1,
    valueNow: 4_400_000,
    valueChangeUsd: -188_000,
    cardCount: 412,
    topCards: [sirCharizard],
  }),
];

export const mockMetaPulse: MetaPulse = {
  game: 'pokemon',
  windowDays: 7,
  lane: 'all',
  availableWindows: [7, 30],
  availableGames: ['pokemon', 'onepiece', 'lorcana'],
  computedAt: COMPUTED_AT,
  asOfDate: '2026-09-23',
  headline: {
    title: 'Vintage low-pop is running. Modern chase cards are cooling.',
    body: 'Vintage PSA 10s with a population of 50 or less rose 18.4% this week, while Scarlet & Violet Special Illustration Rares slipped 4.1%.',
  },
  summary: {
    rawValueChangePercent: 1.2,
    rawValueChangeUsd: 50_000,
    gradedValueChangePercent: 6.8,
    gradedValueChangeUsd: 412_000,
    risingCount: 5,
    coolingCount: 3,
  },
  groups: mockMetaGroups,
  ladders: [
    {
      title: 'Vintage: raw vs graded',
      rungs: [
        { label: 'Raw NM', lane: 'raw', medianChangePercent: 4.1 },
        { label: 'PSA 9', lane: 'graded', medianChangePercent: 7.6 },
        { label: 'PSA 10', lane: 'graded', medianChangePercent: 12.9 },
        { label: 'PSA 10 · pop ≤ 50', lane: 'graded', medianChangePercent: 18.4 },
      ],
    },
  ],
};

/** The group page payload for one of the mock groups (topCards already sorted). */
export function mockMetaGroupDetail(groupKey: string): MetaGroupDetail | null {
  const group = mockMetaGroups.find((candidate) => candidate.groupKey === groupKey);
  return group ? { game: 'pokemon', windowDays: 7, group, asOfDate: '2026-09-23' } : null;
}

const blastoisePsa10 = metaCard({
  cardId: 'base1-2', name: 'Blastoise', number: '2', setName: 'Base Set', imageUrl: `${IMG}/base1/2.png`,
  lane: 'graded', grader: 'PSA', grade: '10', population: 48, priceNow: 3_900, priceThen: 3_640, changePercent: 7.1,
});
const lugiaPsa10 = metaCard({
  cardId: 'neo1-9', name: 'Lugia', number: '9', setName: 'Neo Genesis', imageUrl: `${IMG}/neo1/9.png`,
  lane: 'graded', grader: 'PSA', grade: '10', population: 36, priceNow: 8_200, priceThen: 7_900, changePercent: 3.8,
});

/** The signed-in viewer's exposure, matching the Meta pulse v4 mockup's callout. */
export const mockMetaExposure: MetaExposure = {
  game: 'pokemon',
  windowDays: 7,
  callout: {
    title: 'Your vintage is up +$312 this week',
    body: '4 PSA 10s and 11 raw cards in rising groups',
    valueChangeUsd: 312,
    imageUrls: [hoOh.imageUrl, mortysGengar.imageUrl].filter((url): url is string => url != null),
  },
  groups: {
    'vintage:graded:psa10:pop_le_50': {
      ownedCount: 4,
      valueChangeUsd: 312,
      ownedCards: [hoOh, mortysGengar, blastoisePsa10, lugiaPsa10],
    },
    'vintage:raw:nm': {
      ownedCount: 11,
      valueChangeUsd: 64,
      ownedCards: [baseCharizard],
    },
    'modern:raw:sir': {
      ownedCount: 3,
      valueChangeUsd: -24,
      ownedCards: [sirCharizard],
    },
  },
};

/** Upcoming dates, matching the Coming up mockups (FeedV6 / CalendarV5). */
export const mockCalendarFeed: CalendarFeed = {
  items: [
    {
      id: 'release-delta-reign-en',
      date: '2026-09-26',
      kind: 'release',
      game: 'pokemon',
      title: 'Delta Reign (English)',
      subtitle: 'Pre-release prices usually peak the week before',
      setId: null,
      url: 'https://www.pokemon.com/us/pokemon-tcg',
    },
    {
      id: 'ban-onepiece-2026-09',
      date: '2026-09-30',
      kind: 'ban_list',
      game: 'onepiece',
      title: 'One Piece ban & restriction update',
      subtitle: 'Staples on the list tend to drop the same day',
      setId: null,
      url: 'https://en.onepiece-cardgame.com/rules/',
    },
    {
      id: 'reveal-pokemon-presents-2026-10',
      date: '2026-10-03',
      kind: 'reveal',
      game: 'pokemon',
      title: 'Pokémon Presents',
      subtitle: 'Set reveals often move older reprint candidates',
      setId: null,
      url: 'https://www.pokemon.com/us/pokemon-news',
    },
    {
      id: 'release-cel25-anniversary',
      date: '2026-10-11',
      kind: 'event',
      game: 'pokemon',
      title: 'Celebrations anniversary tournament',
      subtitle: 'Event staples tend to rise that week',
      setId: 'cel25',
      url: null,
    },
  ],
};

export const mockHotCards: HotCards = {
  computedAt: COMPUTED_AT,
  windowHours: 24,
  minDistinctUsers: 5,
  eligible: true,
  items: [
    {
      cardId: 'ecard3-149',
      game: 'pokemon',
      name: 'Lugia (Crystal)',
      number: '149',
      setName: 'Aquapolis',
      imageUrl: 'https://images.pokemontcg.io/ecard3/149.png',
      distinctUsers: 38,
      baselineRatio: 4.2,
      priceNow: 2410,
      changePercent7d: 31,
      currencyCode: 'USD',
    },
    {
      cardId: 'pop5-17',
      game: 'pokemon',
      name: 'Umbreon ☆',
      number: '17',
      setName: 'POP Series 5',
      imageUrl: 'https://images.pokemontcg.io/pop5/17.png',
      distinctUsers: 27,
      baselineRatio: 2.8,
      priceNow: 3050,
      changePercent7d: 12,
      currencyCode: 'USD',
    },
    {
      cardId: 'op09-119',
      game: 'onepiece',
      name: 'Monkey.D.Luffy',
      number: 'OP09-119',
      setName: 'OP09',
      imageUrl: 'https://images.example.test/onepiece/op09-119.png',
      distinctUsers: 19,
      baselineRatio: 2.1,
      priceNow: 1120,
      changePercent7d: -6,
      currencyCode: 'USD',
    },
  ],
};

function setCard(overrides: Partial<SetSpotlightCard> & Pick<SetSpotlightCard, 'cardId' | 'name'>): SetSpotlightCard {
  return {
    number: null,
    imageUrl: null,
    lane: 'raw',
    grader: null,
    grade: null,
    priceNow: 0,
    changePercent7d: null,
    currencyCode: 'USD',
    ...overrides,
  };
}

const mockVideos: NewsItem[] = [
  {
    id: 'yt-cel25-1',
    kind: 'video',
    source: 'YouTube · PokeRev',
    title: 'Opening Celebrations five years later',
    url: 'https://www.youtube.com/watch?v=mock-cel25-1',
    imageUrl: 'https://i.ytimg.com/vi/mock-cel25-1/hqdefault.jpg',
    publishedAt: '2026-09-20T15:00:00.000Z',
    game: 'pokemon',
    setId: 'cel25',
    cardIds: [],
    tags: ['Video'],
    video: { channelTitle: 'PokeRev', durationSeconds: 1122, viewCount: 212_000 },
  },
  {
    id: 'yt-cel25-2',
    kind: 'video',
    source: 'YouTube · Leonhart',
    title: 'Is Celebrations still worth collecting?',
    url: 'https://www.youtube.com/watch?v=mock-cel25-2',
    imageUrl: 'https://i.ytimg.com/vi/mock-cel25-2/hqdefault.jpg',
    publishedAt: '2026-09-16T15:00:00.000Z',
    game: 'pokemon',
    setId: 'cel25',
    cardIds: [],
    tags: ['Video'],
    video: { channelTitle: 'Leonhart', durationSeconds: null, viewCount: 88_000 },
  },
];

export const mockNewsItems: NewsItem[] = [
  {
    id: 'news-pokebeach-1',
    kind: 'news',
    source: 'PokéBeach',
    title: 'Next English set revealed, first cards shown',
    url: 'https://www.pokebeach.com/mock-next-set',
    imageUrl: 'https://images.example.test/news/pokebeach-1.jpg',
    publishedAt: '2026-09-23T11:00:00.000Z',
    game: 'pokemon',
    setId: null,
    cardIds: [],
    tags: ['Set reveal'],
    video: null,
  },
  {
    id: 'news-opgg-1',
    kind: 'news',
    source: 'onepiece.gg',
    title: 'Official ban list update',
    url: 'https://onepiece.gg/mock-ban-list',
    imageUrl: 'https://images.example.test/news/opgg-1.jpg',
    publishedAt: '2026-09-23T08:00:00.000Z',
    game: 'onepiece',
    setId: null,
    cardIds: [],
    tags: ['Ban list'],
    video: null,
  },
  {
    id: 'news-tcgplayer-1',
    kind: 'market',
    source: 'TCGplayer Seller Blog',
    title: 'Price Trends: cards climbing in price',
    url: 'https://seller.tcgplayer.com/blog/mock-price-trends',
    imageUrl: null,
    publishedAt: '2026-09-22T13:00:00.000Z',
    game: null,
    setId: null,
    cardIds: [],
    tags: ['Market', 'Vintage'],
    video: null,
  },
  ...mockVideos,
];

export const mockSetSpotlight: SetSpotlight = {
  computedAt: COMPUTED_AT,
  set: {
    setId: 'cel25',
    game: 'pokemon',
    name: 'Celebrations',
    code: 'CEL',
    series: '25th anniversary',
    releaseDate: '2021-10-08',
    logoUrl: null,
    cardCount: 50,
    valueNow: 1284.4,
    valueChangePercent7d: 5.2,
    psa10ValueNow: 18_420,
    psa10ChangePercent7d: 8.9,
    collectorsCount: 142,
  },
  topByPrice: [
    setCard({ cardId: 'cel25c-4_A', name: 'Charizard', number: '4/102', imageUrl: 'https://images.pokemontcg.io/cel25c/4_A.png', priceNow: 168.4, changePercent7d: 3.2 }),
    setCard({ cardId: 'cel25c-17_A', name: 'Umbreon ☆', number: '17/17', imageUrl: 'https://images.pokemontcg.io/cel25c/17_A.png', priceNow: 112.9, changePercent7d: 9.4 }),
    setCard({ cardId: 'cel25c-66_A', name: 'Shining Magikarp', number: '66/64', imageUrl: 'https://images.pokemontcg.io/cel25c/66_A.png', priceNow: 41.75, changePercent7d: -1.8 }),
  ],
  topMovers: [
    setCard({ cardId: 'cel25c-17_A', name: 'Umbreon ☆', number: '17/17', imageUrl: 'https://images.pokemontcg.io/cel25c/17_A.png', priceNow: 112.9, changePercent7d: 9.4 }),
    setCard({ cardId: 'cel25c-4_A', name: 'Charizard', number: '4/102', imageUrl: 'https://images.pokemontcg.io/cel25c/4_A.png', priceNow: 168.4, changePercent7d: 3.2 }),
  ],
  topPsa10: [
    setCard({ cardId: 'cel25c-4_A', name: 'Charizard', number: '4/102', imageUrl: 'https://images.pokemontcg.io/cel25c/4_A.png', lane: 'graded', grader: 'PSA', grade: '10', priceNow: 1240, changePercent7d: 6.1 }),
  ],
  callout: {
    cardId: 'cel25c-17_A',
    title: 'Umbreon ☆ PSA 10 is up 14% this week',
    body: 'The biggest graded move in the set.',
  },
  videos: mockVideos,
  news: [],
};

export const mockNewsFeed: NewsFeed = { items: mockNewsItems, nextCursor: null };
