/**
 * Whether the "For Sale" profile tab is shown.
 *
 * OFF: the feature is not built. The tab rendered a gated "Coming soon" state,
 * which is a tab that costs a third of the bar and answers nothing — so it is
 * hidden on both the owner's Portfolio and public profiles until there is
 * something behind it.
 *
 * A FLAG, NOT COMMENTED-OUT CODE. Everything that renders For Sale — the page,
 * its scroll ref, its branch of `renderProfilePage` — is left intact and live.
 * Commented-out blocks are invisible to TypeScript, ESLint and the test suite,
 * so they quietly stop compiling as the code around them moves; this one keeps
 * being checked on every run, and turning the tab back on is this line.
 *
 * The `ProfileTab` union deliberately still contains `'forsale'` for the same
 * reason: narrowing it would delete the very code paths we are keeping.
 */
export const FOR_SALE_TAB_ENABLED = false;
