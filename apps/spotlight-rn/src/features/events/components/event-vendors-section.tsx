import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import type { GestureType, ScrollView as GestureScrollView } from 'react-native-gesture-handler';
import { useRouter } from 'expo-router';
import { FireFlame, Instagram, Search, Xmark } from 'iconoir-react-native';

import { isVendorsOnlyMap, type SpotlightEventMap, type SpotlightEventMapVendor } from '@spotlight/api-client';
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

import { recordBoothEvent, reportBoothClaim, type BoothClaim } from '@/features/events/booth-service';
import { BoothVendorPanel, useClaimBooth } from '@/features/events/components/booth-vendor-panel';
import { EventFloorMap } from '@/features/events/components/event-floor-map';
import { VendorLogo } from '@/features/events/components/vendor-logo';
import type { StoryRing } from '@/features/events/booth-stories';
import {
  filterVendors,
  floorMapViewportHeight,
  vendorForTable,
  vendorTableLabel,
} from '@/features/events/event-floor-map-model';
import type { BoothFloor } from '@/features/events/hooks/use-booth-floor';
import { useSpotlightEventMap } from '@/features/events/hooks/use-spotlight-event-map';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';

/** The server sends the chip set in display order (tools/build_event_floor_map.py FILTER_TAGS); this only guards a runaway list. */
const MAX_TAG_CHIPS = 20;
/** Map space the floating vendor card covers; a fitted vendor is centred above it. */
const CARD_OVERLAY_HEIGHT = 96;
/** Extra card height for the booth row, and for its photo strip. */
const BOOTH_ROW_HEIGHT = 60;
const BOOTH_STRIP_HEIGHT = 72;
/** The unfiltered list starts short; 180 rows in a non-virtualized page is a lot of layout. */
const COLLAPSED_ROWS = 25;
const ICON_SIZE = 16;
const HOT_ICON_SIZE = 16;
const INSTAGRAM_ICON_SIZE = 24;
// Figma 5882:12678 / 5865:11361 — 32pt plate with a 20pt logo in the row, 39/24 on the card.
const ROW_LOGO_SIZE = 32;
const CARD_LOGO_SIZE = 39;
// Figma 5882:12668 — rows 10 apart; the selected row's dark shell is 10 inside.
const LIST_GAP = 10;
const SELECTED_ROW_PADDING = 10;
/** A map-tapped vendor scrolls into view with this much page above its row. */
const SCROLL_INTO_VIEW_MARGIN = 120;

/** Select this vendor (a deep link, ticker or story tap); a new `key` re-applies the same vendor. */
export type VendorSelectRequest = { vendorId: string; key: number };

/** Booth stories on the list and card logos. */
export type VendorStories = {
  ringFor: (vendorId: string) => StoryRing;
  open: (vendorId: string, source: 'row' | 'card') => void;
};

type EventVendorsSectionProps = {
  eventId: string;
  floorMapUrl: string;
  /** Claims and booth posts for this show; absent = today's plain vendor card. */
  booth?: BoothFloor | null;
  selectRequest?: VendorSelectRequest | null;
  scrollGesture?: GestureType | React.RefObject<unknown>;
  /** The page's scroll view, so a vendor picked on the map can be scrolled into view. */
  scrollRef?: React.RefObject<GestureScrollView | null>;
  /** The section's title row, so it matches the screen's other sections. */
  renderTitle: (title: string) => React.ReactNode;
  stories?: VendorStories | null;
};

export function EventVendorsSection({
  eventId,
  floorMapUrl,
  booth,
  selectRequest,
  scrollGesture,
  scrollRef,
  renderTitle,
  stories,
}: EventVendorsSectionProps) {
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
  return (
    <EventVendorsBody
      booth={booth ?? null}
      eventId={eventId}
      map={map}
      renderTitle={renderTitle}
      scrollGesture={scrollGesture}
      scrollRef={scrollRef}
      selectRequest={selectRequest ?? null}
      stories={stories ?? null}
    />
  );
}

