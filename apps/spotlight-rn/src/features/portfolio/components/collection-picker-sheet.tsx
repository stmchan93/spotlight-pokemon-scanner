import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  Keyboard,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  type TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, NavArrowLeft, NavArrowRight, ViewGrid } from 'iconoir-react-native';

import { ALL_COLLECTIONS_ID, type Collection } from '@spotlight/api-client';
import { SheetHeader, Text, TextField, colors, textStyles } from '@spotlight/design-system';

/** Figma 3377:3089 — every collection row is 57pt with a 0.5pt rule beneath. */
const ROW_HEIGHT = 57;
/** Leading glyphs (view-grid, chevron) are 20pt. */
const ROW_ICON_SIZE = 20;
const SCREEN_HEIGHT = Dimensions.get('window').height;
/** Drag distance past which releasing dismisses instead of springing back. */
const DISMISS_DRAG_DISTANCE = 80;
const DISMISS_DRAG_VELOCITY = 0.5;
/** Mirrors the backend cap so the field can't accept a name the server truncates. */
const NAME_MAX_LENGTH = 60;

type CollectionPickerStep = 'list' | 'create';

type CollectionPickerSheetProps = {
  visible: boolean;
  onClose: () => void;
  collections: Collection[];
  /** Totals for the "All Collection" row — the server's un-scoped figures. */
  allTotals: { cardCount: number; totalValue: number };
  /** Active collection id, or ALL_COLLECTIONS_ID when the aggregate is shown. */
  activeCollectionID: string;
  onSelectCollection: (collectionID: string) => void;
  /** Resolves once the collection exists; the sheet then closes and switches to it. */
  onCreateCollection: (name: string) => Promise<void>;
  /** Formats a collection's market value for display (owner's masking applies). */
  formatValue: (value: number) => string;
  loading?: boolean;
  testID?: string;
};

/**
 * The collection picker (Figma 3377:3154). One bottom sheet, two steps:
 *
 *   list   — "All Collection" plus one row per collection; ADD opens the form
 *   create — name the collection, CREATE makes it and switches to it
 *
 * v1 is create + switch, so the design's per-row rename/hide/delete icons and
 * drag handles are deliberately NOT rendered: shipping controls that do nothing
 * is worse than shipping fewer of them (same call as the comment sheet's
 * unbacked emoji reactions).
 */
