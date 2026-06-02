import { useEffect, useState } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, Text, TextInput, View } from 'react-native';

import AddToCollectionRoute from '@/app/(sheet)/collection/add/[cardId]';

import { renderAppRouter } from '../test-utils';

function firstParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0);
  }

  return value;
}

function InventoryRouteHarness() {
  const router = useRouter();
  return (
    <View>
      <Text>All cards</Text>
      <Pressable onPress={() => router.back()} testID="inventory-back">
        <Text>Back</Text>
      </Pressable>
      <Pressable
        onPress={() => {
          router.push({
            pathname: '/cards/[cardId]',
            params: {
              cardId: 'mcdonalds25-16',
              entryId: 'entry-1',
            },
          });
        }}
        testID="inventory-entry-entry-1"
      >
        <Text>Scorbunny</Text>
      </Pressable>
      <Pressable
        onPress={() => {
          router.push({
            pathname: '/cards/[cardId]',
            params: {
              cardId: 'mcdonalds25-21',
              entryId: 'entry-2',
            },
          });
        }}
        testID="inventory-entry-entry-2"
      >
        <Text>Oshawott</Text>
      </Pressable>
    </View>
  );
}

function CatalogSearchRouteHarness() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [showResults, setShowResults] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) {
      setShowResults(false);
      return;
    }

    const timeout = setTimeout(() => {
      setShowResults(true);
    }, 275);

    return () => clearTimeout(timeout);
  }, [query]);

  return (
    <View>
      <Text>Add Card</Text>
      <TextInput
        onChangeText={setQuery}
        placeholder="Search by name, set, or number"
        value={query}
      />
      {showResults ? <Text>5 results</Text> : null}
      {showResults
        ? Array.from({ length: 5 }).map((_, index) => (
            <Pressable
              key={`treecko-${index}`}
              onPress={() => {
                router.push({
                  pathname: '/cards/[cardId]',
                  params: {
                    cardId: 'sm7-1',
                  },
                });
              }}
            >
              <Text>Treecko</Text>
            </Pressable>
          ))
        : null}
    </View>
  );
}

function CardDetailRouteHarness() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    cardId?: string | string[];
    entryId?: string | string[];
  }>();
  const cardId = firstParam(params.cardId) ?? '';
  const entryId = firstParam(params.entryId);

  return (
    <View>
      <Text>{cardId || 'Card Detail'}</Text>
      {entryId ? (
        <>
          <Text testID="detail-collection-header-label">In your collection</Text>
          <Pressable
            onPress={() => {
              router.push({
                pathname: '/collection/add/[cardId]',
                params: {
                  cardId,
                  entryId,
                },
              });
            }}
            testID="detail-edit-collection"
          >
            <Text>EDIT COLLECTION</Text>
          </Pressable>
        </>
      ) : (
        <Pressable
          onPress={() => {
            router.push({
              pathname: '/collection/add/[cardId]',
              params: {
                cardId: cardId || 'sm7-1',
              },
            });
          }}
          testID="detail-add-to-collection"
        >
          <Text>ADD TO COLLECTION</Text>
        </Pressable>
      )}
    </View>
  );
}

describe('route wiring flows', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // The Collection redesign (Frame 1) removed the "View All" link from the
  // Portfolio screen — the entire inventory now renders inline in the
  // masonry grid (no 6-card cap). The /inventory route still exists for
  // batch-sell selection mode but is no longer reachable from the Portfolio
  // screen UI. This flow is intentionally removed.
  it.skip('opens inventory from portfolio and returns back to the portfolio shell', async () => {
    renderAppRouter('/portfolio', {
      'inventory/index': InventoryRouteHarness,
    });

    expect(await screen.findByTestId('portfolio-header-title')).toBeTruthy();

    fireEvent.press(screen.getByTestId('portfolio-inventory-view-all'));

    expect(await screen.findByText('All cards')).toBeTruthy();

    fireEvent.press(screen.getByTestId('inventory-back'));

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-header-title')).toBeTruthy();
    });
  });

  it('navigates from add-card search to detail and through add-to-collection', async () => {
    jest.useFakeTimers();

    // Add Card moved from the Portfolio screen to the Inventory Browser, so
    // this flow now starts from `/inventory` instead of `/portfolio`.
    renderAppRouter('/inventory', {
      'catalog/search': CatalogSearchRouteHarness,
      'cards/[cardId]': CardDetailRouteHarness,
      'collection/add/[cardId]': AddToCollectionRoute,
    });

    fireEvent.press(await screen.findByTestId('inventory-add-card'));
    expect(await screen.findByText('Add Card')).toBeTruthy();

    fireEvent.changeText(screen.getByPlaceholderText('Search by name, set, or number'), 'tree');

    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    expect(await screen.findByText('5 results')).toBeTruthy();

    fireEvent.press(screen.getAllByText('Treecko')[0]!);

    expect(await screen.findByTestId('detail-add-to-collection')).toBeTruthy();

    fireEvent.press(screen.getByTestId('detail-add-to-collection'));

    expect(await screen.findByText('Add to Collection')).toBeTruthy();
    expect(screen.getByText('Treecko')).toBeTruthy();
    fireEvent.press(screen.getByTestId('add-to-collection-grader-PSA'));
    expect(screen.getByTestId('add-to-collection-grade-10')).toBeTruthy();
    fireEvent.press(screen.getByTestId('add-to-collection-quantity-increase'));
    expect(screen.getByTestId('add-to-collection-quantity-value').props.children).toBe(2);

    await act(async () => {
      fireEvent.press(screen.getByTestId('submit-add-to-collection'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('detail-add-to-collection')).toBeTruthy();
      expect(screen.queryByText('Add to Collection')).toBeNull();
    });
  });

  it('opens edit collection from owned detail and saves back to card detail', async () => {
    renderAppRouter('/cards/mcdonalds25-21?entryId=entry-2', {
      'cards/[cardId]': CardDetailRouteHarness,
      'collection/add/[cardId]': AddToCollectionRoute,
    });

    expect(await screen.findByTestId('detail-edit-collection')).toBeTruthy();

    fireEvent.press(screen.getByTestId('detail-edit-collection'));

    expect(await screen.findByText('Edit Collection')).toBeTruthy();
    expect(screen.getByTestId('add-to-collection-quantity-value').props.children).toBe(2);
    fireEvent.press(screen.getByTestId('add-to-collection-quantity-increase'));
    expect(screen.getByTestId('add-to-collection-quantity-value').props.children).toBe(3);

    await act(async () => {
      fireEvent.press(screen.getByTestId('submit-add-to-collection'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('detail-edit-collection')).toBeTruthy();
      expect(screen.queryByText('Edit Collection')).toBeNull();
    });
  });
});
