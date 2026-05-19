import { Stack } from 'expo-router';
import { useRef } from 'react';

import { TabsPageContext } from '@/contexts/tabs-page-context';

export default function BrowseStackLayout() {
  // Why: stack routes (sales-history, cards, inventory, etc.) live outside
  // the (tabs) group, so TopTabsPager's TabsPageContext provider doesn't
  // wrap them. Set activePage='portfolio' here so portfolio-adjacent hooks
  // (usePortfolioScreenModel) load their data — the user navigated into
  // the stack *from* the portfolio tab, and treating it as scanner-mode
  // would block the portfolio dashboard / sales refresh effect.
  const chartScrubLockRef = useRef(false);
  return (
    <TabsPageContext.Provider value={{ activePage: 'portfolio', chartScrubLockRef }}>
      <Stack
        screenOptions={{
          animation: 'default',
          contentStyle: {
            backgroundColor: 'transparent',
          },
          headerShown: false,
        }}
      />
    </TabsPageContext.Provider>
  );
}
