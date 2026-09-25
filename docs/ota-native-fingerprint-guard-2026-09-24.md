# OTA native-fingerprint guard (2026-09-24)

An OTA reaches every binary on its channel + `runtimeVersion`. `runtimeVersion` is a hand-set string (`SPOTLIGHT_RUNTIME_VERSION_BY_ENV` in `apps/spotlight-rn/app.config.js`, with app.json as the fallback). So an OTA whose JS needs native code that the installed binary doesn't have (a new module such as expo-sqlite, a config plugin, an app extension) crashes on launch for everyone on that runtime. `tools/run_mobile_eas.sh` now blocks that.

## How it works

- `tools/native_fingerprint.cjs` computes the `@expo/fingerprint` hash for one platform. It runs under the env that `run_mobile_eas.sh` exports, so `app.config.js` resolves the same config an EAS build would. It skips inputs that are the lookup key itself or that ship inside the OTA manifest: versions, the string `runtimeVersion`, `expo.extra`, package.json scripts, and `.gitignore`. It adds `targets/` (Apple app extensions) as an extra iOS source.
- `tools/native-fingerprints.json` is committed. It stores `{env: {runtimeVersion: {ios|android: {hash, sources, gitCommit, via, recordedAt}}}}`.
- **OTA** (`update`): if the current fingerprint differs from the record, the OTA is refused. The message lists the native inputs that changed and says: bump runtimeVersion and ship a native build. If there is no record, the OTA is also refused, unless `SPOTLIGHT_RECORD_FINGERPRINT=1` seeds one.
- **Native build** (`build` and `release`): the tree is fingerprinted before upload. The build is refused if a record for that runtime exists and differs. In that case, old binaries on the runtime would get OTAs built against the new native code. Bump runtimeVersion, or set `SPOTLIGHT_NATIVE_FINGERPRINT_OVERWRITE=1` if every binary on that runtime is being replaced. When the build succeeds, the fingerprint is recorded. Commit the file afterwards. The clean-worktree check won't let the next build or OTA run until you do.

## Commands

```bash
# Inspect (no writes)
python3 tools/native_fingerprint_guard.py show   --environment staging --platform ios --resolve-env
# Seed / re-record manually (from a tree matching the installed binaries)
python3 tools/native_fingerprint_guard.py record --environment staging --platform ios --resolve-env --via seed
```

You only need to seed when there is no record and no new native build is coming. It must be seeded from a tree whose native code matches the binaries users have. A native build through `run_mobile_eas.sh` records its own fingerprint.

Cost: about 1.5–4 s per platform, done locally with no network (`--resolve-env` does an `eas env:pull` for staging). `eas fingerprint:compare` is Expo's hosted cross-check. EAS stores its own per-build fingerprint, but it uses default options, so its hashes differ from ours.
