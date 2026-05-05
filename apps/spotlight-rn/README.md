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

## Claude design workflow

For design-system or screen-polish work with Claude:

1. Generate the repo handoff bundle:

```bash
pnpm claude:design:bundle
```

2. Start the RN design catalog:

```bash
pnpm mobile:visual:design
```

3. Open the design-system route:

- deep link: `spotlight://design-system`
- Expo route path: `/design-system`

4. Give Claude:

- `tmp/claude-design/claude-design-bundle.md`
- `5-8` screenshots max
- one exact task at a time

The design-system source of truth remains:

- `packages/design-system/src/tokens.ts`
- `packages/design-system/src/theme.tsx`
- `packages/design-system/src/components/*.tsx`
- `packages/design-system/README.md`

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

Copy the examples you actually want to use locally:

```bash
cp apps/spotlight-rn/.env.development.example apps/spotlight-rn/.env.development
cp apps/spotlight-rn/.env.production.example apps/spotlight-rn/.env.production
```

Current recommended split:

- `.env.development` is optional local fallback for development-only mobile builds
- staging mobile scripts resolve from `eas.json` plus Expo `preview` environment variables, so a handwritten `apps/spotlight-rn/.env.staging` is not required
- `.env.production` should point at your hosted production backend if you use the local production wrappers
- third-party services like Supabase can stay shared if you only have one project right now

Minimum values you need in local mobile env files:

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

### Observability

The app currently ships `PostHog` only for product analytics:

- manual screen views
- a small set of explicit product events
- no touch autocapture
- no session replay
- no surveys
- no feature flags or experiments preload

Expected env values:

```bash
EXPO_PUBLIC_SPOTLIGHT_POSTHOG_API_KEY=<project-api-key>
EXPO_PUBLIC_SPOTLIGHT_POSTHOG_HOST=https://us.i.posthog.com
EXPO_PUBLIC_SPOTLIGHT_POSTHOG_ENABLED=0|1
```

Recommended defaults:

- `.env.development`: `EXPO_PUBLIC_SPOTLIGHT_POSTHOG_ENABLED=0`
- staging: set PostHog in Expo `preview`
- `.env.production`: enable PostHog only after the API key is set if you want it for production too

Privacy expectations for this repo:

- do not send scanner base64 payloads, normalized targets, source captures, raw OCR text, auth tokens, local file URIs, card IDs, card names, or prices to PostHog
- rely on the shared scrubbing layer for defensive redaction, but treat event payload design as the first line of defense

Cost control is configured outside the repo:

- in PostHog, enable product analytics only for phase 1 and set a spend cap before turning on staging/production traffic

The release helper also enforces the observability env contract when you opt in:

- if `EXPO_PUBLIC_SPOTLIGHT_POSTHOG_ENABLED=1`, builds fail fast unless `EXPO_PUBLIC_SPOTLIGHT_POSTHOG_API_KEY` is present

### PostHog MCP

The repo-level [.mcp.json](/Users/stephenchan/Code/spotlight/.mcp.json) now includes a generic PostHog MCP server entry with no credentials and no pinned organization/project context:

- `https://mcp.posthog.com/mcp`

This is safe to keep checked in because it does not include an API key, org ID, or project ID. First-use authentication still stays local to your MCP client.

If your MCP client needs a manual config, the equivalent entry is:

```json
{
  "mcpServers": {
    "posthog": {
      "type": "http",
      "url": "https://mcp.posthog.com/mcp"
    }
  }
}
```

If your MCP client does not support OAuth, use a PostHog personal API key created with the MCP Server preset and add it as an `Authorization: Bearer ...` header in your local config. Keep pinned org/project headers local as well if you want to restrict the MCP context.

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
- `mobile:build:ios:staging` builds a store-signed staging build using `eas.json` plus Expo `preview` env
- `mobile:build:ios:production` builds the TestFlight/App Store binary using `.env.production`
- `mobile:release:ios:staging` does a one-shot staging `build + auto-submit` to TestFlight
- `mobile:release:ios:production` does a one-shot production `build + auto-submit` to TestFlight
- `mobile:submit:ios:staging` uploads the staging build to App Store Connect / TestFlight
- `mobile:submit:ios` uploads the production build to App Store Connect / TestFlight

The helper script [tools/run_mobile_eas.sh](/Users/stephenchan/Code/spotlight/tools/run_mobile_eas.sh:1) resolves mobile config before invoking EAS CLI:

- staging uses `eas.json` static profile env plus Expo `preview` variables
- development/production still respect local `apps/spotlight-rn/.env.<environment>` files when present

It also fails fast if the resolved config still contains placeholder values like `example.com` or `com.yourcompany.*`.
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

For a higher-trust staging release gate, use:

```bash
pnpm release:gate:staging
pnpm release:gate:staging:build
pnpm release:gate:staging:release
```

The staging wrapper now skips smoke by default so frontend/TestFlight work is not blocked on local smoke credentials or fixture reset state. To force the staging gate to run smoke again, pass:

```bash
pnpm release:gate:staging -- --run-smoke
pnpm release:gate:staging:build -- --run-smoke
pnpm release:gate:staging:release -- --run-smoke
```

Those commands run one wrapper, [tools/run_release_gate.py](/Users/stephenchan/Code/spotlight/tools/run_release_gate.py:1), which can:

