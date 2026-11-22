import { renderHook, waitFor } from '@testing-library/react-native';

import { colors } from '@spotlight/design-system';
import { SET_PAGE_FALLBACK_ACCENT, useSetPageAccent } from '@/features/catalog/hooks/use-set-page-accent';

// jest.mock is hoisted above the imports.

const mockGetColors = jest.fn();
jest.mock('react-native-image-colors', () => ({ getColors: (...args: unknown[]) => mockGetColors(...args) }));

describe('useSetPageAccent', () => {
  beforeEach(() => mockGetColors.mockReset());

  it('falls back to a neutral gray, not the gold event accent', () => {
    expect(SET_PAGE_FALLBACK_ACCENT).toBe(colors.gray200);
    expect(SET_PAGE_FALLBACK_ACCENT).not.toBe(colors.eventAccent);
  });

  it("is the logo's dominant colour once read", async () => {
    mockGetColors.mockResolvedValue({ platform: 'ios', background: '#F5EF31', primary: '#710101' });
    const { result } = renderHook(() => useSetPageAccent('https://images.test/sv8-logo/logo'));
    expect(result.current).toBe(SET_PAGE_FALLBACK_ACCENT);
    await waitFor(() => expect(result.current).toBe('#F5EF31'));
    expect(mockGetColors).toHaveBeenCalledWith('https://images.test/sv8-logo/logo', expect.objectContaining({ cache: true }));
  });

  it('stays neutral when extraction fails', async () => {
    mockGetColors.mockRejectedValue(new Error('decode failed'));
    const { result } = renderHook(() => useSetPageAccent('https://images.test/bad/logo'));
    await waitFor(() => expect(mockGetColors).toHaveBeenCalled());
    expect(result.current).toBe(SET_PAGE_FALLBACK_ACCENT);
  });

  it('stays neutral with no logo', () => {
    const { result } = renderHook(() => useSetPageAccent(null));
    expect(result.current).toBe(SET_PAGE_FALLBACK_ACCENT);
    expect(mockGetColors).not.toHaveBeenCalled();
  });
});
