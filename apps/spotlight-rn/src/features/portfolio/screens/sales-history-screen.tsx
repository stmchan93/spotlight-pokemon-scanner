import { type ReactNode, useMemo, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  PillButton,
  SearchField,
  StateCard,
  SurfaceCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { SalePriceEditSheet } from '@/features/portfolio/components/sale-price-edit-sheet';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { usePortfolioScreenModel } from '@/features/portfolio/hooks/use-portfolio-screen-model';

type SalesHistoryScreenProps = {
  onBack: () => void;
};

type SalesSortOption = 'recent' | 'value' | 'a-z';
type SalesFilterOption = 'all' | 'sold' | 'traded';

const sortOptions: { label: string; value: SalesSortOption }[] = [
  { label: 'Recent', value: 'recent' },
  { label: 'Value', value: 'value' },
  { label: 'A-Z', value: 'a-z' },
];

const filterOptions: { label: string; value: SalesFilterOption }[] = [
  { label: 'All', value: 'all' },
  { label: 'Sold', value: 'sold' },
  { label: 'Traded', value: 'traded' },
];

const PAGE_GUTTER = 16;

function formatCardNumber(cardNumber: string) {
  return cardNumber.startsWith('#') ? cardNumber : `#${cardNumber}`;
}

function saleSearchText(sale: {
  cardNumber: string;
  kind: 'sold' | 'traded';
  name: string;
  setName: string;
  soldAtLabel: string;
}) {
  return [sale.name, sale.setName, sale.cardNumber, sale.soldAtLabel, sale.kind].join(' ').toLowerCase();
}

function ControlGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.controlGroup}>
      <Text style={[theme.typography.micro, styles.sectionLabel]}>{title}</Text>
      <ScrollView
        horizontal
        contentContainerStyle={styles.chipRow}
        showsHorizontalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </View>
  );
}

function SaleCard({
  onPress,
  sale,
}: {
  onPress: () => void;
  sale: {
    cardNumber: string;
    currencyCode: string;
    id: string;
    imageUrl: string;
    kind: 'sold' | 'traded';
    name: string;
    setName: string;
    soldAtLabel: string;
    soldPrice: number;
  };
}) {
  const theme = useSpotlightTheme();
  const canEdit = sale.kind === 'sold';

  return (
    <Pressable
      accessibilityRole={canEdit ? 'button' : undefined}
      onPress={canEdit ? onPress : undefined}
      style={({ pressed }) => [
        styles.saleCardPressable,
        {
          opacity: canEdit && pressed ? 0.94 : 1,
        },
      ]}
      testID={`sales-card-${sale.id}`}
    >
      <SurfaceCard padding={16} radius={16} style={styles.saleCard}>
        <Image source={{ uri: sale.imageUrl }} style={styles.saleArt} />

        <View style={styles.saleCopy}>
          <View style={styles.saleTitleRow}>
            <Text
              numberOfLines={1}
              style={[theme.typography.headline, styles.saleTitleText, { color: theme.colors.textPrimary }]}
            >
              {sale.name}
            </Text>
            <Text style={[theme.typography.headline, styles.salePriceText, { color: theme.colors.textPrimary }]}>
              {formatCurrency(sale.soldPrice, sale.currencyCode)}
            </Text>
          </View>
          <Text numberOfLines={2} style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {formatCardNumber(sale.cardNumber)}
            {' • '}
            {sale.setName}
          </Text>
          <View style={styles.saleDetailRow}>
            <Text style={[theme.typography.caption, styles.saleDate, { color: theme.colors.textSecondary }]}>
              {sale.soldAtLabel}
            </Text>
            {canEdit ? (
              <Text style={[theme.typography.caption, styles.saleIcon, { color: theme.colors.textSecondary }]}>
                ✎
              </Text>
            ) : null}
          </View>
        </View>
      </SurfaceCard>
    </Pressable>
  );
}

