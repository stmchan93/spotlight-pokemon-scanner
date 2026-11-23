import { usePathname } from 'expo-router';

import { TabPager } from '@/components/tab-pager/tab-pager-navigator';
import { rememberActiveTab } from '@/lib/last-active-tab';

/**
 * The bottom tabs: an Instagram-style horizontal pager with our own tab bar.
 *
 *   Home [Collection, …] | Search | Scan | Events | Social [Social, News, Market]
 *
 * WHY A CUSTOM NAVIGATOR. Apple's native tab bar (expo-router NativeTabs) cannot
 * be dragged — UITabBarController has no interactive swipe — so the screens
 * could only ever "appear". `TabPager` (`@/components/tab-pager`) is a real
 * React Navigation navigator (`useNavigationBuilder` + TabRouter, with the same
 * REPLACE override expo-router's `<Tabs>` uses) wrapped by `withLayoutContext`,
 * so EXPO-ROUTER STAYS THE SOURCE OF TRUTH:
 *   - the focused route sets the strip's page: `/`, `/search`, `/scan`,
 *     `/events`, `/social`, deep links, notification routing, `router.push`,
 *     guest redirects and Android back all just change navigator state, and the
 *     strip animates there;
 *   - a settled swipe dispatches JUMP_TO for the page it came to rest on;
 *   - `useIsFocused` / `useFocusEffect` mean what they always did (the focused
 *     route), and `TabsPageContext.activePage` additionally waits for the strip
 *     to be AT REST on the page — the scanner's camera keys off that, so a
 *     half-revealed Scan never starts it;
 *   - pushed stack screens push over the whole pager in the root stack and keep
 *     UIKit's back-swipe.
 * Pages mount on first visit (or when a drag first reveals them) and then stay
 * mounted. The drag is a gesture-handler Pan on the UI thread; the hand-off
 * with each page's inner pager and every gesture conflict are documented in the
 * navigator file.
 *
 * `index` is Collection; `/you`, `/portfolio` and `/wishlist` (-> `?tab=watchlist`) are redirect routes to it and
 * are not pages.
 */
export default function TabsLayout() {
  const pathname = usePathname();
  // Remember where the user was so leaving the Scanner can put them back.
  // `rememberActiveTab` ignores `/scan` itself. A plain module write with no
  // subscribers, so it is safe during render.
  rememberActiveTab(pathname);
  // The app opens on Home (`/`), the first tab (user, 2026-11-16).
  return <TabPager backBehavior="firstRoute" />;
}
