import { Redirect } from 'expo-router';

/**
 * `/you` means "my collection", and the collection is the tabs root again, so
 * this points at `/`. It exists because `/you` was the collection's real route
 * for the stretch when the feed held Home, and both deep links and in-app
 * navigation (tapping your own name in the feed) still reach for it.
 *
 * NOT pointed at `/social`: the feed is what lives at the OLD `/you` slot in the
 * tab bar, but "you" has never meant the feed.
 */
export default function YouRedirect() {
  return <Redirect href={'/' as never} />;
}
