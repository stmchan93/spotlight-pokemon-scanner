import { Alert } from 'react-native';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';

import { listConnectedApps, revokeConnectedApp } from '@/features/ai-settings/connected-apps';
import { UseWithAiScreen, resolveMcpServerUrl } from '@/features/ai-settings/screens/use-with-ai-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => true),
}));

jest.mock('@/features/ai-settings/connected-apps', () => ({
  listConnectedApps: jest.fn(),
  revokeConnectedApp: jest.fn(),
}));

const mockList = listConnectedApps as jest.MockedFunction<typeof listConnectedApps>;
const mockRevoke = revokeConnectedApp as jest.MockedFunction<typeof revokeConnectedApp>;
const MCP_URL = 'https://staging-api.ekalight.com/mcp';

function renderScreen(overrides: Parameters<typeof createTestSpotlightRepository>[0] = {}, mcpUrl: string | null = MCP_URL) {
  const repository = createTestSpotlightRepository(overrides);
  renderWithProviders(<UseWithAiScreen mcpUrl={mcpUrl} onBack={jest.fn()} />, { spotlightRepository: repository });
  return repository;
}

describe('resolveMcpServerUrl', () => {
  it('appends /mcp to the configured API base', () => {
    expect(resolveMcpServerUrl('https://staging-api.ekalight.com')).toBe(MCP_URL);
    expect(resolveMcpServerUrl('https://api.ekalight.com/')).toBe('https://api.ekalight.com/mcp');
    expect(resolveMcpServerUrl(null)).toBeNull();
  });
});

describe('UseWithAiScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockList.mockResolvedValue([]);
  });

  it('explains the feature, shows the URL with copy, and the Claude steps', async () => {
    renderScreen();

    expect(screen.getByText('Use with AI')).toBeTruthy();
    expect(screen.getByText(/Ask Claude or ChatGPT about your Ekalight collection/)).toBeTruthy();
    expect(screen.getByTestId('use-with-ai-url')).toHaveTextContent(MCP_URL);
    expect(screen.getByTestId('use-with-ai-step-1')).toHaveTextContent(/Settings → Connectors → Add custom connector/);
    expect(screen.getByTestId('use-with-ai-step-3')).toHaveTextContent(/log in with Ekalight, then tap Approve/);

    await act(async () => {
      fireEvent.press(screen.getByTestId('use-with-ai-copy-url'));
    });
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(MCP_URL);
    expect(screen.getByText('Copied')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('use-with-ai-connected-empty')).toBeTruthy());
  });

  it('shows a fallback when there is no API base URL', async () => {
    renderScreen({}, null);
    expect(screen.getByTestId('use-with-ai-url-missing')).toBeTruthy();
    expect(screen.queryByTestId('use-with-ai-copy-url')).toBeNull();
    await waitFor(() => expect(mockList).toHaveBeenCalled());
  });

  it('edit toggle defaults off, writes through the repository, and uses Watchlist wording', async () => {
    const setAiSettings = jest.fn(async () => ({ settings: { allowMcpEdits: true }, status: 'ok' as const }));
    renderScreen({ setAiSettings });

    const toggle = screen.getByTestId('use-with-ai-edits-toggle');
    await waitFor(() => expect(toggle.props.disabled).toBe(false));
    expect(toggle.props.value).toBe(false);
    expect(screen.getByText(/add cards to your Watchlist/)).toBeTruthy();
    expect(screen.queryByText(/[Ww]ishlist/)).toBeNull();
    expect(screen.getByText(/can't delete anything/)).toBeTruthy();

    await act(async () => {
      fireEvent(toggle, 'valueChange', true);
    });
    expect(setAiSettings).toHaveBeenCalledWith({ allowMcpEdits: true });
    expect(screen.getByTestId('use-with-ai-edits-toggle').props.value).toBe(true);
  });

  it('reverts the toggle when the write fails', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    renderScreen({ setAiSettings: jest.fn(async () => ({ settings: null, status: 'failed' as const })) });
    const toggle = screen.getByTestId('use-with-ai-edits-toggle');
    await waitFor(() => expect(toggle.props.disabled).toBe(false));

    await act(async () => {
      fireEvent(toggle, 'valueChange', true);
    });
    expect(screen.getByTestId('use-with-ai-edits-toggle').props.value).toBe(false);
    expect(alertSpy).toHaveBeenCalled();
  });

  it('keeps the toggle disabled when the setting cannot load', async () => {
    renderScreen({ getAiSettings: jest.fn(async () => null) });
    await waitFor(() => expect(screen.getByTestId('use-with-ai-settings-error')).toBeTruthy());
    expect(screen.getByTestId('use-with-ai-edits-toggle').props.disabled).toBe(true);
  });

  it('lists connected apps and revokes after confirmation', async () => {
    mockList.mockResolvedValue([{ clientId: 'claude-1', grantedAt: '2026-11-10T00:00:00Z', name: 'Claude' }]);
    mockRevoke.mockResolvedValue(true);
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === 'Disconnect')?.onPress?.();
    });
    renderScreen();

    await waitFor(() => expect(screen.getByTestId('use-with-ai-app-claude-1')).toBeTruthy());
    expect(screen.getByText('Claude')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('use-with-ai-revoke-claude-1'));
    });
    expect(alertSpy).toHaveBeenCalled();
    expect(mockRevoke).toHaveBeenCalledWith('claude-1');
    await waitFor(() => expect(screen.queryByTestId('use-with-ai-app-claude-1')).not.toBeOnTheScreen());
  });

  it('falls back to "disconnect in Claude/ChatGPT" when grants cannot be listed', async () => {
    mockList.mockResolvedValue(null);
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('use-with-ai-connected-fallback')).toBeTruthy());
  });
});
