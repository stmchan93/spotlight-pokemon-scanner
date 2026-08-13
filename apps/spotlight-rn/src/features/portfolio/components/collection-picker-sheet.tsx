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
import {
  Check,
  EditPencil,
  Eye,
  EyeClosed,
  NavArrowLeft,
  NavArrowRight,
  Trash,
  ViewGrid,
} from 'iconoir-react-native';

import { ALL_COLLECTIONS_ID, type Collection } from '@spotlight/api-client';

import { HIDDEN_VALUE_MASK } from '@/features/portfolio/components/portfolio-formatting';
import { Text, TextField, colors, textStyles } from '@spotlight/design-system';

/** Figma 3377:3089 — every collection row is 57pt with a 0.5pt rule beneath. */
const ROW_HEIGHT = 57;
/** Leading glyphs (view-grid, chevron) are 20pt. */
const ROW_ICON_SIZE = 20;
const SCREEN_HEIGHT = Dimensions.get('window').height;
/** How long the sheet takes to slide back out. */
const CLOSE_ANIMATION_MS = 220;
/** Drag distance past which releasing dismisses instead of springing back. */
const DISMISS_DRAG_DISTANCE = 80;
const DISMISS_DRAG_VELOCITY = 0.5;
/** Mirrors the backend cap so the field can't accept a name the server truncates. */
const NAME_MAX_LENGTH = 60;

/** Grabber height (Figma 3357:8970). */
const HANDLE_HEIGHT = 4;
/**
 * Space above and below the header row. 16pt between the grabber and the row,
 * and the same 16pt between the row and whatever the step renders underneath.
 */
const HEADER_GAP = 16;
/** SHEET_PADDING_TOP + HANDLE_HEIGHT + HEADER_GAP = 26pt to the header row. */
const SHEET_PADDING_TOP = 6;

type CollectionPickerStep = 'list' | 'create';

type CollectionPickerSheetProps = {
  visible: boolean;
  onClose: () => void;
  collections: Collection[];
  /** Totals for the "All Collections" row — the server's un-scoped figures. */
  allTotals: { cardCount: number; totalValue: number };
  /** Active collection id, or ALL_COLLECTIONS_ID when the aggregate is shown. */
  activeCollectionID: string;
  onSelectCollection: (collectionID: string) => void;
  /** Resolves once the collection exists; the sheet then closes and switches to it. */
  onCreateCollection: (name: string) => Promise<void>;
  /** Rename an existing collection. */
  onRenameCollection: (collectionID: string, name: string) => Promise<void>;
  /** Toggle whether a collection counts toward the un-scoped totals. */
  onToggleHidden: (collection: Collection) => void;
  /**
   * Hand the collection to the host to confirm deletion. Deleting takes its
   * CARDS too, so the confirm has to name the count — the sheet never deletes
   * directly.
   */
  onRequestDelete: (collection: Collection) => void;
  /**
   * Fires ONCE per close, after this sheet's modal is actually gone.
   *
   * A second `overFullScreen` modal cannot present while this one is still up:
   * on iOS it collides at the view-controller layer, so the follow-up sheet
   * never appears (the same collision documented on the card actions menu).
   * Anything that opens another modal in response to a row action — the delete
   * confirm — must wait for this.
   */
  onDismissed?: () => void;
  /** Formats a collection's market value for display (owner's masking applies). */
  formatValue: (value: number) => string;
  loading?: boolean;
  testID?: string;
};

/**
 * The collection picker (Figma 3377:3154). One bottom sheet, two steps:
 *
 *   list   — "All Collections" plus one row per collection, each with its
 *            hide / rename / delete actions; ADD opens the form
 *   form   — name a NEW collection (CREATE) or rename an existing one (SAVE)
 *
 * Reordering is still the one thing the Figma row shows that isn't here: the
 * drag handle is left out because nothing persists an order yet.
 */
