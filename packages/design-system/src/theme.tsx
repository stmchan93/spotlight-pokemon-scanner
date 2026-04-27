import {
  createContext,
  PropsWithChildren,
  useContext,
} from 'react';

import {
  spotlightTheme,
  type SpotlightTheme,
} from './tokens';

const SpotlightThemeContext = createContext<SpotlightTheme>(spotlightTheme);

export function SpotlightThemeProvider({ children }: PropsWithChildren) {
  return (
    <SpotlightThemeContext.Provider value={spotlightTheme}>
      {children}
    </SpotlightThemeContext.Provider>
  );
}

export function useSpotlightTheme() {
  return useContext(SpotlightThemeContext);
}
