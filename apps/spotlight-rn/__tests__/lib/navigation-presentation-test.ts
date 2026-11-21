import { SLIDE_UP_SCREEN_OPTIONS, slideUpStackGroupOptions } from '@/lib/navigation-presentation';

describe('slideUpStackGroupOptions', () => {
  it('slides Ask Ekalight up from the bottom; Edit profile is a side push', () => {
    expect(slideUpStackGroupOptions({ route: { params: { screen: 'assistant' } } })).toBe(SLIDE_UP_SCREEN_OPTIONS);
    expect(slideUpStackGroupOptions({ route: { params: { screen: 'edit-profile' } } })).toEqual({});
    expect(SLIDE_UP_SCREEN_OPTIONS).toMatchObject({ animation: 'slide_from_bottom', gestureDirection: 'vertical' });
  });

  it('leaves every other stack route on the default push', () => {
    expect(slideUpStackGroupOptions({ route: { params: { screen: 'cards/[cardId]' } } })).toEqual({});
    expect(slideUpStackGroupOptions({ route: {} })).toEqual({});
  });
});
