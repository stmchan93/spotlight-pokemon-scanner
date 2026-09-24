import type { MetaLane, NewsItem } from '@spotlight/api-client';

import { formatAbbreviatedCurrency } from '@/features/portfolio/components/portfolio-formatting';

/**
 * "+18.4%" / "−4.1%" — one decimal, none once the move is three digits. The
 * minus is U+2212 to match the mockups' typography next to a "+".
 */
export function formatSignedPercent(value: number): string {
  const magnitude = Math.abs(value);
  const digits = magnitude >= 100 ? 0 : 1;
  const rounded = magnitude.toFixed(digits);
  if (Number(rounded) === 0) {
    return `${(0).toFixed(digits)}%`;
  }
  return `${value > 0 ? '+' : '−'}${rounded}%`;
}

/** "+$412k" / "−$22k" for tight value columns. */
export function formatSignedCompactUsd(value: number, currencyCode = 'USD'): string {
  const absolute = formatAbbreviatedCurrency(Math.abs(value), currencyCode);
  if (value === 0) {
    return absolute;
  }
  return `${value > 0 ? '+' : '−'}${absolute}`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

/** "212K" / "1.4M" for view counts. */
export function formatCompactCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`;
  }
  return String(value);
}

/** "1h", "3d", "2w" — the source-line age used across the news rows. */
export function formatAge(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return '';
  }
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 60) {
    return `${Math.max(minutes, 1)}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return `${weeks}w`;
  }
  return new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "14:08" / "1:02:10" for a video thumbnail's duration badge. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "PokéBeach · 1h" — the eyebrow above a headline. */
export function newsSourceLine(item: NewsItem, now = Date.now()): string {
  const age = formatAge(item.publishedAt, now);
  const source = item.video ? `YouTube · ${item.video.channelTitle}` : item.source;
  return age ? `${source} · ${age}` : source;
}

/** "Oct 2021" from an ISO date; null when unparseable. */
export function formatReleaseMonth(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC', year: 'numeric' });
}

export function laneLabel(lane: MetaLane): string {
  return lane === 'graded' ? 'Graded' : 'Raw';
}

/** "PSA 10" for a graded row, null for raw. */
export function gradeLabel(grader: string | null, grade: string | null): string | null {
  const parts = [grader, grade].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length > 0 ? parts.join(' ') : null;
}

/** "PokeRev · 212K views · 3d" — the line under a VideoTile. */
export function videoMetaLine(item: NewsItem, now = Date.now()): string {
  const channel = item.video?.channelTitle ?? item.source;
  const views = item.video?.viewCount != null ? `${formatCompactCount(item.video.viewCount)} views` : null;
  return [channel, views, formatAge(item.publishedAt, now) || null].filter(Boolean).join(' · ');
}
