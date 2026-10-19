import type { UserProfile } from '@/features/auth/auth-models';
import type { DevDmOverrides, DmConversation, DmMessage } from '@/features/social/dm-service';
import type { DevProfileOverrides } from '@/features/profile/profile-service';
import type {
  AppNotification,
  BlockedProfile,
  DevSocialOverrides,
  FeedPostAuthor,
} from '@/features/social/social-service';
import { devFeedItems } from '@/dev/dev-feed-data';

/**
 * Deterministic Supabase-layer fixtures for the social dev routes
 * (spotlight://dev/public-profile, /follow-list, /post-detail, /notifications,
 * /messages, /conversation, /blocked-accounts). Installed by the dev host
 * through the services' `setDev*Overrides` seams, so the screens read these
 * instead of Supabase. Avatars stay null (initials) on purpose: the bundled
 * placeholders are card-shaped, and a null avatar is the shape most rows take.
 */

/** The signed-in viewer under EXPO_PUBLIC_DEV_SCREENS=1 (auth-provider's test user). */
export const DEV_VIEWER_ID = '00000000-0000-0000-0000-000000000001';

/** The profile the public-profile / follow-list routes open. */
export const DEV_PROFILE_HANDLE = 'wabisabi';
export const DEV_PROFILE_ID = '00000000-0000-0000-0000-00000000a001';

function person(
  index: number,
  displayName: string,
  handle: string | null,
  extra: Partial<UserProfile> = {},
): UserProfile {
  return {
    userID: `00000000-0000-0000-0000-00000000a${String(index).padStart(3, '0')}`,
    displayName,
    avatarURL: null,
    labelerEnabled: false,
    adminEnabled: false,
    handleKnown: true,
    handle,
    bio: null,
    location: null,
    socialLink: null,
    coverURL: null,
    isVerified: false,
    reputation: 0,
    followerCount: 0,
    followingCount: 0,
    postCount: 0,
    ...extra,
  };
}

export const devProfile: UserProfile = person(1, 'WabiSabi', DEV_PROFILE_HANDLE, {
  bio: 'Vintage WOTC and Japanese promos. Grading what I can, trading what I can’t. LA shows most weekends.',
  location: 'Los Angeles, CA',
  socialLink: 'instagram.com/wabisabi.cards',
  isVerified: true,
  reputation: 412,
  followerCount: 1284,
  followingCount: 356,
  postCount: 97,
});

// One row per name shape the list has to handle: a verified account, a long
// display name, a handle-less user, and a plain row.
export const devFollowers: UserProfile[] = [
  person(2, 'Kanto Grader', 'kantograder', { isVerified: true, followerCount: 8120 }),
  person(3, 'Trogdor the Burninator of Cards', 'trogdor', { followerCount: 42 }),
  person(4, 'Mia Tanaka', 'miatanaka', { followerCount: 311 }),
  person(5, 'Pull Rate Pete', null, { followerCount: 6 }),
  person(6, 'Vintage Vault', 'vintagevault', { isVerified: true, followerCount: 23400 }),
  person(7, 'Jordan Lee', 'jlee', { followerCount: 128 }),
  person(8, 'Binder Babe', 'binderbabe', { followerCount: 904 }),
];

export const devFollowing: UserProfile[] = devFollowers.slice(0, 4);

export const devProfileOverrides: DevProfileOverrides = {
  profiles: [devProfile, ...devFollowers],
  followers: devFollowers,
  following: devFollowing,
};

/** The post the post-detail route opens — the feed's hero image post. */
export const DEV_POST_ID = devFeedItems[0].post.id;

function actor(profile: UserProfile): FeedPostAuthor {
  return {
    displayName: profile.displayName,
    handle: profile.handle ?? null,
    avatarUrl: null,
    isVerified: profile.isVerified === true,
  };
}

function notification(
  id: string,
  type: AppNotification['type'],
  from: UserProfile,
  createdAt: string,
  extra: Partial<AppNotification> = {},
): AppNotification {
  return {
    id,
    type,
    actor: actor(from),
    postId: DEV_POST_ID,
    commentId: null,
    createdAt,
    readAt: null,
    commentBody: null,
    isReply: false,
    postAuthor: null,
    postMediaId: null,
    ...extra,
  };
}

// Every row kind the list phrases differently: a like, a top-level comment, a
// reply on someone else's post, a follow, a repost — the first three unread.
export const devNotifications: AppNotification[] = [
  notification('dev-notif-1', 'like', devFollowers[0], '2026-07-16T14:05:00.000Z'),
  notification('dev-notif-2', 'comment', devFollowers[1], '2026-07-16T13:40:00.000Z', {
    commentId: 'dev-comment-1',
    commentBody: 'That centering looks dead on. Did you grade it yet?',
  }),
  notification('dev-notif-3', 'comment', devFollowers[2], '2026-07-16T11:12:00.000Z', {
    commentId: 'dev-comment-2',
    commentBody: '@uitestuser same pull last weekend, congrats!',
    isReply: true,
    postAuthor: actor(devProfile),
  }),
  notification('dev-notif-4', 'follow', devFollowers[3], '2026-07-15T22:30:00.000Z', {
    postId: null,
    readAt: '2026-07-16T09:00:00.000Z',
  }),
  notification('dev-notif-5', 'repost', devFollowers[4], '2026-07-15T18:02:00.000Z', {
    readAt: '2026-07-16T09:00:00.000Z',
  }),
  notification('dev-notif-6', 'like', devFollowers[5], '2026-07-14T08:45:00.000Z', {
    readAt: '2026-07-16T09:00:00.000Z',
  }),
  notification('dev-notif-7', 'follow', devFollowers[6], '2026-07-12T16:20:00.000Z', {
    postId: null,
    readAt: '2026-07-16T09:00:00.000Z',
  }),
];

