/**
 * The longest a user-facing load may spin, across any retry/fallback chain
 * inside the repository. Past this the screen shows its error + Retry instead.
 */
export const USER_LOAD_DEADLINE_MS = 20_000;

export class LoadDeadlineError extends Error {
  constructor(message = 'This is taking too long. Check your connection and try again.') {
    super(message);
    this.name = 'LoadDeadlineError';
  }
}

/**
 * Reject with `LoadDeadlineError` if `work` hasn't settled within `ms`. The
 * underlying request is not cancelled; its late result is simply ignored.
 */
export function withLoadDeadline<T>(work: Promise<T>, ms = USER_LOAD_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LoadDeadlineError()), ms);
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

export type DeadlineOutcome<T> = { timedOut: true } | { timedOut: false; value: T };

/**
 * Like `withLoadDeadline`, but reports the timeout instead of rejecting, so a
 * caller can drop its spinner at the deadline and still apply a late answer.
 */
export function settleWithin<T>(work: Promise<T>, ms = USER_LOAD_DEADLINE_MS): Promise<DeadlineOutcome<T>> {
  return withLoadDeadline(work, ms).then(
    (value): DeadlineOutcome<T> => ({ timedOut: false, value }),
    (error: unknown) => {
      if (error instanceof LoadDeadlineError) {
        return { timedOut: true };
      }
      throw error;
    },
  );
}
