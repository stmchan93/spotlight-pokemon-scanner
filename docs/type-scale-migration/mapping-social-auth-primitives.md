# Type-scale mapping — shared primitives, Social, Sign-in/Sign-up, Events

Phase-1 inventory (read-only), 2026-10-18. Figma file `XRUD89H31ESUrvf9fGMtjW`. Paths are repo-relative;
`ds/` = `packages/design-system/src/components/`, `rn/` = `apps/spotlight-rn/src/`.

Canonical targets (README): Display Bold 29 · Title-large Bold 23 · Title-medium SemiBold 19 · Title-small SemiBold 17 ·
Body-large Regular 16 · Body Regular 14 · Body-medium Medium 14 · Label Medium 14 · Caption Regular 13 ·
Caption-medium Medium 13 · Overline Regular 12. "(15)" after a style = the frame still carries the stale 15 metric.

Action legend: `ok` · `change-role → X` · `hardcoded → tokenize` · `raw-in-figma` (Plus Jakarta text with no library style) ·
`missing-in-figma` (no frame; nearest metrics) · `missing-in-code`.

---

## A. Shared primitives (`packages/design-system/src/components/`)

Frames verified: Components reference `3725:59667` (children `3725:59676` search+chips, `3725:59899` toolbar,
`3725:59898` Collection Tabs, `3725:59729` time filter, `3725:60043` drawer), Events list `5865:9330`
(`5865:9334` chips, `5865:9368` tabs/cards), Tab Bar `5938:8445`, Sign-in button instances (`36:654/656/667/705`).

### Button (`ds/button.tsx`)
Default `labelStyleVariant = 'control'` (:58); role switch :71-79. Figma button component set `36:xxx`.

| element / variant | Figma style | code role today | file:line | action |
|---|---|---|---|---|
| label, `control` (default: Primary/Secondary/Disabled/Tertiary/dark) | Body-medium (15 on Sign-in `I4255:88453;36:705`; Label 14 on chips `I3725:59691;36:654`) | `control` SemiBold 15/20 | button.tsx:74 | change-role → Body-medium 14 (weight SemiBold→Medium) |
| label, `label` | Label 14 (`3725:59691` filter chips) | `label` Medium 13/18.2 | :78 | change-role → Label 14 |
| label, `caption` | Caption 13 (FOLLOW `5080:6916` Regular 13) | `caption` Medium 12/16 | :72 | change-role → Caption 13 (Medium→Regular) |
| label, `body` | Body 14 | `body` Regular 15/20 | :76 | ok → Body 14 |
| label, `bodyStrong` | none (no SemiBold-15 button in Figma) | `bodyStrong` SemiBold 15 | :79 | change-role → Body-medium (retire variant) |

### PillButton (`ds/pill-button.tsx`) — default `tone='default'` (:50); `filter|filled` → chip (:54)

| tone | Figma style | code role | file:line | action |
|---|---|---|---|---|
| `filter` / `filled` (collection chips, events chips) | Label 14 (`3725:59691-59705` "Secondary"); Events chips `5865:9335` Medium **12** raw | `label` 13 Medium | :65 | change-role → Label 14; Events chip size = raw-in-figma (Medium 12) — designer to pick Label or Caption-medium |
| `soft` | Body-medium 14 | `bodyMedium` 14 | :67 | ok |
| `option` | Caption-medium 13 (nearest) | `caption` Medium 12 | :69 | change-role → Caption-medium |
| `default` | Body-medium 14 | `control` SemiBold 15 | :70 | change-role → Body-medium |

### SegmentedControl (`ds/segmented-control.tsx`)

| size | Figma style | code role | file:line | action |
|---|---|---|---|---|
| `md` / `lg` | Body-medium 14 (no Figma segmented control outside Scanner) | `control` SemiBold 15 | :81 | change-role → Body-medium |
| `scanner` | Caption-medium 13 (Scanner frames: unstyled Medium 13) | `label` + `fontSize: 13` override | :39, :81, :128 | change-role → Caption-medium; drop the fontSize override (hardcoded → tokenize) |
| portfolio time filter (`3725:59729`) | selected SemiBold 13 lh1.4 **raw**; unselected Label 14 | (rendered by portfolio screen, not this primitive) | — | raw-in-figma; note for portfolio agent |

### SearchField (`ds/search-field.tsx`) / SearchEntryPill (`ds/search-entry-pill.tsx`)

| element | Figma style | code role | file:line | action |
|---|---|---|---|---|
| input + placeholder, `size='collection'` | **Label 14** Medium gray-500 (`3725:59686` "Search your collection" — verified) | `label` Medium 13 | search-field.tsx:80 | change-role → Label 14 |
| input + placeholder, default/compact | Body (15) Regular (`4255:88450` input field, `3725:59916`) | `body` Regular 15, lineHeight stripped | :80-81 | ok → Body 14 |
| SearchEntryPill label (toolbar glass pill "Search Collection") | Body (15) Regular (`3725:59916`) | `bodySmall` Regular 14 | search-entry-pill.tsx:128 | ok → Body 14 |