export function CollectionPickerSheet({
  visible,
  onClose,
  collections,
  allTotals,
  activeCollectionID,
  onSelectCollection,
  onCreateCollection,
  onRenameCollection,
  onToggleHidden,
  onRequestDelete,
  onDismissed,
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
  // Set while the form is renaming an EXISTING collection rather than making a
  // new one — same step, same field, different verb.
  const [renameTarget, setRenameTarget] = useState<Collection | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const inputRef = useRef<TextInput | null>(null);

  // `onDismissed` must fire exactly once per close. Two things can tell us the
  // sheet is gone — the native modal's own dismissal (iOS only) and the close
  // timer below (every platform, and the only one under test) — so take
  // whichever arrives first and ignore the other. Starts "already notified" so
  // the first open can't emit a dismissal for a sheet that was never shown.
  const dismissNotifiedRef = useRef(true);
  const onDismissedRef = useRef(onDismissed);
  onDismissedRef.current = onDismissed;
  const notifyDismissed = useCallback(() => {
    if (dismissNotifiedRef.current) {
      return;
    }
    dismissNotifiedRef.current = true;
    onDismissedRef.current?.();
  }, []);

  /**
   * The only way this sheet closes. Resigns the keyboard first: the create step
   * focuses its field, and tearing the modal down while that field is still the
   * first responder leaves the keyboard to collapse on its own AFTER the sheet
   * has gone — which drags the screen underneath through a keyboard-inset pass
   * it has no business reacting to (see `automaticallyAdjustKeyboardInsets` on
   * the Collection list).
   */
  const requestClose = useCallback(() => {
    Keyboard.dismiss();
    onClose();
  }, [onClose]);

  // Every open starts on the list with a clean form — a half-typed name from a
  // previous open reappearing under a "New Collection" title reads as a bug.
  useEffect(() => {
    if (visible) {
      setStep('list');
      setDraftName('');
      setCreateError(null);
      setCreating(false);
      setRenameTarget(null);
      dismissNotifiedRef.current = false;
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
        duration: CLOSE_ANIMATION_MS,
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
    animation.start();
    // The unmount is on a timer rather than the animation's completion
    // callback: RN's Modal stops rendering its children the moment `visible`
    // goes false on every platform except iOS, which tears the animated views
    // (and with them the completion callback) down mid-flight — so that
    // callback cannot be relied on to end the close.
    const closeTimer = setTimeout(() => {
      setIsRendered(false);
      // Backstop for `Modal.onDismiss`, which RN only fires on iOS. There it
      // arrives first (an `animationType="none"` dismissal is unanimated) and
      // this is a no-op; everywhere else it is the only signal there is.
      notifyDismissed();
    }, CLOSE_ANIMATION_MS);
    return () => {
      animation.stop();
      clearTimeout(closeTimer);
    };
  }, [backdropOpacity, notifyDismissed, translateY, visible]);

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
            requestClose();
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
    [requestClose, translateY],
  );

  const handleSelect = useCallback(
    (collectionID: string) => {
      onSelectCollection(collectionID);
      requestClose();
    },
    [onSelectCollection, requestClose],
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
        if (renameTarget) {
          await onRenameCollection(renameTarget.id, trimmedName);
          // Back to the list rather than closing: renaming is a tidy-up, and
          // seeing the new name land is the confirmation.
          setRenameTarget(null);
          setDraftName('');
          setStep('list');
          Keyboard.dismiss();
        } else {
          await onCreateCollection(trimmedName);
          requestClose();
        }
      } catch {
        // Keep the sheet open with the typed name intact so the author can
        // retry — losing what they typed is the worst possible failure here.
        setCreateError(
          renameTarget
            ? 'Could not rename that collection. Try again.'
            : 'Could not create that collection. Try again.',
        );
      } finally {
        setCreating(false);
      }
    })();
  }, [canCreate, onCreateCollection, onRenameCollection, renameTarget, requestClose, trimmedName]);

  const startRename = useCallback((collection: Collection) => {
    setRenameTarget(collection);
    setDraftName(collection.name);
    setCreateError(null);
    setStep('create');
  }, []);

  const handleBack = useCallback(() => {
    if (step === 'create') {
      setStep('list');
      setRenameTarget(null);
      setDraftName('');
      Keyboard.dismiss();
      return;
    }
    requestClose();
  }, [requestClose, step]);

  if (!isRendered) {
    return null;
  }

  const renderRow = (options: {
    key: string;
    title: string;
    valueLabel: string;
    /** Omit for an informational row — same look, no press affordance. */
    onPress?: () => void;
    leadingIcon?: React.ReactNode;
    trailingIcon?: React.ReactNode;
    isFirst?: boolean;
    /** Hidden collections read back but don't count — show them muted. */
    testID: string;
  }) => (
    <Pressable
      accessibilityLabel={`${options.title}, ${options.valueLabel}`}
      accessibilityRole={options.onPress ? 'button' : undefined}
      disabled={!options.onPress}
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
      // iOS-only, and the authoritative "the view controller is really gone"
      // signal — the close timer above is the cross-platform fallback.
      onDismiss={notifyDismissed}
      onRequestClose={requestClose}
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
            onPress={requestClose}
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
          {/* Header, Figma "Action Button" 3368:2567 + Handle 3357:8970. Built
              here rather than with SheetHeader because the geometry is exact and
              differs from that primitive: the handle is 36x4 at radius 2 (not
              48x4 at a pill radius), and the title is CENTRED ON THE SHEET —
              absolutely, so a wide action like CREATE can't shove it off-centre
              the way a flex row would. */}
          <View {...dragResponder.panHandlers}>
            <View style={styles.handle} />
            <View style={styles.headerRow}>
              <Pressable
                accessibilityLabel={step === 'create' ? 'Back to collections' : 'Close'}
                accessibilityRole="button"
                hitSlop={12}
                onPress={handleBack}
                testID={`${testID}-back`}
              >
                <NavArrowLeft color={colors.gray900} height={ROW_ICON_SIZE} width={ROW_ICON_SIZE} />
              </Pressable>

              <View pointerEvents="none" style={styles.headerTitleSlot}>
                <Text style={styles.title}>
                  {step === 'list'
                    ? 'Collection'
                    : renameTarget
                      ? 'Rename Collection'
                      : 'New Collection'}
                </Text>
              </View>

              {step === 'list' ? (
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
                  accessibilityLabel={renameTarget ? 'Save collection name' : 'Create collection'}
                  accessibilityRole="button"
                  disabled={!canCreate}
                  hitSlop={12}
                  onPress={handleCreate}
                  testID={`${testID}-create`}
                >
                  <Text style={[styles.action, canCreate ? null : styles.actionDisabled]}>
                    {renameTarget ? 'SAVE' : 'CREATE'}
                  </Text>
                </Pressable>
              )}
            </View>
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
                    title: 'All Collections',
                    valueLabel: formatValue(allTotals.totalValue),
                    // Informational only — the aggregate is a readout, not a
                    // scope. A real collection is always the active one.
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
                      // A hidden collection MASKS its value rather than dimming
                      // the row. Dimming said "this row is inactive", which is
                      // wrong — a hidden collection still lists, still opens, and
                      // is still yours; it just doesn't count toward the total.
                      // Masking says the one true thing: the number is withheld.
                      // Same mask the balance header uses, so hiding reads
                      // identically wherever a value can be hidden.
                      valueLabel: collection.hidden
                        ? HIDDEN_VALUE_MASK
                        : formatValue(collection.totalValue),
                      onPress: () => handleSelect(collection.id),
                      // Figma 3357:9013 — eye / edit-pencil / trash at 20pt on a
                      // 12pt gap. The active row shows a check in front of them
                      // so you can still tell what you are looking at.
                      trailingIcon: (
                        <View style={styles.rowActions}>
                          {collection.id === activeCollectionID ? (
                            <Check
                              color={colors.purple500}
                              height={ROW_ICON_SIZE}
                              width={ROW_ICON_SIZE}
                            />
                          ) : null}
                          <Pressable
                            accessibilityLabel={
                              collection.hidden
                                ? `Count ${collection.name} toward your total`
                                : `Stop counting ${collection.name} toward your total`
                            }
                            accessibilityRole="button"
                            hitSlop={8}
                            onPress={() => onToggleHidden(collection)}
                            testID={`${testID}-row-${collection.id}-hide`}
                          >
                            {collection.hidden ? (
                              <EyeClosed
                                color={colors.gray400}
                                height={ROW_ICON_SIZE}
                                width={ROW_ICON_SIZE}
                              />
                            ) : (
                              <Eye
                                color={colors.gray900}
                                height={ROW_ICON_SIZE}
                                width={ROW_ICON_SIZE}
                              />
                            )}
                          </Pressable>
                          <Pressable
                            accessibilityLabel={`Rename ${collection.name}`}
                            accessibilityRole="button"
                            hitSlop={8}
                            onPress={() => startRename(collection)}
                            testID={`${testID}-row-${collection.id}-rename`}
                          >
                            <EditPencil
                              color={colors.gray900}
                              height={ROW_ICON_SIZE}
                              width={ROW_ICON_SIZE}
                            />
                          </Pressable>
                          {collections.length > 1 ? (
                            // The last collection is not deletable — a real one
                            // must always exist to hold new adds (the backend
                            // refuses too).
                            <Pressable
                              accessibilityLabel={`Delete ${collection.name}`}
                              accessibilityRole="button"
                              hitSlop={8}
                              onPress={() => onRequestDelete(collection)}
                              testID={`${testID}-row-${collection.id}-delete`}
                            >
                              <Trash
                                color={colors.gray900}
                                height={ROW_ICON_SIZE}
                                width={ROW_ICON_SIZE}
                              />
                            </Pressable>
                          ) : null}
                        </View>
                      ),
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
                // Figma 3368:2573 places the placeholder at gray/400, lighter
                // than the default secondary text.
                placeholderTextColor={colors.gray400}
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
    // The naming step is deliberately roomier than the list: the input gets the
    // whole surface rather than sitting tight under the header (Figma 3357:9430
    // gives it a 48pt field and open space below).
    paddingBottom: 24,
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: colors.gray200,
    // Figma Handle 3357:8970 — 36x4 at radius 2, NOT the 48x4 pill the shared
    // SheetHeader draws.
    borderRadius: 2,
    height: HANDLE_HEIGHT,
    width: 36,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    // Figma 3368:2567 — the chevron and the action sit at the 16pt gutter, the
    // same one the collection rows use, with the title centred between them.
    justifyContent: 'space-between',
    marginBottom: HEADER_GAP,
    marginTop: HEADER_GAP,
    paddingHorizontal: 16,
  },
  headerTitleSlot: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
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
  rowActions: {
    alignItems: 'center',
    flexDirection: 'row',
    // Figma 3357:9013.
    gap: 12,
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
    // Handle top edge. With HEADER_GAP below it this puts the header row at 26pt
    // from the top of the sheet, which is where Figma places it.
    paddingTop: SHEET_PADDING_TOP,
  },
  title: {
    ...textStyles.titleXsmall,
    textAlign: 'center',
  },
});

export default CollectionPickerSheet;
