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
const MAX_MESSAGE_LENGTH = 2000;

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
            <Text style={theme.typography.display}>Send feedback</Text>
          </View>

          {sent ? (
            <View style={styles.form} testID="feedback-sent">
              <Text style={theme.typography.titleCompact}>Thanks — got it.</Text>
              <Button label="Done" onPress={() => router.back()} size="lg" testID="feedback-done" />
            </View>
          ) : (
            <View style={styles.form}>
              <TextField
                inputStyle={styles.messageInput}
                maxLength={MAX_MESSAGE_LENGTH}
                multiline
                onChangeText={setMessage}
                placeholder="Leave comments, questions or concerns for Ekalight and the team will get back to you as soon as possible."
                testID="feedback-message"
                textAlignVertical="top"
                value={message}
              />
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
  form: {
    gap: 16,
  },
  headerCopy: {
    gap: 4,
  },
  messageInput: {
    minHeight: 140,
  },
  safeArea: {
    backgroundColor: colors.gray0,
    flex: 1,
  },
});
