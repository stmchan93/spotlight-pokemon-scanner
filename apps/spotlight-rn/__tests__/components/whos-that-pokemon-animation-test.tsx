import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, Dimensions, StyleSheet } from 'react-native';

import { resolveArtworkRect } from '@/features/whos-that-pokemon/face-geometry';
import type { EvolutionHapticBeat } from '@/features/whos-that-pokemon/evolution-haptics';
import { EvolutionCue } from '@/features/whos-that-pokemon/components/evolution-cue';
import { FaceLockOn } from '@/features/whos-that-pokemon/components/face-lock-on';
import { MorphLoop } from '@/features/whos-that-pokemon/components/morph-loop';
import { RevealMorph } from '@/features/whos-that-pokemon/components/reveal-morph';
import { ScanningTheater } from '@/features/whos-that-pokemon/components/scanning-theater';
import {
  EVOLVING_FALLBACK_NAME,
  EVOLVING_LEAD,
  EVOLVING_TAIL,
} from '@/features/whos-that-pokemon/evolution-copy';
import type { Point } from '@/features/whos-that-pokemon/face-geometry';

import { renderWithProviders } from '../test-utils';

const PALETTE = ['#112233', '#445566', '#778899', '#AABBCC'];
const ARTWORK = 'https://example.test/artwork/25.png';

/**
 * The evolution beat's rhythm is played on the taptic engine (there is no audio
 * — a native audio dependency would cost an EAS build). Intercepting the
 * SCHEDULER rather than the platform calls keeps these assertions about the
 * score the component asked for, which is the part that has to be right; the
 * score's own shape is covered in `evolution-haptics-test`.
 */
const mockScheduleEvolutionHaptics = jest.fn();
jest.mock('@/features/whos-that-pokemon/evolution-haptics', () => {
  const actual = jest.requireActual('@/features/whos-that-pokemon/evolution-haptics');
  return {
    ...actual,
    scheduleEvolutionHaptics: (...args: unknown[]) => {
      mockScheduleEvolutionHaptics(...args);
      return () => {};
    },
  };
});

/** Every haptic beat the component under test asked to have played. */
function scheduledBeats(): EvolutionHapticBeat[] {
  return mockScheduleEvolutionHaptics.mock.calls.flatMap(
    (call) => call[0] as EvolutionHapticBeat[],
  );
}

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

