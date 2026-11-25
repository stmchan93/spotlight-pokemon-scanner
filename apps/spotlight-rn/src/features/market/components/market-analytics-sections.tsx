import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { NavArrowDown } from 'iconoir-react-native';

import {
  gameDisplayName,
  type CardGame,
  type MarketAnalytics,
  type MarketCardTile,
  type MarketWindow,
} from '@spotlight/api-client';
import {
  borderWidths,
  ListPaginationFooter,
  radii,
  SkeletonBlock,
  spacing,
  Text,
  textStyles,
  TrendTriangle,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

export const WINDOW_OPTIONS: readonly { label: string; value: MarketWindow }[] = [
  { label: '7D', value: '7d' },
  { label: '1M', value: '30d' },
  { label: '3M', value: '90d' },
  { label: '1Y', value: '1y' },
];

const ROW_THUMB_WIDTH = 46;
const ROW_THUMB_HEIGHT = 64;
const ICON_SIZE = 18;
const TRIANGLE_SIZE = 9;
const SKELETON_TITLE_HEIGHT = 14;
const SKELETON_TITLE_WIDTH = 160;
const SKELETON_TOGGLE_HEIGHT = 34;

function changeWords(changePct: number | null | undefined) {
  if (changePct == null) {
    return 'no change data';
  }
  return Math.abs(changePct) < 0.05 ? 'flat' : `${changePct > 0 ? 'up' : 'down'} ${Math.abs(changePct).toFixed(1)} percent`;
}

export function changeColor(theme: ReturnType<typeof useSpotlightTheme>, changePct: number | null | undefined) {
  if (changePct == null || Math.abs(changePct) < 0.05) {
    return theme.colors.gray600;
  }
  return changePct > 0 ? theme.colors.green500 : theme.colors.red500;
}

/** Window labels arrive lowercase ("past 30 days"); sentence-case them where they lead. */
export function capitalize(text: string) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

// --- chrome ------------------------------------------------------------------

/** Game name + chevron; opens the game sheet (the Insights header pattern). */
export function GamePickerButton({ game, onPress, testID }: { game: CardGame; onPress: () => void; testID: string }) {
  const theme = useSpotlightTheme();
  return (
    <Pressable
      accessibilityHint="Choose which game's market to show"
      accessibilityLabel={`Game: ${gameDisplayName(game)}`}
      accessibilityRole="button"
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.gamePicker, { opacity: pressed ? 0.6 : 1 }]}
      testID={testID}
    >
      <Text style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}>
        {gameDisplayName(game).toUpperCase()}
      </Text>
      <NavArrowDown color={theme.colors.gray900} height={ICON_SIZE} strokeWidth={2} width={ICON_SIZE} />
    </Pressable>
  );
}

