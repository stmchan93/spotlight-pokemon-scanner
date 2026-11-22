import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { deleteAsync } from 'expo-file-system/legacy';
import { Alert } from 'react-native';

import {
  mockAssistantCards,
  mockAssistantUsage,
  type AssistantSendPayload,
  type AssistantSendResult,
  type CatalogSearchResult,
  type ScannerCapturePayload,
  type ScannerMatchResult,
} from '@spotlight/api-client';

import {
  assistantPhotoCardLabel,
  assistantPhotoScanPayload,
  centeredCardCrop,
} from '@/features/assistant/assistant-photo-scan';
import { AssistantComposer } from '@/features/assistant/components/assistant-composer';
import { AssistantScreen } from '@/features/assistant/screens/assistant-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

jest.mock('@/features/auth/use-guest-gate', () => ({
  useGuestGate: () => ({
    ensureGuestSession: jest.fn(async () => ({ access_token: 'guest' })),
    gate: (fn: () => void) => fn,
    isGuest: false,
    openLogin: jest.fn(),
  }),
}));

function candidate(cardId: string, name: string, setName: string, cardNumber: string): CatalogSearchResult {
  return { id: cardId, cardId, name, setName, cardNumber, imageUrl: `https://img.example/${cardId}.png` };
}

const CANDIDATES = [
  candidate('base1-4', 'Charizard', 'Base Set', '#4/102'),
  candidate('base2-4', 'Charizard', 'Base Set 2', '#4/130'),
  candidate('lc-3', 'Charizard', 'Legendary Collection', '#3/110'),
];

function matchResult(candidates = CANDIDATES): ScannerMatchResult {
  return { scanID: 'scan-1', candidates };
}

function reply(userId = 'u1'): AssistantSendResult {
  const base = { threadId: 'thr_1', createdAt: '2026-11-21T10:00:00Z', status: 'ok' as const };
  return {
    threadId: 'thr_1',
    userMessage: { ...base, id: userId, role: 'user', text: 'q', cards: [], actions: [] },
    message: {
      ...base, id: `a-${userId}`, role: 'assistant', text: 'The card in your photo is **Celebi**.',
      cards: [mockAssistantCards.celebi], actions: [],
    },
    usage: mockAssistantUsage(1),
  };
}

const launchLibrary = ImagePicker.launchImageLibraryAsync as jest.Mock;
const launchCamera = ImagePicker.launchCameraAsync as jest.Mock;

function renderScreen(overrides: Parameters<typeof createTestSpotlightRepository>[0], props = {}) {
  const repository = createTestSpotlightRepository({
    listAssistantThreads: async () => ({ threads: [], nextCursor: null }),
    ...overrides,
  });
  renderWithProviders(
    <AssistantScreen onBack={jest.fn()} onOpenCard={jest.fn()} source="home" {...props} />,
    { spotlightRepository: repository },
  );
  return repository;
}

async function attachFromLibrary() {
  fireEvent.press(screen.getByTestId('assistant-attach'));
  expect(screen.getByTestId('assistant-photo-menu')).toBeTruthy();
  fireEvent.press(screen.getByTestId('assistant-photo-menu-library'));
}

beforeEach(() => {
  launchLibrary.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///picked.jpg', width: 1080, height: 1080 }] });
  launchCamera.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///camera.jpg', width: 1080, height: 1080 }] });
  (deleteAsync as jest.Mock).mockClear();
});

afterEach(() => {
  launchLibrary.mockReset();
  launchLibrary.mockResolvedValue({ canceled: true, assets: null });
  launchCamera.mockReset();
  launchCamera.mockResolvedValue({ canceled: true, assets: null });
});

