import {
  formatEventDateRange,
  formatEventHours,
  formatEventNumericDateRange,
  formatEventSchedule,
  formatEventShareMessage,
} from '@/features/events/event-format';

import { makeEvent } from './event-fixtures';

describe('formatEventDateRange', () => {
  it('collapses a same-month range to one month label', () => {
    expect(formatEventDateRange({ startDate: '2026-10-24', endDate: '2026-10-25' })).toBe('Oct. 24–25');
  });

  it('labels both months across a month boundary', () => {
    expect(formatEventDateRange({ startDate: '2026-08-30', endDate: '2026-09-01' })).toBe('Aug. 30–Sep. 1');
  });

  it('shows a single day once', () => {
    expect(formatEventDateRange({ startDate: '2026-10-24', endDate: '2026-10-24' })).toBe('Oct. 24');
  });

  it('writes May without a period', () => {
    expect(formatEventDateRange({ startDate: '2026-05-02', endDate: '2026-05-03' })).toBe('May 2–3');
    expect(formatEventDateRange({ startDate: '2026-04-30', endDate: '2026-05-01' })).toBe('Apr. 30–May 1');
  });
});

describe('formatEventNumericDateRange', () => {
  it('renders m/d ranges and single days', () => {
    expect(formatEventNumericDateRange({ startDate: '2026-08-23', endDate: '2026-08-24' })).toBe('8/23–8/24');
    expect(formatEventNumericDateRange({ startDate: '2026-08-30', endDate: '2026-09-01' })).toBe('8/30–9/1');
    expect(formatEventNumericDateRange({ startDate: '2026-08-23', endDate: '2026-08-23' })).toBe('8/23');
  });
});

describe('formatEventHours', () => {
  it('drops :00 in compact style and keeps it in full style', () => {
    const event = { openTime: '10:00', closeTime: '17:00' };
    expect(formatEventHours(event)).toBe('10AM - 5PM');
    expect(formatEventHours(event, 'compact')).toBe('10AM - 5PM');
    expect(formatEventHours(event, 'full')).toBe('10:00AM - 5:00PM');
  });

  it('treats 12:00 as noon and 00:00 as midnight', () => {
    expect(formatEventHours({ openTime: '12:00', closeTime: '00:00' })).toBe('12PM - 12AM');
    expect(formatEventHours({ openTime: '00:00', closeTime: '12:00' }, 'full')).toBe('12:00AM - 12:00PM');
  });

  it('keeps half hours even in compact style', () => {
    expect(formatEventHours({ openTime: '09:30', closeTime: '16:30' })).toBe('9:30AM - 4:30PM');
    expect(formatEventHours({ openTime: '09:30', closeTime: '17:00' })).toBe('9:30AM - 5PM');
  });

  it('is null when either end is missing', () => {
    expect(formatEventHours({ openTime: null, closeTime: '17:00' })).toBeNull();
    expect(formatEventHours({ openTime: '10:00', closeTime: null })).toBeNull();
    expect(formatEventHours({ openTime: null, closeTime: null }, 'full')).toBeNull();
  });
});

describe('formatEventSchedule', () => {
  it('joins numeric dates and full hours', () => {
    expect(formatEventSchedule(makeEvent())).toBe('10/24–10/25, 10:00AM - 5:00PM');
  });

  it('is just the dates without hours', () => {
    expect(formatEventSchedule(makeEvent({ openTime: null, closeTime: null }))).toBe('10/24–10/25');
  });
});

describe('formatEventShareMessage', () => {
  it('includes the ticket link when there is no share link', () => {
    expect(formatEventShareMessage(makeEvent())).toBe(
      [
        'Spotlight at the Hawaii Convention Center',
        '10/24–10/25, 10:00AM - 5:00PM · Hawaii Convention Center',
        'https://example.com/tickets/hawaii',
      ].join('\n'),
    );
  });

  it('leaves the ticket link out when a share link exists (it travels as the url)', () => {
    const message = formatEventShareMessage(makeEvent({ shareUrl: 'https://example.com/e/hawaii' }));
    expect(message).not.toContain('tickets');
    expect(message).not.toContain('https://example.com/e/hawaii');
    expect(message.split('\n')).toHaveLength(2);
  });

  it('has no trailing line when there is neither link', () => {
    expect(formatEventShareMessage(makeEvent({ ticketUrl: null })).split('\n')).toHaveLength(2);
  });
});
