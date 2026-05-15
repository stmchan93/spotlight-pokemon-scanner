import { useCallback, useState } from 'react';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { PaymentsNotEnabledError } from '@spotlight/api-client';
import {
  Button,
  SectionHeader,
  SurfaceCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { PaymentsNotEnabledState } from '@/features/payments/components/payments-not-enabled-state';
import { useStripeOnboardingStatus } from '@/features/payments/hooks/use-stripe-onboarding-status';
import { useAppServices } from '@/providers/app-providers';

const STRIPE_DASHBOARD_URL = 'https://dashboard.stripe.com/account';

type StripeOnboardingEntryProps = {
  testID?: string;
};

/**
 * Account-screen entry point for Stripe Connect onboarding.
 * Renders one of:
 *   - "Set up payments" CTA       (state.status.onboarded === false)
 *   - "Payments active" pill      (state.status.onboarded === true)
 *   - PaymentsNotEnabledState     (backend responded 503)
 */
export function StripeOnboardingEntry({
  testID = 'stripe-onboarding-entry',
}: StripeOnboardingEntryProps) {
  const theme = useSpotlightTheme();
  const { spotlightRepository } = useAppServices();
  const { state, refresh } = useStripeOnboardingStatus();
  const [isLaunching, setIsLaunching] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleStartOnboarding = useCallback(async () => {
    setActionError(null);
    setIsLaunching(true);
    try {
      const returnUrl = Linking.createURL('/account?stripeReturn=1');
      const refreshUrl = Linking.createURL('/account?stripeRefresh=1');
      const { onboardingUrl } = await spotlightRepository.startStripeOnboarding(
        refreshUrl,
        returnUrl,
      );

      // Match the existing OAuth pattern in auth-service.ts.
      const result = await WebBrowser.openAuthSessionAsync(onboardingUrl, returnUrl);
      if (result.type === 'success' || result.type === 'dismiss' || result.type === 'cancel') {
        await refresh();
      }
    } catch (error) {
      if (error instanceof PaymentsNotEnabledError) {
        setActionError(error.message);
      } else {
        setActionError(error instanceof Error ? error.message : 'Could not start onboarding.');
      }
    } finally {
      setIsLaunching(false);
    }
  }, [refresh, spotlightRepository]);

  const handleOpenStripeDashboard = useCallback(() => {
    void WebBrowser.openBrowserAsync(STRIPE_DASHBOARD_URL).catch(() => {
      void Linking.openURL(STRIPE_DASHBOARD_URL).catch(() => undefined);
    });
  }, []);

  if (state.kind === 'not_enabled') {
    return (
      <View style={styles.section} testID={`${testID}-not-enabled`}>
        <SectionHeader
          subtitle="Stripe payments are not configured in this environment."
          title="Payments"
        />
        <PaymentsNotEnabledState message={state.message} onRetry={refresh} testID={`${testID}-state`} />
      </View>
    );
  }

  if (state.kind === 'loading') {
    return (
      <View style={styles.section} testID={`${testID}-loading`}>
        <SectionHeader title="Payments" />
        <SurfaceCard padding={20} radius={24}>
          <ActivityIndicator color={theme.colors.brand} />
        </SurfaceCard>
      </View>
    );
  }

  if (state.kind === 'error') {
    return (
      <View style={styles.section} testID={`${testID}-error`}>
        <SectionHeader
          subtitle="We couldn’t load payments status. Try again."
          title="Payments"
        />
        <SurfaceCard padding={20} radius={24}>
          <Button label="Retry" onPress={refresh} testID={`${testID}-retry`} variant="secondary" />
        </SurfaceCard>
      </View>
    );
  }

  const onboarded = state.status.onboarded && state.status.chargesEnabled;

  return (
    <View style={styles.section} testID={testID}>
      <SectionHeader
        subtitle={
          onboarded
            ? 'Stripe Connect account is verified. You can sell cards in person.'
            : 'Set up Stripe Connect so buyers can pay you at the show.'
        }
        title="Payments"
      />
      <SurfaceCard padding={20} radius={24}>
        {onboarded ? (
          <View style={styles.rowStack} testID={`${testID}-active`}>
            <View style={styles.activeCopy}>
              <View
                accessibilityLabel="Payments active"
                style={[
                  styles.activeBadge,
                  { backgroundColor: theme.colors.brand },
                ]}
                testID={`${testID}-active-badge`}
              />
            </View>
            <Button
              label="Manage in Stripe"
              onPress={handleOpenStripeDashboard}
              testID={`${testID}-manage`}
              variant="secondary"
            />
          </View>
        ) : (
          <View style={styles.rowStack}>
            <Button
              disabled={isLaunching}
              label={isLaunching ? 'Opening Stripe…' : 'Set up payments'}
              onPress={handleStartOnboarding}
              testID={`${testID}-start`}
            />
            {state.status.requirementsDue.length > 0 ? (
              <Button
                label="More info needed"
                onPress={handleOpenStripeDashboard}
                testID={`${testID}-requirements-due`}
                variant="ghost"
              />
            ) : null}
          </View>
        )}
        {actionError ? (
          <View testID={`${testID}-error-text`}>
            <Button
              label={actionError}
              onPress={() => setActionError(null)}
              variant="ghost"
            />
          </View>
        ) : null}
      </SurfaceCard>
    </View>
  );
}

const styles = StyleSheet.create({
  activeBadge: {
    borderRadius: 999,
    height: 12,
    width: 12,
  },
  activeCopy: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  rowStack: {
    gap: 12,
  },
  section: {
    gap: 12,
  },
});
