import { Trash } from 'iconoir-react-native';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import type { AssistantThreadSummary } from '@spotlight/api-client';
import {
  InlineLoader,
  StateCard,
  Text,
  borderWidths,
  layout,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { assistantCopyText } from '@/features/assistant/components/assistant-message-bubble';

// Figma 6530:16971: a 20pt trash glyph.
const TRASH_SIZE = 20;
// Row text column: 6pt between date, question and preview.
const ROW_TEXT_GAP = 6;

type AssistantThreadListProps = {
  threads: AssistantThreadSummary[];
  status: 'loading' | 'ready' | 'error';
  onOpenThread: (threadId: string) => void;
  /** Asks for confirmation itself; the caller only deletes. */
  onDeleteThread: (threadId: string) => void;
  onRetry: () => void;
  bottomInset: number;
};

/** "NOV 18" — uppercase in JS, the Figma date caption. */
export function formatThreadDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
}

/** HISTORY (Figma 6530:16826): date, question, answer preview, trash; hairlines between rows. No composer. */
export function AssistantThreadList({
  threads,
  status,
  onOpenThread,
  onDeleteThread,
  onRetry,
  bottomInset,
}: AssistantThreadListProps) {
  const theme = useSpotlightTheme();

  if (status === 'loading' && threads.length === 0) {
    return <InlineLoader style={styles.loader} testID="assistant-threads-loading" />;
  }
  if (status === 'error' && threads.length === 0) {
    return (
      <View style={styles.state}>
        <StateCard
          actionLabel="Try again"
          actionTestID="assistant-threads-retry"
          message="Check your connection and try again."
          onActionPress={onRetry}
          testID="assistant-threads-error"
          title="Couldn't load your chats"
        />
      </View>
    );
  }

  return (
    <FlatList
      ItemSeparatorComponent={() => (
        <View style={[styles.divider, { backgroundColor: theme.colors.gray200 }]} />
      )}
      ListEmptyComponent={
        <Text
          style={[theme.typography.body, styles.empty, { color: theme.colors.gray600 }]}
          testID="assistant-threads-empty"
        >
          No saved chats yet.
        </Text>
      }
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset + spacing.lg }]}
      data={threads}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            onPress={() => onOpenThread(item.id)}
            style={({ pressed }) => [styles.rowBody, { opacity: pressed ? 0.7 : 1 }]}
            testID={`assistant-thread-${item.id}`}
          >
            <Text style={[theme.typography.overline, { color: theme.colors.gray600 }]}>
              {formatThreadDate(item.updatedAt)}
            </Text>
            <Text numberOfLines={2} style={[theme.typography.captionMedium, { color: theme.colors.gray900 }]}>
              {item.title || 'Untitled chat'}
            </Text>
            {item.lastMessagePreview ? (
              <Text numberOfLines={3} style={[theme.typography.caption, { color: theme.colors.gray600 }]}>
                {assistantCopyText(item.lastMessagePreview)}
              </Text>
            ) : null}
          </Pressable>
          <Pressable
            accessibilityLabel="Delete chat"
            accessibilityRole="button"
            hitSlop={spacing.xs}
            onPress={() => onDeleteThread(item.id)}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            testID={`assistant-thread-${item.id}-delete`}
          >
            <Trash color={theme.colors.gray600} height={TRASH_SIZE} width={TRASH_SIZE} />
          </Pressable>
        </View>
      )}
      testID="assistant-threads"
    />
  );
}

const styles = StyleSheet.create({
  loader: {
    paddingVertical: spacing.xl,
  },
  state: {
    padding: layout.pageGutter,
  },
  // 24pt under the toolbar (Figma: toolbar ends at 115, first row at 139).
  content: {
    paddingHorizontal: layout.pageGutter,
    paddingTop: spacing.lg,
  },
  empty: {
    paddingVertical: spacing.lg,
    textAlign: 'center',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  rowBody: {
    flex: 1,
    gap: ROW_TEXT_GAP,
  },
  divider: {
    height: borderWidths.containerRule,
    marginVertical: spacing.sm,
  },
});
