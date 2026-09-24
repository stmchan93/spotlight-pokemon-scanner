import * as Linking from 'expo-linking';

type WebBrowserModule = typeof import('expo-web-browser');

let webBrowserModule: WebBrowserModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module: an older binary without it falls back to the system browser
  webBrowserModule = require('expo-web-browser') as WebBrowserModule;
} catch {
  webBrowserModule = null;
}

/**
 * Open a news/video source in the in-app browser (SFSafariViewController /
 * Custom Tabs), falling back to the system handler. No `canOpenURL` gate — on
 * Android 11+ it reports false for https without a `<queries>` entry.
 */
export async function openLinkOut(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) {
    return;
  }
  try {
    if (webBrowserModule?.openBrowserAsync) {
      await webBrowserModule.openBrowserAsync(url);
      return;
    }
  } catch {
    // Fall through to the system browser.
  }
  await Linking.openURL(url).catch(() => {});
}
