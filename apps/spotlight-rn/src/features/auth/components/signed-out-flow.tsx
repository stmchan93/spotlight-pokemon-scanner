import { useCallback, useEffect, useState } from 'react';

import type { EmailAuthActions, EmailAuthMethod } from '@/providers/auth-provider';

import { ForgotPasswordScreen } from './forgot-password-screen';
import { LoginScreen } from './login-screen';
import { PasswordScreen } from './password-screen';
import { SetNewPasswordScreen } from './set-new-password-screen';
import { SignUpScreen } from './sign-up-screen';
import { SocialAccountScreen, type SocialAccountMethod } from './social-account-screen';
import { VerifyCodeScreen } from './verify-code-screen';

// The signed-out flow is a self-contained stepper. It owns the email/name/
// password/code drafts and routes between steps; every Supabase call is
// delegated to `emailAuth` (the auth provider), which owns busy/error state and
// the session transition to signedIn.
//
// Email-first: the root asks only for an email, then `resolveEmailMethod`
// picks step 2 — password, the Google/Apple account screen, or sign-up. A
// failed lookup falls back to the password step so nobody is blocked.
type Step =
  | 'email'
  | 'password'
  | 'social'
  | 'signup'
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
  /**
   * When present, the email root shows a back/close affordance that calls this
   * (e.g. the guest login MODAL dismisses back to the scanner). Omitted for the
   * full-screen signed-out flow, which has no back on the root.
   */
  onClose?: () => void;
};

export function SignedOutFlow({
  emailAuth,
  appleSignInAvailable,
  configurationIssue,
  errorMessage,
  isBusy,
  onAppleSignIn,
  onGoogleSignIn,
  onClose,
}: SignedOutFlowProps) {
  const [step, setStep] = useState<Step>('email');
  // The auth error is shared across every step. Clear it whenever the step
  // changes so one screen's failure can't follow the user onto the next.
  // `clearError` is stable, so this fires only on a real step change.
  const { clearError } = emailAuth;
  useEffect(() => {
    clearError();
  }, [step, clearError]);
  const [email, setEmail] = useState('');
  // null = the lookup failed (password step shows a create-account escape).
  const [method, setMethod] = useState<EmailAuthMethod | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  // The auth service / profile stores a single display name; combine first + last.
  const fullName = [firstName, lastName].map((value) => value.trim()).filter(Boolean).join(' ');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // Signup guard notice ("an account already exists"). Local, not a provider error.
  const [signupNotice, setSignupNotice] = useState<string | null>(null);

  // Back to the email root keeps the typed email but drops any password.
  const goToEmail = useCallback(() => {
    setPassword('');
    setSignupNotice(null);
    setStep('email');
  }, []);
  const goToSignup = useCallback(() => {
    setPassword('');
    setSignupNotice(null);
    setStep('signup');
  }, []);

  const handleContinueEmail = useCallback(async () => {
    // Normalize once so every later step (chip, sign-in, sign-up) uses the same address.
    const trimmedEmail = email.trim();
    setEmail(trimmedEmail);
    const resolved = await emailAuth.resolveEmailMethod(trimmedEmail);
    setMethod(resolved);
    setPassword('');
    setSignupNotice(null);
    switch (resolved) {
      case 'none':
        setStep('signup');
        return;
      case 'google':
      case 'apple':
      case 'oauth':
        setStep('social');
        return;
      case 'password':
      default:
        setStep('password');
    }
  }, [email, emailAuth]);

  const handleLogin = useCallback(async () => {
    try {
      await emailAuth.signInEmail({ email, password });
    } catch {
      /* errorMessage already set by the provider */
    }
  }, [email, emailAuth, password]);

  // SIGN UP: when the lookup already said 'none' the address is known to be
  // new; otherwise (lookup failed) keep the existing-account guard.
  const handleSignUp = useCallback(async () => {
    setSignupNotice(null);
    try {
      if (method !== 'none') {
        const exists = await emailAuth.checkEmail(email);
        if (exists) {
          setSignupNotice('An account with this email already exists.');
          return;
        }
      }
      const { needsCode } = await emailAuth.signUpEmail({ email, password, fullName });
      // When email confirmation is off the provider already signed us in.
      if (needsCode) {
        setStep('verify');
      }
    } catch {
      /* stay on the sign-up step */
    }
  }, [email, emailAuth, fullName, method, password]);

  const handleVerifySignup = useCallback(async () => {
    try {
      // `password` is only consumed on the guest path (converting an anonymous
      // user sets the password after the code verifies the address); a plain
      // signup already carried it and ignores this.
      await emailAuth.verifyCode({ email, code, fullName, password });
    } catch {
      /* stay on the verify step */
    }
  }, [code, email, emailAuth, fullName, password]);

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
    case 'password':
      return (
        <PasswordScreen
          configurationIssue={configurationIssue}
          email={email}
          errorMessage={errorMessage}
          isBusy={isBusy}
          onBack={goToEmail}
          onChangePassword={setPassword}
          onContinue={() => void handleLogin()}
          onCreateAccount={method === null ? goToSignup : undefined}
          onForgotPassword={() => setStep('forgot')}
          onGoogle={onGoogleSignIn}
          password={password}
        />
      );
    case 'social':
      return (
        <SocialAccountScreen
          configurationIssue={configurationIssue}
          email={email}
          errorMessage={errorMessage}
          isBusy={isBusy}
          method={(method ?? 'oauth') as SocialAccountMethod}
          onApple={onAppleSignIn}
          onBack={goToEmail}
          onGoogle={onGoogleSignIn}
        />
      );
    case 'signup':
      return (
        <SignUpScreen
          appleSignInAvailable={appleSignInAvailable}
          configurationIssue={configurationIssue}
          email={email}
          errorMessage={errorMessage}
          firstName={firstName}
          isBusy={isBusy}
          lastName={lastName}
          notice={signupNotice}
          onApple={onAppleSignIn}
          onBack={goToEmail}
          onChangeFirstName={setFirstName}
          onChangeLastName={setLastName}
          onChangePassword={setPassword}
          onContinue={() => void handleSignUp()}
          onGoogle={onGoogleSignIn}
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
          onBack={() => setStep('signup')}
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
          onBack={() => setStep('password')}
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
    case 'email':
    default:
      return (
        <LoginScreen
          appleSignInAvailable={appleSignInAvailable}
          configurationIssue={configurationIssue}
          email={email}
          errorMessage={errorMessage}
          isBusy={isBusy}
          onApple={onAppleSignIn}
          onBack={onClose}
          onChangeEmail={setEmail}
          onContinue={() => void handleContinueEmail()}
          onGoogle={onGoogleSignIn}
        />
      );
  }
}
