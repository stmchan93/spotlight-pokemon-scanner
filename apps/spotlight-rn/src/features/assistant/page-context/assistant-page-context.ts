import { NavigationContext } from '@react-navigation/native';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';

import {
  CARD_GAMES,
  type AssistantContextSource,
  type AssistantPageContext,
  type AssistantPageKind,
  type CardGame,
  gameDisplayName,
} from '@spotlight/api-client';

import {
  setAssistantBubbleScannerAnchor,
  type AssistantBubbleScannerAnchor,
} from '@/features/assistant/page-context/assistant-bubble-zones';

/**
 * PAGE CONTEXT for the floating Ekalight bubble.
 *
 * The route alone carries most of it (`resolveAssistantPage(pathname, params)`):
 * the card id on a card page, the set id on a set page, the handle on a profile.
 * A screen whose state the route can't see (Search's typed query, Collection's
 * selected collection, the scanner tray, the PDP's chosen grade) publishes an
 * EXTRA with `useAssistantPageContext`, read lazily at tap time so a busy
 * screen (the scanner tray) pays nothing until the bubble is tapped.
 */

export type AssistantPageExtra = {
  /** Overrides the route's kind (rare: a page that is really another kind). */
  kind?: AssistantPageKind;
  label?: string | null;
  params?: Record<string, string | null | undefined>;
  /** Cards on screen that should ride as `context.card_ids` (the scanner tray only). */
  cardIds?: string[];
  game?: CardGame | null;
};

/** What the bubble hands the chat. */
export type AssistantOpenContext = {
  source: AssistantContextSource;
  cardIds: string[];
  game: CardGame | null;
  page: AssistantPageContext;
};

type RouteParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return ((Array.isArray(value) ? value[0] : value) ?? '').trim();
}

function asGame(value: string | null | undefined): CardGame | null {
  return CARD_GAMES.find((game) => game === value) ?? null;
}

