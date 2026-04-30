# Release Automation

This repo now uses a three-part release automation stack:

1. `Release Please` for version bumps, `CHANGELOG.md`, release PRs, and GitHub Releases
2. `GitHub Actions` for running the release workflows
3. `tools/release_notes.mjs` for shortening changelog or recent-commit history into TestFlight-safe notes

## Source of truth

- Durable release history: [CHANGELOG.md](/Users/stephenchan/Code/spotlight/CHANGELOG.md)
- GitHub release workflow: `.github/workflows/release-please.yml`
- Release config: `release-please-config.json`
- Release manifest: `.release-please-manifest.json`

## TestFlight note flow

- Local and CI iOS release commands go through [tools/run_mobile_eas.sh](/Users/stephenchan/Code/spotlight/tools/run_mobile_eas.sh)
- For `staging` and `production` iOS actions, that script now:
  - generates a short build message
  - generates TestFlight `What to Test` notes
  - passes them to `eas build --auto-submit` or `eas submit`

The note source is:

1. commits since the latest Git tag, if HEAD is ahead of the last release
2. otherwise the latest release section in `CHANGELOG.md`

Useful local preview commands:

- `pnpm release:notes:preview`
- `pnpm release:notes:testflight`
- `pnpm release:notes:build-message`

## Required GitHub setup

### Repo secrets

- `EXPO_TOKEN`
- optional: `RELEASE_PLEASE_TOKEN`

### Environment variables / secrets

Create GitHub environments named `staging` and `production`. Add:

- `EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL`
- `EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL`
- `EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY`
- `EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_URL`
- `EXPO_PUBLIC_SPOTLIGHT_AUTH_SCHEME`
- `SPOTLIGHT_APP_SCHEME`
- `SPOTLIGHT_EXPO_OWNER`
- `SPOTLIGHT_EAS_PROJECT_ID`
- `SPOTLIGHT_IOS_BUNDLE_IDENTIFIER`

Optional shell overrides:

- `MOBILE_EAS_ENV_FILE`
- `SPOTLIGHT_BUILD_MESSAGE`
- `SPOTLIGHT_TESTFLIGHT_NOTES`
- `SPOTLIGHT_TESTFLIGHT_NOTES_FILE`

## Expected workflow

1. Merge semantic commits into `main`
2. Release Please updates or opens a release PR
3. Merge the release PR
4. Release Please creates the GitHub Release and updates `CHANGELOG.md`
5. Run `.github/workflows/ios-testflight-release.yml` with:
   - `environment=staging` or `production`
   - `action=build`, `submit`, or `release`

## Important limitation

Release Please works best when merge titles or direct commits follow conventional commit style:

- `feat(scanner): ...`
- `fix(portfolio): ...`
- `perf(api): ...`
- `chore(release): ...`

Without that discipline, the changelog and version bump quality will degrade.
