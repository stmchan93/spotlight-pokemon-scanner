import { useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Button,
  colors,
  fontFamilies,
  IconButton,
  PillButton,
  ScreenHeader,
  SearchField,
  SegmentedControl,
  SectionHeader,
  SheetHeader,
  spacing,
  StateCard,
  SurfaceCard,
  TextField,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';

type DesignSystemCatalogScreenProps = {
  onBack: () => void;
};

const colorEntries = Object.entries(colors);
const spacingEntries = Object.entries(spacing);
const fontEntries = Object.entries(fontFamilies);

export function DesignSystemCatalogScreen({
  onBack,
}: DesignSystemCatalogScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const [segmentValue, setSegmentValue] = useState<'portfolio' | 'scan'>('portfolio');

  const typographySamples = useMemo(() => {
    return [
      { key: 'display', label: 'Display', style: theme.typography.display, sample: 'Design System' },
      { key: 'title', label: 'Title', style: theme.typography.title, sample: 'Shared Primitive' },
      { key: 'titleCompact', label: 'Title Compact', style: theme.typography.titleCompact, sample: 'Compact Title' },
      { key: 'headline', label: 'Headline', style: theme.typography.headline, sample: 'Headline Sample' },
      { key: 'body', label: 'Body', style: theme.typography.body, sample: 'Body copy for supporting information.' },
      { key: 'bodyStrong', label: 'Body Strong', style: theme.typography.bodyStrong, sample: 'Strong supporting copy.' },
      { key: 'control', label: 'Control', style: theme.typography.control, sample: 'Interactive Label' },
      { key: 'caption', label: 'Caption', style: theme.typography.caption, sample: 'Secondary caption style.' },
      { key: 'micro', label: 'Micro', style: theme.typography.micro, sample: 'META LABEL' },
    ];
  }, [theme]);

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: theme.colors.canvas }]}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingBottom: insets.bottom + 40,
            paddingHorizontal: theme.layout.pageGutter,
            paddingTop: theme.layout.pageTopInset,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <ScreenHeader
          eyebrow="CLAUDE DESIGN"
          leftAccessory={<ChromeBackButton onPress={onBack} testID="design-system-back" />}
          subtitle="Live catalog for RN tokens and shared primitives. Use this as the visual reference surface when modifying the design system."
          title="Design System"
        />

        <SurfaceCard padding={20} radius={24}>
          <SectionHeader
            subtitle="Typography roles should be reused instead of rebuilt with local font overrides."
            title="Typography"
          />
          <View style={styles.sampleStack}>
            {typographySamples.map((sample) => (
              <View key={sample.key} style={styles.typographyRow}>
                <Text style={[theme.typography.micro, styles.typographyLabel]}>{sample.label}</Text>
                <Text style={sample.style}>{sample.sample}</Text>
              </View>
            ))}
          </View>
        </SurfaceCard>

        <SurfaceCard padding={20} radius={24}>
          <SectionHeader
            subtitle="Named tokens are easier for Claude to modify safely than repeated hard-coded values."
            title="Tokens"
          />

          <View style={styles.tokenSection}>
            <Text style={theme.typography.headline}>Colors</Text>
            <View style={styles.tokenGrid}>
              {colorEntries.map(([key, value]) => (
                <View key={key} style={styles.tokenCard}>
                  <View style={[styles.colorSwatch, { backgroundColor: value }]} />
                  <Text style={theme.typography.caption}>{key}</Text>
                  <Text style={[theme.typography.micro, styles.tokenValue]}>{value}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.tokenSection}>
            <Text style={theme.typography.headline}>Spacing</Text>
            <View style={styles.metaList}>
              {spacingEntries.map(([key, value]) => (
                <View key={key} style={styles.metaRow}>
                  <Text style={theme.typography.bodyStrong}>{key}</Text>
                  <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>{value}px</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.tokenSection}>
            <Text style={theme.typography.headline}>Font Families</Text>
            <View style={styles.metaList}>
              {fontEntries.map(([key, value]) => (
                <View key={key} style={styles.metaRow}>
                  <Text style={theme.typography.bodyStrong}>{key}</Text>
                  <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>{value}</Text>
                </View>
              ))}
            </View>
          </View>
        </SurfaceCard>

        <SurfaceCard padding={20} radius={24}>
          <SectionHeader
            subtitle="These are the primitives Claude should prefer before patching individual screens."
            title="Primitives"
          />

          <View style={styles.primitiveStack}>
            <View style={styles.buttonRow}>
              <Button label="Primary" testID="catalog-button-primary" variant="primary" />
              <Button label="Secondary" testID="catalog-button-secondary" variant="secondary" />
              <Button label="Ghost" testID="catalog-button-ghost" variant="ghost" />
            </View>

            <Button
              label="Marketplace"
              testID="catalog-button-accessory"
              trailingAccessory={<Text style={theme.typography.micro}>ICON</Text>}
              variant="secondary"
            />

            <View style={styles.iconRow}>
              <IconButton accessibilityLabel="Back sample" testID="catalog-icon-button">
                <Text style={theme.typography.titleCompact}>‹</Text>
              </IconButton>
              <PillButton label="Pill Button" selected testID="catalog-pill-button" />
            </View>

            <SearchField
              placeholder="Search by name, set, or number"
              testID="catalog-search-field"
              value=""
            />

            <TextField
              helperText="Shared form field shell"
              label="Sold Price"
              placeholder="$0.00"
              testID="catalog-text-field"
              value=""
            />

            <SegmentedControl
              items={[
                { label: 'Portfolio', value: 'portfolio' },
                { label: 'Scan', value: 'scan' },
              ]}
              onChange={setSegmentValue}
              testID="catalog-segmented-control"
              value={segmentValue}
            />

            <View style={styles.scannerSegmentWrap}>
              <SegmentedControl
                items={[
                  { label: 'RAW', value: 'portfolio' },
                  { label: 'SLABS', value: 'scan' },
                ]}
                onChange={setSegmentValue}
                size="lg"
                testID="catalog-segmented-control-inverted"
                tone="inverted"
                value={segmentValue}
              />
            </View>

            <SectionHeader
              actionLabel="View all"
              countText="(12)"
              expanded
              onActionPress={() => {}}
              onPress={() => {}}
              subtitle="Shared section header with count, action, and expansion affordance."
              title="Inventory"
            />

            <StateCard
              actionLabel="Retry"
              actionTestID="catalog-state-card-action"
              message="This is the standard retry and empty-state treatment."
              onActionPress={() => {}}
              title="Search unavailable"
            />

            <SurfaceCard padding={18} radius={22} variant="field">
              <SheetHeader
                align="center"
                leadingAccessory={(
                  <Button
                    label="Close"
                    size="sm"
                    variant="secondary"
                  />
                )}
                rightAccessory={<View style={styles.headerSpacer} />}
                title="Import Review"
              />
            </SurfaceCard>
          </View>
        </SurfaceCard>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  colorSwatch: {
    borderRadius: 14,
    height: 52,
    width: '100%',
  },
  content: {
    gap: 16,
  },
  iconRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  headerSpacer: {
    width: 40,
  },
  metaList: {
    gap: 10,
  },
  metaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  primitiveStack: {
    gap: 18,
    marginTop: 18,
  },
  safeArea: {
    flex: 1,
  },
  sampleStack: {
    gap: 16,
    marginTop: 18,
  },
  scannerSegmentWrap: {
    backgroundColor: '#050505',
    borderRadius: 24,
    padding: 16,
  },
  tokenCard: {
    gap: 8,
    width: '48%',
  },
  tokenGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'space-between',
  },
  tokenSection: {
    gap: 12,
    marginTop: 18,
  },
  tokenValue: {
    color: '#4D4F57',
  },
  typographyLabel: {
    marginBottom: 6,
  },
  typographyRow: {
    gap: 4,
  },
});
