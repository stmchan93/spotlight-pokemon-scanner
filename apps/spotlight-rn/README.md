# Spotlight React Native App

React Native mobile shell for the Spotlight/Looty product.

## Platform support

- The React Native app is intended to run on both iOS and Android.
- Native release identifiers are currently env-driven for distribution builds.
- The checked-in `app.json` still uses placeholder app identifiers until you set real release values.
- Expo public env vars are the primary runtime-config path for both platforms.
- The older `Spotlight/Config/LocalOverrides.xcconfig` bridge remains as a local fallback, mainly for the existing iPhone workflow on this machine.

## Current state

- Portfolio, inventory, catalog, card detail, and sell flows run in React Native.
- The Python backend remains the shared runtime backend.
- The React Native scanner now calls the backend scan endpoints for authenticated users and returns raw-card matches from the normalized-target path.
- Scan artifact uploads and deck/portfolio mutations are user-scoped on the backend; staging/production should run with `SPOTLIGHT_AUTH_REQUIRED=1`.
- Slab scan parity is still incomplete in React Native and remains behind the native iOS path.

## Fastest iPhone workflow

From the repo root:

```bash
pnpm mobile:start:phone
```

What that does:

- starts the Python backend on `0.0.0.0:8788` when it is not already running
- detects your Mac's LAN IP
- starts Expo with `EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL=http://<your-mac-lan-ip>:8788`
- clears Metro cache before boot
- launches Expo in `--go` mode by default so the QR works with Expo Go

This is the correct path for testing the React Native shell on a physical iPhone when Expo Go is compatible with the SDK used by this app.

Install `Expo Go` from the App Store first, then scan the Expo QR with:

- the iPhone Camera app
- or the Expo Go app

Do not try to scan the Expo QR with the app's own scanner surface.

This project currently uses Expo SDK `55` (`expo ~55.0.17` in `package.json`). If Expo Go says the project is incompatible, the fastest fix is:

- update Expo Go on the phone
- or use the plugged-in dev-client workflow below

Do not treat "downgrade the app to Expo 54" as the quick fix for that message. That would be a broader Expo/React Native rollback, not a simple runtime toggle.

## Plugged-in iPhone workflow

If Expo Go is blocked or you want to run the native RN shell on a wired iPhone, use a dev client instead of Expo Go.

Build and install the native iOS app on the connected phone:

```bash
pnpm mobile:ios -- --device
```

Then run the backend and Metro in separate terminals:

Terminal 1:

```bash
pnpm backend:start:phone
```

Terminal 2:

```bash
pnpm mobile:start:phone:dev-client
```

What this gives you:

- the React Native app installed directly on the connected iPhone
- Metro running in dev-client mode
- the backend available on your Mac LAN IP at port `8788`

What this does not give you yet:

- slab scan parity with the native iOS app
- production-ready Android validation

If `pnpm mobile:ios -- --device` fails, open `apps/spotlight-rn/ios/Spotlight.xcworkspace` in Xcode and run the `Spotlight` target on the connected device.

## Split-terminal workflow

If you want the backend and Expo Go frontend in separate terminals:

Terminal 1:

```bash
pnpm backend:start:phone
```

Terminal 2:

```bash
pnpm mobile:start:phone:frontend
```

If you already have a custom iOS dev client installed and want to use that instead of Expo Go:

```bash
pnpm mobile:start:phone:dev-client
```

If LAN IP detection fails, set it manually:

```bash
SPOTLIGHT_PHONE_IP=192.168.1.23 pnpm mobile:start:phone
```

## Important limits

- The RN scanner now depends on authenticated backend access for scan/deck/portfolio flows. In staging/production, make sure the Supabase session is live and the backend is running with `SPOTLIGHT_AUTH_REQUIRED=1`.
- Raw scanning is the supported RN lane right now. Slab scanning still lacks full parity with the native iOS app.
- The Swift app lives at the repo root in `Spotlight.xcodeproj`.
- If portfolio/inventory/search fail on phone, the first thing to check is that the backend is reachable at `http://<your-mac-lan-ip>:8788/api/v1/health`.

## Release / TestFlight distribution

This app is not deployed to your VM. The VM only hosts the backend API. iPhone distribution goes through a native iOS build and TestFlight/App Store Connect.

The repo now includes env-split Expo release scaffolding:

- [eas.json](./eas.json)
- [.env.development.example](./.env.development.example)
- [.env.staging.example](./.env.staging.example)
- [.env.production.example](./.env.production.example)