describe('photo in chat helpers', () => {
  it('labels a match "Charizard · Base Set 4/102"', () => {
    expect(assistantPhotoCardLabel(CANDIDATES[0])).toBe('Charizard · Base Set 4/102');
    expect(assistantPhotoCardLabel({ name: 'Pikachu', setName: '', cardNumber: '' })).toBe('Pikachu');
  });

  it('crops the largest centred 5:7 rect (iOS square crop → card shape)', () => {
    expect(centeredCardCrop(1000, 1000)).toEqual({ originX: 142, originY: 0, width: 715, height: 1000 });
    expect(centeredCardCrop(700, 2000)).toEqual({ originX: 0, originY: 511, width: 700, height: 977 });
  });

  it('scans as a raw-lane chat photo with no training artifact and the default game', () => {
    const payload = assistantPhotoScanPayload('file:///crop.jpg', null);
    expect(payload).toMatchObject({
      mode: 'raw', game: 'pokemon', fileUri: 'file:///crop.jpg', width: 630, height: 880, captureSource: 'assistant_photo',
    });
    expect(payload.normalizedImage).toBeUndefined();
    expect(payload.sourceImage).toBeUndefined();
  });
});

describe('AssistantComposer "+"', () => {
  it('opens Take photo / Choose photo and reports the choice, then closes', () => {
    const onAttachPhoto = jest.fn();
    render(
      <AssistantComposer
        isSending={false} maxLength={500} onAttachPhoto={onAttachPhoto} onChangeText={jest.fn()} onSend={jest.fn()} value=""
      />,
    );
    expect(screen.queryByTestId('assistant-photo-menu')).not.toBeOnTheScreen();
    fireEvent.press(screen.getByTestId('assistant-attach'));
    expect(screen.getByText('Take photo')).toBeTruthy();
    expect(screen.getByText('Choose photo')).toBeTruthy();
    fireEvent.press(screen.getByTestId('assistant-photo-menu-camera'));
    expect(onAttachPhoto).toHaveBeenCalledWith('camera');
    expect(screen.queryByTestId('assistant-photo-menu')).not.toBeOnTheScreen();
  });

  it('has no "+" without onAttachPhoto, and sendBlocked disables send', () => {
    render(<AssistantComposer isSending={false} maxLength={500} onChangeText={jest.fn()} onSend={jest.fn()} sendBlocked value="hi" />);
    expect(screen.queryByTestId('assistant-attach')).not.toBeOnTheScreen();
    expect(screen.getByTestId('assistant-send')).toBeDisabled();
  });
});

