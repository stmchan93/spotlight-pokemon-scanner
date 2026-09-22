import { fireEvent, screen } from '@testing-library/react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { FeedbackScreen } from '@/features/feedback/feedback-screen';
import { capturePostHogEvent } from '@/lib/observability/posthog';

import { renderWithProviders } from '../../test-utils';

jest.mock('expo-router', () => ({
  useLocalSearchParams: jest.fn(),
  useRouter: jest.fn(),
}));

jest.mock('@/lib/observability/posthog', () => ({
  capturePostHogEvent: jest.fn(),
}));

describe('FeedbackScreen', () => {
  const back = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({ back });
    (useLocalSearchParams as jest.Mock).mockReturnValue({ from: '/scan' });
  });

  it('does not send an empty message', () => {
    renderWithProviders(<FeedbackScreen />);

    fireEvent.changeText(screen.getByTestId('feedback-message'), '   ');
    fireEvent.press(screen.getByTestId('feedback-send'));

    expect(capturePostHogEvent).not.toHaveBeenCalled();
  });

  it('counts characters against the 1000 limit', () => {
    renderWithProviders(<FeedbackScreen />);

    expect(screen.getByTestId('feedback-count').props.children).toBe('0/1000');
    fireEvent.changeText(screen.getByTestId('feedback-message'), 'hello');
    expect(screen.getByTestId('feedback-count').props.children).toBe('5/1000');
    expect(screen.getByTestId('feedback-message').props.maxLength).toBe(1000);
  });

  it('sends the trimmed message and origin screen, then thanks the user', () => {
    renderWithProviders(<FeedbackScreen />);

    fireEvent.changeText(screen.getByTestId('feedback-message'), '  Salamence keeps scanning as the GX  ');
    fireEvent.press(screen.getByTestId('feedback-send'));

    expect(capturePostHogEvent).toHaveBeenCalledWith('feedback_submitted', {
      message: 'Salamence keeps scanning as the GX',
      from_screen: '/scan',
    });
    expect(screen.getByTestId('feedback-sent')).toBeTruthy();

    fireEvent.press(screen.getByTestId('feedback-done'));
    expect(back).toHaveBeenCalled();
  });
});