### Environment files

Copy the examples and fill in real values:

```bash
cp apps/spotlight-rn/.env.development.example apps/spotlight-rn/.env.development
cp apps/spotlight-rn/.env.staging.example apps/spotlight-rn/.env.staging
cp apps/spotlight-rn/.env.production.example apps/spotlight-rn/.env.production
```

Do not keep development identical to staging/production.

- `.env.development` should point at your local backend by default, usually `http://127.0.0.1:8788`
- `.env.staging` should point at your hosted staging backend
- `.env.production` should point at your hosted production backend
- third-party services like Supabase can stay shared if you only have one project right now

Minimum values you need in each file:

```bash
EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL=https://your-public-backend-url
EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL=https://<your-project-ref>.supabase.co
EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY=<your-supabase-anon-or-publishable-key>
SPOTLIGHT_IOS_BUNDLE_IDENTIFIER=com.yourcompany.spotlight
SPOTLIGHT_EXPO_OWNER=your-expo-account
```

Recommended once the Expo project exists:

```bash
SPOTLIGHT_EAS_PROJECT_ID=<uuid-from-expo>
```

If you change the app scheme from the default `spotlight`, also update:

```bash
SPOTLIGHT_APP_SCHEME=your-scheme
EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_URL=your-scheme://login-callback
EXPO_PUBLIC_SPOTLIGHT_AUTH_SCHEME=your-scheme
```

### Build commands

From the repo root:

```bash
pnpm mobile:build:ios:development
pnpm mobile:build:ios:staging
pnpm mobile:build:ios:production
pnpm mobile:release:ios:staging
pnpm mobile:release:ios:production
pnpm mobile:submit:ios:staging
pnpm mobile:submit:ios
```

What they do:

- `mobile:build:ios:development` builds an internal dev-client build using `.env.development`, which should be local-backend-oriented
- `mobile:build:ios:staging` builds a store-signed staging build using `.env.staging`
- `mobile:build:ios:production` builds the TestFlight/App Store binary using `.env.production`
- `mobile:release:ios:staging` does a one-shot staging `build + auto-submit` to TestFlight
- `mobile:release:ios:production` does a one-shot production `build + auto-submit` to TestFlight
- `mobile:submit:ios:staging` uploads the staging build to App Store Connect / TestFlight
- `mobile:submit:ios` uploads the production build to App Store Connect / TestFlight

The helper script [tools/run_mobile_eas.sh](/Users/stephenchan/Code/spotlight/tools/run_mobile_eas.sh:1) automatically loads the matching env file and sets `SPOTLIGHT_APP_ENV` before invoking EAS CLI.
It also fails fast if the env file still contains placeholder values like `example.com` or `com.yourcompany.*`.
For staging/production iOS builds and submissions, it now also auto-generates:

- a short EAS build message
- a TestFlight `What to Test` summary for preview/manual use

Those notes come from [CHANGELOG.md](/Users/stephenchan/Code/spotlight/CHANGELOG.md) when you are exactly on a released commit, or from commits since the latest tag when you are ahead of the last release. You can preview them locally with:

```bash
pnpm release:notes:preview
pnpm release:notes:testflight
pnpm release:notes:build-message
```

By default, `run_mobile_eas.sh` does **not** pass the generated TestFlight summary to EAS because EAS submits it as a changelog field that requires an Expo Enterprise plan. If the account supports that feature, opt in with `SPOTLIGHT_EAS_TESTFLIGHT_CHANGELOG_ENABLED=1`.

## Release automation

The repo now supports automated release/changelog flow through GitHub Actions and Release Please:

- `.github/workflows/release-please.yml`
- `release-please-config.json`
- `.release-please-manifest.json`
- [CHANGELOG.md](/Users/stephenchan/Code/spotlight/CHANGELOG.md)

Recommended workflow:

1. Merge conventional-commit changes into `main`, ideally through squash merges with semantic PR titles such as:
   - `feat(scanner): improve visual match tray`
   - `fix(portfolio): keep cached data visible on first open`
2. Release Please opens or updates a release PR automatically.
3. Merge the release PR.
4. Release Please creates the GitHub Release and updates `CHANGELOG.md`.
5. Run the manual GitHub Action `.github/workflows/ios-testflight-release.yml` for `staging` or `production`.

Before a staged/prod backend deploy or TestFlight build, run:

```bash
pnpm release:audit:staging
pnpm release:audit:production
```