/** 7D / 1M / 3M / 1Y — the Collection chart's range pills (Figma 5938:21789). */
export function WindowToggle({
  value,
  onChange,
  testID,
}: {
  value: MarketWindow;
  onChange: (value: MarketWindow) => void;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  return (
    <View accessibilityRole="tablist" style={styles.windowRow} testID={testID}>
      {WINDOW_OPTIONS.map((item) => {
        const selected = item.value === value;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={item.value}
            onPress={() => onChange(item.value)}
            style={({ pressed }) => [
              styles.windowPill,
              selected ? { backgroundColor: theme.colors.gray100 } : null,
              pressed ? { opacity: 0.88 } : null,
            ]}
            testID={`${testID}-${item.value}`}
          >
            <Text style={[styles.windowLabel, { color: selected ? theme.colors.gray900 : theme.colors.gray700 }]}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function MarketSectionTitle({
  title,
  caption,
  icon,
  testID,
}: {
  title: string;
  caption?: string | null;
  icon?: ReactNode;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.sectionTitle} testID={testID}>
      <View style={styles.sectionTitleRow}>
        <Text style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}>{title.toUpperCase()}</Text>
        {icon}
      </View>
      {caption ? (
        <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]}>{caption}</Text>
      ) : null}
    </View>
  );
}

export function SectionEmpty({ message, testID }: { message: string; testID: string }) {
  const theme = useSpotlightTheme();
  return (
    <Text style={[theme.typography.label, styles.gutter, { color: theme.colors.gray500 }]} testID={testID}>
      {message}
    </Text>
  );
}

export function SectionBand({ testID }: { testID?: string }) {
  const theme = useSpotlightTheme();
  return <View style={{ backgroundColor: theme.colors.gray50, height: borderWidths.sectionBand }} testID={testID} />;
}

function CardArt({ card, height, width }: { card: MarketCardTile; height: number; width: number }) {
  const theme = useSpotlightTheme();
  return (
    <View
      style={[
        styles.art,
        { backgroundColor: theme.colors.gray100, height, width },
      ]}
    >
      {card.imageUrl ? (
        <ExpoImage
          accessibilityIgnoresInvertColors
          cachePolicy="memory-disk"
          contentFit="cover"
          source={{ uri: card.imageUrl }}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </View>
  );
}

// --- card movers ---------------------------------------------------------------

export type MoverDirection = 'rising' | 'falling';

const MOVERS_PAGE = 5;

/** "38.4%" (the triangle carries the sign). */
function formatPctMagnitude(changePct: number) {
  const magnitude = Math.abs(changePct);
  return `${magnitude.toFixed(magnitude >= 100 ? 0 : 1)}%`;
}

/** "+$22" / "−$8"; cents only under a dollar so a $0.40 move isn't "+$0". */
export function formatSignedUsdShort(value: number) {
  const sign = value >= 0 ? '+' : '−';
  const magnitude = Math.abs(value);
  return magnitude < 1
    ? `${sign}${formatCurrency(magnitude)}`
    : `${sign}${formatCurrency(Math.round(magnitude)).replace(/\.00$/, '')}`;
}

function TrendValue({ value, label, testID }: { value: number; label: string; testID?: string }) {
  const theme = useSpotlightTheme();
  const color = changeColor(theme, value);
  return (
    <View style={styles.trendValue}>
      {Math.abs(value) >= 0.05 ? (
        <TrendTriangle color={color} direction={value > 0 ? 'up' : 'down'} size={TRIANGLE_SIZE} />
      ) : null}
      <Text style={[theme.typography.captionMedium, { color }]} testID={testID}>{label}</Text>
    </View>
  );
}

/** One tappable card row: art, name (+ number), a sub line, and a right column. */
function MoverRow({
  card,
  subline,
  right,
  accessibilityLabel,
  divider,
  onPress,
  testID,
}: {
  card: MarketCardTile;
  subline: string | null;
  right: ReactNode;
  accessibilityLabel: string;
  divider: boolean;
  onPress: () => void;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  return (
    <View>
      {divider ? <View style={[styles.divider, { backgroundColor: theme.colors.gray200 }]} /> : null}
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [styles.moverRow, { opacity: pressed ? 0.8 : 1 }]}
        testID={testID}
      >
        <CardArt card={card} height={ROW_THUMB_HEIGHT} width={ROW_THUMB_WIDTH} />
        <View style={styles.moverCopy}>
          <Text numberOfLines={1} style={[theme.typography.titleXsmall, { color: theme.colors.gray900 }]}>
            {card.name}
            {card.number ? (
              <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]}>{` #${card.number}`}</Text>
            ) : null}
          </Text>
          {subline ? (
            <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray600 }]}>{subline}</Text>
          ) : null}
        </View>
        <View style={styles.moverRight}>{right}</View>
      </Pressable>
    </View>
  );
}

/**
 * RISING or FALLING: 5 card rows, then "Show N more" for the rest of the 20
 * the backend stores. Renders nothing when the list is empty.
 */
export function CardMoversSection({
  data,
  direction,
  onPressCard,
  testID,
}: {
  data: MarketAnalytics;
  direction: MoverDirection;
  onPressCard: (card: MarketCardTile) => void;
  testID: string;
}) {
  const theme = useSpotlightTheme();
  const [expanded, setExpanded] = useState(false);
  const items = direction === 'rising' ? data.cardsRising : data.cardsFalling;
  if (items.length === 0) {
    return null;
  }
  const visible = expanded ? items : items.slice(0, MOVERS_PAGE);

  return (
    <>
      <SectionBand />
      <View style={styles.moverSection} testID={testID}>
        <MarketSectionTitle title={direction === 'rising' ? 'Rising' : 'Falling'} />
        <View style={styles.gutter} testID={`${testID}-list`}>
          {visible.map((item, index) => (
            <MoverRow
              accessibilityLabel={`${item.name}, ${formatCurrency(item.priceUsd)}, ${changeWords(item.changePct)}. Opens the card.`}
              card={item}
              divider={index > 0}
              key={`${item.cardId}|${item.variant ?? ''}`}
              onPress={() => onPressCard(item)}
              right={(
                <>
                  <Text style={[theme.typography.feedRowTitle, { color: theme.colors.gray900 }]}>
                    {formatCurrency(item.priceUsd)}
                  </Text>
                  <TrendValue
                    label={formatPctMagnitude(item.changePct)}
                    testID={`${testID}-${item.cardId}-change`}
                    value={item.changePct}
                  />
                </>
              )}
              subline={item.setName}
              testID={`${testID}-${item.cardId}`}
            />
          ))}
        </View>
        <ListPaginationFooter
          canViewMore={!expanded && items.length > MOVERS_PAGE}
          onViewMore={() => setExpanded(true)}
          testID={`${testID}-more`}
          viewMoreLabel={`Show ${items.length - MOVERS_PAGE} more`}
        />
      </View>
    </>
  );
}

