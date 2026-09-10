import { Redirect } from 'expo-router';

/**
 * The feed is the Social TAB (`(tabs)/social`), not a pushed stack screen.
 * Nothing in the app linked to `/feed` even before the move, but it is a
 * deep-linkable path, so it redirects rather than 404s. Leaving the screen
 * mounted here as well would give the feed two routes and two scroll positions.
 */
export default function FeedRoute() {
  return <Redirect href={'/social' as never} />;
}
