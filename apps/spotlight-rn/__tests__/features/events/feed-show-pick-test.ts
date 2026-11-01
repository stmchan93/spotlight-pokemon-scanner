import { canTagShow, pickActiveShow, pickFeedShow } from '@/features/events/hooks/use-active-show';

import { makeEvent } from './event-fixtures';

const now = new Date('2026-11-14T20:00:00Z');
const onNow = makeEvent({ id: 'on-now', startDate: '2026-11-14', endDate: '2026-11-15', timezone: 'UTC', floorMapUrl: null });
const nextMonth = makeEvent({ id: 'next', startDate: '2026-12-13', endDate: '2026-12-14', status: 'upcoming' });
const later = makeEvent({ id: 'later', startDate: '2027-02-01', endDate: '2027-02-01', status: 'upcoming' });
const past = makeEvent({ id: 'past', startDate: '2026-08-22', endDate: '2026-08-23', status: 'past' });

describe('pickActiveShow', () => {
  it('finds the show in its window, mapped or not unless asked', () => {
    expect(pickActiveShow([nextMonth, onNow], now, { stagingFallback: false })?.id).toBe('on-now');
    expect(pickActiveShow([nextMonth, onNow], now, { mappedOnly: true, stagingFallback: false })).toBeNull();
  });

  it('falls back to the latest mapped show on staging only', () => {
    expect(pickActiveShow([past, nextMonth], now, { stagingFallback: false })).toBeNull();
    expect(pickActiveShow([past, nextMonth], now, { stagingFallback: true })?.id).toBe('next');
  });
});

describe('pickFeedShow', () => {
  it('prefers the live show over a saved one', () => {
    expect(pickFeedShow([onNow, nextMonth], new Set(['next']), now, false)?.id).toBe('on-now');
  });

  it('offers the soonest saved show that has not ended', () => {
    expect(pickFeedShow([past, later, nextMonth], new Set(['past', 'later', 'next']), now, false)?.id).toBe('next');
  });

  it('offers nothing with no show on and none saved', () => {
    expect(pickFeedShow([past, nextMonth], new Set(), now, false)).toBeNull();
  });
});

describe('canTagShow', () => {
  it('opens tagging in the window, and always on staging', () => {
    expect(canTagShow(onNow, now, false)).toBe(true);
    expect(canTagShow(nextMonth, now, false)).toBe(false);
    expect(canTagShow(nextMonth, now, true)).toBe(true);
  });
});
