import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Avatar,
  Button,
  ScreenHeader,
  StateCard,
  Text,
  Toast,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { ConfirmDeleteSheet } from '@/features/cards/components/confirm-delete-sheet';
import { getProfileInitials } from '@/features/profile/screens/public-profile-screen';
import {
  fetchBlockedProfiles,
  unblockUser,
  type BlockedProfile,
} from '@/features/social/social-service';

/** Has the list loaded yet, and did it come back empty? */
type ListStatus = 'loading' | 'ready' | 'empty';

export type BlockedAccountsScreenProps = {
  /** Back affordance; omit to hide the back button. */
  onBack?: () => void;
  testID?: string;
};

/**
 * What to call someone you have blocked.
 *
 * Falls through name → @handle → a generic label. The generic case is real, not
 * defensive padding: once social_19 is applied `public_profiles` filters on an
 * either-direction `is_blocked`, so the blocker cannot read the blocked user's
 * name through the ordinary lane. `fetchBlockedProfiles` prefers the
 * `blocked_profiles()` RPC that CAN read it, and only lands here when the
 * environment has neither. A nameless row still unblocks correctly — the id is
 * all `unblockUser` needs — and that is much better than hiding the row and
 * making the block permanent.
 */
export function blockedAccountName(profile: BlockedProfile): string {
  const name = profile.displayName?.trim();
  if (name) {
    return name;
  }
  const handle = profile.handle?.trim();
  return handle ? `@${handle}` : 'Blocked account';
}

/**
 * Blocked accounts — the surface that makes blocking reversible.
 *
 * `unblockUser` has existed since blocking shipped and nothing ever called it,
 * so a block was a one-way door: the blocked person disappears from the feed,
 * from search, and from their own profile route, and there was no screen left
 * that could name them, let alone lift it. This is that screen.
 *
 * Rows deliberately do NOT navigate to the profile. After social_19 that route
 * resolves to "not found" for exactly these users, so a tappable row would be a
 * dead end; the only action here is the one the user came for.
 */
export function BlockedAccountsScreen({
  onBack,
  testID = 'blocked-accounts',
}: BlockedAccountsScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  const [profiles, setProfiles] = useState<BlockedProfile[]>([]);
  const [status, setStatus] = useState<ListStatus>('loading');
  /** The row awaiting confirmation. Null when the confirm sheet is closed. */
  const [pending, setPending] = useState<BlockedProfile | null>(null);
  const [unblockInFlight, setUnblockInFlight] = useState(false);
  const [unblockFailed, setUnblockFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');

    void (async () => {
      const fetched = await fetchBlockedProfiles();
      if (cancelled) {
        return;
      }
      setProfiles(fetched);
      setStatus(fetched.length === 0 ? 'empty' : 'ready');
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleConfirmUnblock = useCallback(async () => {
    if (!pending || unblockInFlight) {
      return;
    }
    setUnblockInFlight(true);
    const ok = await unblockUser(pending.userID);
    setUnblockInFlight(false);

    if (!ok) {
      // Keep the row: an unblock that silently vanished from the list while the
      // block was still in force would be the worst possible lie to tell here.
      setPending(null);
      setUnblockFailed(true);
      return;
    }

    setProfiles((current) => {
      const next = current.filter((profile) => profile.userID !== pending.userID);
      setStatus(next.length === 0 ? 'empty' : 'ready');
      return next;
    });
    setPending(null);
  }, [pending, unblockInFlight]);

  const renderItem = useCallback(
    ({ item }: { item: BlockedProfile }) => {
      const name = blockedAccountName(item);
      const handle = item.handle?.trim();
      return (
        <View style={styles.row} testID={`${testID}-row-${item.userID}`}>
          <Avatar
            initials={getProfileInitials(item.displayName)}
            size={44}
            testID={`${testID}-row-${item.userID}-avatar`}
            uri={item.avatarURL}
          />
          <View style={styles.rowCopy}>
            <Text numberOfLines={1} style={theme.typography.bodyStrong}>
              {name}
            </Text>
            {handle && item.displayName?.trim() ? (
              <Text
                numberOfLines={1}
                style={[theme.typography.captionMedium, { color: theme.colors.gray500 }]}
              >
                @{handle}
              </Text>
            ) : null}
          </View>
          <Button
            disabled={unblockInFlight}
            label="Unblock"
            labelStyleVariant="label"
            onPress={() => setPending(item)}
            shape="rounded"
            size="sm"
            testID={`${testID}-row-${item.userID}-unblock`}
            variant="outline"
          />
        </View>
      );
    },
    [testID, theme, unblockInFlight],
  );

  const listEmpty = (
    <StateCard
      loading={status === 'loading'}
      message={
        status === 'loading'
          ? 'Fetching the accounts you have blocked.'
          : "You haven't blocked anyone. Blocked accounts show up here so you can unblock them."
      }
      style={styles.stateCard}
      testID={status === 'loading' ? `${testID}-loading` : `${testID}-empty`}
      title={status === 'loading' ? 'Loading' : 'No blocked accounts'}
      variant="field"
    />
  );

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      <FlatList
        contentContainerStyle={{
          paddingHorizontal: theme.layout.pageGutter,
          paddingBottom: insets.bottom + 24,
        }}
        data={status === 'ready' ? profiles : []}
        keyExtractor={(item) => item.userID}
        ListEmptyComponent={listEmpty}
        ListHeaderComponent={
          // Back button on its own row above the title, matching Followers /
          // Search Cards — same kind of screen, same header shape.
          <ScreenHeader
            accessoryTestID={`${testID}-back-row`}
            layout="stacked"
            leftAccessory={
              onBack ? <ChromeBackButton onPress={onBack} testID={`${testID}-back`} /> : undefined
            }
            style={styles.header}
            title="Blocked accounts"
          />
        }
        renderItem={renderItem}
        testID={`${testID}-scroll-view`}
      />

      {/*
        Same confirmation shape as every other deliberate action in the app.
        `presentation="modal"` (the default) is correct here: this is a routed
        screen, not a caller already inside an RN `Modal`.
      */}
      <ConfirmDeleteSheet
        confirmLabel="Unblock"
        confirmPending={unblockInFlight}
        message={
          pending
            ? `${blockedAccountName(pending)} will be able to see your posts and profile again, and you'll see theirs. You can block them again at any time.`
            : ''
        }
        onClose={() => {
          if (!unblockInFlight) {
            setPending(null);
          }
        }}
        onConfirm={() => {
          void handleConfirmUnblock();
        }}
        testID={`${testID}-confirm`}
        title="Unblock account?"
        visible={pending !== null}
      />

      <Toast
        message="Couldn't unblock that account. Please try again."
        onDismiss={() => setUnblockFailed(false)}
        style={[
          styles.errorToast,
          {
            bottom: insets.bottom + theme.spacing.lg,
            left: theme.layout.pageGutter,
            right: theme.layout.pageGutter,
          },
        ]}
        testID={`${testID}-error`}
        tone="dark"
        visible={unblockFailed}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  errorToast: {
    position: 'absolute',
    zIndex: 5,
  },
  header: {
    paddingBottom: 12,
    paddingTop: 8,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
  },
  rowCopy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  safeArea: {
    flex: 1,
  },
  stateCard: {
    marginTop: 12,
  },
});

export default BlockedAccountsScreen;
