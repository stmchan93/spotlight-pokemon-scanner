import { FollowListRoute } from '@/features/profile/screens/follow-list-route';

/** `/u/<handle>/following` — the profiles this collector follows. */
export default function FollowingRoute() {
  return <FollowListRoute mode="following" />;
}
