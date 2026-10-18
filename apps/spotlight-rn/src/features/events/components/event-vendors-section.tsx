import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import type { GestureType, ScrollView as GestureScrollView } from 'react-native-gesture-handler';
import { Instagram, Search, Xmark } from 'iconoir-react-native';

import type { SpotlightEventMap, SpotlightEventMapVendor } from '@spotlight/api-client';
import {
  Button,
  PillButton,
  SearchField,
  SkeletonBlock,
  borderWidths,
  radii,
  shadows,
  spacing,
  Text,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { CachedImage } from '@/components/cached-image';
import { EventFloorMap } from '@/features/events/components/event-floor-map';
import { filterVendors, floorMapViewportHeight, vendorForTable } from '@/features/events/event-floor-map-model';
import { useSpotlightEventMap } from '@/features/events/hooks/use-spotlight-event-map';

/** The server sends the chip set in display order (tools/build_event_floor_map.py FILTER_TAGS); this only guards a runaway list. */
const MAX_TAG_CHIPS = 12;
/** Map space the floating vendor card covers; a fitted vendor is centred above it. */
const CARD_OVERLAY_HEIGHT = 96;
/** The unfiltered list starts short; 180 rows in a non-virtualized page is a lot of layout. */
const COLLAPSED_ROWS = 25;
const ICON_SIZE = 16;
const INSTAGRAM_ICON_SIZE = 24;
// Figma 5882:12678 / 5865:11361 — 32pt plate with a 20pt logo in the row, 39/24 on the card.
const ROW_LOGO_SIZE = 32;
const CARD_LOGO_SIZE = 39;
const LOGO_INSET_RATIO = 6 / 32;
// Figma 5882:12668 — rows 10 apart; the selected row's dark shell is 10 inside.
const LIST_GAP = 10;
const SELECTED_ROW_PADDING = 10;
/** A map-tapped vendor scrolls into view with this much page above its row. */
const SCROLL_INTO_VIEW_MARGIN = 120;

/** "Main Street Cards" -> "MS", "3vilCollections" -> "3". */
function vendorInitials(name: string) {
  const words = name.match(/[A-Za-z0-9]+/g) ?? [];
  return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase() || '?';
}

/** Gray plate with the vendor's logo inset, or their initials when there is none. */
function VendorLogo({ vendor, size }: { vendor: SpotlightEventMapVendor; size: number }) {
  const theme = useSpotlightTheme();
  const inner = Math.round(size * (1 - 2 * LOGO_INSET_RATIO));
  return (
    <View
      style={[
        styles.logo,
        { backgroundColor: theme.colors.gray300, borderRadius: size / 2, height: size, width: size },
      ]}
      testID={`event-vendor-avatar-${vendor.id}`}
    >
      {vendor.logoUrl ? (
        <CachedImage contentFit="contain" source={{ uri: vendor.logoUrl }} style={{ height: inner, width: inner }} />
      ) : (
        // Initials scale with the plate, as `Avatar` does.
        <Text style={[theme.typography.captionStrong, { color: theme.colors.gray900, fontSize: inner * 0.55, lineHeight: inner }]}>
          {vendorInitials(vendor.name)}
        </Text>
      )}
    </View>
  );
}

type EventVendorsSectionProps = {
  floorMapUrl: string;
  scrollGesture?: GestureType | React.RefObject<unknown>;
  /** The page's scroll view, so a vendor picked on the map can be scrolled into view. */
  scrollRef?: React.RefObject<GestureScrollView | null>;
  /** The section's title row, so it matches the screen's other sections. */
  renderTitle: (title: string) => React.ReactNode;
};

export function EventVendorsSection({ floorMapUrl, scrollGesture, scrollRef, renderTitle }: EventVendorsSectionProps) {
  const { map, loading } = useSpotlightEventMap(floorMapUrl);
  const mapHeight = floorMapViewportHeight(useWindowDimensions().height);
  if (!map) {
    return loading ? (
      <View style={styles.section} testID="event-vendors-loading">
        {renderTitle('Vendors')}
        <SkeletonBlock height={mapHeight} width="100%" />
      </View>
    ) : null;
  }
  return <EventVendorsBody map={map} renderTitle={renderTitle} scrollGesture={scrollGesture} scrollRef={scrollRef} />;
}

function EventVendorsBody({
  map,
  renderTitle,
  scrollGesture,
  scrollRef,
}: {
  map: SpotlightEventMap;
  renderTitle: (title: string) => React.ReactNode;
  scrollGesture?: GestureType | React.RefObject<unknown>;
  scrollRef?: React.RefObject<GestureScrollView | null>;
}) {
  const theme = useSpotlightTheme();
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A pick on the map lands wherever its row is; a tapped row is already on screen.
  const [scrollToSelected, setScrollToSelected] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const selectedRowRef = useRef<View>(null);

  const isFiltering = query.trim().length > 0 || tag != null;
  const matches = useMemo(() => filterVendors(map.vendors, query, tag), [map.vendors, query, tag]);
  const selected = useMemo(
    () => map.vendors.find((vendor) => vendor.id === selectedId) ?? null,
    [map.vendors, selectedId],
  );
  const selectedTableIds = useMemo(() => new Set(selected?.tableIds ?? []), [selected]);
  const matchedTableIds = useMemo(
    () => (isFiltering ? new Set(matches.flatMap((vendor) => vendor.tableIds)) : new Set<string>()),
    [isFiltering, matches],
  );
  const chips = map.tags.slice(0, MAX_TAG_CHIPS);
  const rows = isFiltering || expanded ? matches : matches.slice(0, COLLAPSED_ROWS);

  const select = useCallback((vendor: SpotlightEventMapVendor) => {
    setScrollToSelected(false);
    setSelectedId((current) => (current === vendor.id ? null : vendor.id));
  }, []);

  const deselect = useCallback(() => setSelectedId(null), []);

  const handleTablePress = useCallback(
    (tableId: string) => {
      const vendor = vendorForTable(map.vendors, tableId);
      if (!vendor) {
        setSelectedId(null);
        return;
      }
      // Past the fold? Open the list so the row exists to scroll to.
      if (!isFiltering && matches.indexOf(vendor) >= COLLAPSED_ROWS) {
        setExpanded(true);
      }
      setScrollToSelected(true);
      setSelectedId((current) => (current === vendor.id ? null : vendor.id));
    },
    [isFiltering, map.vendors, matches],
  );

  useEffect(() => {
    if (!scrollToSelected || !selectedId || !scrollRef?.current) {
      return;
    }
    const scroll = scrollRef.current;
    const inner = scroll.getInnerViewNode?.();
    if (!inner) {
      return;
    }
    try {
      selectedRowRef.current?.measureLayout(
        inner,
        (_x, y) => scroll.scrollTo({ y: Math.max(0, y - SCROLL_INTO_VIEW_MARGIN), animated: true }),
        () => undefined,
      );
    } catch {
      // Measuring is best effort; the row still highlights.
    }
  }, [scrollRef, scrollToSelected, selectedId]);

  return (
    <View style={styles.section} testID="event-vendors">
      {renderTitle('Vendors')}
      <View style={styles.controls}>
        <SearchField
          accessibilityLabel="Search vendors"
          autoCapitalize="none"
          autoCorrect={false}
          containerTestID="event-vendors-search-field"
          leading={<Search color={theme.colors.gray500} height={ICON_SIZE} width={ICON_SIZE} />}
          onChangeText={setQuery}
          placeholder="SEARCH BY VENDOR OR HOBBY"
          returnKeyType="search"
          size="collection"
          surface="muted"
          testID="event-vendors-search"
          trailing={
            query ? (
              <Pressable accessibilityLabel="Clear search" hitSlop={spacing.xxs} onPress={() => setQuery('')}>
                <Xmark color={theme.colors.gray500} height={ICON_SIZE} width={ICON_SIZE} />
              </Pressable>
            ) : null
          }
          value={query}
        />
        {chips.length > 0 ? (
          <ScrollView
            contentContainerStyle={styles.chips}
            horizontal
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
            testID="event-vendors-tags"
          >
            {chips.map((item) => (
              <PillButton
                key={item}
                label={item.toUpperCase()}
                onPress={() => setTag((current) => (current === item ? null : item))}
                selected={tag === item}
                testID={`event-vendors-tag-${item}`}
                tone="filled"
              />
            ))}
          </ScrollView>
        ) : null}
      </View>

      <View>
        <EventFloorMap
          bottomInset={selected ? CARD_OVERLAY_HEIGHT : 0}
          focusKey={selected?.id ?? null}
          map={map}
          matchedTableIds={matchedTableIds}
          onBackgroundPress={deselect}
          onTablePress={handleTablePress}
          scrollGesture={scrollGesture}
          selectedTableIds={selectedTableIds}
        />
        {/* Docked inside the map (Figma 5865:11358): below it, a tapped table's vendor landed off-screen. */}
        {selected ? (
          <View pointerEvents="box-none" style={styles.cardOverlay}>
            <SelectedVendorCard onClose={deselect} vendor={selected} />
          </View>
        ) : null}
      </View>

      <View style={styles.list}>
        {rows.map((vendor, index) => {
          const isSelected = vendor.id === selectedId;
          const next = rows[index + 1];
          // Hairlines sit between plain rows; the dark selected shell carries its own edges.
          const divider = next != null && !isSelected && next.id !== selectedId;
          return (
            <Fragment key={vendor.id}>
              <VendorRow
                onPress={select}
                ref={isSelected ? selectedRowRef : null}
                selected={isSelected}
                vendor={vendor}
              />
              {divider ? <View style={[styles.divider, { backgroundColor: theme.colors.gray200 }]} /> : null}
            </Fragment>
          );
        })}
        {rows.length === 0 ? (
          <Text style={[theme.typography.body, { color: theme.colors.gray600 }]} testID="event-vendors-empty">
            No vendors match.
          </Text>
        ) : null}
      </View>
      {!isFiltering && !expanded && matches.length > COLLAPSED_ROWS ? (
        <Button
          label={`Show all ${matches.length} vendors`}
          labelStyleVariant="label"
          onPress={() => setExpanded(true)}
          shape="rounded"
          size="xs"
          testID="event-vendors-show-all"
          variant="secondary"
        />
      ) : null}
    </View>
  );
}

type VendorRowProps = {
  vendor: SpotlightEventMapVendor;
  selected: boolean;
  onPress: (vendor: SpotlightEventMapVendor) => void;
  ref?: React.Ref<View>;
};

/** Figma 5882:12677; selected = 5865:10937 (gray-900 shell, white copy). */
function VendorRow({ vendor, selected, onPress, ref }: VendorRowProps) {
  const theme = useSpotlightTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={() => onPress(vendor)}
      ref={ref}
      style={[styles.row, selected ? [styles.rowSelected, { backgroundColor: theme.colors.gray900 }] : null]}
      testID={`event-vendor-${vendor.id}`}
    >
      <VendorLogo size={ROW_LOGO_SIZE} vendor={vendor} />
      <View style={styles.rowText}>
        <Text
          numberOfLines={1}
          style={[theme.typography.bodyMedium, { color: selected ? theme.colors.gray0 : theme.colors.gray900 }]}
        >
          {vendor.name}
        </Text>
        {vendor.tags.length > 0 ? (
          <Text
            numberOfLines={1}
            style={[theme.typography.cardMeta, styles.upper, { color: selected ? theme.colors.gray400 : theme.colors.gray600 }]}
          >
            {vendor.tags.join(' · ')}
          </Text>
        ) : null}
      </View>
      <Text style={[theme.typography.captionStrong, { color: selected ? theme.colors.gray0 : theme.colors.gray900 }]}>
        {vendor.location}
      </Text>
    </Pressable>
  );
}

