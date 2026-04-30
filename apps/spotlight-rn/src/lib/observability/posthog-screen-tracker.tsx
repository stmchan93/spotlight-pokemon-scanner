import { usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';

import { capturePostHogScreen } from './posthog';

function resolveScreenName(pathname: string) {
  if (pathname === '/' || pathname === '/index' || pathname === '/scan' || pathname.startsWith('/scan/')) {
    return 'scan';
  }

  if (pathname === '/portfolio' || pathname.startsWith('/portfolio/')) {
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

  if (pathname.startsWith('/sell/batch')) {
    return 'sell_batch';
  }

  if (pathname.startsWith('/sell/')) {
    return 'sell_single';
  }

  if (pathname.startsWith('/collection/add/')) {
    return 'collection_add';
  }

  if (pathname === '/labeling/session') {
    return 'labeling_session';
  }

  if (pathname === '/design-system') {
    return 'design_system';
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
