import { useFocusEffect } from '@react-navigation/native';
import { useCallback } from 'react';

import { useAppServices } from '@/providers/app-providers';

/**
 * Holds a `refreshData()` deferral for as long as the calling screen is
 * focused, and flushes any pending bump the moment it blurs (tab switch, a
 * pushed card page, a sheet). Meant for a screen that writes a lot but shows
 * none of the `dataVersion`-driven data itself — the Scanner.
 */
export function useDeferDataRefreshWhileFocused() {
  const { deferDataRefresh } = useAppServices();
  useFocusEffect(useCallback(() => deferDataRefresh(), [deferDataRefresh]));
}
