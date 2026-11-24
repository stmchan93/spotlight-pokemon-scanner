import {
  parseSmartSearchResponse,
  removeSmartSearchChip,
  type SmartSearchInterpretation,
} from '@spotlight/api-client';

import {
  SMART_SEARCH_EXAMPLES,
  classifySearchQuery,
  pickSmartSearchExample,
  smartSearchPlaceholder,
} from '@/features/catalog/smart-search-query';

describe('classifySearchQuery', () => {
  it.each([
    ['charizard 199', 'plain'],
    ['umbreon vmax', 'plain'],
    ['pikachu', 'plain'],
    ['', 'plain'],
    ['a', 'plain'],
    ['evolving skies', 'plain'],
  ])('%s -> %s', (query, kind) => {
    expect(classifySearchQuery(query)).toBe(kind);
  });

  it.each([
    'cheap eevee alt arts under $50 from 2023',
    'Eevee alt arts under $50',
    'Japanese Pikachu promos',
    'Pikachu in the rain',
    'priciest Charizard',
    "Umbreon cards I don't own",
    'my charizard cards',
    'cards by mitsuhiro arita',
    'charizard over $100',
    // A name with a cue word asks the server, which answers "plain" for a bare name.
    'Pikachu with Grey Felt Hat',
  ])('%s is natural', (query) => {
    expect(classifySearchQuery(query)).toBe('natural');
  });

  it.each([
    'should I grade my umbreon?',
    'is $250 good for charizard 199',
    "what's my collection worth",
    'how much is moonbreon',
    'worth grading my lugia',
    'umbreon?',
  ])('%s is a question', (query) => {
    expect(classifySearchQuery(query)).toBe('question');
  });

  it('every placeholder example takes the smart path', () => {
    for (const example of SMART_SEARCH_EXAMPLES) {
      expect(classifySearchQuery(example)).toBe('natural');
    }
    expect(pickSmartSearchExample(() => 0)).toBe(SMART_SEARCH_EXAMPLES[0]);
    expect(pickSmartSearchExample(() => 0.9999)).toBe(SMART_SEARCH_EXAMPLES[SMART_SEARCH_EXAMPLES.length - 1]);
    expect(smartSearchPlaceholder('priciest Charizard')).toBe('Search cards, or try "priciest Charizard"');
  });
});

describe('smart search wire', () => {
  const interpretation: SmartSearchInterpretation = {
    filter: { price_max_usd: 50, rarity_bucket: ['sir', 'illustration'], text: 'Eevee' },
    owned: 'owned',
    sort: 'price_asc',
  };

  it('removing a chip drops only its field', () => {
    expect(removeSmartSearchChip(interpretation, { field: 'price_max_usd', id: 'price_max_usd', label: 'Under $50' }))
      .toEqual({ ...interpretation, filter: { rarity_bucket: ['sir', 'illustration'], text: 'Eevee' } });
    expect(removeSmartSearchChip(interpretation, { field: 'owned', id: 'owned', label: 'Owned' }).owned).toBe('any');
    expect(removeSmartSearchChip(interpretation, { field: 'sort', id: 'sort', label: 'Cheapest first' }).sort)
      .toBe('relevance');
    expect(interpretation.filter.price_max_usd).toBe(50);
  });

  it('malformed responses read as plain', () => {
    expect(parseSmartSearchResponse(null).intent).toBe('plain');
    expect(parseSmartSearchResponse({ intent: 'search', interpretation: null }).intent).toBe('plain');
    expect(parseSmartSearchResponse({ intent: 'weird' }).intent).toBe('plain');
    const parsed = parseSmartSearchResponse({
      chips: [{ field: 'text', id: 'text', label: 'Eevee' }, { id: 'x' }],
      intent: 'search',
      interpretation: { filter: { text: 'Eevee' }, owned: 'bogus', sort: 'price_asc' },
      nextCursor: 'abc',
      results: [{ id: 'c1' }],
    });
    expect(parsed).toEqual({
      chips: [{ field: 'text', id: 'text', label: 'Eevee' }],
      intent: 'search',
      interpretation: { filter: { text: 'Eevee' }, owned: 'any', sort: 'price_asc' },
      nextCursor: 'abc',
      rawResults: [{ id: 'c1' }],
    });
  });
});
