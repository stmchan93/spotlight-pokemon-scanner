import { useLocalSearchParams } from 'expo-router';

import { PostDetailScreen } from '@/features/social/screens/post-detail-screen';

function firstParam(value?: string | string[]): string {
  if (Array.isArray(value)) {
    return value.find((entry) => entry.trim().length > 0) ?? '';
  }
  return value ?? '';
}

/**
 * A single post: `/post/<id>`, optionally `?comments=1` to land in the thread.
 *
 * The destination notifications never had. Every like/comment row in the list
 * was inert because this route did not exist.
 */
export default function PostDetailRoute() {
  const params = useLocalSearchParams<{
    postId?: string | string[];
    comments?: string | string[];
    commentId?: string | string[];
  }>();
  const postId = firstParam(params.postId).trim();
  // Carried by a notification about a reply, so the thread opens ON it.
  const commentId = firstParam(params.commentId).trim();

  if (!postId) {
    return null;
  }

  return (
    <PostDetailScreen
      focusCommentId={commentId || null}
      openComments={firstParam(params.comments) === '1'}
      postId={postId}
    />
  );
}