### TextField (`ds/text-field.tsx`)

| element | Figma style | code role | file:line | action |
|---|---|---|---|---|
| input (single/multiline) | Body (15) (`I4255:88450;202:108` placeholder) | `body` minus lineHeight | :58-59 | ok → Body 14 |
| label above field | missing-in-figma (sign-in fields are placeholder-only) | `micro` SemiBold 11 + `letterSpacing: 1.2` | :64, :128 | change-role → Overline 12; tracking literal → tokenize/drop |
| helper text | missing-in-figma | `caption` Medium 12 | :101 | change-role → Caption 13 |

### ScreenHeader (`ds/screen-header.tsx`)

| element | Figma style | code role | file:line | action |
|---|---|---|---|---|
| eyebrow | Overline 12 (nearest) | `micro` + `letterSpacing: 1.4` | :45, :100 | change-role → Overline; tracking → tokenize/drop |
| title | Display Bold 29 (`3725:59711` balance is the only Display in file) | `display` ExtraBold 36 −0.9 | :47 | change-role → Display 29 |
| subtitle | Body 14 | `body` 15 | :49 | ok → Body |

### SectionHeader (`ds/section-header.tsx`)

| element | Figma style | code role | file:line | action |
|---|---|---|---|---|
| title (default) | Title-medium 19 (no 25pt title in Figma; nearest) | `title` display 25 | :71 | change-role → Title-medium |
| title (`compact`) | Title-small 17 | `titleSmall` 17 | :71 | ok |
| count (compact / default) | Caption-medium 13 / Body-medium 14 | `captionMedium` 12 / `bodyStrong` 15 | :81-82 | change-role → Caption-medium / Body-medium |
| description | Body 14 | `body` | :102 | ok |
| action label | Label 14 (chip-style actions) | `control` SemiBold 15 | :133 | change-role → Label |

### SheetHeader (`ds/sheet-header.tsx`)

| element | Figma style | code role | file:line | action |
|---|---|---|---|---|
| title `titleCompact` (default) | Title-medium 19 (`5938:34253` sheet-ish titles) | `titleCompact` display 21 | :36 | change-role → Title-medium |
| title `title` | Title-large 23 | `title` display 25 | :36 | change-role → Title-large |
| title via `titleStyle=titleXsmall` (New Post) | raw SemiBold 13 (`5938:34884` NEW POST) | `titleXsmall` SemiBold 14 | new-post-screen.tsx:608 | raw-in-figma; nearest Caption-medium (weight differs) |
| subtitle | Body 14 | `body` | :65 | ok |

### StateCard / SurfaceCard / EmptyStatePrompt / InlineLoader / ListRow / Toast / Badge (no Figma frames)

| primitive · element | nearest Figma style | code role | file:line | action |
|---|---|---|---|---|
| StateCard title / message | Title-small 17 / Body 14 | `headline` 16 / `body` 15 | state-card.tsx:42, :45 | change-role → Title-small / Body (missing-in-figma) |
| SurfaceCard | — (no text) | — | — | — |
| EmptyStatePrompt message | Body-medium | `bodyMedium` | empty-state-prompt.tsx:55 | ok |
| InlineLoader label | Body | `body` | inline-loader.tsx:27 | ok |
| ListRow title / caption / description | Body-medium / Caption / Body | `bodyStrong` / `caption` / `body` | list-row.tsx:66, :70, :76 | change-role → Body-medium / Caption / Body |
| Toast message / dismiss | Caption-medium / Body-medium | `caption` / `headline` + `lineHeight: 20` | toast.tsx:173, :177-178 | change-role; lineHeight literal → tokenize |
| Badge label | Overline 12 (uppercase) | `micro` + `letterSpacing: 0.5` | badge.tsx:54, :79 | change-role → Overline; tracking → drop |
| ListPaginationFooter | Label / Caption | `label` / `caption` | list-pagination-footer.tsx:57, :72 | ok → Label / Caption |
| QuantityStepper value | Body-medium | `bodyStrong` | quantity-stepper.tsx:58 | change-role → Body-medium |
| CardThumbnail placeholder | Overline | `micro` + `letterSpacing: 0.8` | card-thumbnail.tsx:54, :70 | change-role → Overline |

### FollowButton (`ds/follow-button.tsx`)

| element | Figma style | code role | file:line | action |
|---|---|---|---|---|
| FOLLOW label | **Caption 13 Regular** gray-600 (`5080:6916`) | `bodyMedium` 14 + `lineHeight: 18` | :54, :27/:104 | change-role → Caption (Medium→Regular); lineHeight literal → tokenize |

