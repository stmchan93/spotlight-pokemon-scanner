import { DmInboxScreen } from '@/features/social/screens/dm-inbox-screen';

/**
 * DM inbox at `/messages`.
 *
 * ROOT-LEVEL ON PURPOSE — same reason as `new-post` (see the comment above its
 * `Stack.Screen` in `src/app/_layout.tsx`). Pushing a route that lives inside
 * `(stack)`/`(sheet)`/`(modal)` mounts THAT group's navigator with your screen as
 * its only route, and react-native-screens ignores presentation options on a
 * navigator's bottom-most screen — there is nothing to present over. That is how
 * the New Post form sheet silently became a full-screen push with its close
 * button under the status bar.
 *
 * Here `/messages` is pushed over `(tabs)`, the root stack's initial route, so it
 * is the second screen and presents correctly. `messages/[conversationId]` sits
 * beside it (no `_layout.tsx` in `src/app/messages/`), so the thread is another
 * push on the SAME root stack rather than a nested navigator. Don't move either
 * of them under a group.
 */
export default function MessagesRoute() {
  return <DmInboxScreen />;
}
