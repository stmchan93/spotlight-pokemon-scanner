/**
 * When this JS runtime started. Imported by the root layout so it is evaluated
 * at launch; route modules load lazily, so their own module-load time is not
 * "app start".
 */
let appStartedAt = Date.now();

export function getAppStartedAt(): number {
  return appStartedAt;
}

/** Test-only. */
export function resetAppStartedAtForTests(now: number = Date.now()) {
  appStartedAt = now;
}
