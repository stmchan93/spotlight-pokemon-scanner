import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  clearHasSignedIn,
  hasEverSignedIn,
  isFirstLaunchResetAvailable,
  markHasSignedIn,
} from '@/features/auth/guest-first-launch';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    },
  };
});

describe('guest-first-launch', () => {
  it('reset clears the has-signed-in flag so the next launch is a first launch', async () => {
    await markHasSignedIn();
    expect(await hasEverSignedIn()).toBe(true);

    await clearHasSignedIn();

    expect(await hasEverSignedIn()).toBe(false);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('@spotlight/auth/has-signed-in');
  });

  it('offers the reset on staging and development only, never production', () => {
    expect(isFirstLaunchResetAvailable('staging')).toBe(true);
    expect(isFirstLaunchResetAvailable('development')).toBe(true);
    expect(isFirstLaunchResetAvailable('production')).toBe(false);
    expect(isFirstLaunchResetAvailable('')).toBe(false);
  });
});
