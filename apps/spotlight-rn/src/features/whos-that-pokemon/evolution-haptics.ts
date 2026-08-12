/**
 * The evolution beat's SOUNDTRACK.
 *
 * The show's evolution scene is carried by music: a slow, widely-spaced pulse
 * that tightens into a roll and breaks on a cymbal. We ship no audio (adding
 * `expo-audio`/`expo-av` would be a native dependency, which would force a full
 * EAS build instead of an OTA), so the rhythm is played on the taptic engine
 * instead. Phones live on silent anyway, so this is arguably the better channel
 * — but it is a channel that can be entirely absent, so the rule below is
 * absolute:
 *
 *   THE VISUAL BEAT MUST READ AS A COMPLETE EVOLUTION WITH ZERO HAPTICS.
 *
 * Nothing here is load-bearing for timing or for legibility. Every beat lands on
 * a moment that is already visible on screen (a pulse peak, the flash, the
 * landing); the only exception is the final roll, which is deliberate garnish on
 * top of a continuous visual swell. If the taptic engine is missing, disabled in
 * system settings, or weak (many Android OEMs), the screen is unchanged.
 *
 * The score is a pure function so the shape of the rhythm — build → climax →
 * release, and its collapse under Reduce Motion — is testable without a device.
 */

import * as Haptics from 'expo-haptics';
import { Platform, Vibration } from 'react-native';

/**
 * One event in the score.
 *
 * - `tick`   the slow opening pulses
 * - `build`  the later, harder pulses as the tempo tightens
 * - `roll`   the rapid run-up into the flash (the snare roll)
 * - `climax` the flash itself — the single heaviest thing in the beat
 * - `land`   the release, once the creature has arrived
 *
 * These are RHYTHMIC ROLES, not intensities. What each one actually plays lives
 * in `playEvolutionHaptic` and nowhere else, which is why the ladder could be
 * raised to scanner strength without touching a single caller or timing.
 */
export type EvolutionHapticKind = 'tick' | 'build' | 'roll' | 'climax' | 'land';

export type EvolutionHapticBeat = {
  /** Milliseconds from the start of the beat that owns this score. */
  atMs: number;
  kind: EvolutionHapticKind;
};

/**
 * The reveal's score, derived from the timings the animation is ALREADY using.
 *
 * Callers pass the visual moments (`peaksMs` = the pulse peaks, `climaxAtMs` =
 * the flash, `landAtMs` = the artwork settling) rather than their own numbers,
 * so the rhythm cannot drift out of sync with what is on screen.
 *
 * REDUCE MOTION collapses the whole thing to the single release tap. Someone who
 * asked for less movement gets no build, no roll and no climax — but the payoff
 * is still acknowledged, which is a confirmation rather than a barrage.
 */
export function buildRevealHapticScore(input: {
  /** Pulse peaks, ascending, relative to the start of the reveal. */
  peaksMs: readonly number[];
  /** The rapid run-up into the flash. Empty when there is no roll. */
  rollMs?: readonly number[];
  /** The flash — the moment of becoming. */
  climaxAtMs: number;
  /** The artwork has landed and settled. */
  landAtMs: number;
  reduceMotion: boolean;
}): EvolutionHapticBeat[] {
  const { peaksMs, rollMs = [], climaxAtMs, landAtMs, reduceMotion } = input;

  if (reduceMotion) {
    return sanitizeScore([{ atMs: landAtMs, kind: 'land' }]);
  }

  // The last two pulses are where the tempo has tightened enough to be felt as
  // pressure rather than as a metronome, so they get the heavier tap.
  const buildFromIndex = Math.max(0, peaksMs.length - 2);
  const beats: EvolutionHapticBeat[] = peaksMs.map((atMs, index) => ({
    atMs,
    kind: index >= buildFromIndex ? 'build' : 'tick',
  }));
  rollMs.forEach((atMs) => beats.push({ atMs, kind: 'roll' }));
  beats.push({ atMs: climaxAtMs, kind: 'climax' });
  beats.push({ atMs: landAtMs, kind: 'land' });
  return sanitizeScore(beats);
}

/** Drops anything unplayable and puts the score in playing order. */
function sanitizeScore(beats: readonly EvolutionHapticBeat[]): EvolutionHapticBeat[] {
  return beats
    .filter((beat) => Number.isFinite(beat.atMs) && beat.atMs >= 0)
    .sort((left, right) => left.atMs - right.atMs);
}

