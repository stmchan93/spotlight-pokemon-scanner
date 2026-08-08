import { Redirect } from 'expo-router';

/**
 * Kept so existing `/portfolio` links and deep links still land on the
 * collection. It points at `/you` now, not `/` — `/` became the feed when Home
 * took the tabs root, and redirecting there would silently send every old
 * portfolio link to the wrong screen.
 */
export default function PortfolioRedirect() {
  return <Redirect href={'/you' as never} />;
}
