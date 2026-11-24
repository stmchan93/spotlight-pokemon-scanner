import { Redirect } from 'expo-router';

/**
 * Events is a page of Social now, not a bottom tab. This route stays so old
 * `/events` links and pushes land there; like `/wishlist`, it is not a pager page.
 */
export default function EventsRedirect() {
  return <Redirect href={'/social?tab=events' as never} />;
}
