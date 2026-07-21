import { StyleSheet, View } from 'react-native';
import { Eye, EyeClosed } from 'iconoir-react-native';
import Svg, { Path } from 'react-native-svg';

import type { PortfolioSummary } from '@spotlight/api-client';
import {
  IconButton,
  RollingNumberText,
  Text,
  colors,
  fontFamilies,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { formatCurrency } from './portfolio-formatting';
import type { PortfolioChartActivePoint } from './portfolio-chart-card';

const hiddenValueMask = '*****';

type PortfolioBalanceHeaderProps = {
  summary: PortfolioSummary;
  activeChartPoint: PortfolioChartActivePoint | null;
  isSummaryHidden: boolean;
  onToggleHidden: () => void;
  testIDPrefix?: string;
};

type ChangeDirection = 'up' | 'down' | 'flat';

function directionFromValue(value: number): ChangeDirection {
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'flat';
}

function formatUnsignedPercent(value: number) {
  return `${Math.abs(value).toFixed(2)}%`;
}

export function PortfolioBalanceHeader({
  summary,
  activeChartPoint,
  isSummaryHidden,
  onToggleHidden,
  testIDPrefix = 'portfolio',
}: PortfolioBalanceHeaderProps) {
  const theme = useSpotlightTheme();

  const rawValueLabel = activeChartPoint?.valueLabel ?? formatCurrency(summary.currentValue);
  const valueLabel = isSummaryHidden ? hiddenValueMask : rawValueLabel;

  // Per Figma the resting delta row omits the date; the label only appears
  // while scrubbing the chart to show which point you're inspecting.
  const scrubDateLabel = activeChartPoint?.dateLabel ?? null;

  const changeAmount = activeChartPoint?.changeAmount ?? summary.changeAmount;
  const changePercent = activeChartPoint?.changePercent ?? summary.changePercent;
  const direction = directionFromValue(changeAmount);

  const amountLabel = isSummaryHidden
    ? hiddenValueMask
    : formatCurrency(Math.abs(changeAmount));
  const percentLabel = isSummaryHidden
    ? hiddenValueMask
    : formatUnsignedPercent(changePercent);

  const changeColor =
    direction === 'down'
      ? theme.colors.red400
      : theme.colors.green400;

  return (
    <View
      style={[styles.block, { paddingHorizontal: theme.layout.pageGutter }]}
      testID={`${testIDPrefix}-balance-header`}
    >
      <View style={styles.topGroup}>
        <Text style={styles.portfolioLabel} testID={`${testIDPrefix}-balance-label`}>
          Portfolio
        </Text>
        <View style={styles.valueRow}>
          <RollingNumberText
            style={[styles.value, { color: theme.colors.gray900 }]}
            testID={`${testIDPrefix}-summary-value`}
            value={valueLabel}
          />
          <IconButton
            accessibilityLabel={isSummaryHidden ? 'Show portfolio value' : 'Hide portfolio value'}
            onPress={onToggleHidden}
            shape="circle"
            size={32}
            testID={`${testIDPrefix}-summary-visibility-toggle`}
            variant="subtle"
          >
            {isSummaryHidden ? (
              <EyeClosed color={theme.colors.gray600} height={18} width={18} />
            ) : (
              <Eye color={theme.colors.gray600} height={18} width={18} />
            )}
          </IconButton>
        </View>
      </View>

      <View style={styles.changeRow}>
        <View style={styles.changeIndicator} testID={`${testIDPrefix}-summary-delta`}>
          <ChangeDirectionIcon direction={direction} color={changeColor} />
          <Text style={[styles.changeText, { color: changeColor }]}>
            {amountLabel}
          </Text>
        </View>
        <View style={styles.percentGroup}>
          <Text style={[styles.changeText, { color: changeColor }]}>({percentLabel})</Text>
        </View>
        {scrubDateLabel ? (
          <Text
            style={[styles.dateText, { color: theme.colors.gray600 }]}
            testID={`${testIDPrefix}-summary-delta-date`}
          >
            {scrubDateLabel}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function ChangeDirectionIcon({
  direction,
  color,
}: {
  direction: ChangeDirection;
  color: string;
}) {
  // Filled triangle per Figma 2489:6757 (7px) — points up for 'up'/'flat'
  // (no zero-state icon spec) and is flipped 180° for 'down'. Path taken
  // verbatim from the Figma export so the shape matches exactly.
  return (
    <Svg
      height={7}
      style={direction === 'down' ? styles.changeIconDown : undefined}
      viewBox="0 0 7 7"
      width={7}
    >
      <Path
        d="M0.729395 5.83333L3.50023 0.875L6.27106 5.83333H0.729395Z"
        fill={color}
        stroke={color}
        strokeLinejoin="round"
        strokeWidth={0.291667}
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 8,
  },
  topGroup: {
    gap: 4,
  },
  portfolioLabel: {
    color: colors.gray500,
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 12,
    lineHeight: 14,
  },
  valueRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  value: {
    flexShrink: 1,
    fontFamily: fontFamilies.bodyBold,
    fontSize: 28,
    lineHeight: 33.6,
  },
  changeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  changeIndicator: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
  },
  changeIconDown: {
    transform: [{ rotate: '180deg' }],
  },
  percentGroup: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  changeText: {
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 14,
    lineHeight: 21,
  },
  // The scrub date stays visually secondary (the Figma frame doesn't include
  // it — kept for scrub UX at the pre-redesign weight).
  dateText: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 12,
    lineHeight: 16.8,
  },
});
