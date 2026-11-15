# OTA native-fingerprint guard (2026-09-24)

An OTA reaches every binary on its channel + `runtimeVersion`. `runtimeVersion` is a hand-set string (`SPOTLIGHT_RUNTIME_VERSION_BY_ENV` in `apps/spotlight-rn/app.config.js`, with app.json as the fallback). So an OTA whose JS needs native code that the installed binary doesn't have (a new module such as expo-sqlite, a config plugin, an app extension) crashes on launch for everyone on that runtime. `tools/run_mobile_eas.sh` now blocks that.

## How it works

- `tools/native_fingerprint.cjs` computes the `@expo/fingerprint` hash for one platform. It runs under the env that `run_mobile_eas.sh` exports, so `app.config.js` resolves the same config an EAS build would. It skips inputs that are the lookup key itself or that ship inside the OTA manifest: versions, the string `runtimeVersion`, `expo.extra`, package.json scripts, and `.gitignore`. It adds `targets/` (Apple app extensions) as an extra iOS source.
- Two inputs are normalized rather than skipped (method 2, 2026-11-15). The checkout's absolute path is replaced by `<repo-root>` in every `contents` source. `app.config.js` puts `file://<repo>/node_modules/...` into expo-build-properties `android.extraMavenRepos`, so building from another worktree used to change the hash. `eas.json` is still hashed, but without `EXPO_PUBLIC_*` build env. Its other env (bundle id, Android package, scheme) and its build settings stay in the hash, because a production fingerprint gets its env from `.env.production`, not from `eas.json`.
- `tools/native-fingerprints.json` is committed. It stores `{env: {runtimeVersion: {ios|android: {method, hash, sources, gitCommit, via, recordedAt}}}}`. `method` is the hashing method (`FINGERPRINT_METHOD` in the .cjs). A record without it is method 1. Hashes from different methods are never compared: the guard asks for a re-record instead of reporting a native change.
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

## Re-recording after a method change

When `FINGERPRINT_METHOD` changes, `check-update` and `check-build` refuse records from the old method with status `method-mismatch`. Re-record each live record from the commit its build was cut from (the record's `gitCommit`), using the current tools. Checking out the old commit alone isn't enough, because that brings back the old hashing code. The checkout path no longer affects the hash, so a throwaway worktree works:

```bash
git worktree add /tmp/fp-rerecord <gitCommit>
cd /tmp/fp-rerecord && pnpm install --frozen-lockfile
git checkout main -- tools/native_fingerprint.cjs tools/native_fingerprint_guard.py tools/mobile_env_resolver.py
cp <main checkout>/apps/spotlight-rn/.env.<env> apps/spotlight-rn/   # gitignored; must match what the build used
python3 tools/native_fingerprint_guard.py record --environment <env> --platform <ios|android> \
  --resolve-env --via build --force --records <main checkout>/tools/native-fingerprints.json
```

Then commit `tools/native-fingerprints.json` in the main checkout and remove the worktree. `--resolve-env` runs `eas env:pull` for staging, so it needs an EAS login. Records for runtimes that no longer get OTAs can stay on the old method.

Cost: about 1.5–4 s per platform, done locally with no network (`--resolve-env` does an `eas env:pull` for staging). `eas fingerprint:compare` is Expo's hosted cross-check. EAS stores its own per-build fingerprint, but it uses default options, so its hashes differ from ours.
