import { fireEvent, screen } from '@testing-library/react-native';

import { mockAssistantSets, parseAssistantMessage, type AssistantMessage } from '@spotlight/api-client';

import { AssistantMessageBubble } from '@/features/assistant/components/assistant-message-bubble';
import { AssistantSetTile, assistantSetMeta } from '@/features/assistant/components/assistant-set-tile';

import { renderWithProviders } from '../../test-utils';

function reply(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 's1',
    threadId: 'thr_1',
    role: 'assistant',
    text: '**Plasma Storm** is up 66.9%, while **Ascended Heroes** fell 24%.',
    cards: [],
    actions: [],
    createdAt: '2026-11-20T10:00:00Z',
    status: 'ok',
    ...overrides,
  };
}

describe('assistant set tiles', () => {
  it('parses wire sets: camelCase, id + name required, capped, user rows and older servers get none', () => {
    const wire = {
      set_id: 'bw8',
      name: 'Plasma Storm',
      game: 'pokemon',
      logo_url: 'https://img.example/bw8.png',
      symbol_url: null,
      change_pct: 66.9,
      window: '30d',
      release_year: '2013',
    };
    const parsed = parseAssistantMessage({
      id: 'm',
      role: 'assistant',
      text: 'x',
      sets: [wire, { set_id: 'x' }, { ...wire, game: 'yugioh', window: '1y', change_pct: 'up' }, ...Array(8).fill(wire)],
    });
    expect(parsed?.sets).toHaveLength(6);
    expect(parsed?.sets?.[0]).toEqual({
      setId: 'bw8',
      name: 'Plasma Storm',
      game: 'pokemon',
      logoUrl: 'https://img.example/bw8.png',
      symbolUrl: null,
      changePct: 66.9,
      window: '30d',
      releaseYear: '2013',
    });
    expect(parsed?.sets?.[1]).toMatchObject({ game: null, window: null, changePct: null });
    expect(parseAssistantMessage({ id: 'u', role: 'user', text: 'q', sets: [wire] })?.sets).toEqual([]);
    expect(parseAssistantMessage({ id: 'old', role: 'assistant', text: 'q' })?.sets).toEqual([]);
  });

  it('renders a set rail with signed % moves and opens the tapped set', () => {
    const onOpenSet = jest.fn();
    const sets = mockAssistantSets();
    renderWithProviders(
      <AssistantMessageBubble
        actionStates={{}}
        message={reply({ sets })}
        onConfirmAction={jest.fn()}
        onDismissAction={jest.fn()}
        onOpenCard={jest.fn()}
        onOpenSet={onOpenSet}
      />,
    );
    expect(screen.getByTestId('assistant-message-s1-sets')).toBeTruthy();
    expect(screen.queryByTestId('assistant-message-s1-cards')).toBeNull();
    expect(screen.getByTestId('assistant-set-bw8-change')).toHaveTextContent('+66.9%');
    expect(screen.getByTestId('assistant-set-me3-change')).toHaveTextContent('−24.0%');
    expect(screen.getByTestId('assistant-set-bw8-logo')).toBeTruthy();
    // No logo: the name stands in as a wordmark.
    expect(screen.getByTestId('assistant-set-me3-wordmark')).toHaveTextContent('Ascended Heroes');
    fireEvent.press(screen.getByTestId('assistant-set-bw8'));
    expect(onOpenSet).toHaveBeenCalledWith(sets[0]);
  });

  it('falls back to the wordmark when the logo fails to load', () => {
    const set = mockAssistantSets()[0];
    renderWithProviders(<AssistantSetTile onPress={jest.fn()} set={set} testID="tile" />);
    fireEvent(screen.getByTestId('tile-logo'), 'error', { error: 'load failed' });
    expect(screen.queryByTestId('tile-logo')).toBeNull();
    expect(screen.getByTestId('tile-wordmark')).toHaveTextContent('Plasma Storm');
  });

  it('labels the window and release year', () => {
    const [set] = mockAssistantSets();
    expect(assistantSetMeta(set)).toBe('Past month · 2013');
    expect(assistantSetMeta({ ...set, window: '7d', releaseYear: null })).toBe('Past week');
    expect(assistantSetMeta({ ...set, window: null, releaseYear: null })).toBe('');
  });
});
