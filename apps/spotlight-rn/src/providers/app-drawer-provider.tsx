import { createContext, type PropsWithChildren, useCallback, useContext, useMemo, useState } from 'react';

type AppDrawerContextValue = {
  isOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
};

const AppDrawerContext = createContext<AppDrawerContextValue | null>(null);

export function AppDrawerProvider({ children }: PropsWithChildren) {
  const [isOpen, setIsOpen] = useState(false);

  const openDrawer = useCallback(() => setIsOpen(true), []);
  const closeDrawer = useCallback(() => setIsOpen(false), []);
  const toggleDrawer = useCallback(() => setIsOpen((current) => !current), []);

  const value = useMemo<AppDrawerContextValue>(
    () => ({ isOpen, openDrawer, closeDrawer, toggleDrawer }),
    [closeDrawer, isOpen, openDrawer, toggleDrawer],
  );

  return <AppDrawerContext.Provider value={value}>{children}</AppDrawerContext.Provider>;
}

export function useAppDrawer() {
  const ctx = useContext(AppDrawerContext);
  if (!ctx) {
    throw new Error('useAppDrawer must be used within AppDrawerProvider.');
  }
  return ctx;
}
