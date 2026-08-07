import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
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
    <TabsPageContext.Provider
      value={{
        activePage: 'portfolio',
        chartScrubLockRef,
        collectionEditing: false,
        setCollectionEditing: () => {},
      }}
    >
      {/* Re-assert dark (visible) status-bar icons: pushed stack screens (PDP,
          sales history, etc.) present as their own iOS view controllers, so the
          root layout's StatusBar doesn't stick and light-on-white icons vanish. */}
      <StatusBar style="dark" />
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
