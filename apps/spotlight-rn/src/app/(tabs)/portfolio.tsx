import { Redirect } from 'expo-router';

/**
 * Kept so existing `/portfolio` links and deep links still land on the
 * collection. It points at `/` again — the collection went back to the tabs
 * root when the feed moved to `/social`.
 */
export default function PortfolioRedirect() {
  return <Redirect href={'/' as never} />;
}