export function CollectionPickerSheet({
  visible,
  onClose,
  collections,
  allTotals,
  activeCollectionID,
  onSelectCollection,
  onCreateCollection,
  formatValue,
  loading = false,
  testID = 'collection-picker-sheet',
}: CollectionPickerSheetProps) {
  const insets = useSafeAreaInsets();

  const [isRendered, setIsRendered] = useState(visible);
  const [step, setStep] = useState<CollectionPickerStep>('list');
  const [draftName, setDraftName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const inputRef = useRef<TextInput | null>(null);

  // Every open starts on the list with a clean form — a half-typed name from a
  // previous open reappearing under a "New Collection" title reads as a bug.
  useEffect(() => {
    if (visible) {
      setStep('list');
      setDraftName('');
      setCreateError(null);
      setCreating(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) {
      setKeyboardHeight(0);
      return;
    }
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (event) => {
      setKeyboardHeight(event.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [visible]);

  // The form is the whole point of the create step, so open the keyboard on it.
  useEffect(() => {
    if (!visible || step !== 'create') {
      return;
    }
    const timer = setTimeout(() => inputRef.current?.focus(), 250);
    return () => clearTimeout(timer);
  }, [step, visible]);

  useEffect(() => {
    if (visible) {
      setIsRendered(true);
      translateY.setValue(SCREEN_HEIGHT);
      const animation = Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          damping: 30,
          mass: 1,
          stiffness: 210,
          useNativeDriver: false,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 240,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }),
      ]);
      animation.start();
      return () => animation.stop();
    }

    const animation = Animated.parallel([
      Animated.timing(translateY, {
        toValue: SCREEN_HEIGHT,
        duration: 220,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: false,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 200,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: false,
      }),
    ]);
    animation.start(({ finished }) => {
      if (finished) {
        setIsRendered(false);
      }
    });
    return () => animation.stop();
  }, [backdropOpacity, translateY, visible]);

  const dragResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          gesture.dy > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderGrant: () => {
          Keyboard.dismiss();
        },
        onPanResponderMove: (_event, gesture) => {
          translateY.setValue(Math.max(0, gesture.dy));
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > DISMISS_DRAG_DISTANCE || gesture.vy > DISMISS_DRAG_VELOCITY) {
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

  const handleSelect = useCallback(
    (collectionID: string) => {
      onSelectCollection(collectionID);
      onClose();
    },
    [onClose, onSelectCollection],
  );

  const trimmedName = draftName.trim();
  const canCreate = trimmedName.length > 0 && !creating;

  const handleCreate = useCallback(() => {
    if (!canCreate) {
      return;
    }
    setCreating(true);
    setCreateError(null);
    void (async () => {
      try {
        await onCreateCollection(trimmedName);
        onClose();
      } catch {
        // Keep the sheet open with the typed name intact so the author can
        // retry — losing what they typed is the worst possible failure here.
        setCreateError('Could not create that collection. Try again.');
      } finally {
        setCreating(false);
      }
    })();
  }, [canCreate, onClose, onCreateCollection, trimmedName]);

  const handleBack = useCallback(() => {
    if (step === 'create') {
      setStep('list');
      Keyboard.dismiss();
      return;
    }
    onClose();
  }, [onClose, step]);

  if (!isRendered) {
    return null;
  }

  const renderRow = (options: {
    key: string;
    title: string;
    valueLabel: string;
    onPress: () => void;
    leadingIcon?: React.ReactNode;
    trailingIcon?: React.ReactNode;
    isFirst?: boolean;
    testID: string;
  }) => (
    <Pressable
      accessibilityLabel={`${options.title}, ${options.valueLabel}`}
      accessibilityRole="button"
      key={options.key}
      onPress={options.onPress}
      style={({ pressed }) => [
        styles.row,
        options.isFirst ? styles.rowFirst : null,
        pressed ? styles.rowPressed : null,
      ]}
      testID={options.testID}
    >
      <View style={styles.rowLeading}>
        {options.leadingIcon ?? <View style={styles.rowIconSpacer} />}
        <View style={styles.rowCopy}>
          <Text numberOfLines={1} style={styles.rowTitle}>
            {options.title}
          </Text>
          <Text style={styles.rowValue}>{options.valueLabel}</Text>
        </View>
      </View>
      {options.trailingIcon ?? null}
    </Pressable>
  );

  return (
    <Modal
      animationType="none"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
          <Pressable
            accessibilityLabel="Close"
            accessibilityRole="button"
            onPress={onClose}
            style={StyleSheet.absoluteFill}
            testID={`${testID}-backdrop`}
          />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            {
              paddingBottom:
                keyboardHeight > 0 ? keyboardHeight + 12 : Math.max(insets.bottom, 16),
              transform: [{ translateY }],
            },
          ]}
          testID={testID}
        >
          <View {...dragResponder.panHandlers}>
            <SheetHeader
              // SheetHeader ships with NO horizontal padding — every caller
              // supplies its own gutter. Without `styles.header` the back
              // chevron sits flush against the screen edge and ADD is clipped
              // off the right. 16pt lines the chevron up with the row icons and
              // the collection names directly below it (Figma 3377:3130).
              align="center"
              leadingAccessory={
                <Pressable
                  accessibilityLabel={step === 'create' ? 'Back to collections' : 'Close'}
                  accessibilityRole="button"
                  hitSlop={12}
                  onPress={handleBack}
                  testID={`${testID}-back`}
                >
                  <NavArrowLeft color={colors.gray900} height={ROW_ICON_SIZE} width={ROW_ICON_SIZE} />
                </Pressable>
              }
              rightAccessory={
                step === 'list' ? (
                  <Pressable
                    accessibilityLabel="Add a collection"
                    accessibilityRole="button"
                    hitSlop={12}
                    onPress={() => setStep('create')}
                    testID={`${testID}-add`}
                  >
                    <Text style={styles.action}>ADD</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    accessibilityLabel="Create collection"
                    accessibilityRole="button"
                    disabled={!canCreate}
                    hitSlop={12}
                    onPress={handleCreate}
                    testID={`${testID}-create`}
                  >
                    <Text style={[styles.action, canCreate ? null : styles.actionDisabled]}>
                      CREATE
                    </Text>
                  </Pressable>
                )
              }
              showHandle
              style={styles.header}
              title={step === 'list' ? 'Collection' : 'New Collection'}
              titleStyle={styles.title}
            />
          </View>

          {step === 'list' ? (
            <ScrollView
              keyboardShouldPersistTaps="handled"
              style={styles.list}
              testID={`${testID}-list`}
            >
              {loading && collections.length === 0 ? (
                <View style={styles.loading} testID={`${testID}-loading`}>
                  <ActivityIndicator color={colors.gray400} />
                </View>
              ) : (
                <>
                  {renderRow({
                    key: ALL_COLLECTIONS_ID,
                    title: 'All Collection',
                    valueLabel: formatValue(allTotals.totalValue),
                    onPress: () => handleSelect(ALL_COLLECTIONS_ID),
                    isFirst: true,
                    leadingIcon: (
                      <ViewGrid color={colors.gray900} height={ROW_ICON_SIZE} width={ROW_ICON_SIZE} />
                    ),
                    trailingIcon: (
                      <NavArrowRight
                        color={colors.gray900}
                        height={ROW_ICON_SIZE}
                        width={ROW_ICON_SIZE}
                      />
                    ),
                    testID: `${testID}-row-all`,
                  })}
                  {collections.map((collection) =>
                    renderRow({
                      key: collection.id,
                      title: collection.name,
                      valueLabel: formatValue(collection.totalValue),
                      onPress: () => handleSelect(collection.id),
                      // The design has no selected state (its rows carry the
                      // deferred edit icons instead). Without one there is no way
                      // to tell which collection you are looking at, so the active
                      // row gets a check where those icons would sit.
                      trailingIcon:
                        collection.id === activeCollectionID ? (
                          <Check
                            color={colors.purple500}
                            height={ROW_ICON_SIZE}
                            width={ROW_ICON_SIZE}
                          />
                        ) : null,
                      testID: `${testID}-row-${collection.id}`,
                    }),
                  )}
                </>
              )}
            </ScrollView>
          ) : (
            <View style={styles.form}>
              <TextField
                autoCapitalize="words"
                autoCorrect={false}
                maxLength={NAME_MAX_LENGTH}
                onChangeText={(value) => {
                  setDraftName(value);
                  setCreateError(null);
                }}
                onSubmitEditing={handleCreate}
                placeholder="Enter Portfolio Name"
                ref={inputRef}
                returnKeyType="done"
                testID={`${testID}-name-input`}
                value={draftName}
                variant="underline"
              />
              {createError ? (
                <Text style={styles.error} testID={`${testID}-error`}>
                  {createError}
                </Text>
              ) : null}
            </View>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  action: {
    ...textStyles.labelStrong,
    color: colors.purple500,
  },
  actionDisabled: {
    opacity: 0.4,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  error: {
    ...textStyles.label,
    color: colors.red500,
  },
  form: {
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  header: {
    // Figma 3377:3130 — the header row sits on the same 16pt gutter as the
    // collection rows beneath it. The 12pt gap puts the row's top edge at y=26
    // measured from the sheet (10pt padding + the 4pt grabber + 12), which is
    // where the design places it.
    gap: 12,
    paddingHorizontal: 16,
  },
  list: {
    // Caps the sheet at roughly half the screen so a long collection list
    // scrolls instead of pushing the sheet off the top.
    maxHeight: SCREEN_HEIGHT * 0.5,
  },
  loading: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  row: {
    alignItems: 'center',
    borderBottomColor: colors.gray300,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    height: ROW_HEIGHT,
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  rowCopy: {
    flexShrink: 1,
    gap: 4,
  },
  rowFirst: {
    borderTopColor: colors.gray300,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowIconSpacer: {
    width: ROW_ICON_SIZE,
  },
  rowLeading: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: 12,
  },
  rowPressed: {
    backgroundColor: colors.gray50,
  },
  rowTitle: {
    ...textStyles.bodyMedium,
    color: colors.gray900,
  },
  rowValue: {
    ...textStyles.label,
    color: colors.gray600,
  },
  sheet: {
    backgroundColor: colors.gray0,
    paddingTop: 10,
  },
  title: {
    ...textStyles.titleXsmall,
  },
});

export default CollectionPickerSheet;
