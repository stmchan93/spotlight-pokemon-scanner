import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CardFavoriteEntry } from '@spotlight/api-client';
import {
  Button,
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
  /**
   * `afterWatch` is the prompt shown right after a card is watched: the
   * secondary action dismisses instead of clearing.
   */
  mode?: 'edit' | 'afterWatch';
};

const SCREEN_HEIGHT = Dimensions.get('window').height;

function initialPriceText(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents) || cents <= 0) {
    return '';
  }
  return (cents / 100).toFixed(2);
}

/**
 * Set or clear the price you want to be told about for one watched card.
 * Same bottom-sheet system as ConfirmDeleteSheet / AddToCollectionSheet: spring
 * in, handle + centered title as the drag-to-dismiss zone, rounded md actions.
 *
 * An EMPTY field is the clear action, not an error. A 404 means the card left
 * the watchlist (another device, or while this sheet was open) and gets a plain
 * sentence rather than a transport error.
 */
export function TargetPriceSheet({ entry, onClose, onSubmit, mode = 'edit' }: TargetPriceSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const [priceText, setPriceText] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const visible = entry !== null;
  // Keep drawing the last entry through the slide-down after `entry` clears.
  const [shownEntry, setShownEntry] = useState<CardFavoriteEntry | null>(entry);
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;

  const entryId = entry?.cardId ?? null;
  const currentTarget = entry?.targetPriceCents ?? null;

  useEffect(() => {
    setPriceText(initialPriceText(currentTarget));
    setMessage(null);
    setPending(false);
  }, [currentTarget, entryId]);

  useEffect(() => {
    if (entry) {
      setShownEntry(entry);
    }
  }, [entry]);

  useEffect(() => {
    if (visible) {
      const animation = Animated.spring(translateY, {
        toValue: 0,
        damping: 34,
        mass: 1,
        stiffness: 320,
        useNativeDriver: false,
      });
      animation.start();
      return () => animation.stop();
    }
    const animation = Animated.timing(translateY, {
      toValue: SCREEN_HEIGHT,
      duration: 200,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start(({ finished }) => {
      if (finished) {
        setShownEntry(null);
      }
    });
    return () => animation.stop();
  }, [translateY, visible]);

  const dragResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          gesture.dy > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_event, gesture) => {
          translateY.setValue(Math.max(0, gesture.dy));
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > 80 || gesture.vy > 0.5) {
            onClose();
            return;
          }
          Animated.spring(translateY, {
            toValue: 0,
            damping: 34,
            mass: 1,
            stiffness: 320,
            useNativeDriver: false,
          }).start();
        },
      }),
    [onClose, translateY],
  );

  const sheetEntry = entry ?? shownEntry;
  if (!sheetEntry) {
    return null;
  }

  const afterWatch = mode === 'afterWatch';
  const currencyCode = sheetEntry.currencyCode ?? 'USD';
  const marketLabel = sheetEntry.marketPrice != null
    ? centsToCurrency(Math.round(sheetEntry.marketPrice * 100), currencyCode)
    : null;

  const submit = async (rawText: string) => {
    const parsed = parseTargetPriceCents(rawText);
    if (afterWatch && parsed === null) {
      onClose();
      return;
    }
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
        ? `${sheetEntry.name} isn't on your watchlist any more, so there's nothing to set a target on.`
        : "Couldn't save that target. Try again in a moment.",
    );
  };

  return (
    <Modal
      animationType="none"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        pointerEvents={visible ? 'auto' : 'none'}
        style={styles.root}
      >
        <Pressable
          accessibilityLabel="Close target price"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
          testID="wishlist-target-sheet-backdrop"
        />
        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: theme.colors.gray0,
              paddingBottom: Math.max(insets.bottom, 16) + 8,
              transform: [{ translateY }],
            },
          ]}
          testID={visible ? 'wishlist-target-sheet' : undefined}
        >
          <View style={styles.header} {...dragResponder.panHandlers}>
            <Pressable
              accessibilityLabel="Close target price"
              accessibilityRole="button"
              hitSlop={16}
              onPress={onClose}
              style={styles.handleHit}
              testID="wishlist-target-sheet-handle"
            >
              <View style={[styles.handleBar, { backgroundColor: theme.colors.gray200 }]} />
            </Pressable>
            <Text style={[theme.typography.bodyMedium, styles.title, { color: theme.colors.gray600 }]}>
              {afterWatch ? 'Set a target price?' : 'Target price'}
            </Text>
          </View>

          <View style={styles.body}>
            <View style={styles.cardRow}>
              <View
                style={[
                  styles.art,
                  { backgroundColor: theme.colors.gray50, borderColor: theme.colors.gray200 },
                ]}
              >
                <CachedImage
                  cachePolicy={imageCachePolicy.thumbnail}
                  contentFit="cover"
                  source={getCardImageSource(sheetEntry, 'small')}
                  style={StyleSheet.absoluteFill}
                />
              </View>
              <View style={styles.cardText}>
                <Text numberOfLines={2} style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}>
                  {sheetEntry.name}
                </Text>
                {marketLabel ? (
                  <Text style={[theme.typography.label, { color: theme.colors.gray600 }]}>
                    {`Market ${marketLabel}`}
                  </Text>
                ) : null}
              </View>
            </View>

            <TextField
              helperText="We'll notify you when a listing drops below this price."
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
              label={afterWatch ? 'Set target' : 'Save target'}
              labelStyleVariant="label"
              onPress={() => void submit(priceText)}
              shape="rounded"
              size="md"
              testID="wishlist-target-save"
              variant="dark"
            />
            {afterWatch ? (
              <Button
                disabled={pending}
                label="Not now"
                labelStyleVariant="label"
                onPress={onClose}
                shape="rounded"
                size="md"
                testID="wishlist-target-skip"
                variant="outline"
              />
            ) : (
              <Button
                disabled={pending}
                label="Clear target"
                labelStyleVariant="label"
                onPress={() => {
                  setPriceText('');
                  void submit('');
                }}
                shape="rounded"
                size="md"
                testID="wishlist-target-clear"
                variant="outline"
              />
            )}
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 24,
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
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  body: {
    gap: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  cardRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  cardText: {
    flex: 1,
    gap: 4,
  },
  handleBar: {
    borderCurve: 'continuous',
    borderRadius: 2,
    height: 4,
    width: 36,
  },
  handleHit: {
    alignItems: 'center',
    paddingBottom: 6,
    paddingTop: 4,
  },
  header: {
    width: '100%',
  },
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderCurve: 'continuous',
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    paddingTop: 10,
  },
  title: {
    paddingBottom: 4,
    paddingHorizontal: 16,
    paddingTop: 18,
    textAlign: 'center',
  },
});
