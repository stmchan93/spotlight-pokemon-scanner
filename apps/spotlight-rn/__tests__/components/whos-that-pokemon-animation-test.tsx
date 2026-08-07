import { screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, Dimensions, StyleSheet } from 'react-native';

import { FaceLockOn } from '@/features/whos-that-pokemon/components/face-lock-on';
import { ScanningTheater } from '@/features/whos-that-pokemon/components/scanning-theater';
import { FACE_LANDMARKS, type Point } from '@/features/whos-that-pokemon/face-geometry';

import { renderWithProviders } from '../test-utils';

const PALETTE = ['#112233', '#445566', '#778899', '#AABBCC'];
const ARTWORK = 'https://example.test/artwork/25.png';

// Under the reanimated jest mock every layer renders at its INITIAL animated
// value, which for a beat that fades in means `opacity: 0`. RNTL treats that as
// hidden, so these queries opt hidden elements back in — we are asserting what
// is mounted and where, not what is currently visible.
const DEEP = { includeHiddenElements: true } as const;

function get(testID: string) {
  return screen.getByTestId(testID, DEEP);
}

function query(testID: string) {
  return screen.queryByTestId(testID, DEEP);
}

/** Ring of outline points, as the backend's ray-cast artwork outline arrives. */
function circleOutline(count: number): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    return {
      x: 0.5 + Math.cos(angle) * 0.4,
      y: 0.5 + Math.sin(angle) * 0.4,
    };
  });
}

function dotOffset(testID: string): { x: number; y: number } {
  const style = StyleSheet.flatten(get(testID).props.style) as {
    transform?: { translateX?: number; translateY?: number }[];
  };
  const transform = style.transform ?? [];
  return {
    x: transform.find((entry) => entry.translateX != null)?.translateX ?? 0,
    y: transform.find((entry) => entry.translateY != null)?.translateY ?? 0,
  };
}

// React Native's jest setup already replaces AccessibilityInfo methods with
// jest.fn()s, so `jest.spyOn` hands back that shared mock and
// `restoreAllMocks()` will NOT undo an override — a leaked `true` would
// silently push every later test into the reduced-motion branch. Flip it back
// explicitly instead.
const reduceMotionMock = AccessibilityInfo.isReduceMotionEnabled as jest.Mock;

function enableReduceMotion() {
  reduceMotionMock.mockResolvedValue(true);
}

afterEach(() => {
  reduceMotionMock.mockResolvedValue(false);
});

describe('ScanningTheater', () => {
  it('shows the real extracted palette and no species roulette', async () => {
    renderWithProviders(<ScanningTheater palette={PALETTE} selfieUri="file:///selfie.jpg" />);

    expect(await screen.findByTestId('wtp-theater-swatches')).toBeTruthy();
    PALETTE.forEach((_, index) => {
      expect(get(`wtp-theater-swatch-${index}`)).toBeTruthy();
    });

    // The 170ms species roulette is gone for good — it was the strobe.
    expect(query('wtp-theater-roulette-name')).toBeNull();
    // …and so is the invented confidence ticker.
    expect(query('wtp-theater-confidence')).toBeNull();
  });

  it('captions the swatch row with a count of the tones actually sampled', async () => {
    renderWithProviders(<ScanningTheater palette={PALETTE} selfieUri="file:///selfie.jpg" />);

    const caption = await screen.findByTestId('wtp-theater-sample-count');
    expect(caption.props.children).toBe(`${PALETTE.length} of ${PALETTE.length} tones sampled`);
  });

  it('drops the sweep line under reduce motion', async () => {
    enableReduceMotion();

    renderWithProviders(<ScanningTheater palette={PALETTE} selfieUri="file:///selfie.jpg" />);

    await waitFor(() => {
      expect(query('wtp-theater-sweep')).toBeNull();
    });
    // The status line still reads, so the phase never looks dead.
    expect(get('wtp-theater-status')).toBeTruthy();
  });
});

