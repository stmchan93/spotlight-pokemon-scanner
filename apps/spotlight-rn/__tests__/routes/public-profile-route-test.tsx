import { fireEvent, render, screen } from '@testing-library/react-native';
import type { InventoryCardEntry } from '@spotlight/api-client';

import PublicProfileRoute from '@/app/(stack)/u/[handle]';
import { getCardDetailPreview } from '@/features/cards/card-detail-preview-session';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ handle: 'demo' }),
  useRouter: () => ({ back: jest.fn(), push: mockPush }),
}));

const theirEntry: InventoryCardEntry = {
  addedAt: '2026-09-01T00:00:00.000Z',
  cardId: 'ex-torchic',
  cardNumber: '#001',
  currencyCode: 'USD',
  hasMarketPrice: true,
  id: 'their-entry-1',
  imageUrl: 'https://cdn.spotlight.test/torchic.png',
  kind: 'raw',
  marketPrice: 4,
  name: 'Torchic',
  quantity: 2,
  setName: 'Test Set',
};

jest.mock('@/features/profile/screens/public-profile-screen', () => ({
  PublicProfileScreen: ({ onOpenEntry }: { onOpenEntry: (entry: InventoryCardEntry) => void }) => {
    const { Pressable } = require('react-native');
    return <Pressable onPress={() => onOpenEntry(theirEntry)} testID="public-profile-open-entry" />;
  },
}));

describe('public profile route', () => {
  it("opens another collector's card with a display-only preview: no entry id, no owned entry", () => {
    render(<PublicProfileRoute />);

    fireEvent.press(screen.getByTestId('public-profile-open-entry'));

    expect(mockPush).toHaveBeenCalledTimes(1);
    const { params } = mockPush.mock.calls[0][0] as {
      params: { cardId: string; entryId?: string; previewId: string };
    };
    expect(params.cardId).toBe('ex-torchic');
    expect(params.entryId).toBeUndefined();

    const preview = getCardDetailPreview(params.previewId);
    expect(preview).toMatchObject({ cardId: 'ex-torchic', imageUrl: theirEntry.imageUrl, name: 'Torchic' });
    expect(preview?.ownedEntry ?? null).toBeNull();
    expect(preview?.entryId ?? null).toBeNull();
  });
});
