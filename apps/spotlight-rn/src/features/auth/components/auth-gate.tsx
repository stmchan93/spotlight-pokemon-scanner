import type { ReactNode } from 'react';

import type { AppUser, AuthState } from '@/features/auth/auth-models';
import type { EmailAuthActions } from '@/providers/auth-provider';

import { AuthLoadingScreen } from './auth-loading-screen';
import { ProfileOnboardingScreen } from './profile-onboarding-screen';
import { SignedOutFlow } from './signed-out-flow';

type AuthGateProps = {
  appleSignInAvailable: boolean;
  authenticatedContent: ReactNode;
  configurationIssue: string | null;
  currentUser: AppUser | null;
  emailAuth: EmailAuthActions;
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
  emailAuth,
  errorMessage,
  isBusy,
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
        <SignedOutFlow
          appleSignInAvailable={appleSignInAvailable}
          configurationIssue={configurationIssue}
          emailAuth={emailAuth}
          errorMessage={errorMessage}
          isBusy={isBusy}
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