### Tab bars — BottomTabBar (`ds/bottom-tab-bar.tsx`), FloatingBottomNav (`ds/floating-bottom-nav.tsx`), PageTabs (`ds/page-tabs.tsx`)

| element | Figma style | code role | file:line | action |
|---|---|---|---|---|
| tab label (Tab Bar component `5938:8455`) | raw SemiBold **10** lh 12 (Home frames `5938:8482` use SemiBold **9**, −0.1 tracking) | `navLabel` Medium 11 / `navLabelSelected` SemiBold 11 | bottom-tab-bar.tsx:167 | raw-in-figma; production tabs are native (`rn/app/(tabs)/_layout.tsx:267` keeps the system font) — leave; ask designer to style as Overline or add a "Nav" style |
| FloatingBottomNav default label | Body-medium (nearest) | `control` + `letterSpacing: 0` | floating-bottom-nav.tsx:212, :276 | change-role → Body-medium; tracking literal → drop |
| FloatingBottomNav scanner label | raw SemiBold 10 (scanner frames) | `micro` 11 | :228 | raw-in-figma (scanner agent) |
| PageTabs label (full) | Collection Tabs `3147:10105`: active **Body-medium 14**, inactive **Body 14** | `bodyMedium`/`body` family + `fontSize: 15`, `lineHeight: 18` | page-tabs.tsx:69-77, :212, :216 | hardcoded → tokenize (drop the +1 to 15); roles ok → Body-medium / Body |
| PageTabs label (compact) | `5862:6907` (Events regions): **Label 14** both states (gray-900 / gray-500) | `bodyMedium` + `lineHeight: 18` | :75-77, :222 | ok → Label/Body-medium (same metrics); lineHeight → tokenize |

### IconButton, GlassNavBubble(Group), GlassButtonGroup, ScrollToTopButton — icon-only, no text. ok.

