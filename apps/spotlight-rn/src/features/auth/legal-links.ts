import * as Linking from 'expo-linking';

/*
  The hosted legal site (GitHub Pages). Discovered layout as of 2026-08-12:

    /            → the Privacy Policy (the ROOT page is the policy; /privacy/ 404s)
    /terms/      → the Terms of Service
    /delete-account/ → account-deletion instructions (Play data-deletion URL)

  App Store review (Guideline 1.2 / 5.1.1) requires the Terms and Privacy links
  in-app to actually open these pages, so every mention routes through here —
  one module to update when the documents move to ekalight.com.
*/
const LEGAL_SITE_BASE_URL = 'https://stmchan93.github.io/ekalight-legal';

export const TERMS_OF_USE_URL = `${LEGAL_SITE_BASE_URL}/terms/`;
export const PRIVACY_POLICY_URL = `${LEGAL_SITE_BASE_URL}/`;
export const DELETE_ACCOUNT_URL = `${LEGAL_SITE_BASE_URL}/delete-account/`;

/**
 * Open a known-good https legal URL. No `canOpenURL` gate: on Android 11+ that
 * returns false for https unless the manifest declares a browser `<queries>`
 * entry, while `openURL` itself works — the gate would turn a working link into
 * the silent no-op `social-link.ts` warns about.
 */
export function openLegalUrl(url: string): void {
  Linking.openURL(url).catch(() => {
    // A device with no browser at all is the only failure mode; there is no
    // in-app fallback surface for a full legal document.
  });
}