function segmentsOf(pathname: string): string[] {
  return pathname.split('?')[0].split('/').filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

/** The route-only page. Pure, so every mapping is unit-tested. */
export function resolveAssistantRoutePage(pathname: string, params: RouteParams = {}): AssistantPageContext {
  const segments = segmentsOf(pathname);
  const [head, second, third] = segments;
  const page = (kind: AssistantPageKind, label: string | null, extra: Record<string, string> = {}) => ({
    kind,
    label,
    params: Object.fromEntries(Object.entries(extra).filter(([, value]) => value)),
  });

  switch (head) {
    case undefined:
    case 'portfolio':
    case 'you':
    case 'inventory':
      return page('collection', 'Your collection');
    case 'insights':
      return page('insights', 'Collection insights');
    case 'sales-history':
      return page('collection', 'Your sales history', { view: 'sales_history' });
    case 'wishlist':
      return page('watchlist', 'Your Watchlist');
    case 'scan':
      return page('scanner', 'Scanner');
    case 'events':
      return second ? page('event', first(params.name) || null, { event_id: second }) : page('events', 'Events');
    case 'calendar':
      return page('events', 'Event calendar');
    case 'social':
    case 'feed':
      return page('social', 'Social feed');
    case 'post':
      return page('post', 'A post', { post_id: second ?? '' });
    case 'news':
      return page('news', 'TCG news');
    case 'meta':
      return page('news', 'Meta');
    case 'u':
      return second ? page('profile', `@${second}`, { handle: second }) : page('other', null);
    case 'cards':
      return second ? page('card', first(params.name) || null, { card_id: second }) : page('other', null);
    case 'set-spotlight':
      return page('set', first(params.name) || 'Set spotlight', { set_id: second ?? '' });
    case 'search':
      return page('search', 'People search', { tab: 'people' });
    case 'catalog': {
      if (second === 'expansion' && third) {
        return page('set', first(params.name) || null, { set_id: third, game: asGame(first(params.game)) ?? '' });
      }
      if (second === 'game' && third) {
        return page('search', null, { game: asGame(third) ?? '' });
      }
      const query = first(params.q);
      return page('search', query ? `Search: ${query}` : 'Search', { query, tab: 'cards' });
    }
    default:
      return page('other', null);
  }
}

/** Route page + the screen's extra → what the chat opens with. */
export function resolveAssistantOpenContext(
  pathname: string,
  params: RouteParams = {},
  extra: AssistantPageExtra | null = null,
): AssistantOpenContext {
  const route = resolveAssistantRoutePage(pathname, params);
  const merged: Record<string, string> = { ...route.params };
  for (const [key, value] of Object.entries(extra?.params ?? {})) {
    if (typeof value === 'string' && value.trim()) {
      merged[key] = value.trim();
    } else if (value === null) {
      delete merged[key];
    }
  }
  const kind = extra?.kind ?? route.kind;
  const game = extra?.game ?? asGame(merged.game) ?? null;
  if (game) {
    merged.game = game;
  }
  let label = extra?.label !== undefined ? extra.label : route.label;
  if (kind === 'search' && !label) {
    label = game ? `${gameDisplayName(game)} search` : 'Search';
  }
  const cardIds = Array.from(new Set((extra?.cardIds ?? []).filter(Boolean))).slice(0, 20);
  return {
    source: kind === 'scanner' ? 'scanner' : 'home',
    cardIds,
    game,
    page: { kind, label: label?.trim() || null, params: merged },
  };
}

/**
 * Identity of a page for thread continuity: same key → the bubble continues the
 * latest chat, different → a new chat. Labels and transient params (the search
 * query being typed, the scan tray) are excluded on purpose: they change
 * without the user changing pages.
 */
export function assistantPageKey(page: AssistantPageContext | null | undefined): string {
  if (!page) {
    return 'none';
  }
  const stable = ['card_id', 'set_id', 'handle', 'event_id', 'post_id', 'collection']
    .map((key) => (page.params[key] ? `${key}=${page.params[key]}` : ''))
    .filter(Boolean)
    .join('&');
  return stable ? `${page.kind}:${stable}` : page.kind;
}

// --- screen extras -----------------------------------------------------------

type ExtraSource = AssistantPageExtra | (() => AssistantPageExtra | null);
type ExtraReader = () => AssistantPageExtra | null;

/**
 * Screens currently focused that published an extra, most recent last. Focus
 * and blur can arrive in either order during a transition, so it is a stack
 * with removal by identity: the newest still-focused screen always wins.
 */
const focusedExtras: ExtraReader[] = [];

/** The extra the focused screen published, read now (null when it has none). */
export function readAssistantPageExtra(): AssistantPageExtra | null {
  const reader = focusedExtras[focusedExtras.length - 1];
  if (!reader) {
    return null;
  }
  try {
    return reader();
  } catch {
    return null;
  }
}

/** Test seam. */
export function clearAssistantPageExtras(): void {
  focusedExtras.length = 0;
}

/**
 * Runs `register` while the screen is focused (its cleanup on blur/unmount).
 * Listens on the screen's navigation object directly rather than through
 * `useFocusEffect`, so a screen rendered with no navigator (unit tests, the dev
 * screen host) just registers for its lifetime instead of throwing.
 */
function useWhileFocused(register: () => () => void): void {
  const navigation = useContext(NavigationContext);
  useEffect(() => {
    if (!navigation) {
      return register();
    }
    let cleanup: (() => void) | null = null;
    const onFocus = () => {
      cleanup?.();
      cleanup = register();
    };
    const onBlur = () => {
      cleanup?.();
      cleanup = null;
    };
    if (navigation.isFocused()) {
      onFocus();
    }
    const offFocus = navigation.addListener('focus', onFocus);
    const offBlur = navigation.addListener('blur', onBlur);
    return () => {
      offFocus();
      offBlur();
      onBlur();
    };
  }, [navigation, register]);
}

/**
 * OPTIONAL enrichment for the floating bubble: what this screen shows that its
 * route can't say. Pass an object, or a function read at tap time (cheap for
 * fast-changing state like the scan tray). Registered only while the screen is
 * focused, so a buried screen never leaks into another page.
 */
export function useAssistantPageContext(extra: ExtraSource): void {
  const latest = useRef(extra);
  latest.current = extra;
  useWhileFocused(
    useCallback(() => {
      const reader: ExtraReader = () => {
        const current = latest.current;
        return typeof current === 'function' ? current() : current;
      };
      focusedExtras.push(reader);
      return () => {
        const index = focusedExtras.indexOf(reader);
        if (index >= 0) {
          focusedExtras.splice(index, 1);
        }
      };
    }, []),
  );
}

/**
 * The scanner publishes where the bubble may float (between the frame and the
 * visible tray top) while it is focused; cleared on blur/unmount so a stale
 * geometry never positions the bubble elsewhere.
 */
export function useAssistantBubbleScannerAnchor(anchor: AssistantBubbleScannerAnchor): void {
  const { frameBottom, trayTop, trayExpanded } = anchor;
  const [focused, setFocused] = useState(false);
  useWhileFocused(
    useCallback(() => {
      setFocused(true);
      return () => {
        setFocused(false);
        setAssistantBubbleScannerAnchor(null);
      };
    }, []),
  );
  useEffect(() => {
    if (focused) {
      setAssistantBubbleScannerAnchor({ frameBottom, trayTop, trayExpanded });
    }
  }, [focused, frameBottom, trayExpanded, trayTop]);
}
