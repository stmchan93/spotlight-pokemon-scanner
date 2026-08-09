import { type Dispatch, type ReactNode, type SetStateAction, useCallback, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { ConfirmDeleteSheet } from '@/features/cards/components/confirm-delete-sheet';
import { deletePost, type FeedPost } from '@/features/social/social-service';

const CONFIRM_TITLE = 'Delete post';
const CONFIRM_MESSAGE =
  'This post and all of its likes and comments will be removed. Are you sure you want to continue?';
const FAILURE_TITLE = "Couldn't delete post";
const FAILURE_MESSAGE = 'Your post is still there. Please try again in a moment.';

type PostDeletion = {
  /**
   * Ask to delete a post: opens the confirmation sheet. Nothing is removed and
   * no request is issued until the destructive CTA is pressed.
   */
  requestDelete: (post: FeedPost) => void;
  /**
   * The confirmation sheet. Render it from the SCREEN, not from the row — the
   * confirmed delete unmounts the row, and tearing a presented native modal down
   * mid-dismiss is the collision this codebase has already been bitten by (see
   * the comments in ConfirmDeleteSheet / CardActionsSheet).
   */
  confirmSheet: ReactNode;
};

/**
 * Post deletion for a screen that holds a `FeedPost[]` in state.
 *
 * The feed and the Portfolio Activity tab each own their own list — there is no
 * shared post store — so this hook is what keeps the two behaving identically
 * rather than each screen re-deriving confirm + optimism + rollback.
 *
 * The optimism follows the DM send path (see `dm-thread-screen`): apply locally
 * first, reconcile on the response, and on failure put the post BACK and say so.
 * A delete that silently fails while the row stays gone is the worst outcome —
 * the user believes their post is deleted when it is still public.
 *
 * The author check lives in `PostCard` (it knows the viewer and the post's
 * author). This hook is only reached from that affordance, and Supabase RLS is
 * the actual guard: the UI check is courtesy, not security.
 */
export function usePostDeletion(
  setPosts: Dispatch<SetStateAction<FeedPost[]>>,
  { testID = 'post-delete-confirm' }: { testID?: string } = {},
): PostDeletion {
  const [pendingPost, setPendingPost] = useState<FeedPost | null>(null);
  // De-dupes a second confirm for the same post while its write is in flight.
  const inFlightRef = useRef(new Set<string>());

  const requestDelete = useCallback((post: FeedPost) => {
    setPendingPost(post);
  }, []);

  const closeConfirm = useCallback(() => {
    setPendingPost(null);
  }, []);

  const confirmDelete = useCallback(() => {
    const post = pendingPost;
    setPendingPost(null);
    if (!post || inFlightRef.current.has(post.id)) {
      return;
    }
    inFlightRef.current.add(post.id);

    // Remember where the row sat so a failed delete restores it in place rather
    // than jumping it to the top of the list.
    let removedIndex = -1;
    setPosts((current) => {
      const index = current.findIndex((entry) => entry.id === post.id);
      if (index < 0) {
        return current;
      }
      removedIndex = index;
      return [...current.slice(0, index), ...current.slice(index + 1)];
    });

    void (async () => {
      let deleted = false;
      try {
        deleted = await deletePost(post.id);
      } catch {
        deleted = false;
      }
      inFlightRef.current.delete(post.id);
      if (deleted) {
        return;
      }

      setPosts((current) => {
        // A refresh may have already re-fetched the post; don't double-insert.
        if (current.some((entry) => entry.id === post.id)) {
          return current;
        }
        // Unknown position (the list was replaced under us) → put it back at the
        // top so the restore is visible instead of buried.
        const index = removedIndex >= 0 ? Math.min(removedIndex, current.length) : 0;
        return [...current.slice(0, index), post, ...current.slice(index)];
      });
      Alert.alert(FAILURE_TITLE, FAILURE_MESSAGE);
    })();
  }, [pendingPost, setPosts]);

  const confirmSheet = (
    <ConfirmDeleteSheet
      confirmLabel="Delete"
      message={CONFIRM_MESSAGE}
      onClose={closeConfirm}
      onConfirm={confirmDelete}
      testID={testID}
      title={CONFIRM_TITLE}
      visible={pendingPost != null}
    />
  );

  return { requestDelete, confirmSheet };
}

export default usePostDeletion;
