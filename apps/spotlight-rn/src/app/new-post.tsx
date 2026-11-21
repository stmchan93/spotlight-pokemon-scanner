import { GuestRouteGuard } from '@/features/auth/components/guest-route-guard';
import { NewPostScreen } from '@/features/social/screens/new-post-screen';

export default function NewPostRoute() {
  return (
    <GuestRouteGuard>
      <NewPostScreen />
    </GuestRouteGuard>
  );
}
