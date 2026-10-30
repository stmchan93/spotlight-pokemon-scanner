import { useEffect, useMemo, useState } from 'react';

import type { SpotlightEvent } from '@spotlight/api-client';

import { fetchMyBoothClaims } from '@/features/events/booth-service';
import { useSpotlightEventMap } from '@/features/events/hooks/use-spotlight-event-map';
import { useSpotlightEvents } from '@/features/events/hooks/use-spotlight-events';
import { useAuth } from '@/providers/auth-provider';
import { resolveRuntimeAppEnv } from '@/lib/runtime-config';

const STAGING = resolveRuntimeAppEnv() === 'staging';

export type ActiveBooth = {
  eventId: string;
  /** The show's short title ("Spotlight Ontario"). */
  eventName: string;
  vendorId: string;
  /** Null until the floor map loads (or when the vendor left the map). */
  vendorName: string | null;
};

/** `YYYY-MM-DD` for `now` in the show's own timezone; the device's day if the zone is unusable. */
export function eventLocalDate(timezone: string, now: Date): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      day: '2-digit',
      month: '2-digit',
      timeZone: timezone || undefined,
      year: 'numeric',
    }).format(now);
  } catch {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }
}

function dayBefore(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) - 1)).toISOString().slice(0, 10);
}

/** Booth window: the setup day before the show through its last day, in the show's timezone. */
export function isInBoothWindow(
  event: Pick<SpotlightEvent, 'startDate' | 'endDate' | 'timezone'>,
  now: Date,
): boolean {
  if (!event.startDate || !event.endDate) {
    return false;
  }
  const today = eventLocalDate(event.timezone, now);
  return today >= dayBefore(event.startDate) && today <= event.endDate;
}

type UseActiveBoothOptions = {
  /** From the map's "Post to your booth" link; skips the window + claim lookup. */
  eventId?: string | null;
  vendorId?: string | null;
  /** False = no reads at all (e.g. the scanner while it is off-screen). */
  enabled?: boolean;
};

/**
 * The booth the signed-in user can post to right now, or null.
 *
 * With explicit ids it trusts them (the DB trigger still rejects a tag from a
 * non-claimer) and only resolves display names. Without them it needs a show in
 * its booth window AND an active claim on one of that show's vendors.
 */
export function useActiveBooth({ eventId, vendorId, enabled = true }: UseActiveBoothOptions = {}): ActiveBooth | null {
  const explicit = Boolean(eventId && vendorId);
  const { currentUser } = useAuth();
  const userId = currentUser?.id ?? null;
  const { events } = useSpotlightEvents(enabled);
  // The window is a day wide; checking it once per mount is enough.
  const [now] = useState(() => new Date());

  const event = useMemo(() => {
    if (explicit) {
      return events.find((item) => item.id === eventId) ?? null;
    }
    const mapped = events.filter((item) => item.floorMapUrl != null);
    const live = mapped.find((item) => isInBoothWindow(item, now));
    if (live || !STAGING) {
      return live ?? null;
    }
    // Staging only: with no show on, the latest mapped show stands in so the
    // banner and composer toggle can be tested between shows.
    return [...mapped].sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))[0] ?? null;
  }, [eventId, events, explicit, now]);

  const [claims, setClaims] = useState<string[] | null>(null);
  const needsClaims = enabled && !explicit && event != null && userId != null;
  useEffect(() => {
    if (!needsClaims) {
      setClaims(null);
      return;
    }
    let cancelled = false;
    void fetchMyBoothClaims().then((vendorIds) => {
      if (!cancelled) {
        setClaims(vendorIds);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [needsClaims, userId]);

  // Without a claim there is nothing to name, so the map is never fetched.
  const wantsMap = enabled && event != null && (explicit || (claims?.length ?? 0) > 0);
  const { map } = useSpotlightEventMap(wantsMap && event ? event.floorMapUrl : null);

  return useMemo(() => {
    if (!enabled) {
      return null;
    }
    if (explicit && eventId && vendorId) {
      const vendor = map?.vendors.find((item) => item.id === vendorId) ?? null;
      return {
        eventId,
        eventName: event?.shortTitle ?? 'this show',
        vendorId,
        vendorName: vendor?.name ?? null,
      };
    }
    if (!event || !map || !claims || claims.length === 0) {
      return null;
    }
    const vendor = map.vendors.find((item) => claims.includes(item.id));
    if (!vendor) {
      return null;
    }
    return { eventId: event.id, eventName: event.shortTitle, vendorId: vendor.id, vendorName: vendor.name };
  }, [claims, enabled, event, eventId, explicit, map, vendorId]);
}
