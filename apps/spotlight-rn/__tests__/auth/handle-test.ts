import {
  HANDLE_MAX_LENGTH,
  describeHandleValidity,
  sanitizeHandleInput,
  validateHandle,
} from '@/features/auth/auth-models';

describe('sanitizeHandleInput', () => {
  it('drops a leading @ and lowercases', () => {
    expect(sanitizeHandleInput('@AshKetchum')).toBe('ashketchum');
  });

  it('strips characters the handle index will not accept', () => {
    expect(sanitizeHandleInput('ash ketchum!')).toBe('ashketchum');
    expect(sanitizeHandleInput('ash.ketchum-01')).toBe('ashketchum01');
  });

  it('keeps underscores and digits', () => {
    expect(sanitizeHandleInput('ash_99')).toBe('ash_99');
  });

  it('caps at the max length', () => {
    expect(sanitizeHandleInput('a'.repeat(50))).toHaveLength(HANDLE_MAX_LENGTH);
  });

  it('collapses a whitespace-only entry to empty', () => {
    expect(sanitizeHandleInput('   ')).toBe('');
  });
});

describe('validateHandle', () => {
  it('treats an absent handle as empty, not invalid — handles are optional', () => {
    expect(validateHandle('')).toBe('empty');
    expect(validateHandle(null)).toBe('empty');
    expect(validateHandle(undefined)).toBe('empty');
  });

  it('rejects handles below the minimum length', () => {
    expect(validateHandle('ab')).toBe('too-short');
  });

  it('rejects a leading underscore', () => {
    expect(validateHandle('_ash')).toBe('bad-start');
  });

  it('accepts a well-formed handle', () => {
    expect(validateHandle('ash_99')).toBe('ok');
    expect(validateHandle('@AshKetchum')).toBe('ok');
  });

  it('rejects reserved handles, including the live /u/[handle] route segments', () => {
    expect(validateHandle('admin')).toBe('reserved');
    expect(validateHandle('@Ekalight')).toBe('reserved');
    expect(validateHandle('followers')).toBe('reserved');
    expect(validateHandle('following')).toBe('reserved');
  });

  it('does not reject handles that merely contain a reserved word', () => {
    expect(validateHandle('admiral')).toBe('ok');
    expect(validateHandle('support_ash')).toBe('ok');
  });
});

describe('describeHandleValidity', () => {
  it('explains only the fixable problems', () => {
    expect(describeHandleValidity('too-short')).toMatch(/at least/i);
    expect(describeHandleValidity('bad-start')).toMatch(/letter or number/i);
    expect(describeHandleValidity('reserved')).toMatch(/isn't available/i);
  });

  it('says nothing for empty or ok', () => {
    expect(describeHandleValidity('empty')).toBeNull();
    expect(describeHandleValidity('ok')).toBeNull();
  });
});
