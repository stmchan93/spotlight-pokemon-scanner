import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import type {
  WhosThatPokemonPayload,
  WhosThatPokemonResult,
  WhosThatShareCardResult,
} from '@spotlight/api-client';

import { WhosThatPokemonScreen } from '@/features/whos-that-pokemon/screens/whos-that-pokemon-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

// The screen's share flow lazy-requires expo-sharing; give it a working mock so
// the share sheet path resolves instead of falling through to RN Share.
const mockShareAsync = jest.fn(async (..._args: unknown[]) => {});
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: (...args: unknown[]) => mockShareAsync(...args),
}));

const mockMatches: WhosThatPokemonResult = {
  matches: [
    {
      species: 'Pikachu',
      pokedexId: 25,
      confidence: 0.92,
      reason: 'Bright-eyed and impossible to miss.',
    },
    {
      species: 'Snorlax',
      pokedexId: 143,
      confidence: 0.54,
      reason: 'Nap-first energy.',
    },
    {
      species: 'Psyduck',
      pokedexId: 54,
      confidence: 0.21,
      reason: 'A little chaotic.',
    },
  ],
  personCutoutUri: 'data:image/png;base64,Y3V0b3V0',
};

const mockShareCard: WhosThatShareCardResult = { pngBase64: 'cG5nLWJ5dGVz' };

function renderScreen(repository?: ReturnType<typeof createTestSpotlightRepository>) {
  return renderWithProviders(<WhosThatPokemonScreen />, { spotlightRepository: repository });
}

