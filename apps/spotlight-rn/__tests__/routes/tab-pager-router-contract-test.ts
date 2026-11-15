import { ExpoTabRouter } from '@/components/tab-pager/tab-pager-navigator';

/**
 * Pins what the tab pager's router does with each action the app dispatches.
 *
 * THE BUG THIS EXISTS FOR
 * The drawer's "Portfolio" item once called `router.dismissTo('/you')`, i.e.
 * POP_TO. A tab router has no POP_TO case: the action returned null and was
 * DROPPED WITHOUT ERROR, so the item did nothing from any tab. The render
 * harnesses could not see it (they mock the router), so this drives the REAL
 * router directly — the same TabRouter + expo-router REPLACE override the
 * `(tabs)` navigator is built on.
 */
describe('tab pager router action contract', () => {
  const ROUTE_NAMES = ['index', 'wishlist', 'scan', 'events', 'social', 'you', 'portfolio'];
  const options = { routeNames: ROUTE_NAMES, routeParamList: {}, routeGetIdList: {} };

  const build = () => {
    const router = ExpoTabRouter({});
    return { router, state: router.getInitialState(options) };
  };

  it('DROPS a POP_TO action — this is why a drawer item may never dismissTo a tab', () => {
    const { router, state } = build();
    const result = router.getStateForAction(state, { type: 'POP_TO', payload: { name: 'you' } } as never, options);
    expect(result).toBeNull();
  });

  it('handles NAVIGATE, which is what router.push/navigate to a tab produce', () => {
    const { router, state } = build();
    const result = router.getStateForAction(state, { type: 'NAVIGATE', payload: { name: 'scan' } }, options);
    expect(result?.index).toBe(ROUTE_NAMES.indexOf('scan'));
  });

  it('handles JUMP_TO, which a settled swipe and a bar tap dispatch', () => {
    const { router, state } = build();
    const result = router.getStateForAction(
      state,
      { type: 'JUMP_TO', payload: { name: 'events' }, target: state.key },
      options,
    );
    expect(result?.index).toBe(ROUTE_NAMES.indexOf('events'));
  });

  it('turns REPLACE into a tab jump (router.replace / <Redirect> onto a tab)', () => {
    const { router, state } = build();
    const result = router.getStateForAction(
      state,
      { type: 'REPLACE', payload: { name: 'wishlist' } } as never,
      options,
    );
    expect(result?.index).toBe(ROUTE_NAMES.indexOf('wishlist'));
  });
});
