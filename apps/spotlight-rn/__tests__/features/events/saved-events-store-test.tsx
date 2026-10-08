import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import {
  loadSavedEvents,
  resetSavedEventsForTests,
  toggleSavedEvent,
  useSavedEvents,
} from '@/features/events/saved-events-store';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((key: string) => Promise.resolve(store.has(key) ? store.get(key)! : null)),
      setItem: jest.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      clear: jest.fn(() => {
        store.clear();
        return Promise.resolve();
      }),
    },
  };
});

let mockOwnerKey = 'owner-a';
jest.mock('@/providers/app-providers', () => ({
  useAppServices: () => ({ sessionOwnerKey: mockOwnerKey }),
}));

const KEY_A = '@spotlight/events/saved/owner-a';
const KEY_B = '@spotlight/events/saved/owner-b';

describe('saved-events-store', () => {
  beforeEach(async () => {
    resetSavedEventsForTests();
    await AsyncStorage.clear();
    jest.clearAllMocks();
    mockOwnerKey = 'owner-a';
  });

  it('persists toggles under the owner-scoped key', async () => {
    await loadSavedEvents('owner-a');
    toggleSavedEvent('owner-a', 'hawaii');
    toggleSavedEvent('owner-a', 'ontario');
    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(KEY_A, JSON.stringify(['hawaii', 'ontario']));

    toggleSavedEvent('owner-a', 'hawaii');
    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(KEY_A, JSON.stringify(['ontario']));
    expect(await AsyncStorage.getItem(KEY_A)).toBe(JSON.stringify(['ontario']));
  });

  it('loads saved ids from storage', async () => {
    await AsyncStorage.setItem(KEY_A, JSON.stringify(['hawaii', 42, 'ontario']));
    const { result } = renderHook(() => useSavedEvents());

    await waitFor(() => expect(result.current.isSaved('hawaii')).toBe(true));
    expect(result.current.isSaved('ontario')).toBe(true);
    // Non-string junk is filtered out.
    expect([...result.current.savedIds]).toEqual(['hawaii', 'ontario']);
  });

  it('starts empty when storage is corrupt', async () => {
    await AsyncStorage.setItem(KEY_A, '{not json');
    const { result } = renderHook(() => useSavedEvents());
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(KEY_A));
    expect(result.current.savedIds.size).toBe(0);
  });

  it('never shows one owner\'s saves under another owner', async () => {
    const { result, rerender } = renderHook(() => useSavedEvents());
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(KEY_A));

    act(() => result.current.toggle('hawaii'));
    expect(result.current.isSaved('hawaii')).toBe(true);

    mockOwnerKey = 'owner-b';
    rerender({});
    // Hidden on the very render the owner changes, before storage answers.
    expect(result.current.isSaved('hawaii')).toBe(false);
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalledWith(KEY_B));
    expect(result.current.savedIds.size).toBe(0);

    act(() => result.current.toggle('ontario'));
    expect(await AsyncStorage.getItem(KEY_B)).toBe(JSON.stringify(['ontario']));
    expect(await AsyncStorage.getItem(KEY_A)).toBe(JSON.stringify(['hawaii']));

    mockOwnerKey = 'owner-a';
    rerender({});
    await waitFor(() => expect(result.current.isSaved('hawaii')).toBe(true));
    expect(result.current.isSaved('ontario')).toBe(false);
  });

  it('ignores toggles addressed to an owner that is not loaded', async () => {
    await loadSavedEvents('owner-a');
    toggleSavedEvent('owner-b', 'hawaii');
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('keeps a heart tapped while the stored list is still loading', async () => {
    await AsyncStorage.setItem(KEY_A, JSON.stringify(['ontario']));
    jest.clearAllMocks();

    const loading = loadSavedEvents('owner-a');
    toggleSavedEvent('owner-a', 'hawaii');
    await loading;

    const { result } = renderHook(() => useSavedEvents());
    expect(result.current.isSaved('hawaii')).toBe(true);
    expect(result.current.isSaved('ontario')).toBe(true);
    expect(JSON.parse((await AsyncStorage.getItem(KEY_A)) ?? '[]').sort()).toEqual(['hawaii', 'ontario']);
  });
});
