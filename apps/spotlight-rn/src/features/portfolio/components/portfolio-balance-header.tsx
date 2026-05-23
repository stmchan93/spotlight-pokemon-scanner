import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Eye, EyeClosed, Minus, Plus } from 'iconoir-react-native';

import type { PortfolioSummary } from '@spotlight/api-client';
import {
  RollingNumberText,
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

  const dateLabel = activeChartPoint?.dateLabel ?? 'Today';

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
          <Pressable
            accessibilityLabel={isSummaryHidden ? 'Show portfolio value' : 'Hide portfolio value'}
            accessibilityRole="button"
            hitSlop={8}
            onPress={onToggleHidden}
            style={styles.visibilityButton}
            testID={`${testIDPrefix}-summary-visibility-toggle`}
          >
            {isSummaryHidden ? (
              <EyeClosed color={theme.colors.gray600} height={20} width={20} />
            ) : (
              <Eye color={theme.colors.gray600} height={20} width={20} />
            )}
          </Pressable>
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
          <Text style={[styles.changeText, { color: changeColor }]}>(</Text>
          <ChangeDirectionIcon direction={direction} color={changeColor} />
          <Text style={[styles.changeText, { color: changeColor }]}>{percentLabel}</Text>
          <Text style={[styles.changeText, { color: changeColor }]}>)</Text>
        </View>
        <Text
          style={[styles.changeText, { color: theme.colors.gray600 }]}
          testID={`${testIDPrefix}-summary-delta-date`}
        >
          {dateLabel}
        </Text>
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
  if (direction === 'down') {
    return <Minus color={color} height={12} width={12} />;
  }
  // 'up' and 'flat' both render Plus per Figma (no zero-state icon spec).
  return <Plus color={color} height={12} width={12} />;
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
  visibilityButton: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 2,
  },
  changeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  changeIndicator: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  percentGroup: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  changeText: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 12,
    lineHeight: 16.8,
  },
});
