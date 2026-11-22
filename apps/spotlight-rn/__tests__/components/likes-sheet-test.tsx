import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { UserProfile } from '@/features/auth/auth-models';
import { fetchPostLikers } from '@/features/profile/profile-service';
import { LikesSheet } from '@/features/social/components/likes-sheet';

import { renderWithProviders } from '../test-utils';

jest.mock('@/features/profile/profile-service', () => ({ fetchPostLikers: jest.fn() }));

function profile(userID: string, displayName: string, handle: string | null): UserProfile {
  return {
    userID, displayName, handle, avatarURL: null, labelerEnabled: false, adminEnabled: false, bio: null,
    location: null, socialLink: null, isVerified: false, reputation: 0, followerCount: 0, followingCount: 0,
    postCount: 0,
  };
}

describe('LikesSheet', () => {
  it('lists who liked the post and opens a profile', async () => {
    (fetchPostLikers as jest.Mock).mockResolvedValue([profile('u-1', 'Ash', 'ash'), profile('u-2', 'Misty', null)]);
    const onOpenProfile = jest.fn();
    renderWithProviders(<LikesSheet onClose={jest.fn()} onOpenProfile={onOpenProfile} postId="p-1" visible />);
    await waitFor(() => expect(screen.getByText('Ash')).toBeTruthy());
    expect(fetchPostLikers).toHaveBeenCalledWith('p-1');
    expect(screen.getByText('@ASH')).toBeTruthy();
    fireEvent.press(screen.getByTestId('likes-sheet-row-u-2'));
    expect(onOpenProfile).toHaveBeenCalledWith(expect.objectContaining({ userID: 'u-2' }));
  });

  it('closes from the backdrop and says when nobody liked it', async () => {
    (fetchPostLikers as jest.Mock).mockResolvedValue([]);
    const onClose = jest.fn();
    renderWithProviders(<LikesSheet onClose={onClose} onOpenProfile={jest.fn()} postId="p-1" visible />);
    expect(await screen.findByTestId('likes-sheet-empty')).toBeTruthy();
    fireEvent.press(screen.getByTestId('likes-sheet-backdrop'));
    expect(onClose).toHaveBeenCalled();
  });
});
