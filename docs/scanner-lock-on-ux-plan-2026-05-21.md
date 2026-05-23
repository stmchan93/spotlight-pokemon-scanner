# Scanner Lock-On UX — "Tap to Scan" Pill

**Status: DEFERRED** — Corpus growth is the current priority. Ship once card coverage plateaus and slab matching is stable.

**Written:** 2026-05-21  
**Author:** Claude Sonnet 4.6

---

## What This Is

A pre-capture lock-on UX for the scanner. When the camera detects a scannable object in frame, a **yellow animated pill** appears above the reticle saying **"Tap to scan"**. The pill is the user's signal that the scanner is ready and has a card/slab locked. Tapping it (or the reticle, as today) fires the capture.

This is similar to how Phynite and other card scanner apps present a detection-confirmed state before committing to a scan.

**Why deferred:**
- Adds real-time pre-capture capture loop (CPU risk on older devices)
- Raw card lock-on has no detection signal today (requires new native work)
- Current priority is growing the card corpus and fixing match accuracy

---

## User-Facing Flow

```
Camera ready, no object detected
  → Reticle visible, no pill

Camera ready, object detected in frame (slab/card visible)
  → Yellow pill slides in above reticle: "Tap to scan"

User taps pill (or reticle)
  → Pill fades out, capture fires normally
  → Full-resolution photo taken, classifier runs, match returned

Camera moved away from object
  → Pill fades out within ~400ms
```

---

## Technical Architecture

### Core constraint: expo-camera has no frameProcessor API

The app uses `expo-camera` (~55.0.16), not `react-native-vision-camera`. There is no `frameProcessor` or live frame callback. Real-time detection must be achieved via **periodic low-resolution captures**.

### Detection loop

Every **400ms** when `canCapture` is true and no full capture is in progress:

1. Call `cameraRef.current.takePictureAsync({ quality: 0.15, skipMetadata: true })`  
   → ~300KB JPEG (vs 3–4MB for a full capture). Fast, not stored.
2. Feed URI to `quickClassifyCapture(uri)` — the existing native Swift function
3. Interpret result:
   - **Slab mode**: `isSlabLikely = redBandScore > 0.12 || hasBarcode` → show pill
   - **Raw mode**: no equivalent signal yet → see Raw Mode section below
4. Update `isLockedOn` state

### Existing native function (no changes needed for slab mode)

`quickClassifyCapture` in `SpotlightSlabScannerModule.swift` already does:
- Red band detection (top + bottom 18% of image) for PSA slab red strips
- Barcode region edge detection (bottom 12%)
- Parallel barcode scan
- Returns `{ isSlabLikely, confidence, redBandScore, barcodeRegionScore, hasBarcode }`

The threshold `redBandScore > 0.12 || hasBarcode` was tuned to catch upside-down slabs and barcode-visible cases. This is the lock-on signal for slab mode.

### Raw card mode

**Problem:** Raw cards have no distinctive visual marker that `quickClassifyCapture` detects. Options:

**Option A — Always-on pill (simplest, ships now):**  
Show pill immediately when `canCapture` is true in raw mode, regardless of detection. No lock-on, just a better UX affordance. Acceptable since raw cards are common and the reticle guides framing anyway.

**Option B — Native card edge detection (deferred along with this feature):**  
Add a new native function `classifyRawFrame(imageUri)` to `SpotlightSlabScannerModule.swift` that:
- Converts to grayscale
- Runs Sobel edge detection
- Looks for a card-proportioned rectangle (2.5:3.5 aspect) that fills ~40–70% of frame
- Returns `{ cardDetected: boolean, confidence: number, aspectScore: number }`

This would give true raw card lock-on. Requires ~1 week of native work plus calibration.

**Recommendation:** Ship Option A initially. Add Option B when raw match accuracy is stable.

---

## State Changes (scanner-screen.tsx)

```typescript
// New state
const [isLockedOn, setIsLockedOn] = useState(false);
const lockOnTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
const isRunningLockOnRef = useRef(false); // prevents overlapping classify calls
```

### Lock-on loop lifecycle

```typescript
useEffect(() => {
  if (!canCapture || isCapturing) {
    // Stop loop
    if (lockOnTimerRef.current) {
      clearInterval(lockOnTimerRef.current);
      lockOnTimerRef.current = null;
    }
    setIsLockedOn(false);
    return;
  }

  // Start loop
  lockOnTimerRef.current = setInterval(async () => {
    if (isRunningLockOnRef.current || !cameraRef.current) return;
    isRunningLockOnRef.current = true;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.15,
        skipMetadata: true,
      });
      if (isSlab) {
        const hint = await quickClassifyCapture(photo.uri);
        setIsLockedOn(hint.isSlabLikely);
      } else {
        setIsLockedOn(true); // Option A: raw always locks on
      }
    } catch {
      // ignore — camera might be busy
    } finally {
      isRunningLockOnRef.current = false;
    }
  }, 400);

  return () => {
    if (lockOnTimerRef.current) {
      clearInterval(lockOnTimerRef.current);
      lockOnTimerRef.current = null;
    }
  };
}, [canCapture, isCapturing, isSlab]);
```

When `handleCapture` fires: set `isLockedOn(false)` at the top (pill hides immediately).

---

## UI: The Yellow Pill

### Visual spec

