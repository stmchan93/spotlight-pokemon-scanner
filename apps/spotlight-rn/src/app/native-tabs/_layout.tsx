import { NativeTabs } from 'expo-router/unstable-native-tabs';

const { Trigger } = NativeTabs;
const { Icon, Label } = Trigger;

/**
 * PHASE 1 of native-tab adoption — see docs/native-tabs-adoption-plan-2026-08-07.md.
 *
 * The REAL Collection and Scanner mounted in Apple's native tab bar, reachable
 * only at /native-tabs. The live `(tabs)` pager is untouched, so this is a true
 * side-by-side: same screens, same data, two navigation shells.
 *
 * It is deliberately NOT behind a boolean flag in the live route. Swapping
 * `(tabs)` between a pager and native tabs would mean one route tree trying to
 * be both, and the failure mode we care about most — the camera mounting when it
 * shouldn't — is exactly the kind of bug that hides in that branching. A
 * separate route proves the behaviour first; flipping the default is Phase 2.
 */
export default function NativeTabsLayout() {
  return (
    <NativeTabs minimizeBehavior="onScrollDown">
      <Trigger name="index">
        <Icon sf={{ default: 'square.grid.2x2', selected: 'square.grid.2x2.fill' }} />
        <Label>Collection</Label>
      </Trigger>
      <Trigger name="scan">
        <Icon sf={{ default: 'viewfinder', selected: 'viewfinder' }} />
        <Label>Scan</Label>
      </Trigger>
    </NativeTabs>
  );
}
