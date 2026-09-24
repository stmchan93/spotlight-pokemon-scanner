import { usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';

import { capturePostHogScreen } from './posthog';

function isPathOrChild(pathname: string, root: string) {
  return pathname === root || pathname.startsWith(`${root}/`);
}

export function resolveScreenName(pathname: string) {
  if (pathname === '/scan' || pathname.startsWith('/scan/')) {
    return 'scan';
  }

  // The feed moved to `/social` when the tabs were reordered; `/` is the
  // collection again. Both series see a step change at that release — this is
  // the second time these two names have traded pathnames, so read the split by
  // NAME and not by path.
  if (pathname === '/social' || pathname.startsWith('/social/')) {
    return 'feed';
  }

  // Collection is the tabs root. `/you` and `/portfolio` are redirects to it
  // and may still be seen briefly, so all three map to the same name and the
  // existing series stays continuous.
  if (
    pathname === '/'
    || pathname === '/index'
    || pathname === '/you'
    || pathname === '/portfolio'
    || pathname.startsWith('/portfolio/')
  ) {
    return 'portfolio';
  }

  if (pathname === '/inventory' || pathname.startsWith('/inventory/')) {
    return 'inventory';
  }

  if (pathname === '/sales-history' || pathname.startsWith('/sales-history/')) {
    return 'sales_history';
  }

  // Before the generic `/account` rule: Alerts is its own screen.
  if (isPathOrChild(pathname, '/account/alerts')) {
    return 'alerts';
  }

  if (pathname === '/account' || pathname.startsWith('/account/')) {
    return 'account';
  }

  // The route is still `/wishlist`; users (and these names) call it Watchlist.
  if (isPathOrChild(pathname, '/wishlist')) {
    return 'watchlist';
  }

  // Meta: the group page before the page itself. "Mine" is a query param on
  // the group route (`?mine=1`), not a path, so it reports as `meta_group`.
  if (pathname.startsWith('/meta/group/')) {
    return 'meta_group';
  }

  if (pathname === '/meta') {
    return 'meta';
  }

  if (isPathOrChild(pathname, '/news')) {
    return 'news';
  }

  if (isPathOrChild(pathname, '/calendar')) {
    return 'calendar';
  }

  if (pathname.startsWith('/set-spotlight/')) {
    return 'set_spotlight';
  }

  if (isPathOrChild(pathname, '/search/people')) {
    return 'people_search';
  }

  // Includes a profile's followers/following lists.
  if (pathname.startsWith('/u/')) {
    return 'profile';
  }

  if (pathname.startsWith('/post/')) {
    return 'post';
  }

  if (isPathOrChild(pathname, '/messages')) {
    return 'messages';
  }

  if (isPathOrChild(pathname, '/notifications')) {
    return 'notifications';
  }

  if (isPathOrChild(pathname, '/insights')) {
    return 'insights';
  }

  if (pathname.startsWith('/catalog/game/')) {
    return 'catalog_game';
  }

  if (pathname === '/catalog/search' || pathname.startsWith('/catalog/search/')) {
    return 'catalog_search';
  }

  if (pathname.startsWith('/cards/') && pathname.endsWith('/scan-review')) {
    return 'scan_review';
  }

  if (pathname.startsWith('/cards/')) {
    return 'card_detail';
  }

  if (pathname === '/design-system') {
    return 'design_system';
  }

  // Untracked routes leave `$screen_name` reading whatever came before them,
  // so this screen's crashes arrived labelled `scan`/`feed` — costly, since it
  // owns a camera. No extra events: `$screen` fires on navigation either way.
  if (pathname === '/whos-that-pokemon' || pathname.startsWith('/whos-that-pokemon/')) {
    return 'whos_that_pokemon';
  }

  return null;
}

export function PostHogScreenTracker() {
  const pathname = usePathname();
  const lastTrackedScreenRef = useRef<string | null>(null);

  useEffect(() => {
    const nextScreenName = resolveScreenName(pathname);
    if (!nextScreenName || nextScreenName === lastTrackedScreenRef.current) {
      return;
    }

    lastTrackedScreenRef.current = nextScreenName;
    capturePostHogScreen(nextScreenName);
  }, [pathname]);

  return null;
}
