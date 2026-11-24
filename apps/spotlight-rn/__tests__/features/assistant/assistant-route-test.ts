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
      page: null,
      prompt: null,
    });
  });

  it('carries a prompt to send as the first question', () => {
    const href = assistantHref('home', [], 'pokemon', null, '  should I grade my umbreon?  ') as unknown as {
      params: Record<string, string>;
    };
    expect(href.params).toEqual({ source: 'home', game: 'pokemon', prompt: 'should I grade my umbreon?' });
    expect(parseAssistantRouteParams(href.params).prompt).toBe('should I grade my umbreon?');
    expect(parseAssistantRouteParams({ source: 'home', prompt: '   ' }).prompt).toBeNull();
  });

  it('drops a missing or unknown game', () => {
    const href = assistantHref('home', [], null) as unknown as { params: Record<string, string> };
    expect(href.params).toEqual({ source: 'home' });
    expect(parseAssistantRouteParams({ source: 'home', game: 'chess' }).game).toBeNull();
    expect(parseAssistantRouteParams({ source: 'home' }).game).toBeNull();
  });
});
