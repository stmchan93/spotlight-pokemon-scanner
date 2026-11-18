import { SLIDE_UP_SCREEN_OPTIONS, slideUpStackGroupOptions } from '@/lib/navigation-presentation';

describe('slideUpStackGroupOptions', () => {
  it('slides Ask Ekalight and Edit profile up from the bottom', () => {
    expect(slideUpStackGroupOptions({ route: { params: { screen: 'assistant' } } })).toBe(SLIDE_UP_SCREEN_OPTIONS);
    expect(slideUpStackGroupOptions({ route: { params: { screen: 'edit-profile' } } })).toBe(SLIDE_UP_SCREEN_OPTIONS);
    expect(SLIDE_UP_SCREEN_OPTIONS).toMatchObject({ animation: 'slide_from_bottom', gestureDirection: 'vertical' });
  });

  it('leaves every other stack route on the default push', () => {
    expect(slideUpStackGroupOptions({ route: { params: { screen: 'cards/[cardId]' } } })).toEqual({});
    expect(slideUpStackGroupOptions({ route: {} })).toEqual({});
  });
});
