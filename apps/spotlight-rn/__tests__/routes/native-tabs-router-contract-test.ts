import { NativeBottomTabsRouter } from 'expo-router/build/native-tabs/NativeBottomTabsRouter';

/**
 * Pins the upstream constraint that made a drawer item silently dead.
 *
 * THE BUG THIS EXISTS FOR
 * The drawer's "Portfolio" item called `router.dismissTo('/you')`. `dismissTo`
 * dispatches POP_TO. From a PUSHED screen that diverges at the root stack, where
 * `StackRouter` implements POP_TO — so it worked. From a TAB it diverges inside
 * the tabs navigator, whose `NativeBottomTabsRouter` special-cases only NAVIGATE
 * and delegates the rest to `TabRouter`, which has no POP_TO case. The action
 * returned null and was DROPPED WITHOUT ERROR. Tapping the item did nothing, and
 * nothing anywhere said why.
 *
 * WHY A CONTRACT TEST AND NOT A RENDER TEST
 * This class of bug cannot reproduce in the app's normal harness, which is
 * exactly how it shipped:
 *   - `jest.setup.ts` mocks `expo-router/unstable-native-tabs` so `<NativeTabs>`
 *     renders a `<Slot>` — that builds a STACK router, where POP_TO works fine.
 *   - `app-drawer-test` hands the component a jest-mocked router, so asserting
 *     "dismissTo was called" passed green on the broken behaviour.
 * Both harnesses agreed the code worked. So this drives the REAL router directly
 * and asserts what it does with each action, with no rendering involved.
 *
 * If an expo-router upgrade teaches the native tabs router to handle POP_TO,
 * this test fails — which is the signal that the constraint has lifted, not a
 * breakage.
 */
describe('NativeBottomTabsRouter action contract', () => {
  const ROUTE_NAMES = ['index', 'scan', 'wishlist', 'you'];

  const buildRouter = () => NativeBottomTabsRouter({});

  const initialState = () => {
    const router = buildRouter();
    return router.getInitialState({
      routeNames: ROUTE_NAMES,
      routeParamList: {},
      routeGetIdList: {},
    });
  };

  it('DROPS a POP_TO action — this is why a drawer item may never dismissTo a tab', () => {
    const router = buildRouter();
    const state = initialState();

    const result = router.getStateForAction(
      state,
      { type: 'POP_TO', payload: { name: 'you' } },
      { routeNames: ROUTE_NAMES, routeParamList: {}, routeGetIdList: {} },
    );

    // null = unhandled. React Navigation then bubbles it to the parent, and when
    // nothing up the tree handles it either, it is discarded in silence.
    expect(result).toBeNull();
  });

  it('handles NAVIGATE, which is what push/tab-press produce', () => {
    const router = buildRouter();
    const state = initialState();

    const result = router.getStateForAction(
      state,
      { type: 'NAVIGATE', payload: { name: 'you' } },
      { routeNames: ROUTE_NAMES, routeParamList: {}, routeGetIdList: {} },
    );

    expect(result).not.toBeNull();
    expect(result?.index).toBe(ROUTE_NAMES.indexOf('you'));
  });
});
