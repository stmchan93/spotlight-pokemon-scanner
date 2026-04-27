import type { ReactNode } from 'react';

import type { AppUser, AuthState } from '@/features/auth/auth-models';

import { AuthLoadingScreen } from './auth-loading-screen';
import { ProfileOnboardingScreen } from './profile-onboarding-screen';
import { SignInScreen } from './sign-in-screen';

type AuthGateProps = {
  appleSignInAvailable: boolean;
  authenticatedContent: ReactNode;
  configurationIssue: string | null;
  currentUser: AppUser | null;
  errorMessage: string | null;
  isBusy: boolean;
  isConfigured: boolean;
  onAppleSignIn: () => void;
  onChangeProfileDraftName: (value: string) => void;
  onGoogleSignIn: () => void;
  onSubmitProfile: () => void;
  profileDraftName: string;
  state: AuthState;
};

export function AuthGate({
  appleSignInAvailable,
  authenticatedContent,
  configurationIssue,
  currentUser,
  errorMessage,
  isBusy,
  isConfigured,
  onAppleSignIn,
  onChangeProfileDraftName,
  onGoogleSignIn,
  onSubmitProfile,
  profileDraftName,
  state,
}: AuthGateProps) {
  switch (state) {
    case 'loading':
      return <AuthLoadingScreen />;
    case 'signedOut':
      return (
        <SignInScreen
          appleSignInAvailable={appleSignInAvailable}
          configurationIssue={configurationIssue}
          errorMessage={errorMessage}
          isBusy={isBusy}
          isConfigured={isConfigured}
          onAppleSignIn={onAppleSignIn}
          onGoogleSignIn={onGoogleSignIn}
        />
      );
    case 'needsProfile':
      return (
        <ProfileOnboardingScreen
          errorMessage={errorMessage}
          isBusy={isBusy}
          onChangeDraftName={onChangeProfileDraftName}
          onSubmit={onSubmitProfile}
          profileDraftName={profileDraftName}
          user={currentUser}
        />
      );
    case 'signedIn':
      return authenticatedContent;
    default:
      return <AuthLoadingScreen />;
  }
}