/** Resolved style of a rendered layer, with the array/registry flattened out. */
function flatStyle(testID: string): Record<string, unknown> {
  return (StyleSheet.flatten(get(testID).props.style) ?? {}) as Record<string, unknown>;
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

beforeEach(() => {
  mockScheduleEvolutionHaptics.mockClear();
});

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

  it('measures against the backend head box when one is provided', async () => {
    renderWithProviders(
      <FaceLockOn
        {...baseProps}
        headBox={{ x: 0.06, y: 0.05, width: 0.24, height: 0.18 }}
        onDone={jest.fn()}
      />,
    );

    expect(await screen.findByTestId('wtp-lockon')).toBeTruthy();
    // The caption is the whole readout now: the bracket that used to draw the
    // head box was removed because a box that is off — or estimated — puts a
    // rectangle visibly wrong on your face and advertises the miss.
    expect(get('wtp-lockon-caption').props.children).toBe('Face geometry locked');
    expect(query('wtp-lockon-head-frame')).toBeNull();
  });

  it('never draws landmark dots or caliper readouts over the face', async () => {
    // These were removed on purpose: the backend gives a head BOX, not a face
    // mesh, so every dot was a template projected into that box and every
    // readout ("JAW 87°") was derived from the template rather than the person.
    // The head bracket has since gone the same way, for the same reason.
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
    expect(query('wtp-lockon-head-frame')).toBeNull();
  });

  it('falls back to an estimated frame when the backend sent no head box', async () => {
    renderWithProviders(<FaceLockOn {...baseProps} headBox={null} onDone={jest.fn()} />);

    expect(await screen.findByTestId('wtp-lockon')).toBeTruthy();
    // Says "estimating" rather than claiming a lock it does not have.
    expect(get('wtp-lockon-caption').props.children).toBe('Estimating your frame');
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

describe('EvolutionCue', () => {
  it('plays "What? <NAME> is evolving!" and hands off to the reveal', async () => {
    const onDone = jest.fn();
    renderWithProviders(<EvolutionCue name="STEPHEN" onDone={onDone} />);

    await screen.findByTestId('wtp-evolving');
    expect(get('wtp-evolving-lead').props.children).toBe(EVOLVING_LEAD);
    expect(get('wtp-evolving-name').props.children).toBe('STEPHEN');
    expect(get('wtp-evolving-tail').props.children).toBe(EVOLVING_TAIL);

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it('sits UNDER the silhouette, anchored to it', async () => {
    renderWithProviders(<EvolutionCue name="STEPHEN" onDone={jest.fn()} />);

    await screen.findByTestId('wtp-evolving');
    const { height, width } = Dimensions.get('window');
    // The SAME helper that places the silhouette, so this asserts the real
    // relationship rather than a magic number.
    const silhouette = resolveArtworkRect(width, height);
    const silhouetteBottom = silhouette.y + silhouette.height;
    const top = flatStyle('wtp-evolving-copy').top as number;

    // Below the shape — never drawn across it.
    expect(top).toBeGreaterThanOrEqual(silhouetteBottom);
    // …but hugging it. It used to hang off the bottom EDGE
    // (`justifyContent: 'flex-end'`), where the hero line of the beat read as a
    // system caption instead of as part of the creature.
    expect(top - silhouetteBottom).toBeLessThanOrEqual(32);
    expect(top).toBeLessThan(height * 0.85);
  });

  it('needs no scrim, now that it is off the silhouette', async () => {
    // The radial scrim existed for exactly one reason: white display type
    // centred ON a shape filled with a colour sampled from the user's own
    // selfie. Under the shape, the copy sits on the lock-on's dark stage, so
    // dimming the creature during its own evolution would be a cost with no
    // benefit left to pay for.
    renderWithProviders(<EvolutionCue name="STEPHEN" onDone={jest.fn()} />);

    await screen.findByTestId('wtp-evolving');
    expect(query('wtp-evolving-scrim')).toBeNull();
  });

  it('opens the rhythm with one tap per word, the name hitting hardest', async () => {
    renderWithProviders(<EvolutionCue name="STEPHEN" onDone={jest.fn()} />);

    await screen.findByTestId('wtp-evolving');
    // The rhythm waits for the OS Reduce Motion answer, which is a promise —
    // nothing is played into someone's hand on a guess.
    await waitFor(() => {
      expect(mockScheduleEvolutionHaptics).toHaveBeenCalled();
    });
    const beats = scheduledBeats();
    expect(beats.map((beat) => beat.kind)).toEqual(['tick', 'build', 'tick']);
    // Deliberately slow and widely spaced — everything after this gets faster,
    // and it can only read as faster if it starts here.
    const gaps = beats.slice(1).map((beat, index) => beat.atMs - beats[index].atMs);
    gaps.forEach((gap) => {
      expect(gap).toBeGreaterThan(500);
    });
  });

  it('reads as a sentence on the no-name fallback, never "null is evolving!"', async () => {
    renderWithProviders(<EvolutionCue name={EVOLVING_FALLBACK_NAME} onDone={jest.fn()} />);

    await screen.findByTestId('wtp-evolving');
    const line = [
      get('wtp-evolving-lead').props.children,
      get('wtp-evolving-name').props.children,
      get('wtp-evolving-tail').props.children,
    ].join(' ');
    expect(line).toBe('What? SOMEONE is evolving!');
    expect(line.toLowerCase()).not.toContain('null');
  });

  it('still shows the copy and still completes under reduce motion', async () => {
    // The gag IS the copy, so unlike the sweeps and bursts it is not dropped —
    // it just lands whole instead of word by word.
    enableReduceMotion();
    const onDone = jest.fn();

    renderWithProviders(<EvolutionCue name="STEPHEN" onDone={onDone} />);

    await screen.findByTestId('wtp-evolving');
    expect(get('wtp-evolving-name').props.children).toBe('STEPHEN');
    // …and still parked under the silhouette, since placement is not motion.
    expect(get('wtp-evolving-copy')).toBeTruthy();
    // …and no rhythm is played into someone who opted out of the effect.
    expect(scheduledBeats()).toEqual([]);

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
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
    expect(get('wtp-reveal-bloom')).toBeTruthy();

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it('glows white along the SAME outline it is deforming', async () => {
    renderWithProviders(
      <RevealMorph
        {...baseProps}
        onDone={jest.fn()}
        personOutline={PERSON_OUTLINE}
        speciesOutline={SPECIES_OUTLINE}
      />,
    );

    await screen.findByTestId('wtp-reveal');
    // The pulse is a second pass over ONE derived path, not a separate drawing —
    // if it were its own shape the glow would drift off the silhouette it is
    // supposed to be burning through.
    expect(get('wtp-reveal-pulse')).toBeTruthy();
    expect(pathD('wtp-reveal-pulse-path')).toBe(pathD('wtp-reveal-shape-path'));
  });

  it('lands exactly one flash, on top of a deformation that really happened', async () => {
    // The white-out that used to live here was a cover story: the selfie swapped
    // for the artwork in 40ms at the peak of it, and nothing morphed. The flash
    // is back because the morph is now real and 4.2s long — it punctuates a
    // transformation the user has already watched, rather than replacing one.
    // ONE brief transition, never a repeat: a strobe is a photosensitivity risk.
    renderWithProviders(
      <RevealMorph
        {...baseProps}
        onDone={jest.fn()}
        personOutline={PERSON_OUTLINE}
        speciesOutline={SPECIES_OUTLINE}
      />,
    );

    await screen.findByTestId('wtp-reveal');
    expect(screen.getAllByTestId('wtp-reveal-flash', DEEP)).toHaveLength(1);
    expect(get('wtp-reveal-shape')).toBeTruthy();
    expect(pathD('wtp-reveal-shape-path').startsWith('M ')).toBe(true);
  });

  it('plays the build as an accelerating rhythm that breaks on the flash', async () => {
    renderWithProviders(
      <RevealMorph
        {...baseProps}
        onDone={jest.fn()}
        personOutline={PERSON_OUTLINE}
        speciesOutline={SPECIES_OUTLINE}
      />,
    );

    await screen.findByTestId('wtp-reveal');
    await waitFor(() => {
      expect(mockScheduleEvolutionHaptics).toHaveBeenCalled();
    });
    const kinds = scheduledBeats().map((beat) => beat.kind);
    expect(kinds).toContain('climax');
    expect(kinds[kinds.length - 1]).toBe('land');
    // Five pulses + a run-up: the beat has room to breathe, and it uses that
    // room to speed up rather than to sit still.
    expect(kinds.filter((kind) => kind === 'tick' || kind === 'build')).toHaveLength(5);
    expect(kinds.filter((kind) => kind === 'roll')).toHaveLength(3);
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

  it('drops the pulse, the flash and the rhythm under reduce motion', async () => {
    // A calm cross-fade at a sensible length — NOT a stretched-out version of an
    // effect someone asked not to see. Nothing pulses, nothing flashes, and the
    // soundtrack collapses to a single acknowledgement of the payoff.
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
      expect(query('wtp-reveal-pulse')).not.toBeOnTheScreen();
    });
    expect(query('wtp-reveal-flash')).not.toBeOnTheScreen();
    expect(scheduledBeats().map((beat) => beat.kind)).toEqual(['land']);

    // …and the creature still arrives.
    expect(get('wtp-reveal-artwork')).toBeTruthy();
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
    // …and the white glow echoes the reveal's, so the card reads as a replay of
    // the beat rather than as a different animation of the same two pictures.
    // ONE peak per direction of a ~5.7s loop — a pulse TRAIN on something that
    // never stops would be the repeated flashing the reveal avoids.
    expect(get('wtp-morph-loop-pulse')).toBeTruthy();
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

  it('shows the whole selfie, because this box is square and the capture is not', async () => {
    renderWithProviders(<MorphLoop {...baseProps} />);

    await screen.findByTestId('wtp-morph-loop');
    layout('wtp-morph-loop', 320, 320);

    // `cover` in a 1:1 box crops a 9:16 capture by 44% of its HEIGHT — head and
    // legs gone from the full-body shot the capture screen asks for, which is
    // what made the result read as "that isn't the photo I took".
    expect(get('wtp-morph-loop-selfie').props.contentFit).toBe('contain');
  });

  it('fills the pillarbox with a blurred copy of the selfie, not black', async () => {
    renderWithProviders(<MorphLoop {...baseProps} />);

    await screen.findByTestId('wtp-morph-loop');
    layout('wtp-morph-loop', 320, 320);

    // `contain` alone left dead black down both sides ("black space between the
    // sides"). The backdrop is the SAME photo, `cover`-scaled and blurred, so
    // nothing is cropped away and nothing is dead black.
    const backdrop = get('wtp-morph-loop-selfie-backdrop');
    expect(backdrop.props.contentFit).toBe('cover');
    expect(backdrop.props.source).toEqual({ uri: baseProps.selfieUri });
  });
});
