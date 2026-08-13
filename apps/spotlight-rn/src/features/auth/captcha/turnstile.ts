import { resolveRuntimeValue } from '@/lib/runtime-config';

/**
 * Cloudflare Turnstile token plumbing for Supabase Auth.
 *
 * Production Supabase has "Enable Captcha protection" ON and rejects tokenless
 * signup / password sign-in / anonymous sign-in / recovery requests with
 * "captcha protection: request disallowed (no captcha_token found)". Staging
 * and dev have captcha OFF, and Supabase simply ignores a captchaToken when
 * protection is disabled — so the rule here is:
 *
 *   - When a site key is configured AND the hidden widget produces a token,
 *     every captcha-capable auth call sends it.
 *   - When there is no site key (dev/staging, or the placeholder value), the
 *     provider resolves null IMMEDIATELY and the calls go out tokenless,
 *     exactly as they do today.
 *   - When the widget fails or times out, the provider resolves null rather
 *     than throwing: on captcha-off environments the tokenless request still
 *     succeeds, and on production the server's captcha error is the correct,
 *     user-visible failure — a widget bug must never brick sign-in where
 *     captcha is not enforced.
 *
 * Turnstile tokens are SINGLE-USE, so every call to `getCaptchaToken()` runs a
 * fresh widget execution — tokens are never cached or shared between requests.
 */

/** How long one widget execution may take before we give up and go tokenless. */
export const CAPTCHA_TOKEN_TIMEOUT_MS = 8000;

/**
 * Executes one fresh Turnstile challenge and resolves the token, or null when
 * the widget failed. Registered by the hidden WebView host while it is mounted.
 */
export type TurnstileExecutor = () => Promise<string | null>;

let activeExecutor: TurnstileExecutor | null = null;

/**
 * Serializes executions: the hidden host renders ONE widget, and Turnstile
 * tokens are single-use, so overlapping auth calls take turns rather than
 * racing for the same execution.
 */
let executionChain: Promise<unknown> = Promise.resolve();

export function getTurnstileSiteKey(): string {
  return resolveRuntimeValue(
    ['EXPO_PUBLIC_TURNSTILE_SITE_KEY'],
    ['turnstileSiteKey'],
  );
}

/**
 * Called by the captcha host component on mount. Returns an unregister
 * function; a stale unregister (from a replaced host) is a no-op.
 */
export function registerTurnstileExecutor(executor: TurnstileExecutor): () => void {
  activeExecutor = executor;
  return () => {
    if (activeExecutor === executor) {
      activeExecutor = null;
    }
  };
}

/** Test-only escape hatch so suites can reset module-level state. */
export function resetTurnstileForTesting() {
  activeExecutor = null;
  executionChain = Promise.resolve();
}

function withTimeout(promise: Promise<string | null>): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), CAPTCHA_TOKEN_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer != null) {
      clearTimeout(timer);
    }
  });
}

/**
 * Fetch ONE fresh Turnstile token for the next auth call.
 *
 * Resolves null — never throws — when no site key is configured, no host is
 * mounted, the widget errors, or the execution exceeds
 * `CAPTCHA_TOKEN_TIMEOUT_MS`. Callers omit `captchaToken` entirely on null so
 * captcha-off environments see byte-identical requests to today.
 */
export async function getCaptchaToken(): Promise<string | null> {
  if (!getTurnstileSiteKey()) {
    return null;
  }

  const executor = activeExecutor;
  if (!executor) {
    return null;
  }

  const run = executionChain.then(() => {
    try {
      return withTimeout(executor()).catch(() => null);
    } catch {
      return null;
    }
  });

  // The chain must never carry a rejection forward or every later call fails.
  executionChain = run.catch(() => null);

  return run;
}
