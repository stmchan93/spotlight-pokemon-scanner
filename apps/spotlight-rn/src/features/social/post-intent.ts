/**
 * Show post types (social_33 `posts.post_intent`). Only posts tagged to a show
 * carry one; it is optional even there.
 */
export type PostIntent = 'looking_for' | 'selling' | 'buying';

/** Display order everywhere: composer chips, feed filter chips. */
export const POST_INTENTS: readonly PostIntent[] = ['looking_for', 'selling', 'buying'];

const POST_INTENT_LABELS: Record<PostIntent, string> = {
  looking_for: 'Looking for',
  selling: 'Selling',
  buying: 'Buying',
};

export function postIntentLabel(intent: PostIntent): string {
  return POST_INTENT_LABELS[intent];
}

/** A column value the client knows how to render, or null for anything else. */
export function parsePostIntent(value: unknown): PostIntent | null {
  return typeof value === 'string' && (POST_INTENTS as readonly string[]).includes(value)
    ? (value as PostIntent)
    : null;
}

/** Vendor-side types: the post points at stock or a buylist at a booth. */
export function isBoothIntent(intent: PostIntent | null | undefined): boolean {
  return intent === 'selling' || intent === 'buying';
}
