import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { FaceLockOn } from '@/features/whos-that-pokemon/components/face-lock-on';
import { MorphLoop } from '@/features/whos-that-pokemon/components/morph-loop';
import { RevealMorph } from '@/features/whos-that-pokemon/components/reveal-morph';
import { ScanningTheater } from '@/features/whos-that-pokemon/components/scanning-theater';
import type { Point } from '@/features/whos-that-pokemon/face-geometry';

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

/**
 * Ellipse of outline points as the backend's ray-cast tracer produces them:
 * clockwise on screen from 3 o'clock, evenly spaced by angle, normalized 0..1
 * against their own image.
 */
function ellipseOutline(count: number, radiusX: number, radiusY: number): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    return {
      x: 0.5 + Math.cos(angle) * radiusX,
      y: 0.5 + Math.sin(angle) * radiusY,
    };
  });
}

/** RNTL never fires layout on its own, so measured-geometry views need a nudge. */
function layout(testID: string, width: number, height: number) {
  fireEvent(get(testID), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width, height } },
  });
}

/** The `d` string currently on an animated SVG path. */
function pathD(testID: string): string {
  const node = get(testID);
  const animated = node.props.animatedProps as { d?: string } | undefined;
  return (animated?.d ?? node.props.d ?? '') as string;
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

  it('resolves onto YOUR shape when both outlines were traced', async () => {
    renderWithProviders(
      <FaceLockOn
        {...baseProps}
        headBox={{ x: 0.06, y: 0.05, width: 0.24, height: 0.18 }}
        onDone={jest.fn()}
        personOutline={ellipseOutline(48, 0.16, 0.44)}
        speciesOutline={ellipseOutline(48, 0.42, 0.3)}
      />,
    );

    await screen.findByTestId('wtp-lockon');
    // The reveal deforms YOUR shape into the species — so this beat has to hand
    // over your shape, not the creature's.
    expect(get('wtp-lockon-person-shape')).toBeTruthy();
    expect(pathD('wtp-lockon-person-shape-path').startsWith('M ')).toBe(true);
    expect(query('wtp-lockon-silhouette')).toBeNull();
  });

  it('keeps handing over the species silhouette when only one outline exists', async () => {
    // The reveal cannot morph without both, so the lock-on must not end on a
    // shape the reveal has no way to continue from.
    renderWithProviders(
      <FaceLockOn
        {...baseProps}
        headBox={null}
        onDone={jest.fn()}
        speciesOutline={ellipseOutline(48, 0.42, 0.3)}
      />,
    );

    await screen.findByTestId('wtp-lockon');
    expect(query('wtp-lockon-person-shape')).toBeNull();
    expect(get('wtp-lockon-silhouette')).toBeTruthy();
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

  // A tall person and a squat creature: two shapes that cannot be mistaken for
  // each other, which is what makes a real deformation visible.
  const PERSON_OUTLINE = ellipseOutline(48, 0.16, 0.44);
  const SPECIES_OUTLINE = ellipseOutline(48, 0.42, 0.3);

  it('deforms one silhouette into the other — no white-out, no hard cut', async () => {
    const onDone = jest.fn();
    renderWithProviders(
      <RevealMorph
        {...baseProps}
        onDone={onDone}
        personOutline={PERSON_OUTLINE}
        speciesOutline={SPECIES_OUTLINE}
      />,
    );

    expect(await screen.findByTestId('wtp-reveal')).toBeTruthy();
    // ONE shape layer carries the whole transformation…
    expect(get('wtp-reveal-shape')).toBeTruthy();
    expect(pathD('wtp-reveal-shape-path').startsWith('M ')).toBe(true);
    // …and the species colours in out of it.
    expect(get('wtp-reveal-artwork')).toBeTruthy();

    // The full-white flash is gone for good. It never revealed anything — it
    // existed to hide a 40ms swap. What is left is a soft palette bloom.
    expect(query('wtp-reveal-flash')).toBeNull();
    expect(get('wtp-reveal-bloom')).toBeTruthy();

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it('opens on the exact shape the lock-on left on screen, so the handoff has no seam', async () => {
    const lockOn = renderWithProviders(
      <FaceLockOn
        artworkUrl={ARTWORK}
        headBox={{ x: 0.06, y: 0.05, width: 0.24, height: 0.18 }}
        onDone={jest.fn()}
        personOutline={PERSON_OUTLINE}
        selfieUri="file:///selfie.jpg"
        sourceHeight={1920}
        sourceWidth={1080}
        speciesOutline={SPECIES_OUTLINE}
        washColor="#112233"
      />,
    );
    await screen.findByTestId('wtp-lockon');
    const handedOver = pathD('wtp-lockon-person-shape-path');
    lockOn.unmount();

    renderWithProviders(
      <RevealMorph
        {...baseProps}
        fromSilhouette
        onDone={jest.fn()}
        personOutline={PERSON_OUTLINE}
        speciesOutline={SPECIES_OUTLINE}
      />,
    );
    await screen.findByTestId('wtp-reveal');

    // Byte-identical opening path: same helper, same rect, same inputs.
    expect(handedOver).not.toBe('');
    expect(pathD('wtp-reveal-shape-path')).toBe(handedOver);
    // …and the reveal must NOT replay the photo underneath it. That flash of
    // selfie behind an already-resolved silhouette IS the seam.
    expect(query('wtp-reveal-selfie')).toBeNull();
  });

  it('falls back to the species silhouette rising when your outline is missing', async () => {
    const onDone = jest.fn();
    renderWithProviders(
      <RevealMorph {...baseProps} onDone={onDone} speciesOutline={SPECIES_OUTLINE} />,
    );

    await screen.findByTestId('wtp-reveal');
    // Shape-first, still — but nothing to deform from, so no morph path…
    expect(query('wtp-reveal-shape')).toBeNull();
    expect(get('wtp-reveal-silhouette')).toBeTruthy();
    expect(get('wtp-reveal-artwork')).toBeTruthy();
    // …and emphatically still no flash to paper over the difference.
    expect(query('wtp-reveal-flash')).toBeNull();

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it('never renders a blank stage when the backend sent no geometry at all', async () => {
    const onDone = jest.fn();
    renderWithProviders(<RevealMorph {...baseProps} onDone={onDone} />);

    await screen.findByTestId('wtp-reveal');
    expect(get('wtp-reveal-silhouette')).toBeTruthy();
    expect(get('wtp-reveal-artwork')).toBeTruthy();

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it('still completes under reduce motion', async () => {
    enableReduceMotion();
    const onDone = jest.fn();

    renderWithProviders(
      <RevealMorph
        {...baseProps}
        onDone={onDone}
        personOutline={PERSON_OUTLINE}
        speciesOutline={SPECIES_OUTLINE}
      />,
    );

    await screen.findByTestId('wtp-reveal');
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });
});

describe('MorphLoop', () => {
  const baseProps = {
    artworkUrl: ARTWORK,
    cutoutUri: 'data:image/png;base64,Y3V0b3V0',
    selfieUri: 'file:///selfie.jpg',
    washColor: '#112233',
  };

  it('deforms one path instead of crossfading two silhouettes', async () => {
    renderWithProviders(
      <MorphLoop
        {...baseProps}
        personOutline={ellipseOutline(48, 0.16, 0.44)}
        speciesOutline={ellipseOutline(48, 0.42, 0.3)}
      />,
    );

    await screen.findByTestId('wtp-morph-loop');
    layout('wtp-morph-loop', 320, 320);

    // The result-panel loop and the reveal now play the SAME geometric morph.
    expect(get('wtp-morph-loop-shape')).toBeTruthy();
    expect(pathD('wtp-morph-loop-shape-path').startsWith('M ')).toBe(true);
    // The two opacity-crossfaded silhouettes it replaced are gone — a 200ms
    // crossfade between them read as a flash, not as a deformation.
    expect(query('wtp-morph-loop-person-shape')).toBeNull();
    expect(query('wtp-morph-loop-species-shape')).toBeNull();
    // The palette glow behind the subject stays.
    expect(get('wtp-morph-loop-glow')).toBeTruthy();
  });

  it('keeps the silhouette crossfade when the backend traced no outlines', async () => {
    renderWithProviders(<MorphLoop {...baseProps} />);

    await screen.findByTestId('wtp-morph-loop');
    layout('wtp-morph-loop', 320, 320);

    expect(query('wtp-morph-loop-shape')).toBeNull();
    expect(get('wtp-morph-loop-person-shape')).toBeTruthy();
    expect(get('wtp-morph-loop-species-shape')).toBeTruthy();
    // The cutout is a silhouette SOURCE only, never drawn as a photo.
    expect(query('wtp-morph-loop-cutout')).toBeNull();
  });
});
