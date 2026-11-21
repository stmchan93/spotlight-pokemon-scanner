import { GuestRouteGuard } from '@/features/auth/components/guest-route-guard';
import { EditProfileScreen } from '@/features/profile/screens/edit-profile-screen';

export default function EditProfileRoute() {
  return (
    <GuestRouteGuard>
      <EditProfileScreen />
    </GuestRouteGuard>
  );
}
