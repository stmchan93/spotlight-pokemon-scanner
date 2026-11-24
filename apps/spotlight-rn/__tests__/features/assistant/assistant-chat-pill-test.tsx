import { fireEvent, render, screen } from '@testing-library/react-native';

const mockPush = jest.fn();
let mockPathname = '/search';
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => mockPathname,
  useGlobalSearchParams: () => ({}),
}));
jest.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: jest.fn(() => Promise.resolve()),
}));

import { AssistantChatPill } from '@/features/assistant/components/assistant-chat-pill';
import { AssistantRouteTracker } from '@/features/assistant/page-context/assistant-route-tracker';

describe('AssistantChatPill (Figma 6725:8999)', () => {
  beforeEach(() => mockPush.mockClear());

  it('draws the mark + "Chat" and opens Ask Ekalight about the focused page', () => {
    mockPathname = '/search';
    render(
      <>
        <AssistantRouteTracker />
        <AssistantChatPill />
      </>,
    );
    expect(screen.getByText('Chat')).toBeTruthy();
    expect(screen.getByTestId('assistant-chat-pill-mark')).toBeTruthy();

    fireEvent.press(screen.getByRole('button', { name: 'Chat with Ekalight' }));
    expect(mockPush).toHaveBeenCalledTimes(1);
    const href = mockPush.mock.calls[0][0] as { pathname: string; params: Record<string, string> };
    expect(href.pathname).toBe('/assistant');
    expect(href.params.page).toContain('search');
  });
});