describe('FaceLockOn', () => {
  const baseProps = {
    artworkUrl: ARTWORK,
    selfieUri: 'file:///selfie.jpg',
    sourceWidth: 1080,
    sourceHeight: 1920,
    washColor: '#112233',
  };

  it('measures against the backend head box when one is provided', async () => {
    renderWithProviders(
      <FaceLockOn
        {...baseProps}
        headBox={{ x: 0.06, y: 0.05, width: 0.24, height: 0.18 }}
        onDone={jest.fn()}
        speciesOutline={circleOutline(48)}
      />,
    );

    expect(await screen.findByTestId('wtp-lockon')).toBeTruthy();
    expect(get('wtp-lockon-caption').props.children).toBe('Face geometry locked');
    // One dot per landmark, all mounted before they travel.
    expect(get(`wtp-lockon-dot-${FACE_LANDMARKS.length - 1}`)).toBeTruthy();
    expect(get('wtp-lockon-head-frame')).toBeTruthy();
  });

  it('places the landmarks where the head box says — the box really drives it', async () => {
    const first = renderWithProviders(
      <FaceLockOn
        {...baseProps}
        headBox={{ x: 0.05, y: 0.05, width: 0.2, height: 0.16 }}
        onDone={jest.fn()}
        speciesOutline={null}
      />,
    );
    await screen.findByTestId('wtp-lockon');
    const nearTopLeft = dotOffset('wtp-lockon-dot-0');
    first.unmount();

    renderWithProviders(
      <FaceLockOn
        {...baseProps}
        headBox={{ x: 0.7, y: 0.4, width: 0.2, height: 0.16 }}
        onDone={jest.fn()}
        speciesOutline={null}
      />,
    );
    await screen.findByTestId('wtp-lockon');
    const nearBottomRight = dotOffset('wtp-lockon-dot-0');

    // The selfie is mirrored for display, so a box on the RIGHT of the original
    // lands on the LEFT of the screen — and lower down either way.
    expect(nearBottomRight.x).toBeLessThan(nearTopLeft.x);
    expect(nearBottomRight.y).toBeGreaterThan(nearTopLeft.y);
  });

  it('falls back to an estimated frame when the backend sent no head box', async () => {
    renderWithProviders(<FaceLockOn {...baseProps} headBox={null} onDone={jest.fn()} />);

    expect(await screen.findByTestId('wtp-lockon')).toBeTruthy();
    expect(get('wtp-lockon-caption').props.children).toBe('Estimating your frame');
    // Still a full mesh and a silhouette — the beat must never look broken.
    expect(get('wtp-lockon-dot-0')).toBeTruthy();
    expect(get('wtp-lockon-mesh-0')).toBeTruthy();
    expect(get('wtp-lockon-silhouette')).toBeTruthy();
  });

  it('lands the fallback landmarks inside the frame, horizontally centred', async () => {
    renderWithProviders(<FaceLockOn {...baseProps} headBox={undefined} onDone={jest.fn()} />);
    await screen.findByTestId('wtp-lockon');

    // Landmarks 14 (hairline centre) and 26 (nose tip) share the template's
    // vertical midline, so the guess must land them centred and in order.
    const hairline = dotOffset('wtp-lockon-dot-14');
    const noseTip = dotOffset('wtp-lockon-dot-26');
    expect(hairline.x).toBeCloseTo(Dimensions.get('window').width / 2, 3);
    expect(noseTip.x).toBeCloseTo(hairline.x, 3);
    expect(noseTip.y).toBeGreaterThan(hairline.y);
  });

  it('still hands off to the reveal when neither the head box nor the outline exist', async () => {
    const onDone = jest.fn();
    renderWithProviders(
      <FaceLockOn {...baseProps} headBox={null} onDone={onDone} speciesOutline={null} />,
    );

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it('collapses straight to the silhouette under reduce motion — no point travel', async () => {
    enableReduceMotion();
    const onDone = jest.fn();

    renderWithProviders(
      <FaceLockOn
        {...baseProps}
        headBox={{ x: 0.06, y: 0.05, width: 0.24, height: 0.18 }}
        onDone={onDone}
        speciesOutline={circleOutline(48)}
      />,
    );

    await waitFor(() => {
      expect(query('wtp-lockon-dot-0')).toBeNull();
    });
    expect(query('wtp-lockon-mesh-0')).toBeNull();
    expect(query('wtp-lockon-readouts')).toBeNull();
    expect(query('wtp-lockon-head-frame')).toBeNull();
    // The silhouette — the thing the reveal takes over — is still there.
    expect(get('wtp-lockon-silhouette')).toBeTruthy();

    await waitFor(() => {
      expect(onDone).toHaveBeenCalled();
    });
  });
});
