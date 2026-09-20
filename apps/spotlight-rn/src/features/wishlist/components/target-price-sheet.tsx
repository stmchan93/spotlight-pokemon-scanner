import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CardFavoriteEntry } from '@spotlight/api-client';
import {
  Button,
  IconButton,
  SheetHeader,
  SurfaceCard,
  Text,
  TextField,
  radii,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { getCardImageSource } from '@/lib/card-images';
import { centsToCurrency, parseTargetPriceCents } from '@/features/wishlist/deal-radar';

/** What a submit did, so the sheet can say the right thing. */
export type TargetPriceSubmitResult = 'saved' | 'not_found' | 'error';

type TargetPriceSheetProps = {
  entry: CardFavoriteEntry | null;
  onClose: () => void;
  onSubmit: (targetPriceCents: number | null) => Promise<TargetPriceSubmitResult>;
};

function initialPriceText(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents) || cents <= 0) {
    return '';
  }
  return (cents / 100).toFixed(2);
}

/**
 * Set or clear the price you want to be told about for one watched card.
 *
 * An EMPTY field is the clear action, not an error — "stop telling me" needs to
 * be as cheap as "tell me", and a separate Clear button that only sometimes
 * applies is worse. The Clear button is there for discoverability and just
 * empties the field's intent.
 *
 * A 404 means the card is not on the watchlist any more (removed on another
 * device, or while this sheet was open). That is a real outcome with a plain
 * sentence, not a transport failure to dump on the user.
 */
export function TargetPriceSheet({ entry, onClose, onSubmit }: TargetPriceSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const [priceText, setPriceText] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const entryId = entry?.cardId ?? null;
  const currentTarget = entry?.targetPriceCents ?? null;

  // Re-seed whenever a different card opens the sheet.
  useEffect(() => {
    setPriceText(initialPriceText(currentTarget));
    setMessage(null);
    setPending(false);
  }, [currentTarget, entryId]);

  if (!entry) {
    return null;
  }

  const currencyCode = entry.currencyCode ?? 'USD';
  const marketLabel = entry.marketPrice != null
    ? centsToCurrency(Math.round(entry.marketPrice * 100), currencyCode)
    : null;

  const submit = async (rawText: string) => {
    const parsed = parseTargetPriceCents(rawText);
    if (parsed === undefined) {
      setMessage('Enter a price above zero, or clear the field to turn the target off.');
      return;
    }
    setPending(true);
    setMessage(null);
    const result = await onSubmit(parsed);
    setPending(false);
    if (result === 'saved') {
      onClose();
      return;
    }
    setMessage(
      result === 'not_found'
        ? `${entry.name} isn't on your watchlist any more, so there's nothing to set a target on.`
        : "Couldn't save that target. Try again in a moment.",
    );
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Math.max(insets.bottom, 12)}
        pointerEvents="box-none"
        style={styles.overlay}
      >
        <Pressable
          accessibilityLabel="Close target price"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
          testID="wishlist-target-sheet-backdrop"
        />

        <View
          pointerEvents="box-none"
          style={[styles.sheetWrap, { paddingBottom: Math.max(insets.bottom, 8) }]}
        >
          <SurfaceCard padding={18} radius={0} style={styles.sheet} testID="wishlist-target-sheet">
            <SheetHeader
              leadingAccessory={(
                <View
                  style={[
                    styles.art,
                    {
                      backgroundColor: theme.colors.field,
                      borderColor: theme.colors.outlineSubtle,
                    },
                  ]}
                >
                  <CachedImage
                    cachePolicy={imageCachePolicy.thumbnail}
                    contentFit="cover"
                    source={getCardImageSource(entry, 'small')}
                    style={StyleSheet.absoluteFill}
                  />
                </View>
              )}
              rightAccessory={(
                <IconButton
                  accessibilityLabel="Close target price"
                  onPress={onClose}
                  size={36}
                  testID="wishlist-target-sheet-close"
                >
                  <Text
                    style={[theme.typography.headline, styles.closeGlyph, { color: theme.colors.textPrimary }]}
                  >
                    ×
                  </Text>
                </IconButton>
              )}
              showHandle
              subtitle={entry.name}
              title="Target price"
              titleStyleVariant="title"
            />

            <View style={styles.content}>
              <TextField
                helperText={
                  marketLabel
                    ? `Tell me when it drops below this. Market is ${marketLabel}.`
                    : 'Tell me when it drops below this.'
                }
                keyboardType="decimal-pad"
                label="Target"
                onChangeText={setPriceText}
                placeholder="$0.00"
                testID="wishlist-target-input"
                value={priceText}
              />

              {message ? (
                <Text
                  style={[theme.typography.caption, { color: theme.colors.dangerStrong }]}
                  testID="wishlist-target-message"
                >
                  {message}
                </Text>
              ) : null}
            </View>

            <View style={styles.actions}>
              <Button
                disabled={pending}
                label="Save target"
                onPress={() => void submit(priceText)}
                size="lg"
                testID="wishlist-target-save"
              />
              <Button
                disabled={pending}
                label="Clear target"
                onPress={() => {
                  setPriceText('');
                  void submit('');
                }}
                size="lg"
                testID="wishlist-target-clear"
                variant="outline"
              />
            </View>
          </SurfaceCard>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: 10,
    marginTop: 20,
  },
  art: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    borderWidth: 1,
    height: 72,
    overflow: 'hidden',
    width: 52,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 15, 18, 0.32)',
  },
  closeGlyph: {
    lineHeight: 20,
  },
  content: {
    gap: 10,
    marginTop: 18,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  sheet: {
    marginBottom: 24,
    marginHorizontal: 16,
  },
  sheetWrap: {
    justifyContent: 'flex-end',
  },
});
