import { usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';

import { capturePostHogScreen } from './posthog';

function resolveScreenName(pathname: string) {
  if (pathname === '/scan' || pathname.startsWith('/scan/')) {
    return 'scan';
  }

  // `/` used to be the tabs root that landed on the scanner, which is why it
  // reported as 'scan'. It is the FEED now, so leaving it mapped that way would
  // quietly inflate scanner screen-views with every app open. New name — expect
  // a step change in the split, not a continuous series.
  if (pathname === '/' || pathname === '/index') {
    return 'feed';
  }

  // Collection lives at `/you` since Home took the tabs root. `/portfolio` is a
  // redirect to it and may still be seen briefly, so both map to the same name
  // and the existing series stays continuous.
  if (
    pathname === '/you'
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

  if (pathname === '/account' || pathname.startsWith('/account/')) {
    return pathname === '/account/import' ? 'portfolio_import' : 'account';
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

  // Untracked routes leave `$screen_name` reading whatever came BEFORE them, so
  // this screen's crashes were landing in Error Tracking labelled `scan` or
  // `feed`. That cost real time chasing a camera crash on the wrong screen —
  // and this one owns a camera, so it is exactly the screen that must not be
  // anonymous. (Adding a route here costs no extra events: `$screen` fires on
  // navigation either way.)
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