/**
 * "YOUR CARDS THAT MOVED": the caller's top gainers then losers in this game,
 * by the holding's dollar move. Guests get one muted line; a signed-in
 * collection with no movers renders nothing.
 */
export function YourMoversSection({
  data,
  isGuest,
  onPressCard,
  testID,
}: {
  data: MarketAnalytics;
  isGuest: boolean;
  onPressCard: (card: MarketCardTile) => void;
  testID: string;
}) {
  const movers = data.yourMovers;
  if (!isGuest && movers == null) {
    return null;
  }
  const rows = movers ? [...movers.gainers, ...movers.losers] : [];
  return (
    <>
      <SectionBand />
      <View style={styles.moverSection} testID={testID}>
        <MarketSectionTitle title="Your cards that moved" />
        {isGuest || rows.length === 0 ? (
          <SectionEmpty message="Add cards to see what moved in your collection" testID={`${testID}-guest`} />
        ) : (
          <View style={styles.gutter}>
            {rows.map((item, index) => (
              <MoverRow
                accessibilityLabel={`${item.name}, you own ${item.quantity}, ${item.changeUsd >= 0 ? 'up' : 'down'} ${formatCurrency(Math.abs(item.changeUsd))}. Opens the card.`}
                card={item}
                divider={index > 0}
                key={`${item.cardId}|${item.variant ?? ''}|${index}`}
                onPress={() => onPressCard(item)}
                right={(
                  <TrendValue
                    label={formatSignedUsdShort(item.changeUsd)}
                    testID={`${testID}-${item.cardId}-change`}
                    value={item.changeUsd}
                  />
                )}
                subline={`You own ${item.quantity}`}
                testID={`${testID}-${item.cardId}`}
              />
            ))}
          </View>
        )}
      </View>
    </>
  );
}

// --- loading -----------------------------------------------------------------

export function MarketAnalyticsSkeleton({ testID }: { testID: string }) {
  return (
    <View style={styles.skeleton} testID={testID}>
      <View style={[styles.gutter, styles.skeletonStack]}>
        <SkeletonBlock height={SKELETON_TITLE_HEIGHT} width={SKELETON_TITLE_WIDTH} />
        <SkeletonBlock height={SKELETON_TOGGLE_HEIGHT} />
      </View>
      <View style={[styles.gutter, styles.skeletonStack]}>
        {[0, 1, 2, 3, 4].map((key) => (
          <SkeletonBlock height={ROW_THUMB_HEIGHT} key={key} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  art: {
    borderCurve: 'continuous',
    borderRadius: radii.xs,
    overflow: 'hidden',
  },
  divider: {
    height: borderWidths.ruleSnapped,
  },
  gamePicker: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
  gutter: {
    paddingHorizontal: spacing.sm,
  },
  moverCopy: {
    flex: 1,
    gap: spacing.xxxs,
    minWidth: 0,
  },
  moverRight: {
    alignItems: 'flex-end',
    gap: spacing.xxxs,
  },
  moverRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  moverSection: {
    gap: spacing.xs,
    paddingVertical: spacing.lg,
  },
  sectionTitle: {
    gap: spacing.xxxs,
    paddingHorizontal: spacing.sm,
  },
  sectionTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
  skeleton: {
    gap: spacing.lg,
    paddingTop: spacing.sm,
  },
  skeletonStack: {
    gap: spacing.xs,
  },
  trendValue: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
  windowLabel: {
    ...textStyles.label,
    textAlign: 'center',
  },
  windowPill: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xxxs,
  },
  windowRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
});
