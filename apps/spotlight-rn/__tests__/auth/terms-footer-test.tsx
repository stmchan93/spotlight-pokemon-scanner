import { fireEvent, screen } from '@testing-library/react-native';
import * as Linking from 'expo-linking';

import { TermsFooter } from '@/features/auth/components/auth-controls';
import {
  PRIVACY_POLICY_URL,
  TERMS_OF_USE_URL,
} from '@/features/auth/legal-links';

import { renderWithProviders } from '../test-utils';

jest.mock('expo-linking', () => ({
  openURL: jest.fn(async () => true),
}));

const mockOpenURL = Linking.openURL as jest.MockedFunction<typeof Linking.openURL>;

// App Store Guideline 1.2 / 5.1.1: the sign-up footer's Terms and Privacy
// mentions must be REAL links. They were dead styled text until the legal site
// went live — these tests are the guardrail against regressing to that.
describe('TermsFooter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('opens the hosted Terms of Use when tapped', () => {
    renderWithProviders(<TermsFooter />);

    fireEvent.press(screen.getByTestId('auth-terms-link'));
    expect(mockOpenURL).toHaveBeenCalledWith(TERMS_OF_USE_URL);
    expect(TERMS_OF_USE_URL).toBe('https://stmchan93.github.io/ekalight-legal/terms/');
  });

  it('opens the hosted Privacy Policy when tapped', () => {
    renderWithProviders(<TermsFooter />);

    fireEvent.press(screen.getByTestId('auth-privacy-link'));
    expect(mockOpenURL).toHaveBeenCalledWith(PRIVACY_POLICY_URL);
    // The ROOT of the legal site is the privacy policy — /privacy/ is a 404.
    expect(PRIVACY_POLICY_URL).toBe('https://stmchan93.github.io/ekalight-legal/');
  });
});
