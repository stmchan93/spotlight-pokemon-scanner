import * as Haptics from 'expo-haptics';

import {
  buildRevealHapticScore,
  playEvolutionHaptic,
  resetEvolutionHapticsAvailability,
  scheduleEvolutionHaptics,
  type EvolutionHapticBeat,
} from '@/features/whos-that-pokemon/evolution-haptics';

/**
 * The evolution beat ships no audio (a native audio dependency would force a
 * full EAS build instead of an OTA), so the taptic engine IS the soundtrack.
 * What is testable about a soundtrack without a device is its SCORE: the shape
 * of the rhythm, its ordering, and — the part that actually matters for
 * accessibility — what it collapses to under Reduce Motion.
 *
 * The feel of it does not survive a unit test and is not asserted here.
 */

const impactMock = Haptics.impactAsync as jest.Mock;
const notificationMock = Haptics.notificationAsync as jest.Mock;

/** The pulse peaks of a build that is speeding up, as the reveal produces them. */
const ACCELERATING_PEAKS = [300, 1255, 2066, 2756, 3352];
const ROLL = [3860, 4000, 4110];

beforeEach(() => {
  jest.clearAllMocks();
  resetEvolutionHapticsAvailability();
});

describe('buildRevealHapticScore', () => {
  it('plays build → climax → release, in that order', () => {
    const score = buildRevealHapticScore({
      peaksMs: ACCELERATING_PEAKS,
      rollMs: ROLL,
      climaxAtMs: 4200,
      landAtMs: 5040,
      reduceMotion: false,
    });

    // Exactly one climax, exactly one release, and the release is last.
    expect(score.filter((beat) => beat.kind === 'climax')).toHaveLength(1);
    expect(score.filter((beat) => beat.kind === 'land')).toHaveLength(1);
    expect(score[score.length - 1]).toEqual({ atMs: 5040, kind: 'land' });
    expect(score[score.length - 2]).toEqual({ atMs: 4200, kind: 'climax' });

    // Nothing plays out of order.
    const times = score.map((beat) => beat.atMs);
    expect([...times].sort((left, right) => left - right)).toEqual(times);
  });

  it('accelerates — every gap is shorter than the one before it', () => {
    // This is the whole trick. A long beat at a constant tempo just feels slow;
    // the same duration with a rising tempo feels like something is coming.
    const score = buildRevealHapticScore({
      peaksMs: ACCELERATING_PEAKS,
      rollMs: ROLL,
      climaxAtMs: 4200,
      landAtMs: 5040,
      reduceMotion: false,
    });

    // The release is the exhale, not part of the build — measure up to the climax.
    const build = score.filter((beat) => beat.kind !== 'land').map((beat) => beat.atMs);
    const gaps = build.slice(1).map((at, index) => at - build[index]);
    gaps.slice(1).forEach((gap, index) => {
      expect(gap).toBeLessThan(gaps[index]);
    });
  });

  it('leans on the heavier tap only for the last pulses of the build', () => {
    const score = buildRevealHapticScore({
      peaksMs: ACCELERATING_PEAKS,
      climaxAtMs: 4200,
      landAtMs: 5040,
      reduceMotion: false,
    });

    const pulseKinds = score
      .filter((beat) => beat.kind === 'tick' || beat.kind === 'build')
      .map((beat) => beat.kind);
    expect(pulseKinds).toEqual(['tick', 'tick', 'tick', 'build', 'build']);
  });

  it('collapses to a single release tap under reduce motion', () => {
    // NOT a quieter build — no build at all. Someone who asked for less movement
    // must not get a stretched-out version of the effect they opted out of, and
    // must not get a haptic barrage standing in for it either. One tap
    // acknowledges the payoff; nothing else fires.
    const score = buildRevealHapticScore({
      peaksMs: ACCELERATING_PEAKS,
      rollMs: ROLL,
      climaxAtMs: 4200,
      landAtMs: 5040,
      reduceMotion: true,
    });

    expect(score).toEqual([{ atMs: 5040, kind: 'land' }]);
  });

  it('drops unplayable beats rather than scheduling them at nonsense times', () => {
    const score = buildRevealHapticScore({
      peaksMs: [Number.NaN, -40, 120],
      climaxAtMs: 400,
      landAtMs: 800,
      reduceMotion: false,
    });

    expect(score.map((beat) => beat.atMs)).toEqual([120, 400, 800]);
  });
});

