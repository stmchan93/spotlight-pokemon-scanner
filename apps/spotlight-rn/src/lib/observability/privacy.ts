const sensitiveFieldNames = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'authorizationheader',
  'base64',
  'cardid',
  'cardids',
  'cardname',
  'cardnames',
  'email',
  'idtoken',
  'image',
  'imagebase64',
  'imageuri',
  'jpegbase64',
  'normalizedimagebase64',
  'normalizedtarget',
  'normalizedtargetbase64',
  'ocrtext',
  'ocrtokens',
  'password',
  'price',
  'prices',
  'refreshtoken',
  'requestbody',
  'requesturl',
  'scanid',
  'secret',
  'sourcecapture',
  'sourcecapturebase64',
  'token',
  'uri',
  'url',
]);

const redactableStringPatterns = [
  /^file:\/\//i,
  /^data:image\//i,
];

export const OBSERVABILITY_REDACTED_VALUE = '[redacted]';

function normalizeFieldName(value: string) {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function shouldRedactField(key: string) {
  return sensitiveFieldNames.has(normalizeFieldName(key));
}

function shouldRedactString(value: string) {
  return redactableStringPatterns.some((pattern) => pattern.test(value));
}

export function scrubObservabilityValue(value: unknown, key?: string): unknown {
  if (key && shouldRedactField(key)) {
    return OBSERVABILITY_REDACTED_VALUE;
  }

  if (typeof value === 'string') {
    return shouldRedactString(value) ? OBSERVABILITY_REDACTED_VALUE : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => scrubObservabilityValue(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const scrubbedEntries = Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => {
    return [entryKey, scrubObservabilityValue(entryValue, entryKey)];
  });

  return Object.fromEntries(scrubbedEntries);
}
