import { createContext, useContext } from 'react';

type TabsPageContextValue = {
  activePage: 'portfolio' | 'scanner';
};

export const TabsPageContext = createContext<TabsPageContextValue>({ activePage: 'scanner' });

export function useTabsPage() {
  return useContext(TabsPageContext);
}