- run `pnpm release:check`
- run `pnpm release:audit:staging`
- deploy the staging backend VM
- authenticate as a dedicated smoke user
- verify staging health, auth, inventory, portfolio, catalog search, manual add, and scan-add flows
- optionally kick off the iOS staging EAS build or full TestFlight release

Required CI/local secrets for the smoke gate:

- `SPOTLIGHT_STAGING_SMOKE_EMAIL`
- `SPOTLIGHT_STAGING_SMOKE_PASSWORD`

Optional overrides:

- `SPOTLIGHT_STAGING_SMOKE_BEARER_TOKEN`
- `SPOTLIGHT_STAGING_SMOKE_CARD_QUERY`

Use a dedicated smoke-test account only. The smoke gate intentionally performs real add-card mutations so it can catch inventory/scan regressions before a release.

The normal staging shortcuts now route through that gate too:

```bash
pnpm deploy:staging
pnpm mobile:build:ios:staging
pnpm mobile:release:ios:staging
```

If you need the low-level Expo wrapper directly for debugging, use [tools/run_mobile_eas.sh](/Users/stephenchan/Code/spotlight/tools/run_mobile_eas.sh:1) instead of the package shortcut.

### iOS staging simulator smoke

There is now a dedicated Maestro staging smoke suite under:

- `apps/spotlight-rn/.maestro/staging-smoke.yml`
- `.github/workflows/ios-staging-smoke.yml`

Use it locally with:

```bash
pnpm mobile:smoke:staging:maestro
```

Optional scanner-fixture smoke:

```bash
pnpm mobile:smoke:staging:maestro:scan-fixture
```

The suite is split into dedicated flows for:

- auth restore + portfolio
- scan shell
- catalog add-to-collection
- sales history
- single sell
- bulk sell

Important current assumptions:

- The signed-in suite assumes the simulator already has a valid staging session, or that CI/local opens a smoke auth bootstrap deep link before Maestro starts.
- The scanner fixture suite now uses the staging-only `scanner-smoke-fixture-trigger` button, which is exposed only when `EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED=1` and the app is running as staging or a dev build.
- The inventory and bulk-sell Maestro flows are designed to target stable smoke selectors from the RN source layer rather than runtime row IDs.

Required staging environment variables for the Maestro smoke lane:

- `SPOTLIGHT_MAESTRO_CATALOG_QUERY`
- `SPOTLIGHT_MAESTRO_CATALOG_RESULT_ID`
- `SPOTLIGHT_MAESTRO_SINGLE_SELL_ENTRY_ID`
- `SPOTLIGHT_MAESTRO_SINGLE_SELL_PRICE`
- `SPOTLIGHT_MAESTRO_BULK_SELL_ENTRY_ID_ONE`
- `SPOTLIGHT_MAESTRO_BULK_SELL_ENTRY_ID_TWO`
- `SPOTLIGHT_MAESTRO_BULK_SELL_SOLD_PRICE_ID_ONE`
- `SPOTLIGHT_MAESTRO_BULK_SELL_SOLD_PRICE_ID_TWO`
- `SPOTLIGHT_MAESTRO_BULK_SELL_PRICE_ONE`
- `SPOTLIGHT_MAESTRO_BULK_SELL_PRICE_TWO`

Optional staging smoke variables:

- `SPOTLIGHT_MAESTRO_IOS_SIMULATOR_DEVICE`
- `SPOTLIGHT_MAESTRO_AUTH_BOOTSTRAP_LINK`

Recommended selector contract for the RN source layer:

- raw inventory rows: `inventory-entry-smoke-raw-${cardId}`
- graded inventory rows: `inventory-entry-smoke-graded-${cardId}-${grader}-${grade}-${cert}`
- catalog results: `catalog-result-smoke-${cardId}`
- bulk sell rows / fields should expose matching `*-smoke-*` IDs instead of runtime `entry.id` IDs

The GitHub workflow `ios-staging-smoke.yml` runs on `macos-latest`, boots an iOS simulator, launches the staging app, optionally opens the auth bootstrap link, then runs the signed-in Maestro suite. Use that workflow as the staging UI smoke gate before TestFlight release.

### Local one-command staging prerelease

For local release prep, the repo now supports one-command staging smoke from an ignored repo-root file:

- `.env.staging.smoke.local`
- `.env.staging.smoke.local.example`

With that file in place, use:

```bash
pnpm prerelease
```

That command now runs:

- `release:check`
- `release:audit:staging`
- hosted staging backend smoke via `tools/run_release_gate.py --skip-deploy`
- iOS simulator build/launch
- automatic Supabase smoke-session bootstrap into the simulator
- Maestro staging smoke
- Maestro scanner-fixture smoke

And for the full staging TestFlight path:

```bash
pnpm prerelease
pnpm mobile:build:ios:staging
pnpm mobile:release:ios:staging
```

Recommended split:

- `pnpm prerelease`
  - local staging prerelease gate only
- `pnpm mobile:build:ios:staging`
  - deploy staging backend + kick off the EAS staging build without rerunning local prerelease
- `pnpm mobile:release:ios:staging`
  - deploy staging backend + kick off the EAS staging release/TestFlight path without rerunning local prerelease

That keeps the smoke gate explicit so you can choose when to run it.

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
4. Put the returned project ID into the local mobile env files you actually use and keep the same ID in `eas.json`.
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
