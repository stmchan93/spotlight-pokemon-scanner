import { assistantHref, parseAssistantRouteParams } from '@/features/assistant/assistant-route';

describe('assistant route game param', () => {
  it('carries the opening screen game through the route', () => {
    const href = assistantHref('scanner', ['a', 'a', 'b'], 'onepiece') as unknown as {
      params: Record<string, string>;
    };
    expect(href.params).toEqual({ source: 'scanner', cardIds: 'a,b', game: 'onepiece' });
    expect(parseAssistantRouteParams(href.params)).toEqual({
      source: 'scanner',
      cardIds: ['a', 'b'],
      threadId: null,
      game: 'onepiece',
    });
  });

  it('drops a missing or unknown game', () => {
    const href = assistantHref('home', [], null) as unknown as { params: Record<string, string> };
    expect(href.params).toEqual({ source: 'home' });
    expect(parseAssistantRouteParams({ source: 'home', game: 'chess' }).game).toBeNull();
    expect(parseAssistantRouteParams({ source: 'home' }).game).toBeNull();
  });
});
