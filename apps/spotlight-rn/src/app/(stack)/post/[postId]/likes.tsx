import { useLocalSearchParams, useRouter } from 'expo-router';

import { PostLikesScreen } from '@/features/social/screens/post-likes-screen';

export default function PostLikesRoute() {
  const router = useRouter();
  const { postId } = useLocalSearchParams<{ postId?: string }>();
  return <PostLikesScreen onBack={() => router.back()} postId={typeof postId === 'string' ? postId : ''} />;
}