export function SalesHistoryScreen({ onBack }: SalesHistoryScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const model = usePortfolioScreenModel();
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOption, setSortOption] = useState<SalesSortOption>('recent');
  const [filterOption, setFilterOption] = useState<SalesFilterOption>('all');

  const sales = model.dashboard?.recentSales ?? [];
  const trimmedSearchQuery = searchQuery.trim().toLowerCase();

  const displayedSales = useMemo(() => {
    let nextSales = sales.filter((sale) => {
      if (filterOption === 'sold') {
        return sale.kind === 'sold';
      }

      if (filterOption === 'traded') {
        return sale.kind === 'traded';
      }

      return true;
    });

    if (trimmedSearchQuery.length > 0) {
      nextSales = nextSales.filter((sale) => saleSearchText(sale).includes(trimmedSearchQuery));
    }

    return nextSales.slice().sort((left, right) => {
      switch (sortOption) {
        case 'value':
          return right.soldPrice - left.soldPrice;
        case 'a-z':
          return left.name.localeCompare(right.name);
        case 'recent':
        default:
          return Date.parse(right.soldAtISO) - Date.parse(left.soldAtISO);
      }
    });
  }, [filterOption, sales, sortOption, trimmedSearchQuery]);

  const emptyState = useMemo(() => {
    if (sales.length === 0) {
      return {
        title: 'No transactions yet',
        message: 'Completed transactions will show up here as soon as you start moving inventory.',
      };
    }

    return {
      title: 'No transactions match that search',
      message: 'Try a different card name, set, or transaction filter.',
    };
  }, [sales.length]);

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: theme.colors.canvas }]}
    >
      <View style={[styles.screen, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.navRow}>
          <ChromeBackButton onPress={onBack} testID="sales-history-back" />
          <Text style={[theme.typography.headline, { color: theme.colors.textSecondary }]}>Transactions</Text>
          <View style={styles.navSpacer} />
        </View>

        <View style={styles.headerCopy}>
          <Text style={theme.typography.display}>All Transactions</Text>
          <Text style={[theme.typography.headline, { color: theme.colors.textSecondary }]}>
            {displayedSales.length} shown
          </Text>
        </View>

        <SearchField
          containerStyle={styles.searchField}
          onChangeText={setSearchQuery}
          placeholder="Search transactions"
          returnKeyType="search"
          value={searchQuery}
        />

        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={styles.controlsCard}>
            <ControlGroup title="SORT">
              {sortOptions.map((option) => (
                <PillButton
                  key={option.value}
                  label={option.label}
                  onPress={() => setSortOption(option.value)}
                  selected={sortOption === option.value}
                  testID={`sales-sort-${option.value}`}
                />
              ))}
            </ControlGroup>

            <ControlGroup title="FILTER">
              {filterOptions.map((option) => (
                <PillButton
                  key={option.value}
                  label={option.label}
                  onPress={() => setFilterOption(option.value)}
                  selected={filterOption === option.value}
                  testID={`sales-filter-${option.value}`}
                />
              ))}
            </ControlGroup>
          </View>

          {model.dashboard == null ? (
            <StateCard
              message="Pulling your recent transactions."
              style={styles.stateCard}
              title="Loading transactions..."
            />
          ) : displayedSales.length === 0 ? (
            <StateCard
              message={emptyState.message}
              style={styles.stateCard}
              title={emptyState.title}
            />
          ) : (
            <View style={styles.saleList}>
              {displayedSales.map((sale) => (
                <SaleCard key={sale.id} onPress={() => model.openSaleEditor(sale)} sale={sale} />
              ))}
            </View>
          )}
        </ScrollView>
      </View>

      <SalePriceEditSheet
        canConfirm={model.canConfirmSalePriceEdit}
        onChangePriceText={model.updateEditingSalePriceText}
        onClose={model.closeSaleEditor}
        onConfirm={model.confirmSalePriceEdit}
        priceText={model.editingSalePriceText}
        sale={model.editingSale}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  chipRow: {
    flexDirection: 'row',
    gap: 10,
    paddingRight: 8,
  },
  controlGroup: {
    gap: 10,
  },
  controlsCard: {
    gap: 16,
    paddingHorizontal: 0,
  },
  headerCopy: {
    gap: 4,
  },
  navRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  navSpacer: {
    width: 44,
  },
  safeArea: {
    flex: 1,
  },
  saleArt: {
    borderRadius: 12,
    height: 96,
    resizeMode: 'contain',
    width: 72,
  },
  saleCard: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
  },
  saleCardPressable: {
    borderRadius: 16,
  },
  saleCopy: {
    flex: 1,
    gap: 6,
    justifyContent: 'center',
    minHeight: 96,
  },
  saleDate: {
    flex: 1,
  },
  saleDetailRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  saleIcon: {
    marginTop: 1,
  },
  saleList: {
    gap: 10,
  },
  salePriceText: {
    flexShrink: 0,
    textAlign: 'right',
  },
  saleTitleRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    width: '100%',
  },
  saleTitleText: {
    flex: 1,
  },
  screen: {
    flex: 1,
    gap: 18,
    paddingHorizontal: PAGE_GUTTER,
    paddingTop: 8,
  },
  scrollContent: {
    gap: 18,
    paddingBottom: 120,
  },
  searchField: {
  },
  sectionLabel: {
    letterSpacing: 1.8,
  },
  stateCard: {
    alignItems: 'flex-start',
    paddingVertical: 20,
  },
});
