import {
  OBSERVABILITY_REDACTED_VALUE,
  scrubObservabilityValue,
} from '@/lib/observability/privacy';

describe('scrubObservabilityValue', () => {
  it('redacts nested sensitive keys while preserving safe fields', () => {
    expect(scrubObservabilityValue({
      Authorization: 'Bearer secret-token',
      nested: {
        'normalized-image-base64': 'abc123',
        request_url: 'https://api.example.com/private',
        safeLabel: 'raw',
      },
      safeCount: 3,
      sourceCapture: {
        uri: 'file:///private-source.jpg',
      },
    })).toEqual({
      Authorization: OBSERVABILITY_REDACTED_VALUE,
      nested: {
        'normalized-image-base64': OBSERVABILITY_REDACTED_VALUE,
        request_url: OBSERVABILITY_REDACTED_VALUE,
        safeLabel: 'raw',
      },
      safeCount: 3,
      sourceCapture: OBSERVABILITY_REDACTED_VALUE,
    });
  });

  it('redacts file and data-image strings even without a sensitive key name', () => {
    expect(scrubObservabilityValue({
      captures: [
        'file:///private-scan.jpg',
        'data:image/jpeg;base64,abc123',
        'https://spotlight.example.com/public',
      ],
      previewUri: 'file:///private-preview.jpg',
      notes: 'safe text',
    })).toEqual({
      captures: [
        OBSERVABILITY_REDACTED_VALUE,
        OBSERVABILITY_REDACTED_VALUE,
        'https://spotlight.example.com/public',
      ],
      previewUri: OBSERVABILITY_REDACTED_VALUE,
      notes: 'safe text',
    });
  });
});
