import { FollowListRoute } from '@/features/profile/screens/follow-list-route';

/** `/u/<handle>/followers` — the profiles that follow this collector. */
export default function FollowersRoute() {
  return <FollowListRoute mode="followers" />;
}
