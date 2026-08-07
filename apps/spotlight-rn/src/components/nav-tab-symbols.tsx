import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import { CollectionTabIcon, ScanTabIcon, WishlistTabIcon } from './nav-tab-icons';

/**
 * SF Symbol glyphs for the bottom bar, so the custom pill reads as the system
 * tab bar rather than as a lookalike.
 *
 * WHY NOT JUST USE NATIVE TABS
 * Native tabs were evaluated and rejected for THIS bar, on a hard constraint
 * rather than taste: `NativeBottomTabsNavigator.js` emits `tabPress` and then
 * dispatches JUMP_TO unconditionally — it never reads `defaultPrevented`. So a
 * native tab item can't be intercepted to push a screen instead of switching,
 * which the Scan slot has to do, and a native bar necessarily renders on the
 * Scanner (insetting the camera and shrinking the reticle). The custom bar
 * already satisfies every behavioural requirement; only the glyphs differed.
 *
 * SAFE TO SHIP OVER OTA. ExpoSymbols is already compiled into the binary as a
 * transitive pod (Podfile.lock: `ExpoSymbols (55.0.7)`), so this needs no native
 * build. The probe below still guards it, for the same reason
 * `native-image-picker.ts` does: a missing native module must degrade, never
 * crash — that exact assumption is what took the composer down once already.
 */
const SYMBOLS_NATIVE_MODULE = 'ExpoSymbols';

function hasNativeSymbols(): boolean {
  return Platform.OS === 'ios' && requireOptionalNativeModule(SYMBOLS_NATIVE_MODULE) != null;
}

type NavSymbolProps = {
  color: string;
  size: number;
  /** Selected state renders the filled variant, matching UIKit's tab behaviour. */
  filled?: boolean;
};

function SfSymbol({
  color,
  filled,
  name,
  selectedName,
  size,
}: NavSymbolProps & { name: string; selectedName: string }) {
  // Required lazily so the import never evaluates on a target without the native
  // module — the probe above decides, and a top-level import would defeat it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SymbolView } = require('expo-symbols') as typeof import('expo-symbols');

  return (
    <SymbolView
      name={(filled === true ? selectedName : name) as never}
      resizeMode="scaleAspectFit"
      size={size}
      tintColor={color}
      // UIKit tab glyphs are medium, not regular — regular reads thin and washed
      // out against the glass at this size.
      weight="medium"
    />
  );
}

export function CollectionNavSymbol(props: NavSymbolProps) {
  if (!hasNativeSymbols()) {
    return <CollectionTabIcon {...props} />;
  }
  return <SfSymbol {...props} name="square.grid.2x2" selectedName="square.grid.2x2.fill" />;
}

export function ScanNavSymbol(props: NavSymbolProps) {
  if (!hasNativeSymbols()) {
    return <ScanTabIcon {...props} />;
  }
  // `viewfinder` has no filled counterpart in SF Symbols; the selected state
  // uses the version with a centred dot, which is UIKit's own convention here.
  return <SfSymbol {...props} name="viewfinder" selectedName="viewfinder.circle.fill" />;
}

export function WishlistNavSymbol(props: NavSymbolProps) {
  if (!hasNativeSymbols()) {
    return <WishlistTabIcon {...props} />;
  }
  return <SfSymbol {...props} name="bookmark" selectedName="bookmark.fill" />;
}
