import { useGlobalSearchParams, usePathname } from 'expo-router';
import { useEffect } from 'react';

import { bubbleRoutePath } from '@/features/assistant/page-context/assistant-bubble-zones';

type AssistantRoute = { pathname: string; params: Record<string, string | string[] | undefined> };

let currentRoute: AssistantRoute = { pathname: '/', params: {} };

/** The focused route, as the Chat pill reads it at tap time. */
export function readAssistantRoute(): AssistantRoute {
  return currentRoute;
}

/**
 * Mounted ONCE at the root: records the focused route so a Chat pill anywhere
 * resolves its page context without subscribing every pill to route changes.
 */
export function AssistantRouteTracker() {
  const pathname = bubbleRoutePath(usePathname());
  const params = useGlobalSearchParams();
  useEffect(() => {
    currentRoute = { pathname, params: params as AssistantRoute['params'] };
  }, [params, pathname]);
  return null;
}
