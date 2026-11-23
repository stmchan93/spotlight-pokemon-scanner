import {
  ASSISTANT_SHEET_DETENT,
  ASSISTANT_SHEET_OPTIONS,
  SLIDE_UP_SCREEN_OPTIONS,
} from '@/lib/navigation-presentation';

describe('navigation presentation presets', () => {
  it('slides Search up from the bottom, swipe-down from the top zone', () => {
    expect(SLIDE_UP_SCREEN_OPTIONS).toMatchObject({ animation: 'slide_from_bottom', gestureDirection: 'vertical' });
  });

  it('opens Ask Ekalight as a native 90% form sheet with a grabber and the sheet corner radius', () => {
    expect(ASSISTANT_SHEET_DETENT).toBeGreaterThanOrEqual(0.8);
    expect(ASSISTANT_SHEET_DETENT).toBeLessThan(1);
    expect(ASSISTANT_SHEET_OPTIONS).toMatchObject({
      presentation: 'formSheet',
      sheetAllowedDetents: [ASSISTANT_SHEET_DETENT],
      sheetCornerRadius: 20,
      sheetGrabberVisible: true,
    });
  });
});