export const devBlockedProfiles: BlockedProfile[] = [
  { userID: '00000000-0000-0000-0000-00000000b001', displayName: 'Spam Pulls', handle: 'spampulls', avatarURL: null },
  { userID: '00000000-0000-0000-0000-00000000b002', displayName: null, handle: 'lowballer_99', avatarURL: null },
  { userID: '00000000-0000-0000-0000-00000000b003', displayName: 'Bot Account 4471', handle: null, avatarURL: null },
  { userID: '00000000-0000-0000-0000-00000000b004', displayName: null, handle: null, avatarURL: null },
];

export const devSocialOverrides: DevSocialOverrides = {
  posts: devFeedItems.map((item) => item.post),
  notifications: devNotifications,
  blockedProfiles: devBlockedProfiles,
};

/** The thread the conversation route opens. */
export const DEV_CONVERSATION_ID = 'dev-dm-1';

function conversation(
  id: string,
  other: UserProfile | null,
  lastMessageAt: string,
  lastMessagePreview: string | null,
  unreadCount: number,
): DmConversation {
  return {
    id,
    isGroup: false,
    otherUserId: other?.userID ?? null,
    otherUser: other ? actor(other) : null,
    lastMessageAt,
    lastMessagePreview,
    lastReadAt: unreadCount > 0 ? null : lastMessageAt,
    unreadCount,
  };
}

// Inbox shapes: unread with a long preview, read, a never-written thread (blank
// preview), a hidden counterpart (null otherUser), and a 99+ badge.
export const devConversations: DmConversation[] = [
  conversation(DEV_CONVERSATION_ID, devProfile, '2026-07-16T15:12:00.000Z', 'Sounds good — see you at the Pomona show Saturday. I’ll bring the binder.', 2),
  conversation('dev-dm-2', devFollowers[0], '2026-07-16T09:48:00.000Z', 'PSA 10 came back! Posting it tonight.', 0),
  conversation('dev-dm-3', devFollowers[1], '2026-07-15T21:03:00.000Z', 'lol no way', 0),
  conversation('dev-dm-4', devFollowers[2], '2026-07-14T12:30:00.000Z', null, 0),
  conversation('dev-dm-5', null, '2026-07-13T08:15:00.000Z', 'Still interested in the Umbreon?', 0),
  conversation('dev-dm-6', devFollowers[4], '2026-07-10T17:40:00.000Z', 'Shipped. Tracking in your email.', 120),
];

function message(id: string, senderId: string, body: string, createdAt: string): DmMessage {
  return {
    id,
    conversationId: DEV_CONVERSATION_ID,
    senderId,
    body,
    createdAt,
    sharedPostId: null,
    sharedProfileUserId: null,
    sharedProfileTab: null,
  };
}

// Oldest first, the order `fetchMessages` returns. Both sides, a long wrapped
// bubble, a one-word bubble, and a day boundary for the date stamp.
export const devThreadMessages: DmMessage[] = [
  message('dev-msg-1', DEV_PROFILE_ID, 'Hey! Saw your Charizard post — is the SIR still available?', '2026-07-15T18:02:00.000Z'),
  message('dev-msg-2', DEV_VIEWER_ID, 'It is. Looking for $600 or a trade toward a PSA 9 Base Set Blastoise.', '2026-07-15T18:10:00.000Z'),
  message('dev-msg-3', DEV_PROFILE_ID, 'I have a 9 Blastoise but the label is the old flip. Would you take that plus a little cash?', '2026-07-15T18:14:00.000Z'),
  message('dev-msg-4', DEV_VIEWER_ID, 'Maybe', '2026-07-15T18:15:00.000Z'),
  message('dev-msg-5', DEV_VIEWER_ID, 'Can you send a photo of the back and the cert number? Want to check the pop report before I say yes.', '2026-07-15T18:16:00.000Z'),
  message('dev-msg-6', DEV_PROFILE_ID, 'Sure, tonight when I get home.', '2026-07-15T18:20:00.000Z'),
  message('dev-msg-7', DEV_PROFILE_ID, 'Sounds good — see you at the Pomona show Saturday. I’ll bring the binder.', '2026-07-16T15:12:00.000Z'),
];

export const devDmOverrides: DevDmOverrides = {
  conversations: devConversations,
  messages: { [DEV_CONVERSATION_ID]: devThreadMessages },
};
