import type { AppUser } from '@/features/auth/auth-models';
import {
  buildEvolvedLead,
  EVOLVING_FALLBACK_NAME,
  EVOLVING_LEAD,
  EVOLVING_TAIL,
  resolveEvolvingName,
} from '@/features/whos-that-pokemon/evolution-copy';

function makeUser(overrides: Partial<AppUser> = {}): AppUser {
  return {
    adminEnabled: false,
    avatarURL: null,
    displayName: null,
    email: null,
    id: 'user-1',
    labelerEnabled: false,
    providers: [],
    ...overrides,
  };
}

describe('resolveEvolvingName', () => {
  it('shouts the first name from a real display name', () => {
    expect(resolveEvolvingName(makeUser({ displayName: 'Stephen Chan' }))).toBe('STEPHEN');
  });

  it('trims and collapses whitespace around the name', () => {
    expect(resolveEvolvingName(makeUser({ displayName: '  ash   ketchum ' }))).toBe('ASH');
  });

  it('falls back to the email prefix the way the rest of the app does', () => {
    // `getResolvedDisplayName` is the app-wide resolver, so this screen can
    // never disagree with the account screen about who you are.
    expect(
      resolveEvolvingName(makeUser({ displayName: null, email: 'ash@pallet.town' })),
    ).toBe('ASH');
  });

  it('uses the playful fallback when the account has no name at all', () => {
    // The common case, not an edge case: many accounts never finished the
    // profile step, and guests have neither a display name nor an email.
    expect(resolveEvolvingName(makeUser({ displayName: null, email: null }))).toBe(
      EVOLVING_FALLBACK_NAME,
    );
  });

  it('uses the playful fallback when nobody is signed in', () => {
    expect(resolveEvolvingName(null)).toBe(EVOLVING_FALLBACK_NAME);
    expect(resolveEvolvingName(undefined)).toBe(EVOLVING_FALLBACK_NAME);
  });

  it('never lets a null/blank name leak into the copy', () => {
    // "null is evolving!" is the exact failure this module exists to prevent.
    const nameless = [
      makeUser({ displayName: null, email: null }),
      makeUser({ displayName: '   ', email: null }),
      makeUser({ displayName: '', email: '' }),
      null,
    ];
    nameless.forEach((user) => {
      const name = resolveEvolvingName(user);
      const line = `${EVOLVING_LEAD} ${name} ${EVOLVING_TAIL}`;
      expect(name).toBe(EVOLVING_FALLBACK_NAME);
      expect(line.toLowerCase()).not.toContain('null');
      expect(line.toLowerCase()).not.toContain('undefined');
      expect(name.trim()).not.toBe('');
    });
  });

  it('clips a very long single-token name so it cannot dominate the card', () => {
    const name = resolveEvolvingName(
      makeUser({ displayName: 'Bulbasaurcharmandersquirtle' }),
    );
    expect(name).toBe('BULBASAURCHARM');
    expect(name.length).toBeLessThanOrEqual(14);
  });
});

describe('buildEvolvedLead', () => {
  it('names the user and hands the species to the hero line below it', () => {
    expect(buildEvolvedLead('STEPHEN')).toBe('STEPHEN evolved into…');
  });

  it('still reads as a sentence on the no-name fallback', () => {
    expect(buildEvolvedLead(EVOLVING_FALLBACK_NAME)).toBe('SOMEONE evolved into…');
  });
});
