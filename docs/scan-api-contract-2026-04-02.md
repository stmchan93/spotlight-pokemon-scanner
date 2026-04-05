# Scan API Contract

Update: see [spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md) for the current source of truth. This document is now the lower-level API appendix.

This is the scanner-first contract for the Spotlight iOS app and the local scan service.

## Endpoints

### `POST /api/v1/scan/match`

Request body:

```json
{
  "scanID": "UUID",
  "capturedAt": "2026-04-02T22:15:04Z",
  "clientContext": {
    "platform": "iOS",
    "appVersion": "1.0",
    "buildNumber": "1",
    "localeIdentifier": "en_US",
    "timeZoneIdentifier": "America/Los_Angeles"
  },
  "image": {
    "jpegBase64": "optional normalized jpeg payload",
    "width": 720,
    "height": 1024
  },
  "recognizedTokens": [
    { "text": "Charizard", "confidence": 0.92 },
    { "text": "223/197", "confidence": 0.88 }
  ],
  "fullRecognizedText": "Charizard ex 223/197",
  "collectorNumber": "223/197",
  "cropConfidence": 0.91,
  "warnings": []
}
```

Response body:

```json
{
  "scanID": "UUID",
  "topCandidates": [
    {
      "rank": 1,
      "candidate": {
        "id": "pokemon-charizard-ex-223-197",
        "name": "Charizard ex",
        "setName": "Obsidian Flame",
        "number": "223/197",
        "rarity": "Hyper Rare",
        "variant": "Raw",
        "language": "English"
      },
      "imageScore": 0.83,
      "collectorNumberScore": 0.40,
      "nameScore": 0.00,
      "finalScore": 0.91
    }
  ],
  "confidence": "high",
  "ambiguityFlags": [],
  "matcherSource": "remotePrototype",
  "matcherVersion": "prototype-hash-v1"
}
```

### `GET /api/v1/cards/search?q=...`

Response body:

```json
{
  "results": [
    {
      "id": "pokemon-charizard-ex-223-197",
      "name": "Charizard ex",
      "setName": "Obsidian Flame",
      "number": "223/197",
      "rarity": "Hyper Rare",
      "variant": "Raw",
      "language": "English"
    }
  ]
}
```

### `POST /api/v1/scan/feedback`

Request body:

```json
{
  "scanID": "UUID",
  "selectedCardID": "pokemon-charizard-ex-223-197",
  "wasTopPrediction": true,
  "correctionType": "acceptedTop",
  "submittedAt": "2026-04-02T22:15:10Z"
}
```

## Local Moat Data

The iOS app persists:

- normalized crop image path
- request payload
- response payload
- top candidate list
- selected card
- whether the top prediction was accepted
- correction type
- timestamps

That is the local telemetry foundation for later sync and model improvement.
