import { Redirect } from 'expo-router';

/** Kept so existing `/portfolio` links and deep links still land on Collection. */
export default function PortfolioRedirect() {
  return <Redirect href={'/' as never} />;
}
