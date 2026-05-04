import { useEffect, useState } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, Text, TextInput, View } from 'react-native';

import { renderAppRouter } from '../test-utils';

function firstParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0);
  }

  return value;
}

function listParam(value?: string | string[]) {
  const rawValues = Array.isArray(value) ? value : value ? [value] : [];

  return [...new Set(
    rawValues
      .flatMap((candidate) => candidate.split(','))
      .map((candidate) => candidate.trim())
      .filter(Boolean),
  )];
}

function InventoryRouteHarness() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    mode?: string | string[];
    selected?: string | string[];
  }>();
  const initialMode = firstParam(params.mode) === 'select' ? 'select' : 'browse';
  const [selectedIds, setSelectedIds] = useState<string[]>(listParam(params.selected));

  const toggleSelection = (entryId: string) => {
    setSelectedIds((current) => {
      if (current.includes(entryId)) {
        return current.filter((candidate) => candidate !== entryId);
      }

      return [...current, entryId];
    });
  };

  return (
    <View>
      <Text>All cards</Text>
      <Pressable onPress={() => router.back()} testID="inventory-back">
        <Text>Back</Text>
      </Pressable>
      <Pressable
        onPress={() => {
          if (initialMode === 'select') {
            toggleSelection('entry-1');
            return;
          }

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
          if (initialMode === 'select') {
            toggleSelection('entry-2');
            return;
          }

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
      {initialMode === 'select' ? (
        <Pressable
          onPress={() => {
            if (selectedIds.length === 0) {
              return;
            }

            router.push({
              pathname: '/sell/batch',
              params: {
                entryIds: selectedIds.join(','),
              },
            });
          }}
          testID="inventory-sell-selected"
        >
          <Text>Sell selected</Text>
        </Pressable>
      ) : null}
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
                pathname: '/sell/[entryId]',
                params: {
                  entryId,
                },
              });
            }}
            testID="detail-sell-card"
          >
            <Text>SELL CARD</Text>
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

function AddToCollectionRouteHarness() {
  const router = useRouter();
  const params = useLocalSearchParams<{ cardId?: string | string[] }>();
  const cardId = firstParam(params.cardId) ?? '';

  return (
    <View>
      <Text>Add to Collection</Text>
      <Text>{cardId}</Text>
      <Pressable
        onPress={() => {
          router.replace({
            pathname: '/cards/[cardId]',
            params: {
              cardId: cardId || 'sm7-1',
              entryId: 'owned-entry-1',
            },
          });
        }}
        testID="submit-add-to-collection"
      >
        <Text>Submit</Text>
      </Pressable>
    </View>
  );
}

function BatchSellRouteHarness() {
  const params = useLocalSearchParams<{
    entryIds?: string | string[];
    entryId?: string | string[];
  }>();
  const entryIds = [...new Set([
    ...listParam(params.entryIds),
    ...listParam(params.entryId),
  ])];
  const labels = entryIds.map((entryId) => {
    switch (entryId) {
      case 'entry-1':
        return 'Scorbunny';
      case 'entry-2':
        return 'Oshawott';
      default:
        return entryId;
    }
  });

  return (
    <View>
      <Text>{entryIds.length} cards selected</Text>
      {labels.map((label) => (
        <Text key={label}>{label}</Text>
      ))}
    </View>
  );
}

function SingleSellRouteHarness() {
  const params = useLocalSearchParams<{
    entryId?: string | string[];
  }>();
  const entryId = firstParam(params.entryId) ?? '';

  return (
    <View>
      <Text>Sell order</Text>
      <Text>{entryId}</Text>
    </View>
  );
}

describe('route wiring flows', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens inventory from portfolio and returns back to the portfolio shell', async () => {
    renderAppRouter('/portfolio', {
      'inventory/index': InventoryRouteHarness,
    });

    expect(await screen.findByText('Track value, favorites, and your latest transactions in one place.')).toBeTruthy();

    fireEvent.press(screen.getByTestId('portfolio-see-more'));

    expect(await screen.findByText('All cards')).toBeTruthy();

    fireEvent.press(screen.getByTestId('inventory-back'));

    await waitFor(() => {
      expect(screen.getByText('Track value, favorites, and your latest transactions in one place.')).toBeTruthy();
    });
  });

  it('navigates from add-card search to detail and through add-to-collection', async () => {
    jest.useFakeTimers();

    renderAppRouter('/portfolio', {
      'catalog/search': CatalogSearchRouteHarness,
      'cards/[cardId]': CardDetailRouteHarness,
      'collection/add/[cardId]': AddToCollectionRouteHarness,
    });

    fireEvent.press(await screen.findByTestId('portfolio-add-card'));
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

    fireEvent.press(screen.getByTestId('submit-add-to-collection'));

    await waitFor(() => {
      expect(screen.getByTestId('detail-collection-header-label')).toBeTruthy();
      expect(screen.getByTestId('detail-sell-card')).toBeTruthy();
      expect(screen.queryByTestId('detail-add-to-collection')).toBeNull();
    });
  });

  it('opens batch sell from inventory selection mode with preselected entries', async () => {
    renderAppRouter('/inventory?mode=select&selected=entry-1', {
      'inventory/index': InventoryRouteHarness,
      'sell/batch': BatchSellRouteHarness,
    });

    expect(await screen.findByText('All cards')).toBeTruthy();
    expect(screen.getByText('Sell selected')).toBeTruthy();

    fireEvent.press(screen.getByTestId('inventory-entry-entry-2'));
    fireEvent.press(screen.getByTestId('inventory-sell-selected'));

    expect(await screen.findByText('2 cards selected')).toBeTruthy();
    expect(screen.getByText('Scorbunny')).toBeTruthy();
    expect(screen.getByText('Oshawott')).toBeTruthy();
  });

  it('opens single sell from owned detail', async () => {
    renderAppRouter('/inventory', {
      'inventory/index': InventoryRouteHarness,
      'cards/[cardId]': CardDetailRouteHarness,
      'sell/[entryId]': SingleSellRouteHarness,
    });

    expect(await screen.findByText('All cards')).toBeTruthy();

    fireEvent.press(screen.getByTestId('inventory-entry-entry-1'));

    expect(await screen.findByTestId('detail-sell-card')).toBeTruthy();

    fireEvent.press(screen.getByTestId('detail-sell-card'));

    expect(await screen.findByText('Sell order')).toBeTruthy();
    expect(screen.getByText('entry-1')).toBeTruthy();
  });
});
