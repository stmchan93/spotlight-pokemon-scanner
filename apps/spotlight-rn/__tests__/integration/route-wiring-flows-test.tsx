import { useEffect, useState } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, Text, TextInput, View } from 'react-native';

import AddToCollectionRoute from '@/app/(sheet)/collection/add/[cardId]';
import BulkSellRoute from '@/app/(sheet)/sell/batch';
import SingleSellRoute from '@/app/(sheet)/sell/[entryId]';

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

async function enterSingleSellPriceWithCalculator() {
  fireEvent.press(screen.getByTestId('single-sell-sold-price'));
  fireEvent.press(screen.getByTestId('single-sell-calculator-key-1'));
  fireEvent.press(screen.getByTestId('single-sell-calculator-key-2'));
  fireEvent.press(screen.getByTestId('single-sell-calculator-key-5'));
  fireEvent.press(screen.getByTestId('single-sell-calculator-key-÷'));
  fireEvent.press(screen.getByTestId('single-sell-calculator-key-1'));
  fireEvent.press(screen.getByTestId('single-sell-calculator-key-0'));
  fireEvent.press(screen.getByTestId('single-sell-calculator-equals'));
}

async function enterBulkSellPriceWithCalculator() {
  fireEvent.press(screen.getByTestId('bulk-sell-sold-price-smoke-raw-mcdonalds25-16'));
  fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-key-1'));
  fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-key-2'));
  fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-key-5'));
  fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-key-÷'));
  fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-key-1'));
  fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-key-0'));
  fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-16-calculator-equals'));
}

async function enterSecondBulkSellPriceWithCalculator() {
  fireEvent.press(screen.getByTestId('bulk-sell-sold-price-smoke-raw-mcdonalds25-21'));
  fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-21-calculator-key-2'));
  fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-21-calculator-key-×'));
  fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-21-calculator-key-3'));
  fireEvent.press(screen.getByTestId('bulk-sell-smoke-raw-mcdonalds25-21-calculator-equals'));
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
      'collection/add/[cardId]': AddToCollectionRoute,
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

  it('opens single sell from owned detail and completes the happy path', async () => {
    jest.useFakeTimers();

    renderAppRouter('/inventory', {
      'inventory/index': InventoryRouteHarness,
      'cards/[cardId]': CardDetailRouteHarness,
      'sell/[entryId]': SingleSellRoute,
    });

    expect(await screen.findByText('All cards')).toBeTruthy();

    fireEvent.press(screen.getByTestId('inventory-entry-entry-1'));

    expect(await screen.findByTestId('detail-sell-card')).toBeTruthy();

    fireEvent.press(screen.getByTestId('detail-sell-card'));

    expect(await screen.findByText('Scorbunny')).toBeTruthy();
    await enterSingleSellPriceWithCalculator();
    expect(screen.getByText('$12.5')).toBeTruthy();

    const rail = screen.getByTestId('single-sell-swipe-rail');
    await act(async () => {
      rail.props.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } });
    });

    expect(screen.getByText('Processing sale')).toBeTruthy();

    await act(async () => {
      jest.runAllTimers();
    });

    await waitFor(() => {
      expect(screen.getByText('Track value, favorites, and your latest transactions in one place.')).toBeTruthy();
    });
  });

  it('opens batch sell from inventory selection mode and completes the happy path', async () => {
    jest.useFakeTimers();

    renderAppRouter('/inventory?mode=select&selected=entry-1', {
      'inventory/index': InventoryRouteHarness,
      'sell/batch': BulkSellRoute,
    });

    expect(await screen.findByText('All cards')).toBeTruthy();
    expect(screen.getByText('Sell selected')).toBeTruthy();

    fireEvent.press(screen.getByTestId('inventory-entry-entry-2'));
    fireEvent.press(screen.getByTestId('inventory-sell-selected'));

    expect(await screen.findByText('3 cards selected')).toBeTruthy();

    await enterBulkSellPriceWithCalculator();
    fireEvent.press(screen.getByTestId('bulk-sell-review-sale'));
    expect(screen.queryByText('Review before confirm')).toBeNull();

    await enterSecondBulkSellPriceWithCalculator();
    fireEvent.press(screen.getByTestId('bulk-sell-review-sale'));
    expect(await screen.findByText('Review before confirm')).toBeTruthy();

    const rail = screen.getByTestId('bulk-sell-swipe-rail');
    await act(async () => {
      rail.props.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } });
    });

    expect(screen.getByText('Processing sale')).toBeTruthy();

    await act(async () => {
      jest.runAllTimers();
    });

    await waitFor(() => {
      expect(screen.getByText('Track value, favorites, and your latest transactions in one place.')).toBeTruthy();
    });
  });
});