describe('WhosThatPokemonScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({
      back: jest.fn(),
      canGoBack: jest.fn(() => true),
      push: jest.fn(),
      replace: jest.fn(),
    });
  });

  it('opens on the capture phase with the privacy caption and shutter', async () => {
    renderScreen();

    expect(await screen.findByTestId('wtp-shutter')).toBeTruthy();
    expect(screen.getByTestId('wtp-privacy-caption').props.children).toBe(
      'Analyzed in the moment. Never stored.',
    );
    // No result/theater UI yet.
    expect(screen.queryByTestId('wtp-theater')).toBeNull();
    expect(screen.queryByTestId('wtp-result')).toBeNull();
  });

  it('walks capture → scanning → reveal → result on a successful match', async () => {
    const whosThatPokemon = jest.fn(async (_payload: WhosThatPokemonPayload) => mockMatches);
    const repository = createTestSpotlightRepository({ whosThatPokemon });

    renderScreen(repository);

    await act(async () => {
      fireEvent.press(await screen.findByTestId('wtp-shutter'));
    });

    // The theater (or the reveal, on fast test timings) plays while the API
    // call runs; the result panel lands with the top match as the hero.
    await waitFor(
      () => {
        expect(screen.getByTestId('wtp-result-hero-name').props.children).toBe('Pikachu');
      },
      { timeout: 4000 },
    );

    // The selfie traveled inline as base64 (from the mocked capture pipeline)
    // with the extracted palette.
    expect(whosThatPokemon).toHaveBeenCalledTimes(1);
    const payload = whosThatPokemon.mock.calls[0][0];
    expect(payload.jpegBase64).toBe('bW9jay1zY2FuLWJhc2U2NA==');
    expect(payload.width).toBeGreaterThan(0);
    expect(payload.height).toBeGreaterThan(0);
    expect(Array.isArray(payload.palette)).toBe(true);
    expect(payload.palette?.length ?? 0).toBeGreaterThanOrEqual(3);

    // The other two matches render as alternate rows.
    expect(screen.getByTestId('wtp-result-alternate-1')).toBeTruthy();
    expect(screen.getByTestId('wtp-result-alternate-2')).toBeTruthy();

    // The backend returned a person cutout → the morph renders the shape arc:
    // the dark stage, the palette glow, and BOTH silhouettes (yours and the
    // species') that the transformation crossfades between.
    expect(screen.getByTestId('wtp-result-morph-backdrop')).toBeTruthy();
    expect(screen.getByTestId('wtp-result-morph-glow')).toBeTruthy();
    expect(screen.getByTestId('wtp-result-morph-person-shape')).toBeTruthy();
    expect(screen.getByTestId('wtp-result-morph-species-shape')).toBeTruthy();

    // The cutout is a silhouette SOURCE only — it must never be drawn as a
    // photo, which is what made the morph look like two copies of the user.
    expect(screen.queryByTestId('wtp-result-morph-cutout')).toBeNull();
  });

  it('walks the same phases when the backend attaches segmentation geometry', async () => {
    // The lock-on prefers the real head box and settles the landmark points on
    // the species outline; with both present the screen must still land on the
    // result, and with neither (every other test here) it must too.
    const whosThatPokemon = jest.fn(async (_payload: WhosThatPokemonPayload) => ({
      ...mockMatches,
      headBox: { x: 0.34, y: 0.08, width: 0.3, height: 0.24 },
      personBounds: { x: 0.2, y: 0.05, width: 0.6, height: 0.9 },
      speciesOutline: Array.from({ length: 48 }, (_, index) => {
        const angle = (index / 48) * Math.PI * 2;
        return { x: 0.5 + Math.cos(angle) * 0.4, y: 0.5 + Math.sin(angle) * 0.4 };
      }),
    }));
    const repository = createTestSpotlightRepository({ whosThatPokemon });

    renderScreen(repository);

    await act(async () => {
      fireEvent.press(await screen.findByTestId('wtp-shutter'));
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('wtp-result-hero-name').props.children).toBe('Pikachu');
      },
      { timeout: 4000 },
    );
  });

  it('shows the friendly retry state when the match fails, then recovers on retry', async () => {
    const whosThatPokemon = jest
      .fn(async (_payload: WhosThatPokemonPayload) => mockMatches)
      .mockRejectedValueOnce(new Error('backend offline'));
    const repository = createTestSpotlightRepository({ whosThatPokemon });

    renderScreen(repository);

    await act(async () => {
      fireEvent.press(await screen.findByTestId('wtp-shutter'));
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('wtp-error')).toBeTruthy();
      },
      { timeout: 4000 },
    );

    await act(async () => {
      fireEvent.press(screen.getByTestId('wtp-error-retry'));
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('wtp-result-hero-name').props.children).toBe('Pikachu');
      },
      { timeout: 4000 },
    );

    // The retry reused the captured selfie — no second camera capture needed.
    expect(whosThatPokemon).toHaveBeenCalledTimes(2);
  });

  it('requests the server-composed share card when Share is pressed on the result', async () => {
    const whosThatPokemon = jest.fn(async () => mockMatches);
    const whosThatShareCard = jest.fn(async () => mockShareCard);
    const repository = createTestSpotlightRepository({ whosThatPokemon, whosThatShareCard });

    renderScreen(repository);

    await act(async () => {
      fireEvent.press(await screen.findByTestId('wtp-shutter'));
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('wtp-result-share')).toBeTruthy();
      },
      { timeout: 4000 },
    );

    await act(async () => {
      fireEvent.press(screen.getByTestId('wtp-result-share'));
    });

    await waitFor(() => {
      expect(whosThatShareCard).toHaveBeenCalledTimes(1);
    });
    expect(whosThatShareCard).toHaveBeenCalledWith(
      expect.objectContaining({
        jpegBase64: 'bW9jay1zY2FuLWJhc2U2NA==',
        species: 'Pikachu',
        pokedexId: 25,
        confidence: 0.92,
      }),
    );

    // The PNG was written to the cache dir and handed to the share sheet.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const legacyFs = require('expo-file-system/legacy');
    await waitFor(() => {
      expect(legacyFs.writeAsStringAsync).toHaveBeenCalledWith(
        'file:///mock-cache/whos-that-pokemon.png',
        'cG5nLWJ5dGVz',
        { encoding: 'base64' },
      );
    });
    await waitFor(() => {
      expect(mockShareAsync).toHaveBeenCalled();
    });
  });

  it('resets back to the capture phase from Try again', async () => {
    const whosThatPokemon = jest.fn(async () => mockMatches);
    const repository = createTestSpotlightRepository({ whosThatPokemon });

    renderScreen(repository);

    await act(async () => {
      fireEvent.press(await screen.findByTestId('wtp-shutter'));
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('wtp-result-try-again')).toBeTruthy();
      },
      { timeout: 4000 },
    );

    await act(async () => {
      fireEvent.press(screen.getByTestId('wtp-result-try-again'));
    });

    expect(screen.getByTestId('wtp-shutter')).toBeTruthy();
    expect(screen.queryByTestId('wtp-result')).toBeNull();
  });
});
