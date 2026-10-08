import type { SpotlightEvent } from '@spotlight/api-client';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type DateParts = { month: number; day: number };

// Dates are calendar days in the event's own timezone; parse them as plain
// parts so the viewer's timezone can never shift a day.
function parts(value: string): DateParts {
  const [, month, day] = value.split('-').map(Number);
  return { month: month ?? 1, day: day ?? 1 };
}

function monthLabel(month: number): string {
  const name = MONTHS[month - 1] ?? '';
  // "May" has nothing abbreviated, so no period.
  return name.length > 0 && name !== 'May' ? `${name}.` : name;
}

/** "Oct. 24–25", "Aug. 30–Sep. 1", or "Oct. 24" (list + carousel). */
export function formatEventDateRange(event: Pick<SpotlightEvent, 'startDate' | 'endDate'>): string {
  const start = parts(event.startDate);
  const end = parts(event.endDate);
  if (start.month === end.month && start.day === end.day) {
    return `${monthLabel(start.month)} ${start.day}`;
  }
  if (start.month === end.month) {
    return `${monthLabel(start.month)} ${start.day}–${end.day}`;
  }
  return `${monthLabel(start.month)} ${start.day}–${monthLabel(end.month)} ${end.day}`;
}

/** "8/23–8/24" or "8/23" (detail page). */
export function formatEventNumericDateRange(event: Pick<SpotlightEvent, 'startDate' | 'endDate'>): string {
  const start = parts(event.startDate);
  const end = parts(event.endDate);
  const startLabel = `${start.month}/${start.day}`;
  return event.startDate === event.endDate ? startLabel : `${startLabel}–${end.month}/${end.day}`;
}

function clock(value: string, withMinutes: boolean): string {
  const [hourText, minuteText] = value.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  if (!withMinutes && minute === 0) {
    return `${hour12}${suffix}`;
  }
  return `${hour12}:${String(minute).padStart(2, '0')}${suffix}`;
}

/**
 * "10AM - 5PM" (compact) or "10:00AM - 5:00PM" (full). Null when the hours
 * are not set.
 */
export function formatEventHours(
  event: Pick<SpotlightEvent, 'openTime' | 'closeTime'>,
  style: 'compact' | 'full' = 'compact',
): string | null {
  if (!event.openTime || !event.closeTime) {
    return null;
  }
  const withMinutes = style === 'full';
  return `${clock(event.openTime, withMinutes)} - ${clock(event.closeTime, withMinutes)}`;
}

/** "8/23–8/24, 10:00AM - 5:00PM" — the detail page's schedule line. */
export function formatEventSchedule(event: SpotlightEvent): string {
  const hours = formatEventHours(event, 'full');
  const dates = formatEventNumericDateRange(event);
  return hours ? `${dates}, ${hours}` : dates;
}

export function formatEventShareMessage(event: SpotlightEvent): string {
  return [
    event.title,
    `${formatEventSchedule(event)} · ${event.venue}`,
    event.shareUrl ? null : event.ticketUrl,
  ]
    .filter(Boolean)
    .join('\n');
}
