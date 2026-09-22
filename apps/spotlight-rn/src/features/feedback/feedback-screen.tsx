import { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Button,
  Text,
  TextField,
  colors,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { capturePostHogEvent } from '@/lib/observability/posthog';

// Long enough for a real report, short enough that one event can't carry an essay.
const MAX_MESSAGE_LENGTH = 1000;

/**
 * Free-text feedback, sent as a `feedback_submitted` PostHog event so it sits
 * next to the sender's activity and session replay. Reached from the drawer,
 * which passes the route the user was on as `from`.
 */
export function FeedbackScreen() {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);

  const trimmed = message.trim();

  const handleSend = () => {
    if (!trimmed) {
      return;
    }
    capturePostHogEvent('feedback_submitted', {
      message: trimmed,
      from_screen: typeof from === 'string' ? from : null,
    });
    setSent(true);
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {
              paddingBottom: 36 + insets.bottom,
              paddingHorizontal: theme.layout.pageGutter,
              paddingTop: theme.layout.pageTopInset,
            },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.backRow}>
            <ChromeBackButton onPress={() => router.back()} testID="feedback-close" />
          </View>

          <View style={styles.headerCopy}>
            <Text style={theme.typography.display}>Give us feedback</Text>
          </View>

          {sent ? (
            <View style={styles.form} testID="feedback-sent">
              <Text style={theme.typography.titleCompact}>Thanks — got it.</Text>
              <Button label="Done" onPress={() => router.back()} size="lg" testID="feedback-done" />
            </View>
          ) : (
            <View style={styles.form}>
              <View style={styles.fieldWithCount}>
                <TextField
                  containerStyle={styles.messageContainer}
                  inputStyle={styles.messageInput}
                  maxLength={MAX_MESSAGE_LENGTH}
                  multiline
                  onChangeText={setMessage}
                  placeholder="Tell us anything. Every piece of feedback goes directly back to the team"
                  testID="feedback-message"
                  textAlignVertical="top"
                  value={message}
                />
                <Text
                  style={[theme.typography.caption, styles.count, { color: theme.colors.textSecondary }]}
                  testID="feedback-count"
                >
                  {`${message.length}/${MAX_MESSAGE_LENGTH}`}
                </Text>
              </View>
              <Button
                disabled={!trimmed}
                label="Send"
                onPress={handleSend}
                size="lg"
                testID="feedback-send"
              />
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  backRow: {
    alignSelf: 'flex-start',
  },
  content: {
    gap: 18,
  },
  flex: {
    flex: 1,
  },
  count: {
    alignSelf: 'flex-end',
  },
  fieldWithCount: {
    gap: 6,
  },
  form: {
    gap: 16,
  },
  headerCopy: {
    gap: 4,
  },
  // Multiline text starts at the top, not centred in the row the field lays out.
  messageContainer: {
    alignItems: 'flex-start',
  },
  messageInput: {
    minHeight: 140,
    paddingBottom: 12,
    paddingTop: 12,
  },
  safeArea: {
    backgroundColor: colors.gray0,
    flex: 1,
  },
});
