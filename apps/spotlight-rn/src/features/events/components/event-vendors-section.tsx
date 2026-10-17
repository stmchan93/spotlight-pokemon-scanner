import { useCallback, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { GestureType } from 'react-native-gesture-handler';
import { Instagram, Search, Xmark } from 'iconoir-react-native';

import type { SpotlightEventMap, SpotlightEventMapVendor } from '@spotlight/api-client';
import {
  Avatar,
  Button,
  IconButton,
  PillButton,
  SearchField,
  SkeletonBlock,
  SurfaceCard,
  borderWidths,
  iconButtonDefaultGlyphSize,
  radii,
  shadows,
  spacing,
  Text,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { EventFloorMap } from '@/features/events/components/event-floor-map';
import { filterVendors, vendorForTable } from '@/features/events/event-floor-map-model';
import { useSpotlightEventMap } from '@/features/events/hooks/use-spotlight-event-map';

/** The server sends the chip set in display order (tools/build_event_floor_map.py FILTER_TAGS); this only guards a runaway list. */
const MAX_TAG_CHIPS = 12;
/** Map space the floating vendor card covers; a fitted vendor is centred above it. */
const CARD_OVERLAY_HEIGHT = 96;
/** The unfiltered list starts short; 180 rows in a non-virtualized page is a lot of layout. */
const COLLAPSED_ROWS = 25;
const ICON_SIZE = 18;
const ROW_AVATAR_SIZE = 36;
const CARD_AVATAR_SIZE = 44;

/** "Main Street Cards" -> "MS", "3vilCollections" -> "3". */
function vendorInitials(name: string) {
  const words = name.match(/[A-Za-z0-9]+/g) ?? [];
  return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase() || '?';
}

function VendorAvatar({ vendor, size }: { vendor: SpotlightEventMapVendor; size: number }) {
  const theme = useSpotlightTheme();
  return (
    <Avatar
      initials={vendorInitials(vendor.name)}
      size={size}
      // Logos are often transparent; a light plate keeps them off the row colour.
      style={vendor.logoUrl ? { backgroundColor: theme.colors.gray50 } : null}
      testID={`event-vendor-avatar-${vendor.id}`}
      uri={vendor.logoUrl}
    />
  );
}

type EventVendorsSectionProps = {
  floorMapUrl: string;
  scrollGesture?: GestureType | React.RefObject<unknown>;
  /** The section's title row, so it matches the screen's other sections. */
  renderTitle: (title: string) => React.ReactNode;
};

export function EventVendorsSection({ floorMapUrl, scrollGesture, renderTitle }: EventVendorsSectionProps) {
  const { map, loading } = useSpotlightEventMap(floorMapUrl);
  if (!map) {
    return loading ? (
      <View style={styles.section} testID="event-vendors-loading">
        {renderTitle('Vendors')}
        <SkeletonBlock height={440} width="100%" />
      </View>
    ) : null;
  }
  return <EventVendorsBody map={map} renderTitle={renderTitle} scrollGesture={scrollGesture} />;
}

function EventVendorsBody({
  map,
  renderTitle,
  scrollGesture,
}: {
  map: SpotlightEventMap;
  renderTitle: (title: string) => React.ReactNode;
  scrollGesture?: GestureType | React.RefObject<unknown>;
}) {
  const theme = useSpotlightTheme();
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

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
    setSelectedId((current) => (current === vendor.id ? null : vendor.id));
  }, []);

  const handleTablePress = useCallback(
    (tableId: string) => {
      const vendor = vendorForTable(map.vendors, tableId);
      setSelectedId(vendor?.id ?? null);
    },
    [map.vendors],
  );

  return (
    <View style={styles.section} testID="event-vendors">
      {renderTitle('Vendors')}
      <View>
        <EventFloorMap
          bottomInset={selected ? CARD_OVERLAY_HEIGHT : 0}
          focusKey={selected?.id ?? null}
          map={map}
          matchedTableIds={matchedTableIds}
          onTablePress={handleTablePress}
          scrollGesture={scrollGesture}
          selectedTableIds={selectedTableIds}
        />
        {/* On the map, not below it: below, a tapped table's vendor landed off-screen. */}
        {selected ? (
          <View pointerEvents="box-none" style={styles.cardOverlay}>
            <SelectedVendorCard onClose={() => setSelectedId(null)} vendor={selected} />
          </View>
        ) : null}
      </View>
      <Text style={[theme.typography.caption, { color: theme.colors.gray500 }]}>
        {'Pinch to zoom · tap a table to see who\'s there'}
      </Text>

      <Text style={[theme.typography.label, { color: theme.colors.gray600 }]} testID="event-vendors-count">
        {isFiltering
          ? `${matches.length} of ${map.vendors.length} vendors`
          : `${map.vendors.length} vendors`}
      </Text>
      <SearchField
        accessibilityLabel="Search vendors"
        autoCapitalize="none"
        autoCorrect={false}
        containerTestID="event-vendors-search-field"
        leading={<Search color={theme.colors.gray500} height={ICON_SIZE} width={ICON_SIZE} />}
        onChangeText={setQuery}
        placeholder="Search vendors, booths or what they sell"
        returnKeyType="search"
        size="collection"
        surface="muted"
        testID="event-vendors-search"
        trailing={
          query ? (
            <Pressable accessibilityLabel="Clear search" hitSlop={8} onPress={() => setQuery('')}>
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
              label={item}
              onPress={() => setTag((current) => (current === item ? null : item))}
              selected={tag === item}
              testID={`event-vendors-tag-${item}`}
              tone="filled"
            />
          ))}
        </ScrollView>
      ) : null}

      <View style={styles.list}>
        {rows.map((vendor) => (
          <VendorRow key={vendor.id} onPress={select} selected={vendor.id === selectedId} vendor={vendor} />
        ))}
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

