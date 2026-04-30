# AGENTS

Scoped workflow notes for agents working under `apps/spotlight-rn`.

## Scope

- This app is the active React Native mobile shell for Spotlight/Looty across iOS and Android.
- New product work should land in React Native unless the user explicitly asks for legacy Swift work.
- Treat root `Spotlight/` Swift code as legacy/reference material that is being removed soon. Do not start new product surfaces there by default.
- The Python backend remains the runtime source for identity, pricing, scan logging, artifacts, deck entries, and authenticated data.
- Keep edits scoped. Other workers may be editing nearby files; do not revert or overwrite work outside your task.

## Read First

- Root repo rules: [../../AGENTS.md](../../AGENTS.md)
- Agent doc index for current rollout/spec links: [../../docs/agent-context-index.md](../../docs/agent-context-index.md)
- Current product/runtime status: [../../docs/spotlight-scanner-master-status-2026-04-03.md](../../docs/spotlight-scanner-master-status-2026-04-03.md)
- Current status and priorities: [../../PLAN.md](../../PLAN.md)
- RN app setup and env workflow: [README.md](README.md)
- Design-system plan when touching shared primitives: [../../docs/looty-ui-design-system-plan-2026-04-16.md](../../docs/looty-ui-design-system-plan-2026-04-16.md)
- RN scanner normalized-target plan: [../../docs/react-native-scanner-normalized-target-mvp-plan-2026-04-28.md](../../docs/react-native-scanner-normalized-target-mvp-plan-2026-04-28.md)
- RN cross-platform slab plan: [../../docs/react-native-ml-kit-psa-slab-plan-2026-04-29.md](../../docs/react-native-ml-kit-psa-slab-plan-2026-04-29.md)
- Scanner rewrite source of truth: [../../docs/scanner-model-rewrite-spec-2026-04-23.md](../../docs/scanner-model-rewrite-spec-2026-04-23.md)
- Scan data / labeling pipeline: [../../docs/scan-data-labeling-pipeline-spec-2026-04-23.md](../../docs/scan-data-labeling-pipeline-spec-2026-04-23.md)
- Older raw/slab/backend specs still matter for backend behavior; read only the relevant doc for the touched surface after the files above.

## Design System

- Use `@spotlight/design-system` before adding local UI: `Button`, `IconButton`, `PillButton`, `SearchField`, `TextField`, `ScreenHeader`, `SectionHeader`, `SheetHeader`, `StateCard`, `SurfaceCard`, `SegmentedControl`, and `FloatingBottomNav`.
- Pull typography, colors, spacing, radii, and layout from `useSpotlightTheme()`, `textStyles`, or exported design-system tokens.
- Avoid raw `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`, `#hex`, `rgb(a)`, spacing, gap, and radius literals in app UI when a token fits.
- Reuse app chrome that already exists, especially `src/components/chrome-back-button.tsx`.
- If a reusable visual pattern is missing, add it to `packages/design-system/src/components` and export it from `packages/design-system/src/index.ts` instead of copying one-off styles into a screen.
- When changing design-system primitives or tokens, update the RN catalog and tests when relevant:
  - `src/features/design-system/screens/design-system-catalog-screen.tsx`
  - `__tests__/components/design-system-catalog-screen-test.tsx`

## Scanner Rules

- Current RN scanner surface: `src/features/scanner/screens/scanner-screen.tsx`, `src/features/scanner/raw-scanner-capture-surface.tsx`, and `src/features/scanner/scanner-normalized-target.ts`.
- RN scanner currently uses `expo-camera`, app reticle geometry, and `buildNormalizedScannerTarget` for a `630x880` normalized target. Reuse this path for guided labeling sessions.
- Do not build a separate labeling capture geometry. Labeling sessions should use the same scanner surface, reticle geometry, capture path, and review tray patterns as normal scans.
- Labeling sessions are admin-gated by `labeler_enabled`, capture the required angles (`front`, `tilt_left`, `tilt_right`, `tilt_forward`), and apply one card label to the whole session.
- Keep scan capture, matcher prediction, scan selection, and deck confirmation separate:
  - matcher output is prediction
  - scan-review choice is selection
  - `Add to deck` is trusted confirmation
- Do not collapse `predicted_card_id`, `selected_card_id`, and `confirmed_card_id`.
- Store/upload both `source_capture` and `normalized_target` where scan artifacts are involved.
- Runtime top-K stays `10`; do not widen it as a frontend shortcut.
- Raw mode is the supported RN scanner lane right now. Slab parity is incomplete; do not silently degrade slab scans into raw matches or raw pricing.
- Future high-frame-rate vision work belongs behind native modules, not a pure JS scanner rewrite. The planned boundary is a native scanner module with iOS/Android platform implementations behind one TypeScript contract.

## Environment And Native Notes

- Prefer repo root commands. The common phone path is `pnpm mobile:start:phone`.
- For split terminals, use `pnpm backend:start:phone` plus `pnpm mobile:start:phone:frontend` or `pnpm mobile:start:phone:dev-client`.
- Expo public env vars are the primary RN runtime-config path. Minimum env values are documented in `README.md`.
- Keep `.env.development` local-backend-oriented, staging pointed at hosted staging, and production pointed at hosted production.
- For physical phones, prefer the helper launcher over editing `.env.development` for the current LAN IP.
- Staging/production scan, deck, and portfolio flows should use authenticated backend access with `SPOTLIGHT_AUTH_REQUIRED=1`.
- Expo Go is the fastest loop when SDK-compatible, but native scanner-module work requires a dev client or native build. Use `pnpm mobile:ios -- --device` or open `ios/Spotlight.xcworkspace` for a dev-client/native run.
- The VM hosts the backend only. iPhone distribution goes through EAS/TestFlight/App Store Connect.

## Key Files

- App routes: `src/app/**`
- Providers/config: `src/providers/app-providers.tsx`, `src/providers/auth-provider.tsx`, `src/lib/runtime-config.ts`, `src/lib/supabase.ts`
- Auth/profile flags: `src/features/auth/**`
- Scanner: `src/features/scanner/**`
- Labeling: `src/features/labeling/**`
- Cards/catalog: `src/features/cards/**`, `src/features/catalog/**`
- Portfolio/inventory/sell/import: `src/features/portfolio/**`, `src/features/inventory/**`, `src/features/sell/**`, `src/features/portfolio-import/**`
- Shared package contracts: `../../packages/api-client/src/**`, `../../packages/design-system/src/**`
- RN tests: `__tests__/**`, `test-support/**`, `jest.setup.ts`

## Validation

- Basic RN checks:
  - `pnpm mobile:lint`
  - `pnpm mobile:typecheck`
  - `pnpm mobile:test`
- Focused tests are preferred when the touched surface is narrow, for example:
  - `pnpm --filter @spotlight/mobile-app test -- __tests__/components/scanner-screen-test.tsx`
  - `pnpm --filter @spotlight/mobile-app test -- __tests__/repository/spotlight-repository-loading-test.ts`
- Backend contract changes should also run the relevant backend tests from the repo root.
- For phone smoke tests, confirm `http://<mac-lan-ip>:8788/api/v1/health` is reachable from the device path before debugging the app.
