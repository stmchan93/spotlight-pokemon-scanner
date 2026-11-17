import { Trash } from 'iconoir-react-native';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import type { AssistantThreadSummary } from '@spotlight/api-client';
import {
  Button,
  IconButton,
  InlineLoader,
  StateCard,
  Text,
  borderWidths,
  layout,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

type AssistantThreadListProps = {
  threads: AssistantThreadSummary[];
  status: 'loading' | 'ready' | 'error';
  activeThreadId: string | null;
  onOpenThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
  onClearAll: () => void;
  onNewChat: () => void;
  onRetry: () => void;
  bottomInset: number;
};

function formatThreadDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Saved chats: open one, delete one, or clear them all. */
export function AssistantThreadList({
  threads,
  status,
  activeThreadId,
  onOpenThread,
  onDeleteThread,
  onClearAll,
  onNewChat,
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
      ListEmptyComponent={
        <Text
          style={[theme.typography.body, styles.empty, { color: theme.colors.gray600 }]}
          testID="assistant-threads-empty"
        >
          No saved chats yet.
        </Text>
      }
      ListFooterComponent={
        <View style={styles.footer}>
          <Button
            label="New chat"
            labelStyleVariant="control"
            onPress={onNewChat}
            testID="assistant-threads-new"
            variant="dark"
          />
          {threads.length > 0 ? (
            <Button
              label="Clear all chats"
              labelStyleVariant="control"
              onPress={onClearAll}
              testID="assistant-threads-clear-all"
              variant="ghost"
            />
          ) : null}
        </View>
      }
      contentContainerStyle={{ paddingBottom: bottomInset + spacing.lg }}
      data={threads}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <View
          style={[
            styles.row,
            { borderBottomColor: theme.colors.gray200 },
            item.id === activeThreadId ? { backgroundColor: theme.colors.purple50 } : null,
          ]}
        >
          <Pressable
            accessibilityRole="button"
            onPress={() => onOpenThread(item.id)}
            style={({ pressed }) => [styles.rowBody, { opacity: pressed ? 0.7 : 1 }]}
            testID={`assistant-thread-${item.id}`}
          >
            <Text numberOfLines={1} style={theme.typography.bodyStrong}>
              {item.title || 'Untitled chat'}
            </Text>
            {item.lastMessagePreview ? (
              <Text numberOfLines={2} style={[theme.typography.caption, { color: theme.colors.gray600 }]}>
                {item.lastMessagePreview.replace(/\*\*/g, '')}
              </Text>
            ) : null}
            <Text style={[theme.typography.captionTiny, { color: theme.colors.gray500 }]}>
              {formatThreadDate(item.updatedAt)}
            </Text>
          </Pressable>
          <IconButton
            accessibilityLabel="Delete chat"
            onPress={() => onDeleteThread(item.id)}
            testID={`assistant-thread-${item.id}-delete`}
            variant="ghost"
          >
            <Trash color={theme.colors.gray600} height={18} width={18} />
          </IconButton>
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
  empty: {
    paddingHorizontal: layout.pageGutter,
    paddingVertical: spacing.lg,
    textAlign: 'center',
  },
  footer: {
    gap: spacing.xxs,
    padding: layout.pageGutter,
  },
  row: {
    alignItems: 'center',
    borderBottomWidth: borderWidths.ruleSnapped,
    flexDirection: 'row',
    gap: spacing.xxs,
    paddingHorizontal: layout.pageGutter,
    paddingVertical: spacing.xs,
  },
  rowBody: {
    flex: 1,
    gap: spacing.xxxs,
  },
});