describe('scheduleEvolutionHaptics', () => {
  const score: EvolutionHapticBeat[] = [
    { atMs: 0, kind: 'tick' },
    { atMs: 100, kind: 'build' },
    { atMs: 200, kind: 'climax' },
    { atMs: 300, kind: 'land' },
  ];

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /*
    THE LADDER WAS RAISED ONCE, DELIBERATELY, AND THIS IS THE TEST THAT MOVED.

    It used to open on Light and top out at a lone Heavy. Measured against the
    SCANNER — Heavy for the shutter, Heavy + Success for a found card — the
    entire evolution build was quieter than a single scan tap, which is not a
    defensible ranking of the two moments. Every rung went up one.
  */
  it('plays each beat at its own time, with weight that rises to the climax', () => {
    scheduleEvolutionHaptics(score);

    jest.advanceTimersByTime(0);
    expect(impactMock).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Medium);

    jest.advanceTimersByTime(100);
    expect(impactMock).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Heavy);

    /*
      The climax and the release now play the SAME pair as a found card: a Heavy
      impact plus a Success notification. The old assertion here was
      `expect(notificationMock).not.toHaveBeenCalled()`, on the grounds that the
      release should have a texture the build never uses — true when the climax
      was a bare impact, false now, and the honest fix is to state what is
      actually being claimed rather than to delete the line.

      What survives is the COUNT: the climax fires the pair exactly once, and the
      release fires it a second time. If a rung ever leaks a Success into the
      build, this goes red.
    */
    jest.advanceTimersByTime(100);
    expect(impactMock).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Heavy);
    expect(notificationMock).toHaveBeenCalledTimes(1);
    expect(notificationMock).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);

    jest.advanceTimersByTime(100);
    expect(notificationMock).toHaveBeenCalledTimes(2);
  });

  it('scales the whole score, so the same rhythm can be replayed compressed', () => {
    scheduleEvolutionHaptics(score, { scale: 0.01 });

    // Four beats, and the last two carry an impact each as well as their
    // notification — so four impacts, not three.
    jest.advanceTimersByTime(3);
    expect(impactMock).toHaveBeenCalledTimes(4);
  });

  it('cancels pending beats, so a climax never fires onto a screen you left', () => {
    const cancel = scheduleEvolutionHaptics(score);

    jest.advanceTimersByTime(0);
    cancel();
    jest.advanceTimersByTime(1000);

    expect(impactMock).toHaveBeenCalledTimes(1);
    expect(notificationMock).not.toHaveBeenCalled();
  });
});

describe('playEvolutionHaptic', () => {
  it('never throws when the native module is missing from the binary', () => {
    // expo-haptics is native, and an OTA'd JS bundle can land on a binary that
    // does not have it. The beat is decoration; it must never take the screen
    // down with it.
    impactMock.mockImplementationOnce(() => {
      throw new Error('ExpoHaptics native module unavailable');
    });

    expect(() => playEvolutionHaptic('climax')).not.toThrow();
  });

  /*
    The climax and the release are the only beats that make TWO native calls.
    The unavailability latch exists so a missing module costs one failed bridge
    call rather than one per beat — a second call after the first has already
    thrown would quietly double that, on the two beats that matter most.
  */
  it('does not attempt the second call once the first has thrown', () => {
    impactMock.mockImplementationOnce(() => {
      throw new Error('ExpoHaptics native module unavailable');
    });

    playEvolutionHaptic('land');

    expect(notificationMock).not.toHaveBeenCalled();
    // …and the latch means the next beat does not even try.
    playEvolutionHaptic('build');
    expect(impactMock).toHaveBeenCalledTimes(1);
  });
});
