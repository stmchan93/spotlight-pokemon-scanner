import { screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, Dimensions, StyleSheet } from 'react-native';

import { FaceLockOn } from '@/features/whos-that-pokemon/components/face-lock-on';
import { RevealMorph } from '@/features/whos-that-pokemon/components/reveal-morph';
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
      expect(query('wtp-theater-sweep')).not.toBeOnTheScreen();
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

  /** Top-left corner of the head bracket, in screen coordinates. */
  function bracketOrigin(): { x: number; y: number } {
    const path = get('wtp-lockon-head-frame-path').props.d as string;
    const [, x, y] = /^M ([\d.-]+) ([\d.-]+)/.exec(path) ?? [];
    return { x: Number(x), y: Number(y) };
  }

  it('measures against the backend head box when one is provided', async () => {
    renderWithProviders(
      <FaceLockOn
        {...baseProps}
        headBox={{ x: 0.06, y: 0.05, width: 0.24, height: 0.18 }}
        onDone={jest.fn()}
      />,
    );

    expect(await screen.findByTestId('wtp-lockon')).toBeTruthy();
    expect(get('wtp-lockon-caption').props.children).toBe('Face geometry locked');
    expect(get('wtp-lockon-head-frame')).toBeTruthy();
  });

  it('never draws landmark dots or caliper readouts over the face', async () => {
    // These were removed on purpose: the backend gives a head BOX, not a face
    // mesh, so every dot was a template projected into that box and every
    // readout ("JAW 87°") was derived from the template rather than the person.
    // The bracket stays — it reflects data we actually have.
    renderWithProviders(
      <FaceLockOn
        {...baseProps}
        headBox={{ x: 0.06, y: 0.05, width: 0.24, height: 0.18 }}
        onDone={jest.fn()}
      />,
    );

    await screen.findByTestId('wtp-lockon');
    expect(query('wtp-lockon-dot-0')).toBeNull();
    expect(query('wtp-lockon-readouts')).toBeNull();
    expect(query('wtp-lockon-mesh-0')).toBeNull();
    expect(get('wtp-lockon-head-frame')).toBeTruthy();
  });

  it('places the bracket where the head box says — the box really drives it', async () => {
    const first = renderWithProviders(
      <FaceLockOn
        {...baseProps}
        headBox={{ x: 0.05, y: 0.05, width: 0.2, height: 0.16 }}
        onDone={jest.fn()}
      />,
    );
    await screen.findByTestId('wtp-lockon');
    const nearTopLeft = bracketOrigin();
    first.unmount();

    renderWithProviders(
      <FaceLockOn
        {...baseProps}
        headBox={{ x: 0.7, y: 0.4, width: 0.2, height: 0.16 }}
        onDone={jest.fn()}
      />,
    );
    await screen.findByTestId('wtp-lockon');
    const nearBottomRight = bracketOrigin();

    // The selfie is mirrored for display, so a box on the RIGHT of the original
    // lands on the LEFT of the screen — and lower down either way.
    expect(nearBottomRight.x).toBeLessThan(nearTopLeft.x);
    expect(nearBottomRight.y).toBeGreaterThan(nearTopLeft.y);
  });

  it('falls back to an estimated frame when the backend sent no head box', async () => {
    renderWithProviders(<FaceLockOn {...baseProps} headBox={null} onDone={jest.fn()} />);

    expect(await screen.findByTestId('wtp-lockon')).toBeTruthy();
    // Says "estimating" rather than claiming a lock it does not have.
    expect(get('wtp-lockon-caption').props.children).toBe('Estimating your frame');
    expect(get('wtp-lockon-head-frame')).toBeTruthy();
    expect(get('wtp-lockon-silhouette')).toBeTruthy();
  });

  it('still hands off to the reveal when there is no head box', async () => {
    const onDone = jest.fn();
    renderWithProviders(<FaceLockOn {...baseProps} headBox={null} onDone={onDone} />);

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it('collapses straight to the silhouette under reduce motion', async () => {
    enableReduceMotion();
    const onDone = jest.fn();

    renderWithProviders(
      <FaceLockOn
        {...baseProps}
        headBox={{ x: 0.06, y: 0.05, width: 0.24, height: 0.18 }}
        onDone={onDone}
      />,
    );

    await waitFor(() => {
      expect(query('wtp-lockon-head-frame')).not.toBeOnTheScreen();
    });
    // The silhouette — the thing the reveal takes over — is still there.
    expect(get('wtp-lockon-silhouette')).toBeTruthy();

    await waitFor(() => {
      expect(onDone).toHaveBeenCalled();
    });
  });
});

describe('RevealMorph', () => {
  const baseProps = {
    artworkUrl: ARTWORK,
    burstColors: PALETTE,
    selfieUri: 'file:///selfie.jpg',
    washColor: '#112233',
  };

  it('reveals the species behind a single white-out and hands back once', async () => {
    const onDone = jest.fn();
    renderWithProviders(<RevealMorph {...baseProps} onDone={onDone} />);

    expect(await screen.findByTestId('wtp-reveal')).toBeTruthy();
    expect(get('wtp-reveal-artwork')).toBeTruthy();
    // One flash layer, not a strobe rig — the whiteout is a single swell.
    expect(get('wtp-reveal-flash')).toBeTruthy();

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it('opens on the lock-on silhouette so the handoff has no seam', async () => {
    renderWithProviders(<RevealMorph {...baseProps} fromSilhouette onDone={jest.fn()} />);

    await screen.findByTestId('wtp-reveal');
    expect(get('wtp-reveal-silhouette')).toBeTruthy();
    expect(get('wtp-reveal-artwork')).toBeTruthy();
  });

  it('still completes under reduce motion', async () => {
    enableReduceMotion();
    const onDone = jest.fn();

    renderWithProviders(<RevealMorph {...baseProps} onDone={onDone} />);

    await screen.findByTestId('wtp-reveal');
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });
});