### Top Trends (`ds/top-mover-tile.tsx`, `ds/top-trends-rail.tsx`; block in `rn/features/social/components/top-trends-block.tsx`)
Figma: Home `5768:27092` → `5768:27136` title row, `5768:27152` tile. (design-map's `4969:4101` **no longer exists**.)

| element | Figma style | code role | file:line | action |
|---|---|---|---|---|
| "TOP TRENDS" title | Label 14 Medium | `titleXsmall` SemiBold 14 | top-trends-block.tsx:155 | change-role → Label |
| "PAST 30 DAYS" subtitle | Overline 12 Regular | `captionMedium` Medium 12 | top-trends-block.tsx:159 | change-role → Overline |
| rail caption | Overline 12 (nearest) | `captionMedium` | top-trends-rail.tsx:206 | change-role → Overline |
| game chip "Pokemon" | raw Regular 10 | not built | — | raw-in-figma (not built by decision) |
| tile card name | Title-small 17 | `titleSmall` | top-mover-tile.tsx:90 | ok |
| tile set line | Label 14 Medium gray-600 | `bodyMedium` 14 | :93 | ok (Label and Body-medium share metrics) |
| tile % change | raw SemiBold 17 green | `titleSmall` | :99 | raw-in-figma; keep Title-small |
| tile price | raw SemiBold 15 | `bodyStrong` SemiBold 15 | :117 | raw-in-figma; nearest Body-medium |
| tile "from $x" | Label 14 | `bodyMedium` | :120 | ok |

### Raw-literal primitives with no role at all
`ds/trend-pill.tsx:95-102` (`'SpotlightBodySemiBold'` 11/14 and 13/16) → tokenize (Caption-medium / Overline-strong TBD);
`ds/card-list-row.tsx:436-438, :491-493, :500-501`; `ds/inventory-card-tile.tsx:700-701, :728, :731-732, :744-746` → tokenize
(screens belong to the Collection/Wishlist agent; the primitives are shared). `ds/slab-frame.tsx` (4–12pt slab-label
rendering) and `ds/grader-wordmark.tsx:110,:130` are artwork-scale text — exempt. `ds/avatar.tsx:58,:74` initials
(`fontSize: size*0.4`, `fontWeight: '600'` with no family) — computed, but add a family.

---

## B. Social (Figma page "3. Social" + "Post flow")

### Home feed — `rn/features/social/screens/feed-screen.tsx`, `rn/components/home-header.tsx`, `post-card.tsx`
Frame `5768:27092` (current Home: Top Trends + posts). design-map still points Feed at `5085:15398` — update.

| element | Figma style | code role today | file:line | action |
|---|---|---|---|---|
| header: wordmark + glass icons | — | — | home-header.tsx:328-431 | ok (no text) |
| bell unread badge | missing-in-figma | `overline` Medium 11 | home-header.tsx:371 | change-role → Overline 12 |
| compose prompt "What's on your mind?" | Caption 13 Regular gray-500 (`5938:34701`) | `label` Medium 13 | feed-screen.tsx:686 | change-role → Caption |
| post author name | raw SemiBold **16** (`5768:21655`) | `bodyStrong` 15 + bump `fontSize:16, lineHeight:21` | post-card.tsx:657, :975-977 | raw-in-figma; drop bump, nearest Title-small 17 or Body-medium 14 — designer call |
| post date | Overline 12 Regular gray-600 (`5768:21656`) | `cardMeta` Regular 11 | post-card.tsx:675 | change-role → Overline |
| post body | Body-medium (15) gray-800 (`5768:21660`) | `bodyMedium` 14 + bump `fontSize:15, lineHeight:22.5` | post-card.tsx:719, :979-981 | hardcoded → tokenize (drop bump) → Body-medium 14 |
| FOLLOW | Caption 13 Regular | FollowButton `bodyMedium` | follow-button.tsx:54 | change-role → Caption |
| like / comment / repost counts | raw SemiBold 13 (`5768:21666`) | `labelStrong` SemiBold 13 | post-card.tsx:783, :807, :846 | raw-in-figma; metrics already match — keep as Caption-medium-strong alias |
| "view comments" link | Caption-medium 13 | `captionMedium` 12 | post-card.tsx:734 | change-role → Caption-medium |
| image counter / chip | Caption 13 | `caption` Medium 12 | post-card.tsx:242 | change-role → Caption |
| repost attribution | Label 14 (nearest; not in frame) | `label` 13 | repost-attribution.tsx:34 | change-role → Label |
| empty / error state | missing-in-figma | StateCard | feed-screen.tsx:723 | see StateCard |

### Post detail — `post-detail-screen.tsx` + `comments-sheet.tsx` (no Figma frame → missing-in-figma, nearest listed)

| element | nearest Figma style | code role | file:line | action |
|---|---|---|---|---|
| nav title "Post" | raw SemiBold 13 (New Post header) | `titleXsmall` 14 | post-detail-screen.tsx:104 | raw-in-figma; nearest Caption-medium |
| comment author / reply CTA | Body-medium | `bodyMedium` | comments-sheet.tsx:2093, :2133, :2177 | ok |
| comment body / mentions / tombstone / empty copy | Body | `body` 15 | :2018, :2110, :2112, :2366, :2373 | ok → Body 14 |
| timestamp | Caption | `caption` 12 | :2105 | change-role → Caption 13 |
| sheet title | Body-medium | `bodyStrong` | :2342 | change-role → Body-medium |
| action labels / reply banner | Label / Caption-medium | `label` / `captionMedium` | :2399 / :2448 | ok |

### New post — `new-post-screen.tsx` (Figma `5938:34856` "Footer-modal-expanded")

| element | Figma style | code role | file:line | action |
|---|---|---|---|---|
| CANCEL / NEW POST / POST header row | raw SemiBold 13 (`5938:34883-85`) | SheetHeader `titleXsmall` 14; cancel = IconButton; POST = Button `dark` `control` 15 | :592-608, :738-747 | raw-in-figma; nearest Caption-medium (Button → Body-medium per primitive) |
| author name | Body-medium (15) | `bodyMedium` 14 | :623 | ok |
| "WHAT'S NEW" + "0/160" counter | Caption 13 Regular gray-700 | `label` Medium 13 | :692 (counter), label helper :222 | change-role → Caption |
| body placeholder / typed text | Caption 13 Regular gray-500 (placeholder) | `bodySmall` 14 (empty) / `bodyMedium` (typing) | :644 | change-role → Caption (placeholder); typed → Body-medium |
| PUBLIC / PHOTO / CAMERA controls | Caption-medium 13 | `label` Medium 13 | :222 | change-role → Caption-medium (same metrics) |

### Notifications — `notifications-screen.tsx`, `rn/features/notifications/components/alert-settings-section.tsx` (missing-in-figma)

| element | nearest | code role | file:line | action |
|---|---|---|---|---|
| nav title | raw SemiBold 13 / Title-small | `titleXsmall` | notifications-screen.tsx:240 | change-role → Title-small (or new nav style) |
| row text (actor + action + body, nested `<Text>` inherit) | Body-medium / Body | `bodyMedium` | :183-201 | ok; nested spans inherit |
| alert settings title / caption | Body-medium / Caption-medium | `bodyStrong` / `captionMedium` | alert-settings-section.tsx:153, :156 | change-role → Body-medium / Caption-medium |

### Messages inbox — `dm-inbox-screen.tsx` (missing-in-figma)

| element | nearest | code role | file:line | action |
|---|---|---|---|---|
| nav title | Title-small | `titleXsmall` | :313 | change-role → Title-small |
| name / preview / meta | Body-medium / Label | `bodyMedium` :244, :374; `label` :260, :281, :381 | | ok → Body-medium / Label 14 |
| unread count badge | Overline | `micro` | :293 | change-role → Overline |

### Conversation — `dm-thread-screen.tsx`, `message-body-text.tsx`, `shared-post-bubble.tsx`, `shared-profile-bubble.tsx` (missing-in-figma)

| element | nearest | code role | file:line | action |
|---|---|---|---|---|
| nav title / handle | Title-small / Caption | `titleXsmall` :1008 / `caption` :1014 | | change-role → Title-small / Caption |
| message bubbles | Body | `body` :899, :1071 | | ok → Body 14 |
| time separators / seen note / bubble time | Overline | `micro` :795, :911, :942 | | change-role → Overline |
| blocked notice | Label | `label` :1143 | | ok |
| composer | Body | TextField :1151 | | ok |
| shared post bubble name / caption | Label / Body | `label` :170, :205; `bodySmall` :224 | shared-post-bubble.tsx | ok |
| shared profile bubble name / footer | Label / Caption | `label` :281, :346; `caption` :378 | shared-profile-bubble.tsx | change-role footer → Caption 13 |
| share sheet / options sheet | Body-medium / Label / Body | share-post-sheet.tsx:331, :338, :349, :408, :432; options-sheet.tsx:159, :167 | | ok |

### Blocked accounts — `blocked-accounts-screen.tsx` (missing-in-figma)

| element | nearest | code role | file:line | action |
|---|---|---|---|---|
| header | Display | ScreenHeader `display` | :195 | via ScreenHeader → Display 29 |
| row name / handle | Body-medium / Caption-medium | `bodyStrong` :135 / `captionMedium` :141 | | change-role → Body-medium / Caption-medium |
| Unblock button | Body-medium | Button `outline` `control` | :147-155 | via Button |
| empty state | — | StateCard `field` | :164 | via StateCard |

---

## C. Sign in / Sign up (Figma page "5. Sign in/Sign up") + Account screens

Frames: Log In `4255:88306`, Sign Up `4255:88782`, Password Reset `4255:89937` (form `4255:90140`) and `4255:90171`.
**Library drift recorded:** these frames carry Body **15**, Body-medium **15**; Overline here is already Regular 12 (the old
Overline Medium 11 noted in the inventory was not present on the three frames pulled). Body-large 16 is used only here.
All auth text is hardcoded in `rn/features/auth/components/auth-controls.tsx` (no `typography.*` roles).

### Log In `4255:88306` — `login-screen.tsx` via `auth-controls.tsx`

| element | Figma style (frame metric) | code today | file:line | action |
|---|---|---|---|---|
| "LOG IN" section title | Body-large 16 Regular | `sectionTitle` Regular 15/23 | auth-controls.tsx:411-413 | hardcoded → tokenize → Body-large |
| Email / Password input + placeholder | Body (15) Regular gray-400 | `input` Regular 14, no lineHeight | :392-393 | hardcoded → tokenize → Body 14 (keep lineHeight stripped) |
| Continue (Disabled `36:705`) | Body-medium (15) | `buttonLabel` Medium 14/21 | :337-339 | hardcoded → tokenize → Body-medium |
| Forgot password? (Tertiary `36:667`) | Body-medium (15) | `tertiaryLabel` Medium 14/21 | :430-432 | hardcoded → tokenize → Body-medium |
| OR divider | Label 14 gray-500 | `dividerLabel` Medium 13/18 | :352-354 | hardcoded → tokenize → Label 14 |
| Continue with Google / Apple (Primary) | Body-medium (15) on 88306; **Label 14** on 89619 | `buttonLabelOutline` Medium 14/21 | :342-344 | hardcoded → tokenize → Body-medium 14 |
| NEW ACCOUNT group label | Label 14 gray-900 | `groupLabel` Medium 13/18 | :383-385 | hardcoded → tokenize → Label 14 |
| Sign Up (Secondary `36:656`) | Body-medium (15) | `buttonLabelOutline` | :342-344 | → Body-medium |
| Terms / Privacy footer | Overline 12 Regular lh 1.4, underlined links | `terms` Regular 12/17 | :416-418 | hardcoded → tokenize → Overline (lh 16) |
| error line | missing-in-figma | `errorLine` Medium 13/18 | :361-363 | tokenize → Caption-medium |
| floating field label | missing-in-figma (placeholder-only fields) | `fieldLabel` Medium 11/14 | :370-372 | tokenize → Overline 12 |

### Sign Up `4255:88782` — `sign-up-screen.tsx`
Same elements as Log In plus: "SIGN UP" Body-large 16; First/Last/Email/Password placeholders Body (15); "LOG IN" group
label Label 14; "Continue with Email" Body-medium (15). Password rules (`ruleLabel` Regular 13/18, auth-controls.tsx:398-400)
→ missing-in-figma → Caption 13.

### Password reset `4255:90140` — `forgot-password-screen.tsx`, `verify-code-screen.tsx`, `set-new-password-screen.tsx`

| element | Figma style | code today | file:line | action |
|---|---|---|---|---|
| "PASSWORD RESET" | Body-large 16 | `sectionTitle` 15/23 | auth-controls.tsx:411 | → Body-large |
| reset message | Body (15) Regular gray-600 | `subtitle` Regular 14/21 | forgot-password-screen.tsx:85-87 | hardcoded → tokenize → Body 14 |
| Email field / Continue (Disabled → Primary on 90171) / Terms | Body (15) / Body-medium (15) / Overline | as Log In | | as Log In |
| "CHECK YOUR INBOX" + subtitle | missing-in-figma | `subtitle` Regular 14/21 | verify-code-screen.tsx:130-132 | tokenize → Body |
| "NEW PASSWORD" + fields | missing-in-figma | sectionTitle / input | set-new-password-screen.tsx | as Log In |

### Handle claim / Profile onboarding (missing-in-figma) — `handle-claim-screen.tsx`, `profile-onboarding-screen.tsx`

| element | nearest | code today | file:line | action |
|---|---|---|---|---|
| title | Title-large 23 | Bold 22/28 | handle-claim-screen.tsx:166-168; profile-onboarding-screen.tsx:90-92 | hardcoded → tokenize → Title-large |
| subtitle / helper | Caption 13 | Regular 13/18 | handle-claim:151-153, :161-163; onboarding:85-87 | tokenize → Caption |
| "signed in as" | Caption-medium | Medium 13/18 | handle-claim:156-158; onboarding:80-82 | tokenize → Caption-medium |

### Account / Change password / Between-shows (missing-in-figma; `rn/features/auth/screens/`)

| element | nearest | code role | file:line | action |
|---|---|---|---|---|
| Account title | Display 29 | `display` 36 | account-screen.tsx:326 | change-role → Display |
| Account section headline | Title-small | `headline` 16 | :340 | change-role → Title-small |
| row titles | Title-medium 19 (or Title-small) | `titleCompact` display 21 ×10 | :346, :361, :386, :411, :440, :463, :478, :512, :535 | change-role → Title-small 17 (rows are list items, not page titles) |
| row copy / whitelist email | Body | `body` ×11 | :350-577 | ok → Body 14 |
| control labels / Remove | Body-medium | `control` | :591, :629 | change-role → Body-medium |
| build stamp | Caption | `caption` | :657 | → Caption 13 |
| Buttons / TextField | — | Button ×9, TextField :545 | | via primitives |
| Change password title | Title-large | Bold 22/28 | change-password-screen.tsx:102-104 | hardcoded → tokenize → Title-large |
| Between-shows (access gate) | Display / Title-medium / Body / Caption / Body-medium | `display` :108, `titleCompact` :120, :158, `body` :111, :123, `caption` :179, `control` :208 | between-shows-screen.tsx | change-role per primitive map |

---

## D. Events (synced to Figma 2026-10-17 — roles listed, Figma styles confirmed, not re-derived)

Frames `5865:9330` (list), `5882:12594` (detail). Figma styled: Body 4 (Regular **14** — this page is on the canonical
14), Overline 12 ×12, Label 6–7, Caption-medium 1; raw: Medium 12 chips, SemiBold 16 section title, Bold 15/19 titles,
Regular 11, SemiBold 12, Light 15/13/12.

| element | code role | file:line | Figma style |
|---|---|---|---|
| "UPCOMING SPOTLIGHT EVENTS" | `headline` SemiBold 16 | events-screen.tsx:276 | raw SemiBold 16 (`5865:9370`) — raw-in-figma; nearest Title-small |
| EVENTS / TICKETS / SAVED chips | PillButton `filled` → `label` 13 | :259-267 | raw Medium 12 (`5865:9336`) — raw-in-figma |
| search (collection size) | SearchField `label` | :283-292 | not in frame (toolbar icon) |
| region tabs | PageTabs compact `bodyMedium` | :304 | Label 14 (`5862:6911/6915`) ok |
| event card title | `feedRowTitle` Bold 15 | event-list-card.tsx:47 | raw Bold 15 (`5865:9377`) |
| venue / date / time | `captionRegular` 12 | :32 | Overline 12 ok |
| location | `bodySmall` 14 | :66 | Body 14 ok |
| detail title | `detailTitleBold` Bold 19 | event-detail-screen.tsx:153 | raw Bold 19 |
| schedule rows | `bodySmall` / `bodyMedium` | :95, :107 | Body 14 / Body-medium 14 ok |
| pricing note bullets | `body` + `lineHeight: 26` | :113, :116, :44, :401 | raw Regular 15 on 26 (`5882:12631`) — literal is Figma-driven |
| meta lines | `captionRegular` | :124 | Overline ok |
| about | `bodySmall` | :178 | Body ok |
| category tags | `caption` 12 Medium | :185 | raw SemiBold 12 |
| section rules | `feedRowTitle` | :316 | raw Bold 15 |
| vendor name / table / tags | `headline` :352, `label` :360, `cardMeta` :331, :356, `captionStrong` :337, `bodyMedium` :324 | event-vendors-section.tsx | raw SemiBold 16 / Label 14 / raw Regular 11 / raw SemiBold 12 / Label |
| floor-map table numbers | computed `fontSize`, `fontWeight` | event-floor-map.tsx:499, :520-522, :569 | artwork-scale, exempt |
| vendor logo initials | `captionStrong` + computed size | event-vendors-section.tsx:76 | exempt |

---

## E. Hardcoded font literals (outside `tokens.ts`) in this area

| file:line | literal | note |
|---|---|---|
| ds/text-field.tsx:128 | `letterSpacing: 1.2` | field label tracking |
| ds/screen-header.tsx:100 | `letterSpacing: 1.4` | eyebrow tracking |
| ds/badge.tsx:79 | `letterSpacing: 0.5` | |
| ds/card-thumbnail.tsx:70 | `letterSpacing: 0.8` | |
| ds/floating-bottom-nav.tsx:276 | `letterSpacing: 0` | |
| ds/follow-button.tsx:27, :104 | `lineHeight: 18` | |
| ds/toast.tsx:178 | `lineHeight: 20` | |
| ds/page-tabs.tsx:212, :216, :222 | `fontSize: 15`, `lineHeight: 18` ×2 | +1 bump over Figma 14 |
| ds/segmented-control.tsx:39, :128 | `fontSize: 13` (scanner) | |
| ds/search-field.tsx:81 | `lineHeight: undefined` | intentional iOS descender fix |
| ds/trend-pill.tsx:95-97, :100-102 | `fontFamily: 'SpotlightBodySemiBold'`, 11/14, 13/16 | string literal family |
| ds/card-list-row.tsx:436-438, :491-493, :500-501 | `'SpotlightBodyBold'` 14/21, `'SpotlightBodySemiBold'` 14/21, label pieces | string literal family |
| ds/inventory-card-tile.tsx:700-701, :728, :731-732, :744-746 | 14/21, 12, label pieces, SemiBold 14/21 | |
| ds/avatar.tsx:58, :74 | `fontSize: size*0.4`, `fontWeight: '600'` | no family |
| ds/slab-frame.tsx:326, :484-497, :548-572, :602-609 | 4–12pt slab text | exempt (artwork) |
| ds/grader-wordmark.tsx:110, :130 | fallback size | exempt |
| rn/features/auth/components/auth-controls.tsx:337-339, :342-344, :352-354, :361-363, :370-372, :383-385, :392-393, :398-400, :411-413, :416-418, :430-432 | 11 styles, `fontFamilies.*` + size/lineHeight | whole auth type ramp |
| rn/features/auth/components/forgot-password-screen.tsx:85-87 | Regular 14/21 | |
| rn/features/auth/components/verify-code-screen.tsx:130-132 | Regular 14/21 | |
| rn/features/auth/components/handle-claim-screen.tsx:151-168 | 13/18 ×3, Bold 22/28 | |
| rn/features/auth/components/profile-onboarding-screen.tsx:80-92 | 13/18 ×2, Bold 22/28 | |
| rn/features/auth/screens/change-password-screen.tsx:102-104 | Bold 22/28 | |
| rn/features/social/components/post-card.tsx:976-977, :980-981 | 16/21, 15/22.5 bumps | |
| rn/features/events/screens/event-detail-screen.tsx:44, :401 | `lineHeight: 26` | Figma-driven |
| rn/features/events/components/event-floor-map.tsx:499, :520, :522, :569 | computed size, `fontWeight` | exempt |
| rn/features/events/components/event-vendors-section.tsx:76 | computed size/lineHeight | exempt |
| rn/components/app-drawer.tsx:535, :547-549 | `fontSize: 16`; `fontFamilies.bodyRegular` 12/16.8 | drawer `3725:60043`: name raw SemiBold 15, meta Overline 12, nav Caption-medium 13 |
| rn/components/edit-done-button.tsx:52-53 | 14/21 over `bodyStrong` | |
| rn/app/_layout.tsx:98-111 | `fontFamily`/`fontWeight` pairs | font-registration map, exempt |
| rn/features/profile/screens/edit-profile-screen.tsx:769-771, :801-804, :816-817 | `'SpotlightBodyRegular'` 14/18, 14; `'SpotlightBodyMedium'` 13 | other agent's screen — string literal families |
| rn/features/wishlist/screens/wishlist-screen.tsx:1484-1486 | `'SpotlightBodyRegular'` 14/20 | other agent's screen — string literal family |

---

## F. Role → Figma style summary (this area's roles)

| code role (today) | → Figma style | notes |
|---|---|---|
| `display` 36 ExtraBold | Display 29 Bold | ScreenHeader, Account |
| `title` 25 display | Title-large 23 (SheetHeader `title`) / Title-medium 19 (SectionHeader default) | no 25 in Figma |
| `titleCompact` 21 display | Title-medium 19 | Account rows better as Title-small |
| `titleLarge` 22 | Title-large 23 | |
| `titleMedium` 18 | Title-medium 19 | |
| `titleSmall` 17 | Title-small 17 | ok |
| `headline` 16 SemiBold | Title-small 17 | StateCard, Account, Events title (raw 16 in Figma) |
| `titleXsmall` 14 SemiBold | Label 14 (Top Trends title) / nav titles → Title-small or new nav style | Figma uses raw SemiBold 13 for sheet headers |
| `bodyLarge` 16 | Body-large 16 | |
| `body` 15 | Body 14 | |
| `bodySmall` 14 | Body 14 | |
| `bodyMedium` 14 | Body-medium 14 (= Label 14 metrics) | |
| `bodyStrong` 15 SemiBold | Body-medium 14 | weight drops; raw SemiBold 15 exists only on mover-tile price |
| `control` 15 SemiBold | Body-medium 14 | all buttons/segments/tabs; weight SemiBold→Medium |
| `label` 13 Medium | Label 14 (chips, search, group labels) / Caption-medium 13 (New Post controls) | split by site |
| `labelStrong` 13 SemiBold | (raw SemiBold 13 in Figma: counts, sheet headers) | keep as alias, flag to designer |
| `caption` 12 Medium | Caption 13 Regular | weight drops |
| `captionMedium` 12 Medium | Caption-medium 13 / Overline 12 (Top Trends subtitle) | |
| `captionRegular` 12 | Overline 12 | Events meta |
| `captionStrong` 12 SemiBold | (raw SemiBold 12 in Figma) | Events tags |
| `micro` 11 SemiBold +0.8 | Overline 12 | eyebrows, badges, time separators |
| `overline` 11 Medium | Overline 12 | |
| `cardMeta` 11 Regular | Overline 12 | post date |
| `navLabel`/`navLabelSelected` 11 | (raw SemiBold 10) | native tabs; leave |
| `feedRowTitle` 15 Bold / `detailTitleBold` 19 Bold | (raw Bold 15 / 19) | Events; no library style |
| auth raw ramp (auth-controls) | Body-large / Body / Body-medium / Label / Overline / Caption / Caption-medium | see §C |

## G. Figma inconsistencies to raise

1. **Button component set `36:xxx` label is 15 Medium on Sign-in pages but 14 Medium (Label) on the Components frame** — same component, two library versions. At canonical 14 these converge; the "update from library" on page 5 is the fix.
2. **Body / Body-medium 15 vs 14** on the same key: Sign-in, Components-frame Collection Summary (`3725:59679` Medium 15), post body (`5768:21660` 15), New Post author (`5938:34863` 15) vs Collection Tabs (`3147:10089` 14), Events (`5865:9385` Body 14). Code follows 14.
3. **Collection Tabs rendered three ways:** `3147:10105` Body-medium/Body 14; Post-flow instance `5938:34331` Regular/Medium **13**; Events `5862:6907` Label 14 both states.
4. **Tab bar label 9 vs 10:** Home frames `5938:8482` SemiBold 9 (−0.1 tracking); Tab Bar component `5938:8455` SemiBold 10. Never on a library style.
5. **SemiBold 13 / 15 / 16 and Bold 15 / 19 have no library style** yet carry the loudest text: post author (16), reaction counts (13), CANCEL/NEW POST/POST (13), Events section title (16), event card title (Bold 15), event detail title (Bold 19), mover-tile price (15). Designer should either restyle these to Title-small/Label or add a strong label style.
6. **Chip sizes differ:** collection filter chips Label 14 (`3725:59691`), Events chips raw Medium 12 (`5865:9335`), Top Trends game chip raw Regular 10 (`5768:27141`).
7. **Time filter** `3725:59729`: selected = raw SemiBold 13 lh 1.4, unselected = Label 14 — selection changes size and weight.
8. **FOLLOW** (`5080:6916`) is Caption Regular 13 inside a bordered button — the only Regular-weight button label in the file.
9. **Stale node ids in `design-map.json`:** TopTrends `4969:4101` no longer exists (Top Trends now lives inside Home `5768:27092` → `5768:27136`/`5768:27152`); Feed `5085:15398` should be re-pointed at `5768:27092`.
10. **Search placeholders** are three different things: collection search Label 14 Medium gray-500 (`3725:59686`), toolbar glass pill Body 15 Regular gray-900 (`3725:59916`), Sign-in inputs Body 15 Regular gray-400 (`202:108`). Code: `label` 13 / `bodySmall` 14 / raw 14.
11. No Figma frames exist for Post detail, Notifications, Messages, Conversation, Blocked accounts, Account, Change password, Verify code, Handle claim, Profile onboarding, Between-shows — all mapped by nearest metrics above.