/** Figma 5865:11358 — the white card docked at the bottom of the map. */
function SelectedVendorCard({ vendor, onClose }: { vendor: SpotlightEventMapVendor; onClose: () => void }) {
  const theme = useSpotlightTheme();
  const instagram = vendor.instagram;
  return (
    <View style={[styles.card, shadows.card, { backgroundColor: theme.colors.gray0 }]} testID="event-vendor-card">
      <VendorLogo size={CARD_LOGO_SIZE} vendor={vendor} />
      <View style={styles.cardText}>
        <Text numberOfLines={1} style={[theme.typography.headline, { color: theme.colors.gray900 }]} testID="event-vendor-card-name">
          {vendor.name}
        </Text>
        {vendor.tags.length > 0 ? (
          <Text numberOfLines={1} style={[theme.typography.cardMeta, styles.upper, { color: theme.colors.gray600 }]}>
            {vendor.tags.join(' · ')}
          </Text>
        ) : null}
        <Text style={[theme.typography.label, { color: theme.colors.gray700 }]}>{`Table ${vendor.location}`}</Text>
      </View>
      {instagram ? (
        <Pressable
          accessibilityLabel={`@${instagram} on Instagram`}
          accessibilityRole="link"
          hitSlop={spacing.xxs}
          onPress={() => void Linking.openURL(`https://instagram.com/${instagram}`).catch(() => undefined)}
          testID="event-vendor-card-instagram"
        >
          <Instagram color={theme.colors.gray900} height={INSTAGRAM_ICON_SIZE} width={INSTAGRAM_ICON_SIZE} />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityLabel="Close vendor"
        accessibilityRole="button"
        hitSlop={spacing.xxs}
        onPress={onClose}
        testID="event-vendor-card-close"
      >
        <Xmark color={theme.colors.gray600} height={INSTAGRAM_ICON_SIZE} width={INSTAGRAM_ICON_SIZE} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.sm,
  },
  controls: {
    gap: spacing.xxs,
  },
  chips: {
    gap: spacing.xxs,
  },
  cardOverlay: {
    bottom: spacing.xs,
    left: spacing.xs,
    position: 'absolute',
    right: spacing.xs,
  },
  // Figma 5865:11358 — 12 padding, 8 gap, radius 8.
  card: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    flexDirection: 'row',
    gap: spacing.xxs,
    padding: spacing.xs,
  },
  cardText: {
    flex: 1,
    gap: spacing.xxxs,
  },
  logo: {
    alignItems: 'center',
    borderCurve: 'continuous',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  upper: {
    textTransform: 'uppercase',
  },
  list: {
    gap: LIST_GAP,
  },
  divider: {
    height: borderWidths.rule,
  },
  // Rows sit 8 in from the section edge (Figma: 345 wide in a 361 column).
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
    paddingHorizontal: spacing.xxs,
  },
  rowSelected: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    padding: SELECTED_ROW_PADDING,
  },
  rowText: {
    flex: 1,
    gap: spacing.xxxs,
  },
});