describe('AssistantScreen photo in chat', () => {
  it('identifies a library photo, switches to an alternate, and sends its card as attachedCardIds', async () => {
    const matchScannerCapture = jest.fn(async (_payload: ScannerCapturePayload) => matchResult());
    const sendAssistantMessage = jest.fn(async (_payload: AssistantSendPayload) => reply());
    renderScreen({ matchScannerCapture, sendAssistantMessage }, { game: 'pokemon' });

    await attachFromLibrary();
    expect(await screen.findByTestId('assistant-photo-match')).toHaveTextContent('Charizard · Base Set 4/102');
    expect(launchLibrary).toHaveBeenCalledWith(expect.objectContaining({ allowsEditing: true, aspect: [5, 7] }));
    expect(matchScannerCapture).toHaveBeenCalledTimes(1);
    expect(matchScannerCapture.mock.calls[0][0]).toMatchObject({ mode: 'raw', game: 'pokemon', width: 630, height: 880 });

    // The top match can be wrong: pick the Base Set 2 printing.
    fireEvent.press(screen.getByTestId('assistant-photo-change'));
    expect(screen.getByTestId('assistant-photo-sheet')).toBeTruthy();
    fireEvent.press(screen.getByTestId('assistant-photo-candidate-1'));
    expect(screen.queryByTestId('assistant-photo-sheet')).not.toBeOnTheScreen();
    expect(screen.getByTestId('assistant-photo-match')).toHaveTextContent('Charizard · Base Set 2 4/130');

    fireEvent.changeText(screen.getByTestId('assistant-input'), 'Is this worth grading?');
    fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(1));
    expect(sendAssistantMessage.mock.calls[0][0].context).toEqual({ source: 'home', game: 'pokemon', attachedCardIds: ['base2-4'] });
    // The photo moves from the composer to the sent bubble.
    expect(await screen.findByTestId('assistant-photo-bubble')).toBeTruthy();
    expect(screen.queryByTestId('assistant-photo-chip')).not.toBeOnTheScreen();
  });

  it('a photo can ride a FOLLOW-UP turn, beside nothing else', async () => {
    let sends = 0;
    const sendAssistantMessage = jest.fn(async (_payload: AssistantSendPayload) => reply(`u${(sends += 1)}`));
    renderScreen({ matchScannerCapture: async () => matchResult(), sendAssistantMessage });
    fireEvent.changeText(screen.getByTestId('assistant-input'), 'hello');
    fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(1));
    await screen.findByTestId('assistant-card-xyp-111');

    await attachFromLibrary();
    await screen.findByTestId('assistant-photo-match');
    fireEvent.changeText(screen.getByTestId('assistant-input'), 'What about this one?');
    fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(2));
    expect(sendAssistantMessage.mock.calls[1][0]).toMatchObject({
      threadId: 'thr_1',
      context: { source: 'home', attachedCardIds: ['base1-4'] },
    });
    expect(sendAssistantMessage.mock.calls[1][0].context?.cardIds).toBeUndefined();
  });

  it('keeps the scan tray ids on the first question when a photo is attached too', async () => {
    const sendAssistantMessage = jest.fn(async (_payload: AssistantSendPayload) => reply());
    renderScreen(
      { matchScannerCapture: async () => matchResult(), sendAssistantMessage },
      { source: 'scanner', cardIds: ['xyp-111'] },
    );
    await attachFromLibrary();
    await screen.findByTestId('assistant-photo-match');
    fireEvent.changeText(screen.getByTestId('assistant-input'), 'Compare these');
    fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(1));
    expect(sendAssistantMessage.mock.calls[0][0].context).toEqual({
      source: 'scanner', cardIds: ['xyp-111'], attachedCardIds: ['base1-4'],
    });
  });

  it('blocks send while identifying; a failed match offers Try again; X removes and deletes the crop', async () => {
    let resolveMatch: (value: ScannerMatchResult) => void = () => undefined;
    const matchScannerCapture = jest.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise<ScannerMatchResult>((resolve) => { resolveMatch = resolve; }));
    const sendAssistantMessage = jest.fn(async (_payload: AssistantSendPayload) => reply());
    renderScreen({ matchScannerCapture, sendAssistantMessage });

    fireEvent.press(screen.getByTestId('assistant-attach'));
    fireEvent.press(screen.getByTestId('assistant-photo-menu-camera'));
    expect(await screen.findByTestId('assistant-photo-failed')).toBeTruthy();
    expect(launchCamera).toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('assistant-photo-retry'));
    expect(await screen.findByTestId('assistant-photo-identifying')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('assistant-input'), 'worth it?');
    expect(screen.getByTestId('assistant-send')).toBeDisabled();
    await act(async () => resolveMatch(matchResult()));
    expect(await screen.findByTestId('assistant-photo-match')).toBeTruthy();
    expect(screen.getByTestId('assistant-send')).not.toBeDisabled();

    fireEvent.press(screen.getByTestId('assistant-photo-remove'));
    expect(screen.queryByTestId('assistant-photo-chip')).not.toBeOnTheScreen();
    expect(deleteAsync).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\/\/mock-normalized-/), { idempotent: true });
    fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(sendAssistantMessage).toHaveBeenCalledTimes(1));
    expect(sendAssistantMessage.mock.calls[0][0].context?.attachedCardIds).toBeUndefined();
  });

  it('a cancelled pick changes nothing; a missing picker says update needed', async () => {
    launchLibrary.mockResolvedValueOnce({ canceled: true, assets: null });
    const matchScannerCapture = jest.fn(async () => matchResult());
    renderScreen({ matchScannerCapture });
    await attachFromLibrary();
    await waitFor(() => expect(launchLibrary).toHaveBeenCalled());
    expect(screen.queryByTestId('assistant-photo-chip')).not.toBeOnTheScreen();
    expect(matchScannerCapture).not.toHaveBeenCalled();

    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
    fireEvent.press(screen.getByTestId('assistant-attach'));
    fireEvent.press(screen.getByTestId('assistant-photo-menu-camera'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Camera access needed', expect.any(String)));
    alert.mockRestore();
  });
});
