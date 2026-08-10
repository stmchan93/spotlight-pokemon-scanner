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

// The raw vision-camera capture: sensor-native orientation, EXIF flag not yet
// applied to the pixels. `expo-file-system/legacy`'s mock hands this back.
const RAW_CAPTURE_URI = 'file:///mock-scan.jpg';
const RAW_CAPTURE_BASE64 = 'bW9jay1zY2FuLWJhc2U2NA==';
// What comes back out of expo-image-manipulator — the upright, orientation-baked
// copy, which is the ONLY version the backend and the display may ever see.
const UPRIGHT_BASE64 = 'bm9ybWFsaXplZC1zY2FuLWJhc2U2NA==';

function imageManipulatorMock() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-image-manipulator') as { manipulateAsync: jest.Mock };
}

function legacyFileSystemMock() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-file-system/legacy') as {
    deleteAsync: jest.Mock;
    writeAsStringAsync: jest.Mock;
  };
}

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

    // The selfie traveled inline as base64 (from the mocked capture pipeline,
    // after the orientation bake) with the extracted palette.
    expect(whosThatPokemon).toHaveBeenCalledTimes(1);
    const payload = whosThatPokemon.mock.calls[0][0];
    expect(payload.jpegBase64).toBe(UPRIGHT_BASE64);
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
    // The lock-on prefers the real head box, and BOTH outlines together are
    // what let the reveal deform your shape into the species'. With everything
    // present the screen must still land on the result, and with none of it
    // (every other test here) it must too.
    const outline = (radiusX: number, radiusY: number) =>
      Array.from({ length: 48 }, (_, index) => {
        const angle = (index / 48) * Math.PI * 2;
        return { x: 0.5 + Math.cos(angle) * radiusX, y: 0.5 + Math.sin(angle) * radiusY };
      });
    const whosThatPokemon = jest.fn(async (_payload: WhosThatPokemonPayload) => ({
      ...mockMatches,
      headBox: { x: 0.34, y: 0.08, width: 0.3, height: 0.24 },
      personBounds: { x: 0.2, y: 0.05, width: 0.6, height: 0.9 },
      speciesOutline: outline(0.42, 0.3),
      personOutline: outline(0.16, 0.44),
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
        jpegBase64: UPRIGHT_BASE64,
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

  it('bakes the capture orientation in and sends THAT photo to the backend', async () => {
    // THE ORIENTATION BUG. vision-camera saves the still sensor-native
    // (landscape) with the rotation recorded as an EXIF flag. expo-image applies
    // that flag when it draws the photo; the backend's PIL decode does not, so
    // `personOutline` / `headBox` come back normalized against the SIDEWAYS
    // frame and the morph deforms a rotated human. Baking the rotation into the
    // pixels before anything reads the file is the fix — and it only works if
    // the base64 that travels comes from the ROTATED file.
    const whosThatPokemon = jest.fn(async (_payload: WhosThatPokemonPayload) => mockMatches);
    const repository = createTestSpotlightRepository({ whosThatPokemon });

    renderScreen(repository);

    await act(async () => {
      fireEvent.press(await screen.findByTestId('wtp-shutter'));
    });

    await waitFor(
      () => {
        expect(whosThatPokemon).toHaveBeenCalledTimes(1);
      },
      { timeout: 4000 },
    );

    // The raw capture went through the manipulator, asking for base64 back so
    // there is no second read of the original file.
    const { manipulateAsync } = imageManipulatorMock();
    expect(manipulateAsync).toHaveBeenCalledTimes(1);
    expect(manipulateAsync.mock.calls[0][0]).toBe(RAW_CAPTURE_URI);
    expect(manipulateAsync.mock.calls[0][2]).toEqual(
      expect.objectContaining({ base64: true }),
    );

    // …and the payload carries the ROTATED bytes and the ROTATED dimensions,
    // not the raw capture's. (The vision-camera mock reports the photo as
    // 1080x1620; the manipulator mock resolves the saved file at 1920x888.)
    const payload = whosThatPokemon.mock.calls[0][0];
    expect(payload.jpegBase64).toBe(UPRIGHT_BASE64);
    expect(payload.jpegBase64).not.toBe(RAW_CAPTURE_BASE64);
    expect(payload.width).toBe(1920);
    expect(payload.height).toBe(888);

    // The sideways original is a selfie sitting in the cache dir with no
    // remaining consumer — it gets dropped.
    expect(legacyFileSystemMock().deleteAsync).toHaveBeenCalledWith(
      RAW_CAPTURE_URI,
      expect.objectContaining({ idempotent: true }),
    );
  });

  it('falls back to the original capture when the image manipulator is unavailable', async () => {
    // expo-image-manipulator is a native module that can be missing from the
    // binary an OTA'd bundle is running on. A rotated selfie beats no feature.
    imageManipulatorMock().manipulateAsync.mockRejectedValueOnce(
      new Error('native module unavailable'),
    );
    const whosThatPokemon = jest.fn(async (_payload: WhosThatPokemonPayload) => mockMatches);
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

    const payload = whosThatPokemon.mock.calls[0][0];
    expect(payload.jpegBase64).toBe(RAW_CAPTURE_BASE64);
    expect(payload.width).toBe(1080);
    expect(payload.height).toBe(1620);
    // Nothing was deleted out from under the surviving capture.
    expect(legacyFileSystemMock().deleteAsync).not.toHaveBeenCalledWith(
      RAW_CAPTURE_URI,
      expect.anything(),
    );
  });

  it('pays off the evolution beat by name on the result panel', async () => {
    const whosThatPokemon = jest.fn(async () => mockMatches);
    const repository = createTestSpotlightRepository({ whosThatPokemon });

    renderScreen(repository);

    await act(async () => {
      fireEvent.press(await screen.findByTestId('wtp-shutter'));
    });

    // The test-bypass auth user is "UI Test User", so the shouting name is its
    // first token. The point of the assertion is that a REAL name reaches the
    // copy — `evolution-copy-test` covers the null-display-name accounts.
    await waitFor(
      () => {
        expect(screen.getByTestId('wtp-result-evolved-lead').props.children).toBe(
          'UI evolved into…',
        );
      },
      { timeout: 4000 },
    );
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
