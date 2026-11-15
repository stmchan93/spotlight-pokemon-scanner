import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Xmark } from 'iconoir-react-native';

import { Text, useSpotlightTheme } from '@spotlight/design-system';

import { fetchBrowsingNow, hasPostedToBoothSince } from '@/features/events/booth-service';
import { useActiveBooth } from '@/features/events/hooks/use-active-booth';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';

const DISMISS_KEY_PREFIX = '@spotlight/scanner/booth-banner-dismissed/';
const BROWSING_POLL_MS = 60_000;
// Below this a live count reads as empty rather than busy.
const MIN_BROWSING_TO_SHOW = 3;

function localDay(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function startOfLocalDay(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function boothBannerCopy(browsing: number | null): string {
  return browsing != null && browsing >= MIN_BROWSING_TO_SHOW
    ? `${browsing} people are browsing the map. Post your booth →`
    : 'Attendees are browsing the map. Post your booth →';
}

type BoothPostBannerProps = {
  /** The scanner tab is on screen. False = no reads, no polling. */
  active: boolean;
  /** Other chrome owns this band right now (tray open, tooltip, binder mode). */
  hidden: boolean;
  /** Absolute top, between the top chrome row and the reticle. */
  top: number;
};

/**
 * "N people are browsing the map. Post your booth →" for a booth claimer during
 * a show window who hasn't posted to their booth today. Pure overlay: it never
 * touches the camera, and it reads Supabase only while the scanner is active.
 */
export function BoothPostBanner({ active, hidden, top }: BoothPostBannerProps) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const { sessionOwnerKey } = useAppServices();
  const booth = useActiveBooth({ enabled: active });
  const eventId = booth?.eventId ?? null;
  const vendorId = booth?.vendorId ?? null;
  const dismissKey = `${DISMISS_KEY_PREFIX}${sessionOwnerKey}`;

  // null = still checking; the banner only shows on a definite "no".
  const [eligible, setEligible] = useState<boolean | null>(null);
  const [browsing, setBrowsing] = useState<number | null>(null);
  // Tapped through to the composer this session: don't nag on the way back.
  const [tapped, setTapped] = useState(false);

  useEffect(() => {
    setEligible(null);
    if (!active || !eventId || !vendorId) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const dismissed = await AsyncStorage.getItem(dismissKey).catch(() => null);
      if (dismissed === `${eventId}:${localDay()}`) {
        if (!cancelled) {
          setEligible(false);
        }
        return;
      }
      const posted = await hasPostedToBoothSince(eventId, vendorId, startOfLocalDay());
      if (!cancelled) {
        setEligible(posted === false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, dismissKey, eventId, vendorId]);

  const visible = active && !hidden && !tapped && eligible === true && booth != null;

  useEffect(() => {
    if (!visible || !eventId) {
      return;
    }
    let cancelled = false;
    const poll = () => {
      void fetchBrowsingNow(eventId).then((count) => {
        if (!cancelled) {
          setBrowsing(count);
        }
      });
    };
    poll();
    const timer = setInterval(poll, BROWSING_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [eventId, visible]);

  const handlePress = useCallback(() => {
    if (!eventId || !vendorId) {
      return;
    }
    setTapped(true);
    capturePostHogEvent(AnalyticsEvent.boothBannerTapped, { event_id: eventId, vendor_id: vendorId });
    router.push({ pathname: '/new-post', params: { eventId, vendorId } } as never);
  }, [eventId, router, vendorId]);

  const handleDismiss = useCallback(() => {
    setEligible(false);
    if (eventId) {
      void AsyncStorage.setItem(dismissKey, `${eventId}:${localDay()}`).catch(() => undefined);
    }
  }, [dismissKey, eventId]);

  if (!visible) {
    return null;
  }

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top }]} testID="scanner-booth-banner">
      <View
        style={[
          styles.banner,
          {
            backgroundColor: theme.colors.gray900,
            borderCurve: 'continuous',
            borderRadius: theme.radii.pill,
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          onPress={handlePress}
          style={({ pressed }) => [styles.body, { opacity: pressed ? 0.8 : 1 }]}
          testID="scanner-booth-banner-open"
        >
          <Text
            numberOfLines={1}
            style={[theme.typography.captionMedium, { color: theme.colors.gray0 }]}
            testID="scanner-booth-banner-text"
          >
            {boothBannerCopy(browsing)}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Dismiss for today"
          accessibilityRole="button"
          hitSlop={8}
          onPress={handleDismiss}
          style={styles.dismiss}
          testID="scanner-booth-banner-dismiss"
        >
          <Xmark color={theme.colors.gray0} height={14} width={14} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 32,
    maxWidth: '100%',
    paddingLeft: 14,
    paddingRight: 6,
  },
  body: {
    flexShrink: 1,
    justifyContent: 'center',
    minHeight: 32,
  },
  dismiss: {
    alignItems: 'center',
    height: 28,
    justifyContent: 'center',
    marginLeft: 4,
    width: 28,
  },
  wrap: {
    alignItems: 'center',
    left: 16,
    position: 'absolute',
    right: 16,
    zIndex: 5,
  },
});