That preflight checks:
- hosted backend auth settings (`SPOTLIGHT_AUTH_REQUIRED=1`, `SUPABASE_URL`, no auth fallback user)
- backend artifact bucket/storage config
- mobile release env values used by `run_mobile_eas.sh`

The TestFlight workflow uses the same release-note generator for previews/build messages. Passing generated TestFlight text into EAS via `--what-to-test` is opt-in with `SPOTLIGHT_EAS_TESTFLIGHT_CHANGELOG_ENABLED=1` because EAS changelog submission requires an Expo Enterprise plan.

### GitHub setup needed

Repo-level secret:

- `EXPO_TOKEN`

Optional repo-level secret:

- `RELEASE_PLEASE_TOKEN`
  - only needed if you want Release Please PRs/releases to trigger additional workflows that the default `GITHUB_TOKEN` would suppress

GitHub environment setup:

- create `staging` and `production` environments
- add the following variables/secrets per environment so the iOS TestFlight workflow can run without local `.env` files:
  - `EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL`
  - `EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL`
  - `EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY`
  - `EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_URL`
  - `EXPO_PUBLIC_SPOTLIGHT_AUTH_SCHEME`
  - `SPOTLIGHT_APP_SCHEME`
  - `SPOTLIGHT_EXPO_OWNER`
  - `SPOTLIGHT_EAS_PROJECT_ID`
  - `SPOTLIGHT_IOS_BUNDLE_IDENTIFIER`

Optional local/CI overrides supported by `tools/run_mobile_eas.sh`:

- `MOBILE_EAS_ENV_FILE`
- `SPOTLIGHT_BUILD_MESSAGE`
- `SPOTLIGHT_TESTFLIGHT_NOTES`
- `SPOTLIGHT_TESTFLIGHT_NOTES_FILE`

The GitHub workflow is intentionally iOS-only for now because your existing automated release path is currently TestFlight-focused.

For physical-phone local development, prefer the phone helper launcher instead of editing `.env.development` to your current LAN IP:

```bash
pnpm backend:start:phone
pnpm mobile:start:phone:frontend:dev-client
```

That launcher keeps `.env.development` local-first while overriding Expo at runtime with `http://<your-mac-lan-ip>:8788`.

### First production TestFlight pass

1. Fill out `apps/spotlight-rn/.env.production`.
2. Log in once with Expo:
   `pnpm dlx eas-cli login`
3. Create or link the Expo project from `apps/spotlight-rn`:
   `cd apps/spotlight-rn && pnpm dlx eas-cli project:init`
4. Put the returned project ID into `SPOTLIGHT_EAS_PROJECT_ID` in all three env files.
5. Create the App Store Connect app for your chosen iOS bundle identifier.
6. From the repo root, run:
   `pnpm mobile:release:ios:production`
7. In App Store Connect, open TestFlight, finish any missing metadata, and invite testers.

### Manual setup still required outside the repo

- Apple Developer membership
- an App Store Connect app record for your chosen bundle identifier
- an Expo account / EAS project
- a real public `https://` backend URL
- Supabase project config for the same redirect URL the app uses
- Apple sign-in configured in Supabase if you want Apple auth live for testers

## Supabase auth config

The RN app now mirrors the Swift app's phase-1 Supabase auth gate:

- boot-time session restore
- Google sign-in through Supabase OAuth
- native Apple sign-in on iOS
- profile completion gate
- account screen + sign out

Set these Expo env vars before starting the app:

```bash
EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL=https://<your-project-ref>.supabase.co
EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY=<your-supabase-anon-or-publishable-key>
```

If you are running on Android, also set:

```bash
EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL=http://<your-backend-host>:8788
```

Optional override if you want a non-default auth callback:

```bash
EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_URL=spotlight://login-callback
```

Supabase Auth must allow the redirect URL used by the RN app. By default that is:

```text
spotlight://login-callback
```

Apple sign-in also requires a native rebuild after config changes because the app now declares the Apple sign-in capability through Expo config.

For Android builds and CI, prefer the Expo env vars above instead of relying on `LocalOverrides.xcconfig`.

## Direct backend run

If you want to run the backend yourself instead of using the helper script:

```bash
backend/.venv/bin/python -m pip install -r backend/requirements.vm.txt
backend/.venv/bin/python backend/server.py \
  --database-path backend/data/spotlight_scanner.sqlite \
  --host 0.0.0.0 \
  --port 8788
```

Then start Expo with:

```bash
EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL=http://<your-mac-lan-ip>:8788 pnpm --filter @spotlight/mobile-app start -- --clear
```
