/*
  ─────────────────────────────────────────────────────────────────────────────
  THE ONE PLACE THAT DECIDES WHAT A SOCIAL LINK IS
  ─────────────────────────────────────────────────────────────────────────────
  The field accepted anything. `edit-profile-screen` did `socialLink.trim()` and
  nothing else, `auth-service` wrote it through unchanged, and the column is a
  plain nullable `text` with no CHECK. So "hello world" saved fine, rendered as a
  blue link, and — because both readers prefix a bare value with `https://` and
  then call `Linking.openURL(...).catch(() => {})` — did nothing at all when
  tapped. Reported by a tester as "the social media url permits invalid urls".

  A silent no-op is the worst of the options: the profile advertises a link that
  cannot work, and the owner has no way to find out.

  The shape here follows `auth-models`' handle trio deliberately:

    sanitize  — never rejects, only narrows, so the field cannot fight the user
                mid-word.
    validate  — classifies a finished value.
    describe  — turns a classification into copy.

  `normalizeSocialLink` additionally absorbs the `/^https?:\/\//i` test that was
  written out twice, in `public-profile-screen` and `portfolio-screen`. Those two
  are the reason this lives in its own module rather than inside the edit screen:
  the value is READ in more places than it is written.
*/

/** Generous, but bounded — a URL this long is a tracking blob, not a profile. */
export const SOCIAL_LINK_MAX_LENGTH = 200;

/**
 * Trim and bound, without judging. Safe to call on every keystroke.
 *
 * Deliberately does NOT strip or add a scheme: doing that while someone is
 * typing rewrites the text under the cursor, which is the behaviour the handle
 * field's comment warns about.
 */
export function sanitizeSocialLinkInput(value: string): string {
  return value.trim().slice(0, SOCIAL_LINK_MAX_LENGTH);
}

export type SocialLinkValidity = 'empty' | 'has-space' | 'no-host' | 'bad-scheme' | 'ok';

/**
 * Classify a finished value. `empty` is legitimate, not an error — a social link
 * is optional, exactly like a handle.
 *
 * Parsing is `new URL`, not a regex: the regexes this replaces were happy with
 * `https://hello world`. Hermes ships a URL implementation and the app already
 * relies on it (`app-providers`, `auth-service`).
 */
export function validateSocialLink(value: string | null | undefined): SocialLinkValidity {
  const link = sanitizeSocialLinkInput(value ?? '');
  if (link.length === 0) {
    return 'empty';
  }
  // Checked before parsing: `new URL` percent-encodes interior spaces rather
  // than failing, so "hello world" would otherwise sail through as a host.
  if (/\s/.test(link)) {
    return 'has-space';
  }

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(link);
  // A scheme we will not open. Checked separately from parse failure so
  // `mailto:` or `javascript:` gets an honest answer rather than "not a link".
  if (hasScheme && !/^https?:\/\//i.test(link)) {
    return 'bad-scheme';
  }

  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? link : `https://${link}`);
  } catch {
    return 'no-host';
  }

  /*
    A hostname has to have a dot and something after it. `new URL` is happy with
    `https://instagram` — a valid URL that resolves nowhere on the public
    internet, and precisely the kind of half-typed value this field collects.
  */
  const host = parsed.hostname;
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) {
    return 'no-host';
  }
  return 'ok';
}

/*
  `describeSocialLinkValidity` USED TO LIVE HERE AND IS DELIBERATELY GONE.

  It turned a validity into red copy under the field — and because the field
  re-validated on every keystroke, typing `instagram.com/you` was told "Enter a
  full address, like instagram.com/you" from its first character. There is no
  timing that fixes that: a half-typed URL is genuinely invalid, so any validator
  watching the keystroke is correct and still wrong to speak.

  The field now accepts free text and says nothing. What used to be an error is a
  COLOUR: blue while the value is openable, ordinary text while it is not, in the
  edit field and on the profile alike. Do not reintroduce the copy — reintroduce
  the colour somewhere new if a surface needs the signal.
*/

/**
 * The value to OPEN: an absolute `https://` URL, or null when there is nothing
 * usable.
 *
 * NOT the value to store, despite what this used to say. Storing the normalised
 * form meant an unopenable value was persisted as empty, so typing `instagram` and
 * pressing SAVE cleared the field. The raw text is stored now
 * (`sanitizeSocialLinkInput`) and this decides, at DISPLAY time, whether it is
 * drawn as a link at all — which is what stops an unopenable string being
 * presented as one. Every read site should call this instead of prefixing
 * `https://` itself.
 */
export function normalizeSocialLink(value: string | null | undefined): string | null {
  const link = sanitizeSocialLinkInput(value ?? '');
  if (validateSocialLink(link) !== 'ok') {
    return null;
  }
  const withScheme = /^https?:\/\//i.test(link) ? link : `https://${link}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    return null;
  }
}
