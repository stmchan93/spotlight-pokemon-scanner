import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  type TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SendDiagonal } from 'iconoir-react-native';

import { Text, TextField, useSpotlightTheme } from '@spotlight/design-system';

import { addComment, type PostComment } from '@/features/social/social-service';

type CommentComposerSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** The post the comment is attached to. */
  postId: string;
  /** Fired after the comment saves, so the card can bump its count. */
  onCommentAdded?: (comment: PostComment) => void;
  testID?: string;
};

/** Gap between the composer's bottom edge and the top of the keyboard. */
const KEYBOARD_GAP = 8;
/** Backdrop fade, fast enough that the bar and the keyboard read as one motion. */
const FADE_MS = 140;

/**
 * The lightweight "Add a comment" affordance: tapping a post's comment icon
 * pops ONLY the composer — an auto-focused text field riding the top of the
 * keyboard — instead of sliding the whole thread panel up. Reading the thread
 * is a separate, deliberate tap on the post's comment count, which opens
 * `CommentsSheet`.
 *
 * The bar is bottom-anchored and tracks the keyboard itself (no
 * KeyboardAvoidingView, which would pad the whole overlay). Sending posts a
 * top-level comment, hands the optimistic row back to the caller, and closes.
 */
export function CommentComposerSheet({
  visible,
  onClose,
  postId,
  onCommentAdded,
  testID = 'comment-composer',
}: CommentComposerSheetProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput | null>(null);

  const [isRendered, setIsRendered] = useState(visible);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  const restingInset = Math.max(insets.bottom, 12);
  const opacity = useRef(new Animated.Value(0)).current;
  // Animated so the bar rides the keyboard's own curve rather than snapping to
  // its final position a frame before the keyboard gets there.
  const liftRef = useRef(new Animated.Value(restingInset));
  const lift = liftRef.current;

  useEffect(() => {
    if (visible) {
      setIsRendered(true);
      setDraft('');
      setFailed(false);
      const animation = Animated.timing(opacity, {
        toValue: 1,
        duration: FADE_MS,
        easing: Easing.out(Easing.quad),
        // JS-driven: this value also styles the bar, whose sibling
        // `paddingBottom` can't be driven natively. Mixing the two on one style
        // node throws at runtime.
        useNativeDriver: false,
      });
      animation.start();
      return () => animation.stop();
    }

    const animation = Animated.timing(opacity, {
      toValue: 0,
      duration: FADE_MS,
      easing: Easing.in(Easing.quad),
      useNativeDriver: false,
    });
    animation.start(({ finished }) => {
      if (finished) {
        setIsRendered(false);
        lift.setValue(restingInset);
      }
    });
    return () => animation.stop();
  }, [lift, opacity, restingInset, visible]);

  // Track the keyboard so the bar sits exactly KEYBOARD_GAP above it. iOS gets
  // the "will" events (and the system's own duration) so the two move together;
  // Android only reliably fires the "did" pair.
  useEffect(() => {
    if (!visible) {
      return;
    }
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (event) => {
      Animated.timing(lift, {
        toValue: (event.endCoordinates?.height ?? 0) + KEYBOARD_GAP,
        duration: event.duration || 250,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start();
    });
    const hideSub = Keyboard.addListener(hideEvent, (event) => {
      Animated.timing(lift, {
        toValue: restingInset,
        duration: event?.duration || 200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start();
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [lift, restingInset, visible]);

  const handleDismiss = useCallback(() => {
    Keyboard.dismiss();
    onClose();
  }, [onClose]);

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (sending || text.length === 0 || !postId) {
      return;
    }
    setSending(true);
    setFailed(false);

    void (async () => {
      const newId = await addComment(postId, text, null);
      setSending(false);
      if (!newId) {
        // Keep the sheet open with the draft intact so the send can be retried.
        setFailed(true);
        return;
      }
      onCommentAdded?.({
        id: newId,
        postId,
        authorId: '',
        author: null,
        body: text,
        parentCommentId: null,
        likeCount: 0,
        createdAt: new Date().toISOString(),
      });
      setDraft('');
      handleDismiss();
    })();
  }, [draft, handleDismiss, onCommentAdded, postId, sending]);

  if (!isRendered) {
    return null;
  }

  const canSend = draft.trim().length > 0 && !sending;

  return (
    <Modal
      animationType="none"
      onRequestClose={handleDismiss}
      // Focus once the overlay is actually on screen — `autoFocus` inside a
      // Modal is unreliable on iOS.
      onShow={() => inputRef.current?.focus()}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      // `isRendered`, not `visible` — it outlives the close by one fade so the
      // exit animation actually plays instead of the overlay vanishing.
      visible={isRendered}
    >
      <View style={styles.root}>
        <Animated.View style={[styles.backdropLayer, { opacity }]}>
          <Pressable
            accessibilityLabel="Close"
            accessibilityRole="button"
            onPress={handleDismiss}
            style={styles.backdrop}
            testID={`${testID}-backdrop`}
          />
        </Animated.View>

        <Animated.View
          style={[
            styles.bar,
            {
              backgroundColor: theme.colors.gray0,
              borderTopColor: theme.colors.outlineSubtle,
              opacity,
              paddingBottom: lift,
            },
          ]}
          testID={testID}
        >
          {failed ? (
            <Text
              style={[theme.typography.caption, styles.error, { color: theme.colors.gray600 }]}
              testID={`${testID}-error`}
            >
              Could not post that comment. Tap send to try again.
            </Text>
          ) : null}
          <View style={styles.row}>
            <View style={styles.field}>
              <TextField
                onChangeText={setDraft}
                onSubmitEditing={handleSend}
                placeholder="Add a comment…"
                ref={inputRef}
                returnKeyType="send"
                testID={`${testID}-input`}
                value={draft}
              />
            </View>
            <Pressable
              accessibilityLabel="Send comment"
              accessibilityRole="button"
              disabled={!canSend}
              hitSlop={8}
              onPress={handleSend}
              style={[
                styles.sendButton,
                {
                  backgroundColor: canSend ? theme.colors.purple500 : theme.colors.gray200,
                  borderRadius: theme.radii.pill,
                },
              ]}
              testID={`${testID}-send`}
            >
              {sending ? (
                <ActivityIndicator color={theme.colors.gray0} size="small" />
              ) : (
                <SendDiagonal color={theme.colors.gray0} height={18} width={18} />
              )}
            </Pressable>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
  },
  backdropLayer: {
    ...StyleSheet.absoluteFillObject,
    // Lighter than the full sheet's scrim — this is a quick inline action, not
    // a mode you navigate into.
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
  },
  bar: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  error: {
    paddingBottom: 8,
  },
  field: {
    flex: 1,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sendButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
});

export default CommentComposerSheet;
