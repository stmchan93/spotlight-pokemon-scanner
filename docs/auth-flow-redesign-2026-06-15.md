# Auth flow redesign — white full-screen (Figma 1543:2170)

Status: implemented 2026-06-15 (every signed-out screen converted; auth tests green)

Cleanup done: deleted the now-unreferenced `auth-sheet-layout.tsx` (old purple sheet)
and `sign-in-screen.tsx`. The "share" header button shares the app via the RN `Share`
API. Figma's literal title "Sign / Signup" shipped as the corrected "Sign in / Sign up".

Social sign-in: the entry (get-started) screen offers Continue with Email (purple),
then Google, then Apple. Apple is always shown on iOS (App Store guideline 4.8 requires
it alongside Google) via `Platform.OS === 'ios' || appleSignInAvailable`; on Android it
falls back to the availability flag (hidden, since Apple auth isn't native there).
Figma: Spotlight-App `node-id=1543-2170` ("Section 3" — full sign-in/sign-up flow)

## Context

The app already has a complete, working Supabase auth flow (email + Google/Apple,
verify-code, forgot/reset, profile onboarding). It is presented today through a
**purple full-bleed background + white bottom-sheet** (`auth-sheet-layout.tsx`).

The new Figma redesigns every screen to a **clean white full-screen page**: a top
header (back button + "Sign / Signup" title + share button), the large **EKALIGHT**
wordmark + tagline, **bottom-border (underline) inputs**, a purple **Primary**
button, and a subtle **Tertiary** link. The entry ("Pre-login homepage") screen has
no header and shows EKALIGHT + tagline + "Continue with Email" / "Continue with
Google" buttons.

This is a **presentation-only** change. None of the Supabase logic, `useAuth()`,
`auth-provider.tsx`, `auth-service.ts`, the `signed-out-flow.tsx` stepper routing,
or the `AuthGate` state machine changes. We swap the shared layout + restyle the
shared controls; each screen keeps its handlers and testIDs.

## Design system mapping (already confirmed — no new tokens needed)

| Figma | Token |
| --- | --- |
| Color/gray/0 #FFFFFF | `colors.gray0` |
| Color/gray/50 #F7F7F7 | `colors.gray50` (header circles, Google btn, disabled) |
| Color/gray/300 #D4D4D4 | `colors.gray300` (input underline) |
| Color/gray/400 #BEBEBE | `colors.gray400` (placeholder) |
| Color/gray/600 #717171 | `colors.gray600` (rule text, tertiary) |
| Color/gray/900 #1A1A1A | `colors.gray900` (wordmark, titles, input text) |
| Color/purple/500 #A54BFA | `colors.purple500` (Primary button) |
| radius-8 | `8` |
| EKALIGHT (ExtraBold 57) | `typography.display` (= PlusJakartaSans-ExtraBold), `fontSize: 57` |
| Title-medium (SemiBold 18) | header title → `fontFamilies.bodySemiBold` 18/1.3 |
| Body-medium (Medium 14) | button labels, input text → `fontFamilies.bodyMedium` |
| Tagline (Regular 18) | `fontFamilies.bodyRegular` 18, lineHeight ~1.35 |
| Overline (Medium 11) | password-rule text → `typography.overline` |

Fonts are all loaded in `src/app/_layout.tsx:75`. Colors live in
`packages/design-system/src/tokens.ts`.

## Components to build / restyle

All under `src/features/auth/components/`.

1. **NEW `auth-screen-layout.tsx`** (replaces `auth-sheet-layout.tsx` usage):
   - White `SafeAreaView` (edges top/left/right/bottom).
   - Optional **header** (`showHeader`, `title`, `onBack`, `onShare`): a row with
     16px h / 10px v padding — left 36px gray50 circle with `NavArrowLeft`
     (gray900, 24), center title (SemiBold 18 gray900), right 36px gray50 circle
     with `ShareIos` (gray900). Back/share omitted when their handler is absent.
   - `KeyboardAvoidingView` + `ScrollView` (`keyboardShouldPersistTaps="handled"`),
     content padding **horizontal 32**, top spacer, `gap`. Content flows top-down
     (wordmark → fields → buttons) — NOT bottom-pinned (Figma places buttons right
     under the inputs).
   - Keep `testID`, `backTestID` props so existing tests/screens map over.

2. **NEW `auth-wordmark.tsx`**: EKALIGHT (`typography.display`, 57, gray900,
   centered) + tagline (bodyRegular 18 gray900 centered), gap 10. Reused by every
   screen. Replaces the per-screen wordmark in `get-started-screen.tsx`.

3. **Restyle `auth-controls.tsx`**:
   - `SecondaryField` → **underline** input: bottom border gray300 (1px), height
     40, no box/radius, text bodyMedium 14 gray900, placeholder gray400, optional
     trailing (eye). Drop the floating-label box treatment (Figma uses plain
     placeholder).
   - `PasswordField`: keep the eye toggle (24px, right).
   - `PrimaryButton`: purple500 bg, white bodyMedium-14 label, h40, radius 8
     (already close; tighten to 40 + label role). Disabled → gray50 bg + gray400
     label.
   - **NEW `SecondaryActionButton`** (Google/Apple): gray50 bg, gray900 label, icon
     left, h40, radius 8.
   - `TertiaryButton`: transparent, h32, label `Label`(13) gray600.
   - **NEW `PasswordRules`**: list of `{ label, satisfied }` rows — check-circle 16
     (purple500 when satisfied, gray300 outline when not) + overline-11 gray600
     text. Rules: ≥8 chars, ≥1 number, ≥1 special char. (Logic already exists in
     `set-new-password-screen` / password validation — reuse it.)

## Per-screen changes (compose the above; logic untouched)

- `get-started-screen.tsx` (entry / "Pre-login homepage"): no header; wordmark
  block; `PrimaryButton` "Continue with Email" (mail icon) + `SecondaryActionButton`
  "Continue with Google" (+ Apple where available). Drops the hero photo + purple.
- `email-entry-screen.tsx`: header (title "Sign / Signup"); wordmark; email
  underline field; Primary "Continue" (disabled until valid email).
- `email-password-screen.tsx` (create & login modes): header; wordmark; full-name
  field (signup only); password field; `PasswordRules` (signup); Primary
  Continue/Submit; Tertiary "Forgot password?" (login).
- `sign-in-screen.tsx`, `verify-code-screen.tsx`, `forgot-password-screen.tsx`,
  `set-new-password-screen.tsx`, `profile-onboarding-screen.tsx`: same chrome
  swap — header + wordmark/title + underline fields + Primary/Tertiary.
- `forgot-password` headers read "Forgot your password?" with the longer subtitle
  from the Figma (bottom two frames).

## Risks / guardrails

- **Don't touch** `auth-provider.tsx`, `auth-service.ts`, `auth-gate.tsx`,
  `signed-out-flow.tsx` routing, or session/token wiring. Auth regressions can lock
  users out.
- Preserve existing **testIDs** (`auth-emailpw-*`, `auth-email-*`,
  `auth-brand-wordmark`, `auth-fullname-input`, etc.) and key visible strings so
  the auth test suite keeps passing; update tests only where the redesign
  deliberately changes copy/structure.
- The Figma "share" button on auth screens is unusual; wire it to the RN `Share`
  API (share the app) or make it a no-op/optional. Low priority.
- `ekalight-intro-screen.tsx` (branded intro animation) is separate; leave unless
  asked.

## Verification

- `pnpm typecheck` + `npx eslint` on touched files (0 errors).
- `npx jest auth get-started email-password email-entry auth-gate` — keep green;
  update assertions only for intended copy/structure changes.
- Manual: sign out → walk the flow (entry → email → create w/ rules → submit;
  entry → email(existing) → login → forgot → reset) and confirm each screen matches
  Figma and still authenticates.
