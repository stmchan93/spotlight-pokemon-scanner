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

  it('plays each beat at its own time, with weight that rises to the climax', () => {
    scheduleEvolutionHaptics(score);

    jest.advanceTimersByTime(0);
    expect(impactMock).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Light);

    jest.advanceTimersByTime(100);
    expect(impactMock).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Medium);

    jest.advanceTimersByTime(100);
    expect(impactMock).toHaveBeenLastCalledWith(Haptics.ImpactFeedbackStyle.Heavy);

    // The release is a notification, not an impact — a different texture, so it
    // reads as "done" rather than as one more beat of the build.
    expect(notificationMock).not.toHaveBeenCalled();
    jest.advanceTimersByTime(100);
    expect(notificationMock).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
  });

  it('scales the whole score, so the same rhythm can be replayed compressed', () => {
    scheduleEvolutionHaptics(score, { scale: 0.01 });

    jest.advanceTimersByTime(3);
    expect(impactMock).toHaveBeenCalledTimes(3);
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
});
