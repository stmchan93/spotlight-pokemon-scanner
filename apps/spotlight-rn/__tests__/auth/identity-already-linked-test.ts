import { isIdentityAlreadyLinkedError } from '@/features/auth/auth-service';

/*
  The guest→account link fallback (reinstall → guest scan → sign in to an
  EXISTING account) hinges on recognizing GoTrue's refusal. Miss it and the
  user is stuck at "identity is already linked to another user" with no way
  into their own account — found live during the 2026-08-13 cutover smoke.
*/
describe('isIdentityAlreadyLinkedError', () => {
  it('matches the GoTrue error code', () => {
    expect(isIdentityAlreadyLinkedError({ code: 'identity_already_exists' })).toBe(true);
  });

  it('matches the human message shape', () => {
    expect(
      isIdentityAlreadyLinkedError({ message: 'Identity is already linked to another user' }),
    ).toBe(true);
  });

  it('rejects unrelated auth errors, so real failures still surface', () => {
    expect(isIdentityAlreadyLinkedError({ code: 'over_request_rate_limit' })).toBe(false);
    expect(isIdentityAlreadyLinkedError({ message: 'Network request failed' })).toBe(false);
    expect(isIdentityAlreadyLinkedError(null)).toBe(false);
    expect(isIdentityAlreadyLinkedError(undefined)).toBe(false);
  });
});
