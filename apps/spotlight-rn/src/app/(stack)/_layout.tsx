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
      >
        {/*
          New Post is a NATIVE form sheet, not a full-screen push. Figma
          3147:4638 sizes the sheet 393×787 on an 852pt screen (top edge at
          y=65), which is the 0.92 detent below.

          `formSheet` is what buys the two dismissal gestures for free — drag
          the sheet down, or tap the dimmed area above it — so neither needs a
          hand-rolled backdrop Pressable or pan handler.

          `sheetGrabberVisible` stays false because the composer draws its own
          grabber (SheetHeader `showHandle`, Figma 3147:4639); letting iOS add
          its system grabber too would stack two bars.

          `sheetExpandsWhenScrolledToEdge` is off so scrolling the body to its
          end doesn't try to grow the sheet — with one detent there is nothing
          to grow into, and the default (true) makes the scroll feel sticky.
        */}
        <Stack.Screen
          name="new-post"
          options={{
            gestureEnabled: true,
            presentation: 'formSheet',
            sheetAllowedDetents: [0.92],
            sheetCornerRadius: 16,
            sheetExpandsWhenScrolledToEdge: false,
            sheetGrabberVisible: false,
          }}
        />
      </Stack>
    </TabsPageContext.Provider>
  );
}
