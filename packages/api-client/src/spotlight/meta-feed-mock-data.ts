import type {
  HotCards,
  MetaCard,
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
    risingCount: 4,
    coolingCount: 2,
  },
  groups: [
    {
      groupKey: 'vintage:graded:psa10:pop_le_50',
      label: 'Vintage PSA 10 · pop ≤ 50',
      lane: 'graded',
      description: 'pre-2003 · 1,840 cards',
      medianChangePercent: 18.4,
      valueNow: 2_650_000,
      valueThen: 2_238_000,
      valueChangeUsd: 412_000,
      cardCount: 1840,
      movedCardCount: 214,
      sparkPoints: [100, 101, 103, 104, 108, 112, 118.4],
      topCards: [
        metaCard({
          cardId: 'ecard3-149',
          name: 'Lugia (Crystal)',
          number: '149',
          setName: 'Aquapolis',
          lane: 'graded',
          grader: 'PSA',
          grade: '10',
          population: 12,
          priceNow: 24_100,
          priceThen: 18_400,
          changePercent: 31,
        }),
      ],
    },
    {
      groupKey: 'vintage:raw:nm',
      label: 'Vintage',
      lane: 'raw',
      description: 'pre-2003 · NM · 9,600 cards',
      medianChangePercent: 4.1,
      valueNow: 6_040_000,
      valueThen: 5_802_000,
      valueChangeUsd: 238_000,
      cardCount: 9600,
      movedCardCount: 3120,
      sparkPoints: [100, 100.4, 101, 101.8, 102.6, 103.4, 104.1],
      topCards: [],
    },
    {
      groupKey: 'modern:raw:sir',
      label: 'Special Illustration Rare',
      lane: 'raw',
      description: 'Scarlet & Violet · NM · 412 cards',
      medianChangePercent: -4.1,
      valueNow: 4_400_000,
      valueThen: 4_588_000,
      valueChangeUsd: -188_000,
      cardCount: 412,
      movedCardCount: 398,
      sparkPoints: [100, 99.6, 99, 98.1, 97.2, 96.4, 95.9],
      topCards: [],
    },
  ],
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
