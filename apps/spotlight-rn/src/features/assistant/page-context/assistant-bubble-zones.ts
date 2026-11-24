/** The dev scanner screenshot routes lay out exactly like `/scan`, so they share its page context. */
export function bubbleRoutePath(pathname: string): string {
  return /^\/dev\/scanner(-binder)?$/.test(pathname) ? '/scan' : pathname;
}