function EventVendorsBody({
  booth,
  eventId,
  map,
  renderTitle,
  scrollGesture,
  scrollRef,
  selectRequest,
  stories,
}: {
  booth: BoothFloor | null;
  eventId: string;
  map: SpotlightEventMap;
  selectRequest: VendorSelectRequest | null;
  stories: VendorStories | null;
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
  const mapRef = useRef<View>(null);
  const controlsRef = useRef<View>(null);
  // A deep link, ticker or story pick scrolls the map (not the row) into view.
  const [scrollToMap, setScrollToMap] = useState(false);
  // Claim mode: every unclaimed row gets a Claim pill until Done.
  const [claimMode, setClaimMode] = useState(false);
  const router = useRouter();
  const refreshClaims = booth?.refreshClaims;
  const onClaimsChanged = useCallback(() => refreshClaims?.(), [refreshClaims]);
  const { claim, gate, pendingId } = useClaimBooth(eventId, onClaimsChanged);

  // No tables assigned yet: no floor to draw, so the list carries everything and
  // a tapped vendor's card opens in place of its row.
  const vendorsOnly = isVendorsOnlyMap(map);
  const isFiltering = query.trim().length > 0 || tag != null;
  const matches = useMemo(() => filterVendors(map.vendors, query, tag), [map.vendors, query, tag]);
  const selected = useMemo(
    () => map.vendors.find((vendor) => vendor.id === selectedId) ?? null,
    [map.vendors, selectedId],
  );
  const selectedTableIds = useMemo(() => new Set(selected?.tableIds ?? []), [selected]);
  // One dot per vendor that posted in the last 24h, on their first table.
  const postedTableIds = useMemo(() => {
    const ids = new Set<string>();
    if (booth) {
      for (const vendor of map.vendors) {
        if (booth.freshVendorIds.has(vendor.id) && vendor.tableIds[0]) {
          ids.add(vendor.tableIds[0]);
        }
      }
    }
    return ids;
  }, [booth, map.vendors]);
  const hotTableIds = useMemo(() => {
    const ids = new Set<string>();
    if (booth) {
      for (const vendor of map.vendors) {
        if (booth.hotVendorIds.has(vendor.id)) {
          vendor.tableIds.forEach((id) => ids.add(id));
        }
      }
    }
    return ids;
  }, [booth, map.vendors]);
  // Treasure-email matches the user hasn't claimed yet (theirs already reads "Your booth").
  const suggestions = useMemo(() => {
    if (!booth || booth.hasMyBooth) {
      return [];
    }
    const ids = new Set(booth.suggestedVendorIds);
    return map.vendors.filter((vendor) => ids.has(vendor.id) && booth.claims.get(vendor.id)?.userId !== booth.myUserId);
  }, [booth, map.vendors]);
  const matchedTableIds = useMemo(
    () => (isFiltering ? new Set(matches.flatMap((vendor) => vendor.tableIds)) : new Set<string>()),
    [isFiltering, matches],
  );
  const chips = map.tags.slice(0, MAX_TAG_CHIPS);
  // Shown on each chip so it's clear how much a filter narrows the floor.
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const vendor of map.vendors) {
      for (const item of vendor.tags) {
        counts.set(item, (counts.get(item) ?? 0) + 1);
      }
    }
    return counts;
  }, [map.vendors]);
  const rows = isFiltering || expanded ? matches : matches.slice(0, COLLAPSED_ROWS);
  const selectedHasPhotos = Boolean(
    selected && booth?.postsByVendor.get(selected.id)?.some((post) => post.media.length > 0),
  );
  const cardOverlayHeight =
    CARD_OVERLAY_HEIGHT + (booth ? BOOTH_ROW_HEIGHT : 0) + (selectedHasPhotos ? BOOTH_STRIP_HEIGHT : 0);

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
    if (!selectRequest || !map.vendors.some((vendor) => vendor.id === selectRequest.vendorId)) {
      return;
    }
    if (vendorsOnly) {
      // The card lives in the list, so the row must exist to scroll to.
      if (!isFiltering && matches.findIndex((vendor) => vendor.id === selectRequest.vendorId) >= COLLAPSED_ROWS) {
        setExpanded(true);
      }
      setScrollToSelected(true);
    } else {
      setScrollToSelected(false);
      setScrollToMap(true);
    }
    setSelectedId(selectRequest.vendorId);
    // Only a new request re-selects; filtering afterwards must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map.vendors, selectRequest, vendorsOnly]);

  useEffect(() => {
    if (!scrollToMap || !scrollRef?.current) {
      return;
    }
    setScrollToMap(false);
    const scroll = scrollRef.current;
    const inner = scroll.getInnerViewNode?.();
    if (!inner) {
      return;
    }
    try {
      mapRef.current?.measureLayout(
        inner,
        (_x, y) => scroll.scrollTo({ y: Math.max(0, y - SCROLL_INTO_VIEW_MARGIN), animated: true }),
        () => undefined,
      );
    } catch {
      // Best effort, as for rows.
    }
  }, [scrollRef, scrollToMap]);

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

  // The search sits low on the page; bring it near the top so the keyboard opens below it.
  const scrollSearchIntoView = useCallback(() => {
    const scroll = scrollRef?.current;
    const inner = scroll?.getInnerViewNode?.();
    if (!scroll || !inner) {
      return;
    }
    try {
      controlsRef.current?.measureLayout(
        inner,
        (_x, y) => scroll.scrollTo({ y: Math.max(0, y - SCROLL_INTO_VIEW_MARGIN), animated: true }),
        () => undefined,
      );
    } catch {
      // Best effort, as for rows.
    }
  }, [scrollRef]);

  return (
    <View style={styles.section} testID="event-vendors">
      {renderTitle('Vendors')}
      {vendorsOnly ? (
        <View style={[styles.pendingNote, { backgroundColor: theme.colors.gray100 }]} testID="event-vendors-tables-pending">
          <Text style={[theme.typography.body, { color: theme.colors.gray700 }]}>Table assignments coming soon</Text>
        </View>
      ) : (
        <View ref={mapRef}>
          <EventFloorMap
            bottomInset={selected ? cardOverlayHeight : 0}
            focusKey={selected?.id ?? null}
            map={map}
            matchedTableIds={matchedTableIds}
            onBackgroundPress={deselect}
            onTablePress={handleTablePress}
            hotTableIds={hotTableIds}
            postedTableIds={postedTableIds}
            scrollGesture={scrollGesture}
            selectedTableIds={selectedTableIds}
          />
          {/* Docked inside the map (Figma 5865:11358): below it, a tapped table's vendor landed off-screen. */}
          {selected ? (
            <View pointerEvents="box-none" style={styles.cardOverlay}>
              <SelectedVendorCard booth={booth} eventId={eventId} onClose={deselect} stories={stories} vendor={selected} />
            </View>
          ) : null}
        </View>
      )}

      {/* Under the map: the map is the first thing you see; search and filters drive the list below. */}
      <View ref={controlsRef} style={styles.controls}>
        <SearchField
          accessibilityLabel="Search vendors"
          onFocus={scrollSearchIntoView}
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
                label={`${item.toUpperCase()} ${tagCounts.get(item) ?? 0}`}
                labelRole="caption"
                onPress={() => setTag((current) => (current === item ? null : item))}
                selected={tag === item}
                testID={`event-vendors-tag-${item}`}
                tone="filled"
              />
            ))}
          </ScrollView>
        ) : null}
      </View>

      {suggestions.map((vendor) => (
        <ThisIsYouCard
          claim={booth?.claims.get(vendor.id) ?? null}
          key={vendor.id}
          onClaim={gate(() => claim(vendor, 'suggestion'))}
          pending={pendingId === vendor.id}
          vendor={vendor}
        />
      ))}

      {booth && !booth.hasMyBooth ? (
        <View style={styles.claimModeBar}>
          {claimMode ? (
            <>
              <Text style={[theme.typography.caption, styles.grow, { color: theme.colors.gray600 }]}>
                Tap Claim on your booth
              </Text>
              <Pressable
                accessibilityRole="button"
                hitSlop={spacing.xxs}
                onPress={() => setClaimMode(false)}
                testID="event-vendors-claim-done"
              >
                <Text style={[theme.typography.label, { color: theme.colors.purple500 }]}>Done</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              hitSlop={spacing.xxs}
              onPress={() => setClaimMode(true)}
              testID="event-vendors-find-booth"
            >
              <Text style={[theme.typography.caption, { color: theme.colors.purple500 }]}>
                Tap here to claim your vendor booth
              </Text>
            </Pressable>
          )}
        </View>
      ) : null}

      <View style={styles.list}>
        {rows.map((vendor, index) => {
          const isSelected = vendor.id === selectedId;
          const next = rows[index + 1];
          // Hairlines sit between plain rows; the dark selected shell carries its own edges.
          const divider = next != null && !isSelected && next.id !== selectedId;
          return (
            <Fragment key={vendor.id}>
              {vendorsOnly && isSelected ? (
                <View ref={selectedRowRef}>
                  <SelectedVendorCard booth={booth} eventId={eventId} onClose={deselect} stories={stories} vendor={vendor} />
                </View>
              ) : (
                <VendorRow
                  booth={booth ? rowBoothState(booth.claims.get(vendor.id), booth.myUserId, claimMode && !booth.hasMyBooth) : null}
                  claimPending={pendingId === vendor.id}
                  hot={booth?.hotVendorIds.has(vendor.id) ?? false}
                  onClaim={gate(() => claim(vendor, 'list'))}
                  onPost={() =>
                    router.push(
                      `/new-post?eventId=${encodeURIComponent(eventId)}&vendorId=${encodeURIComponent(vendor.id)}` as never,
                    )
                  }
                  onPress={select}
                  ref={isSelected ? selectedRowRef : null}
                  selected={isSelected}
                  storyRing={stories?.ringFor(vendor.id) ?? null}
                  onOpenStory={stories ? () => stories.open(vendor.id, 'row') : undefined}
                  vendor={vendor}
                />
              )}
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

/** What a list row shows for its booth: nothing extra, a Claim pill, "Claimed", or the owner's actions. */
type RowBoothState = 'mine' | 'claimable' | 'claimed' | null;

function rowBoothState(claim: BoothClaim | undefined, myUserId: string | null, claimMode: boolean): RowBoothState {
  if (claim && myUserId && claim.userId === myUserId) {
    return 'mine';
  }
  if (!claimMode) {
    return null;
  }
  return claim ? 'claimed' : 'claimable';
}

type VendorRowProps = {
  vendor: SpotlightEventMapVendor;
  selected: boolean;
  onPress: (vendor: SpotlightEventMapVendor) => void;
  ref?: React.Ref<View>;
  hot?: boolean;
  booth?: RowBoothState;
  claimPending?: boolean;
  onClaim?: () => void;
  onPost?: () => void;
  storyRing?: StoryRing;
  onOpenStory?: () => void;
};

/** Figma 5882:12677; selected = 5865:10937 (gray-900 shell, white copy). */
function VendorRow({
  vendor,
  selected,
  onPress,
  ref,
  hot = false,
  booth = null,
  claimPending,
  onClaim,
  onPost,
  storyRing = null,
  onOpenStory,
}: VendorRowProps) {
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
      <VendorLogo onPress={storyRing ? onOpenStory : undefined} ring={storyRing} size={ROW_LOGO_SIZE} vendor={vendor} />
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
            style={[theme.typography.cardMeta, { color: selected ? theme.colors.gray400 : theme.colors.gray600 }]}
          >
            {vendor.tags.join(' · ').toUpperCase()}
          </Text>
        ) : null}
      </View>
      {hot ? (
        <View accessibilityLabel="Busy right now" accessible testID={`event-vendor-hot-${vendor.id}`}>
          <FireFlame color={theme.colors.eventAccent} height={HOT_ICON_SIZE} width={HOT_ICON_SIZE} />
        </View>
      ) : null}
      {booth === 'mine' ? (
        <>
          <Text
            style={[theme.typography.captionStrong, { color: selected ? theme.colors.gray0 : theme.colors.purple500 }]}
            testID={`event-vendor-mine-${vendor.id}`}
          >
            Your booth
          </Text>
          <Button
            label="Post"
            labelStyleVariant="label"
            onPress={onPost}
            shape="rounded"
            size="xs"
            testID={`event-vendor-post-${vendor.id}`}
            variant="primary"
          />
        </>
      ) : booth === 'claimable' ? (
        <Button
          disabled={claimPending}
          label="Claim"
          labelStyleVariant="label"
          onPress={onClaim}
          shape="rounded"
          size="xs"
          testID={`event-vendor-claim-${vendor.id}`}
          variant="secondary"
        />
      ) : booth === 'claimed' ? (
        <Text
          style={[theme.typography.caption, { color: selected ? theme.colors.gray400 : theme.colors.gray600 }]}
          testID={`event-vendor-claimed-${vendor.id}`}
        >
          Claimed
        </Text>
      ) : null}
      {vendor.location ? (
        <Text style={[theme.typography.captionStrong, { color: selected ? theme.colors.gray0 : theme.colors.gray900 }]}>
          {vendor.location}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * Pinned above the list when the signed-in email is this vendor's Treasure
 * email. Claimed by someone else, it offers a report instead.
 */
function ThisIsYouCard({
  vendor,
  claim,
  pending,
  onClaim,
}: {
  vendor: SpotlightEventMapVendor;
  claim: BoothClaim | null;
  pending: boolean;
  onClaim: () => void;
}) {
  const theme = useSpotlightTheme();
  const report = useCallback(() => {
    void reportBoothClaim(vendor.id).then((ok) => {
      Alert.alert(
        ok ? 'Thanks for letting us know' : 'Couldn’t send the report',
        ok ? 'We’ll check who this booth belongs to.' : 'Please try again.',
      );
    });
  }, [vendor.id]);
  return (
    <View style={[styles.youCard, { backgroundColor: theme.colors.gray100 }]} testID={`event-vendor-you-${vendor.id}`}>
      <VendorLogo size={ROW_LOGO_SIZE} vendor={vendor} />
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}>
          {`${vendor.name} · This is you`}
        </Text>
        <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray600 }]}>
          {claim ? `Claimed by ${claim.handle ? `@${claim.handle}` : 'another account'}` : 'Matched to your Treasure email'}
        </Text>
      </View>
      {claim ? (
        <Button
          label="Report"
          labelStyleVariant="label"
          onPress={report}
          shape="rounded"
          size="xs"
          testID={`event-vendor-you-report-${vendor.id}`}
          variant="secondary"
        />
      ) : (
        <Button
          disabled={pending}
          label="Claim booth"
          labelStyleVariant="label"
          onPress={onClaim}
          shape="rounded"
          size="xs"
          testID={`event-vendor-you-claim-${vendor.id}`}
          variant="primary"
        />
      )}
    </View>
  );
}

/** Figma 5865:11358 — the white card docked at the bottom of the map; booth actions sit under it. */
function SelectedVendorCard({
  booth,
  eventId,
  vendor,
  onClose,
  stories,
}: {
  booth: BoothFloor | null;
  eventId: string;
  vendor: SpotlightEventMapVendor;
  onClose: () => void;
  stories: VendorStories | null;
}) {
  const theme = useSpotlightTheme();
  const instagram = vendor.instagram;
  const claim = booth?.claims.get(vendor.id) ?? null;
  const mine = claim != null && claim.userId === booth?.myUserId;

  // The owner's own looks don't count toward their views.
  useEffect(() => {
    if (!booth || mine) {
      return;
    }
    recordBoothEvent(eventId, vendor.id, 'card_open');
    capturePostHogEvent(AnalyticsEvent.boothCardOpened, {
      event_id: eventId,
      vendor_id: vendor.id,
      claimed: claim != null,
    });
    // Once per opened vendor, not on every claims refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, vendor.id]);

  return (
    <View style={[styles.card, shadows.card, { backgroundColor: theme.colors.gray0 }]} testID="event-vendor-card">
      <View style={styles.cardHeader}>
        <VendorLogo
          onPress={stories ? () => stories.open(vendor.id, 'card') : undefined}
          ring={stories?.ringFor(vendor.id) ?? null}
          size={CARD_LOGO_SIZE}
          vendor={vendor}
        />
        <View style={styles.cardText}>
          <Text
            numberOfLines={1}
            style={[theme.typography.headline, { color: theme.colors.gray900 }]}
            testID="event-vendor-card-name"
          >
            {vendor.name}
          </Text>
          {vendor.tags.length > 0 ? (
            <Text numberOfLines={1} style={[theme.typography.cardMeta, { color: theme.colors.gray600 }]}>
              {vendor.tags.join(' · ').toUpperCase()}
            </Text>
          ) : null}
          <Text style={[theme.typography.label, { color: theme.colors.gray700 }]}>{vendorTableLabel(vendor.location)}</Text>
        </View>
        {instagram ? (
          <Pressable
            accessibilityLabel={`@${instagram} on Instagram`}
            accessibilityRole="link"
            hitSlop={spacing.xxs}
            onPress={() => {
              if (booth && !mine) {
                recordBoothEvent(eventId, vendor.id, 'instagram_tap');
              }
              void Linking.openURL(`https://instagram.com/${instagram}`).catch(() => undefined);
            }}
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
      {booth ? (
        <BoothVendorPanel
          canClaim={!booth.hasMyBooth}
          claim={claim}
          eventId={eventId}
          myUserId={booth.myUserId}
          onClaimsChanged={booth.refreshClaims}
          posts={booth.postsByVendor.get(vendor.id) ?? []}
          vendor={vendor}
        />
      ) : null}
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
  // Where the map goes once tables are assigned.
  pendingNote: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  cardOverlay: {
    bottom: spacing.xs,
    left: spacing.xs,
    position: 'absolute',
    right: spacing.xs,
  },
  // Figma 5865:11358 — 12 padding, 8 gap, radius 8.
  card: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    gap: spacing.xs,
    padding: spacing.xs,
  },
  cardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  cardText: {
    flex: 1,
    gap: spacing.xxxs,
  },
  list: {
    gap: LIST_GAP,
  },
  // Pixel-snapped: a raw 0.5pt rule alternated 1px/2px down the list.
  divider: {
    height: borderWidths.ruleSnapped,
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
  grow: {
    flex: 1,
  },
  claimModeBar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
    paddingHorizontal: spacing.xxs,
  },
  youCard: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    flexDirection: 'row',
    gap: spacing.xxs,
    padding: SELECTED_ROW_PADDING,
  },
});
