import { useCallback } from 'react';
import { Pressable } from 'react-native';
import { useRouter } from 'expo-router';

import { Text, useSpotlightTheme } from '@spotlight/design-system';

import { usePostEventLabel } from '@/features/events/hooks/use-post-event-label';

export type PostEventBadgeMode = 'show' | 'booth';

type PostEventBadgeProps = {
  eventId: string;
  boothVendorId: string | null;
  /**
   * `show`: "📍 Spotlight Ontario · Table C1" (every feed).
   * `booth`: "📍 Vendor · Table C1" on the show's own feed, where the show is
   * implied; renders nothing for attendee posts there.
   */
  mode?: PostEventBadgeMode;
  testID?: string;
};

export function formatPostEventBadge(
  mode: PostEventBadgeMode,
  label: { showTitle: string | null; vendorName: string | null; table: string | null },
): string | null {
  if (mode === 'booth') {
    const parts = [label.vendorName, label.table].filter(Boolean);
    return parts.length > 0 ? `📍 ${parts.join(' · ')}` : null;
  }
  return `📍 ${[label.showTitle ?? 'Card show', label.table].filter(Boolean).join(' · ')}`;
}

/** A post's show tag; taps through to the show (booth posts: with the vendor selected). */
export function PostEventBadge({ eventId, boothVendorId, mode = 'show', testID = 'post-event-badge' }: PostEventBadgeProps) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const label = usePostEventLabel(eventId, boothVendorId);
  const text = mode === 'booth' && !boothVendorId ? null : formatPostEventBadge(mode, label);

  const open = useCallback(() => {
    const path = `/events/${encodeURIComponent(eventId)}`;
    router.push((boothVendorId ? `${path}?vendor=${encodeURIComponent(boothVendorId)}` : path) as never);
  }, [boothVendorId, eventId, router]);

  if (!text) {
    return null;
  }
  return (
    <Pressable accessibilityRole="link" hitSlop={6} onPress={open} testID={testID}>
      <Text numberOfLines={1} style={[theme.typography.captionMedium, { color: theme.colors.gray700 }]}>
        {text}
      </Text>
    </Pressable>
  );
}
