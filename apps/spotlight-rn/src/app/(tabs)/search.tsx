import { FocusedStatusBar } from '@/components/focused-status-bar';
import { SearchSurface } from '@/features/catalog/search-surface';

/**
 * Search — the second tab (Figma 6642:5964 tab bar). The same Search the
 * `/catalog/search` sheet slides up, in `tab` mode: nothing to close, no Ask
 * button, no pull-down. The sheet route stays for deep links and the in-page
 * entry points that still push it.
 *
 * Open to guests (`GUEST_OPEN_TABS`): catalog browsing was already reachable
 * signed-out from the Scanner.
 */
export default function SearchRoute() {
  return (
    <>
      {/* Dark, as the `/catalog/search` sheet draws it over the same banner. */}
      <FocusedStatusBar style="dark" />
      <SearchSurface mode="tab" />
    </>
  );
}