/**
 * expo-haptics is a NATIVE module, and an OTA'd JS bundle can land on a binary
 * that does not have it (the same hazard `scanner-screen-helpers` documents).
 * The first throw latches this flag so a 9-beat score does not produce 9
 * identical warnings and 9 failed bridge calls.
 */
let hapticsUnavailable = false;

/**
 * Android pulse lengths, in ms. See `playEvolutionHaptic` for why.
 *
 * Calibrated against the SCANNER, which is the app's reference for "strong":
 * `triggerScannerHaptic` fires 60ms pulses for the shutter. A `tick` sits
 * deliberately under that and the `climax` deliberately over it, so the build
 * arrives somewhere in the neighbourhood of a capture and the flash beats it.
 * The earlier values (14/24/12/60/40) were tuned as decoration and read as
 * nothing at all next to a single scan tap.
 */
const ANDROID_DURATION_MS: Record<EvolutionHapticKind, number> = {
  tick: 40,
  build: 55,
  roll: 35,
  climax: 90,
  land: 60,
};

/**
 * Play one beat.
 *
 * ANDROID goes through the core `Vibration` API rather than expo-haptics, for
 * the reason the scanner already found the hard way: `ImpactFeedbackStyle.Heavy`
 * maps to a weak OEM effect (Samsung fires it at ~27% amplitude), while
 * `Vibration` runs the motor at full amplitude. Amplitude is not controllable
 * there, so WEIGHT is expressed as duration — a 60ms climax against a 14ms tick.
 *
 * Every call is best-effort. A missing module, a disabled system setting, or a
 * device with no motor at all simply means the beat plays silently.
 */
export function playEvolutionHaptic(kind: EvolutionHapticKind): void {
  if (Platform.OS === 'android') {
    try {
      if (kind === 'land') {
        // Two quick taps, so the release reads as a resolution rather than as
        // one more pulse in the build.
        Vibration.vibrate([0, ANDROID_DURATION_MS.land, 60, 80]);
      } else {
        Vibration.vibrate(ANDROID_DURATION_MS[kind]);
      }
    } catch {
      /* no motor, or vibration disabled — the visual beat stands on its own */
    }
    return;
  }

  if (hapticsUnavailable) {
    return;
  }

  try {
    switch (kind) {
      case 'tick':
      case 'roll':
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        return;
      case 'build':
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
        return;
      /*
        Both endpoints play the SCANNER'S found-card pair verbatim
        (`scanner-screen-helpers.ts`: Heavy impact, then a Success notification).
        That pairing is the app's existing definition of "unmistakably felt", and
        matching it is the whole point of this ladder — the climax of an
        evolution should not land softer than confirming a card.

        Not chained with `.then`: `impactAsync` resolves on a microtask, and
        sequencing through it would push the notification behind a promise tick
        for no gain — the two are separate native calls either way, and ordering
        on the native side follows call order. A synchronous throw from the first
        call skips the second on its way to the catch below, which is what keeps
        a missing native module to ONE failure per beat rather than two.
      */
      case 'climax':
      case 'land':
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        return;
      default:
        return;
    }
  } catch {
    // Synchronous throw means the native module is not in this binary at all.
    // The climax is the one moment worth falling back for; a per-tick fallback
    // would turn the build into a coarse buzz storm.
    hapticsUnavailable = true;
    if (kind === 'climax') {
      try {
        Vibration.vibrate(30);
      } catch {
        /* nothing left to try */
      }
    }
  }
}

/**
 * Schedule a score and hand back a cancel function.
 *
 * `scale` exists so callers can pass the SAME compression factor they apply to
 * their animation timings (jest runs the whole choreography at ~1-2% speed), and
 * so the score is written once in real-world milliseconds.
 *
 * The cancel function is not optional bookkeeping: the reveal can be unmounted
 * mid-build (back button, a promoted alternate re-keying the component), and a
 * climax firing onto a screen the user already left is exactly the kind of stray
 * buzz that makes an app feel broken.
 */
export function scheduleEvolutionHaptics(
  beats: readonly EvolutionHapticBeat[],
  options: { scale?: number } = {},
): () => void {
  const scale = options.scale ?? 1;
  const timers = beats.map((beat) =>
    setTimeout(() => playEvolutionHaptic(beat.kind), Math.max(0, Math.round(beat.atMs * scale))),
  );
  return () => {
    timers.forEach(clearTimeout);
    if (Platform.OS === 'android') {
      try {
        Vibration.cancel();
      } catch {
        /* nothing scheduled, or no motor */
      }
    }
  };
}

/** Test-only reset for the "native module missing" latch. */
export function resetEvolutionHapticsAvailability(): void {
  hapticsUnavailable = false;
}