| Property | Value |
|---|---|
| Background | `#F5C518` (yellow) — check `scannerValuePill` in `packages/design-system/src/tokens.ts` first |
| Text | `"Tap to scan"` |
| Typography | `typography.control` (existing design token) |
| Text color | `#1A1A1A` (near-black for contrast on yellow) |
| Border radius | 999 (full pill shape) |
| Padding | 8px vertical, 20px horizontal |
| Position | Centered horizontally, 20px above reticle top edge |
| Shadow | Subtle drop shadow for legibility over camera feed |

### Animation

Use `Animated` from React Native core (already imported in scanner):

```typescript
const pillAnim = useRef(new Animated.Value(0)).current; // 0=hidden, 1=shown

useEffect(() => {
  Animated.timing(pillAnim, {
    toValue: isLockedOn ? 1 : 0,
    duration: isLockedOn ? 180 : 120,
    useNativeDriver: true,
  }).start();
}, [isLockedOn]);

const pillStyle = {
  opacity: pillAnim,
  transform: [{
    translateY: pillAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [8, 0],  // slides up 8px on appear
    }),
  }],
};
```

### Placement in component tree

Add inside `RawScannerCaptureSurface`, within the reticle overlay layer, above the reticle shell:

```tsx
{/* Lock-on pill */}
<Animated.View style={[styles.lockOnPillContainer, pillStyle]} pointerEvents={isLockedOn ? 'auto' : 'none'}>
  <Pressable onPress={onCapture} style={styles.lockOnPill}>
    <Text style={styles.lockOnPillText}>Tap to scan</Text>
  </Pressable>
</Animated.View>
```

Position with absolute layout above the reticle:
```typescript
lockOnPillContainer: {
  position: 'absolute',
  alignSelf: 'center',
  bottom: layout.reticleTop + layout.reticleSize + 16, // 16px above reticle
  // OR: top: layout.promptTop - 56, depending on layout structure
},
lockOnPill: {
  backgroundColor: '#F5C518',
  borderRadius: 999,
  paddingHorizontal: 20,
  paddingVertical: 8,
  shadowColor: '#000',
  shadowOpacity: 0.2,
  shadowRadius: 4,
  shadowOffset: { width: 0, height: 2 },
  elevation: 3,
},
lockOnPillText: {
  ...typography.control,
  color: '#1A1A1A',
},
```

---

## Props delta

### `RawScannerCaptureSurfaceProps` (raw-scanner-capture-surface.tsx)

Add:
```typescript
isLockedOn?: boolean;        // drives pill visibility
```

### `scanner-screen.tsx` → `RawScannerCaptureSurface`

Pass:
```tsx
isLockedOn={isLockedOn}
```

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| Tray expanded | Reticle hidden by existing logic → pill also hidden (pill is child of reticle layer) |
| Camera permission denied | `canCapture = false` → loop never starts → pill never shows |
| Camera not ready | `canCapture = false` → same |
| Active capture in progress | Loop stops, `isLockedOn = false`, pill hides |
| Device backgrounded | `shouldMountCamera = false` → `canCapture = false` → loop stops |
| Rapid camera movement | `isLockedOn` toggles each tick; animation handles flicker gracefully |
| Slow device | 400ms interval + 0.15 quality is low-cost; classifier is CPU-only, ~3–5ms on modern iPhones |
| Two rapid taps | `isCapturing` gate prevents double-capture (existing protection) |

---

## Files to Change (when implementing)

| File | What changes |
|---|---|
| `apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx` | `isLockedOn` state + lock-on interval `useEffect` + reset on capture |
| `apps/spotlight-rn/src/features/scanner/screens/raw-scanner-capture-surface.tsx` | `isLockedOn` prop + animated pill component + styles |
| `apps/spotlight-rn/src/features/scanner/slab-scanner-native.ts` | No changes for phase 1 |
| `apps/spotlight-rn/modules/spotlight-slab-scanner/ios/SpotlightSlabScannerModule.swift` | No changes for phase 1; add `classifyRawFrame` in phase 2 |

---

## Performance Notes

- `quality: 0.15` JPEG: ~250–350KB, takes ~40–80ms on iPhone 12+
- `quickClassifyCapture`: ~3–8ms (pure CPU, no ML inference)
- Total per tick: ~50–90ms, well within 400ms budget
- Peak extra CPU: ~15–20% during detection loop — acceptable
- No network, no disk writes (photo URI is temp, discarded immediately)

---

## Testing Plan

1. **Slab mode**: point at PSA slab → pill appears within 400ms ✓
2. **Slab mode**: move camera away → pill disappears within 400ms ✓
3. **Raw mode**: camera ready → pill shows immediately (Option A) ✓
4. **Tap pill** → capture fires, same result as tapping reticle ✓
5. **Tap reticle** → still works, no regression ✓
6. **Expand tray** → pill hidden ✓
7. **Lock rotation/background** → loop stops, no ghost timer ✓
8. **Unit test** (if lock logic extracted to hook): mock cameraRef + quickClassifyCapture, verify state transitions

---

## What's NOT in scope here

- Haptic feedback on lock-on (could add, low priority)
- Visual reticle animation on lock (e.g. corners turning green) — separate enhancement
- Raw card edge detection native function — phase 2
- Android support — Android doesn't use SpotlightSlabScannerModule; raw mode pill (Option A) covers Android automatically
