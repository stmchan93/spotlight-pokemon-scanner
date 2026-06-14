import { useCallback, useState } from 'react';

import type { EmailAuthActions } from '@/providers/auth-provider';

import { EmailEntryScreen } from './email-entry-screen';
import { EmailPasswordScreen } from './email-password-screen';
import { ForgotPasswordScreen } from './forgot-password-screen';
import { GetStartedScreen } from './get-started-screen';
import { SetNewPasswordScreen } from './set-new-password-screen';
import { VerifyCodeScreen } from './verify-code-screen';

// The signed-out flow is a self-contained stepper over the email-first Figma
// screens. It owns the email/name/password/code drafts and routes between
// steps; every Supabase call is delegated to `emailAuth` (the auth provider),
// which owns busy/error state and the session transition to signedIn.
type Step =
  | 'getStarted'
  | 'email'
  | 'create'
  | 'login'
  | 'verify'
  | 'forgot'
  | 'forgotVerify'
  | 'setPassword';

type SignedOutFlowProps = {
  emailAuth: EmailAuthActions;
  appleSignInAvailable: boolean;
  configurationIssue: string | null;
  errorMessage: string | null;
  isBusy: boolean;
  onAppleSignIn: () => void;
  onGoogleSignIn: () => void;
};

export function SignedOutFlow({
  emailAuth,
  appleSignInAvailable,
  configurationIssue,
  errorMessage,
  isBusy,
  onAppleSignIn,
  onGoogleSignIn,
}: SignedOutFlowProps) {
  const [step, setStep] = useState<Step>('getStarted');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  // Each handler advances only on success; failures surface through the
  // provider's `errorMessage`, so the catch keeps the user on the same step.
  const handleEmailContinue = useCallback(async () => {
    try {
      const exists = await emailAuth.checkEmail(email);
      setStep(exists ? 'login' : 'create');
    } catch {
      /* errorMessage already set by the provider */
    }
  }, [email, emailAuth]);

  const handleSignUp = useCallback(async () => {
    try {
      const { needsCode } = await emailAuth.signUpEmail({ email, password, fullName });
      // When email confirmation is off the provider already signed us in.
      if (needsCode) {
        setStep('verify');
      }
    } catch {
      /* stay on the create step */
    }
  }, [email, emailAuth, fullName, password]);

  const handleLogin = useCallback(async () => {
    try {
      await emailAuth.signInEmail({ email, password });
    } catch {
      /* stay on the login step */
    }
  }, [email, emailAuth, password]);

  const handleVerifySignup = useCallback(async () => {
    try {
      await emailAuth.verifyCode({ email, code, fullName });
    } catch {
      /* stay on the verify step */
    }
  }, [code, email, emailAuth, fullName]);

  const handleResendSignup = useCallback(() => {
    void emailAuth.resendCode(email).catch(() => {});
  }, [email, emailAuth]);

  const handleSendReset = useCallback(async () => {
    try {
      await emailAuth.sendReset(email);
      setCode('');
      setStep('forgotVerify');
    } catch {
      /* stay on the forgot step */
    }
  }, [email, emailAuth]);

  const handleVerifyReset = useCallback(async () => {
    try {
      await emailAuth.verifyResetCode({ email, code });
      setPassword('');
      setStep('setPassword');
    } catch {
      /* stay on the recovery verify step */
    }
  }, [code, email, emailAuth]);

  const handleUpdatePassword = useCallback(async () => {
    try {
      await emailAuth.updatePassword(password);
    } catch {
      /* stay on the set-password step */
    }
  }, [emailAuth, password]);

  switch (step) {
    case 'email':
      return (
        <EmailEntryScreen
          appleSignInAvailable={appleSignInAvailable}
          configurationIssue={configurationIssue}
          email={email}
          errorMessage={errorMessage}
          isBusy={isBusy}
          onApple={onAppleSignIn}
          onBack={() => setStep('getStarted')}
          onChangeEmail={setEmail}
          onContinue={() => void handleEmailContinue()}
          onGoogle={onGoogleSignIn}
        />
      );
    case 'create':
      return (
        <EmailPasswordScreen
          email={email}
          errorMessage={errorMessage}
          fullName={fullName}
          isBusy={isBusy}
          mode="signup"
          onBack={() => setStep('email')}
          onChangeFullName={setFullName}
          onChangePassword={setPassword}
          onContinue={() => void handleSignUp()}
          onForgotPassword={() => setStep('forgot')}
          password={password}
        />
      );
    case 'login':
      return (
        <EmailPasswordScreen
          email={email}
          errorMessage={errorMessage}
          fullName={fullName}
          isBusy={isBusy}
          mode="login"
          onBack={() => setStep('email')}
          onChangeFullName={setFullName}
          onChangePassword={setPassword}
          onContinue={() => void handleLogin()}
          onForgotPassword={() => setStep('forgot')}
          password={password}
        />
      );
    case 'verify':
      return (
        <VerifyCodeScreen
          code={code}
          email={email}
          errorMessage={errorMessage}
          isBusy={isBusy}
          onBack={() => setStep('create')}
          onChangeCode={setCode}
          onContinue={() => void handleVerifySignup()}
          onResend={handleResendSignup}
        />
      );
    case 'forgot':
      return (
        <ForgotPasswordScreen
          email={email}
          errorMessage={errorMessage}
          isBusy={isBusy}
          onBack={() => setStep('email')}
          onChangeEmail={setEmail}
          onContinue={() => void handleSendReset()}
        />
      );
    case 'forgotVerify':
      return (
        <VerifyCodeScreen
          code={code}
          email={email}
          errorMessage={errorMessage}
          isBusy={isBusy}
          onBack={() => setStep('forgot')}
          onChangeCode={setCode}
          onContinue={() => void handleVerifyReset()}
          onResend={() => void handleSendReset()}
        />
      );
    case 'setPassword':
      return (
        <SetNewPasswordScreen
          errorMessage={errorMessage}
          isBusy={isBusy}
          onBack={() => setStep('forgotVerify')}
          onChangePassword={setPassword}
          onContinue={() => void handleUpdatePassword()}
          password={password}
        />
      );
    case 'getStarted':
    default:
      return <GetStartedScreen onGetStarted={() => setStep('email')} />;
  }
}