function VendorRow({
  vendor,
  selected,
  onPress,
}: {
  vendor: SpotlightEventMapVendor;
  selected: boolean;
  onPress: (vendor: SpotlightEventMapVendor) => void;
}) {
  const theme = useSpotlightTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={() => onPress(vendor)}
      style={[
        styles.row,
        { borderBottomColor: theme.colors.gray200 },
        selected ? [styles.rowSelected, { backgroundColor: theme.colors.purple50 }] : null,
      ]}
      testID={`event-vendor-${vendor.id}`}
    >
      <VendorAvatar size={ROW_AVATAR_SIZE} vendor={vendor} />
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}>
          {vendor.name}
        </Text>
        {vendor.tags.length > 0 ? (
          <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray500 }]}>
            {vendor.tags.join(' · ')}
          </Text>
        ) : null}
      </View>
      <Text style={[theme.typography.label, { color: theme.colors.gray700 }]}>{vendor.location}</Text>
    </Pressable>
  );
}

/** Compact, so it covers as little of the map it floats on as possible. */
function SelectedVendorCard({ vendor, onClose }: { vendor: SpotlightEventMapVendor; onClose: () => void }) {
  const theme = useSpotlightTheme();
  const instagram = vendor.instagram;
  const details = [`Booth ${vendor.location}`, ...vendor.tags].join(' · ');
  return (
    <SurfaceCard padding={spacing.xs} style={shadows.card} testID="event-vendor-card" variant="elevated">
      <View style={styles.cardHeader}>
        <VendorAvatar size={CARD_AVATAR_SIZE} vendor={vendor} />
        <View style={styles.rowText}>
          <Text numberOfLines={1} style={theme.typography.titleCompact} testID="event-vendor-card-name">
            {vendor.name}
          </Text>
          <Text numberOfLines={2} style={[theme.typography.label, { color: theme.colors.gray600 }]}>
            {details}
          </Text>
        </View>
        {instagram ? (
          <IconButton
            accessibilityLabel={`@${instagram} on Instagram`}
            onPress={() => void Linking.openURL(`https://instagram.com/${instagram}`).catch(() => undefined)}
            testID="event-vendor-card-instagram"
            variant="subtle"
          >
            <Instagram color={theme.colors.gray900} height={iconButtonDefaultGlyphSize} width={iconButtonDefaultGlyphSize} />
          </IconButton>
        ) : null}
        <IconButton accessibilityLabel="Close vendor" onPress={onClose} testID="event-vendor-card-close" variant="ghost">
          <Xmark color={theme.colors.gray600} height={ICON_SIZE} width={ICON_SIZE} />
        </IconButton>
      </View>
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.sm,
  },
  cardOverlay: {
    bottom: spacing.xs,
    left: spacing.xs,
    position: 'absolute',
    right: spacing.xs,
  },
  chips: {
    gap: spacing.xxs,
  },
  list: {
    gap: 0,
  },
  row: {
    alignItems: 'center',
    borderBottomWidth: borderWidths.rule,
    flexDirection: 'row',
    gap: spacing.xs,
    // Inset so the selected row's fill doesn't run flush to the text.
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
  },
  rowSelected: {
    borderBottomColor: 'transparent',
    borderCurve: 'continuous',
    borderRadius: radii.md,
  },
  rowText: {
    flex: 1,
    gap: spacing.xxxs,
  },
  cardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xxxs,
    marginTop: spacing.xs,
  },
  tag: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    paddingHorizontal: spacing.xxs,
    paddingVertical: spacing.xxxs,
  },
  instagram: {
    alignSelf: 'stretch',
    marginTop: spacing.xs,
  },
});
