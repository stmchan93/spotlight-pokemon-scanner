import { eventLocalDate, isInBoothWindow } from '@/features/events/hooks/use-active-booth';
import { boothBannerCopy } from '@/features/scanner/components/booth-post-banner';

const show = { startDate: '2026-12-13', endDate: '2026-12-14', timezone: 'Pacific/Honolulu' };

describe('booth window', () => {
  it('opens the day before the show and closes after its last day, in the show timezone', () => {
    // 2026-12-12 10:00 in Honolulu (UTC-10).
    expect(isInBoothWindow(show, new Date('2026-12-12T20:00:00Z'))).toBe(true);
    // 2026-12-11 23:00 in Honolulu, though already the 12th in UTC.
    expect(isInBoothWindow(show, new Date('2026-12-12T09:00:00Z'))).toBe(false);
    expect(isInBoothWindow(show, new Date('2026-12-15T09:00:00Z'))).toBe(true); // 12-14 23:00 HST
    expect(isInBoothWindow(show, new Date('2026-12-15T11:00:00Z'))).toBe(false); // 12-15 01:00 HST
  });

  it('crosses a month boundary for the setup day', () => {
    const first = { startDate: '2026-12-01', endDate: '2026-12-01', timezone: 'UTC' };
    expect(isInBoothWindow(first, new Date('2026-11-30T12:00:00Z'))).toBe(true);
    expect(isInBoothWindow(first, new Date('2026-11-29T12:00:00Z'))).toBe(false);
  });

  it('falls back to the device day for an unknown timezone', () => {
    expect(eventLocalDate('Not/AZone', new Date(2026, 9, 29, 12))).toBe('2026-10-29');
  });
});

describe('scanner booth banner copy', () => {
  it('shows a live count only when it reads as busy', () => {
    expect(boothBannerCopy(41)).toBe('41 people are browsing the map. Post your booth →');
    expect(boothBannerCopy(2)).toBe('Attendees are browsing the map. Post your booth →');
    expect(boothBannerCopy(null)).toBe('Attendees are browsing the map. Post your booth →');
  });
});
