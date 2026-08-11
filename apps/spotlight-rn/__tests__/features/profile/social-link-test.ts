import {
  describeSocialLinkValidity,
  normalizeSocialLink,
  sanitizeSocialLinkInput,
  validateSocialLink,
} from '@/features/profile/social-link';

/*
  Reported by a tester: "the social media url permits invalid urls". It did —
  the field trimmed and saved anything, and both readers then prefixed
  `https://` and called `Linking.openURL(...).catch(() => {})`, so a bad value
  rendered as a blue link and did nothing when tapped. Silent.
*/
describe('social link validation', () => {
  it('accepts a bare host and a full URL alike', () => {
    for (const value of [
      'instagram.com/ash',
      'https://instagram.com/ash',
      'HTTP://Example.com',
      'example.co.uk',
    ]) {
      expect(validateSocialLink(value)).toBe('ok');
    }
  });

  // Optional, exactly like a handle — clearing the field is not an error.
  it('treats empty as legitimate, not invalid', () => {
    expect(validateSocialLink('')).toBe('empty');
    expect(validateSocialLink('   ')).toBe('empty');
    expect(validateSocialLink(null)).toBe('empty');
    expect(describeSocialLinkValidity('empty')).toBeNull();
  });

  /*
    THE REPORTED CASE. `new URL('https://hello world')` does NOT throw — it
    percent-encodes the space and yields host "hello". So the space has to be
    rejected before parsing, which is why a regex-only check missed it.
  */
  it('rejects text with spaces, which the old prefix-and-hope accepted', () => {
    expect(validateSocialLink('hello world')).toBe('has-space');
    expect(describeSocialLinkValidity('has-space')).toMatch(/space/i);
  });

  /*
    Also parses clean but resolves nowhere. Half-typed values like this are
    exactly what a social field collects, and `new URL` alone is happy with them.
  */
  it('rejects a hostname with no dot', () => {
    expect(validateSocialLink('instagram')).toBe('no-host');
    expect(validateSocialLink('https://instagram')).toBe('no-host');
    expect(validateSocialLink('trailing.')).toBe('no-host');
  });

  // Named separately from "not a link" so the message can be honest about why.
  it('rejects schemes it will not open, rather than calling them malformed', () => {
    expect(validateSocialLink('mailto:ash@example.com')).toBe('bad-scheme');
    expect(validateSocialLink('javascript:alert(1)')).toBe('bad-scheme');
    expect(describeSocialLinkValidity('bad-scheme')).toMatch(/http/i);
  });

  it('never rejects while sanitizing, only bounds', () => {
    expect(sanitizeSocialLinkInput('  instagram.com/ash  ')).toBe('instagram.com/ash');
    expect(sanitizeSocialLinkInput('a'.repeat(500))).toHaveLength(200);
  });

  /*
    `normalizeSocialLink` is what gets STORED and OPENED. Returning null for an
    unusable value is the guard: it is what stops a string that cannot open
    being persisted and then drawn as a link.
  */
  describe('normalizing for storage and Linking.openURL', () => {
    it('adds the scheme a bare host is missing', () => {
      expect(normalizeSocialLink('instagram.com/ash')).toBe('https://instagram.com/ash');
    });

    it('keeps an explicit scheme', () => {
      expect(normalizeSocialLink('http://example.com/x')).toBe('http://example.com/x');
    });

    it('returns null for anything that cannot open', () => {
      expect(normalizeSocialLink('hello world')).toBeNull();
      expect(normalizeSocialLink('instagram')).toBeNull();
      expect(normalizeSocialLink('mailto:ash@example.com')).toBeNull();
      expect(normalizeSocialLink('')).toBeNull();
    });
  });
});
