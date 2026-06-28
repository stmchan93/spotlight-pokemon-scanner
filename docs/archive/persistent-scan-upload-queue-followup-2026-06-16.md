# Follow-up: persistent (cross-launch) scan-artifact upload queue

Status: **DEFERRED — post-show.** Filed 2026-06-16. Owner: TBD.
Priority: medium (training-data flywheel; not a user-facing bug, not a beta blocker).

## Context / why this exists

Scans feed the visual-matcher training corpus, so a lost scan artifact = a lost
training sample. Two loss modes were found via the "Scanner health" PostHog
dashboard (insight `8CHCgRuZ`) and partly fixed on 2026-06-16:

- **Source-image loss (fixed, commit b61be8d):** `expo-file-system/legacy` import fix
  — see [expo-file-system gotcha memory]. Was 100%, now ~0% on the updated bundle.
- **Artifact upload-fail (partly fixed, commit ebcd7b5):** longer timeout + backoff
  retries + drop-source-on-retry cut it from ~12–24% to a **~6% floor**.

This doc covers the remaining ~6% floor, which the cheap hardening **cannot** close.

## What the residual actually is (evidence, 2026-06-16)

PostHog HogQL over the residual `scan_artifact_upload_failed` events:
`p50 = 185ms, ~77% died < 1s, 0 anywhere near the 25s timeout`, all `error_kind = request_failed`.

That signature = **client-side drops where the request never leaves the phone**: the
app was **backgrounded** (locked phone, app-switch, swipe-home) or the network was
gone mid-flight. In-session retries can't help — if the app isn't running or there's
no signal, every retry attempt fails too. The upload is currently fire-and-forget
with no persistence, so a double/total failure is **permanent** (no server row to
backfill from; the sub-1s drops never reach the backend at all).

## The fix

Persist the upload locally and drain it later, instead of fire-and-forget:

1. On scan, write the artifact payload (at minimum the **normalized** image + `scanID`
   + `submittedAt`; source image optional) to disk, keyed by `scanID`.
2. Attempt the upload as today. On success, delete the queued file.
3. On failure, **leave it queued**. Drain the queue:
   - on next app **foreground** (`AppState` active),
   - and/or on **connectivity regained**,
   - and opportunistically at app launch.
4. Idempotent by design — the backend already **upserts by `scanID`** (no dedup work
   needed server-side; re-sending a previously-half-sent artifact is safe).
5. Bound it: cap queue size / age (e.g. keep last N or M days), drop oldest, and
   `log()`/breadcrumb what was dropped so silent truncation never reads as success.

## Code touch-points

- Client upload path: `packages/api-client/src/spotlight/repository.ts`
  — `uploadScanArtifactsForMatch` / `postScanArtifacts` (the retry loop shipped 2026-06-16),
  and `createScanArtifactUploadPayload`. The match-call site + `onArtifactUploadComplete`
  is in `apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx` (~:818).
- **Reuse the existing on-device persistence pattern** in
  `apps/spotlight-rn/src/features/scanner/recent-captures-persistence.ts`
  (`RECENT_CAPTURES_DIR`, `copyAsync`/`getInfoAsync`/`deleteAsync`, already on
  `expo-file-system/legacy`) rather than inventing new storage. The queue can sit
  alongside it (e.g. a `scan-upload-queue/` dir of small JSON descriptors pointing at
  the already-persisted capture files, to avoid duplicating base64 on disk).
- `AppState` (react-native) for the foreground trigger; optional `@react-native-community/netinfo`
  for connectivity (check whether it's already a dep before adding — prefer no new dep).

## Acceptance / how to verify

- A scan taken with the app then immediately backgrounded / in airplane mode lands in
  GCS after the app is reopened with connectivity (manual: scan → background → kill
  network → reopen → confirm the `scan_artifacts` row + GCS object appear).
- PostHog: the residual `scan_artifact_upload_failed` floor (the ~6%, sub-1s class)
  drops further once devices update; no permanent loss across a relaunch. Watch the
  hard-loss line on insight `8CHCgRuZ`.
- Storage stays bounded (queue dir doesn't grow unbounded); dropped items are logged.

## Out of scope (separate levers, also deferred)

- Backend GCS write off the request thread; VM resize (e2-medium → t2d-standard) for
  the 5–11s slow band. See [[project_backend_vm_sizing]].
