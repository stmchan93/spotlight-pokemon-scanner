import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import type {
  WhosThatPokemonPayload,
  WhosThatPokemonResult,
  WhosThatShareCardResult,
} from '@spotlight/api-client';

import { WhosThatPokemonScreen } from '@/features/whos-that-pokemon/screens/whos-that-pokemon-screen';
import { capturePostHogEvent } from '@/lib/observability/posthog';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('@/lib/observability/posthog', () => ({
  capturePostHogEvent: jest.fn(),
}));

const mockCapturePostHogEvent = capturePostHogEvent as jest.Mock;

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

  it('opens on the capture phase with the plain-language hint and shutter', async () => {
    renderScreen();

    expect(await screen.findByTestId('wtp-shutter')).toBeTruthy();
    // One line, and it says what the feature DOES rather than art-directing the
    // shot. The old copy ("Step back for a full-body shot…") and the privacy
    // caption under it are both gone; the selfie is still never persisted, which
    // is documented where the behaviour actually lives.
    expect(screen.getByTestId('wtp-capture-hint').props.children).toBe(
      'Take a picture of yourself to find out which Pokémon you look like!',
    );
    expect(screen.queryByTestId('wtp-privacy-caption')).toBeNull();
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

    /*
      The result HOLDS STILL. It used to replay the whole transformation on an
      endless loop; you have already watched the evolution once at full size on
      the way here, and a card that never stops moving is noise the moment you
      have read it. The before/after row below still carries the comparison the
      loop was really for, and it does not move.
    */
    expect(screen.getByTestId('wtp-result-hero-artwork')).toBeTruthy();
    expect(screen.queryByTestId('wtp-result-morph-backdrop')).toBeNull();
    expect(screen.queryByTestId('wtp-result-morph-person-shape')).toBeNull();
    expect(screen.queryByTestId('wtp-result-morph-species-shape')).toBeNull();
    // The still comparison stays.
    expect(screen.getByTestId('wtp-result-compare')).toBeTruthy();
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

  /*
    THE MIRROR BUG — "when taking a photo of myself it got mirrored, it should
    just take it as is."

    `selfie-image.tsx` already answered that sentence once by removing a
    display-side flip; the pixels were still arriving mirrored. vision-camera's
    `mirrorMode` defaults to `'auto'`, which mirrors selfie cameras and records
    it on the still as an EXIF flag — the SAME flag that carries the rotation.
    So the mirror gets baked exactly where the rotation gets baked: in pass 1,
    on the platform whose manipulator applies EXIF (iOS). Pass 2 rebuilds from
    the original and drops the EXIF wholesale, mirror included.

    Hence: cancel it in pass 1, and nowhere else. Undoing it in both places is
    a double flip, which is the same bug wearing the opposite sign.
  */
  it('cancels the front camera mirror in the pass that bakes it, and only there', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { usePhotoOutput } = require('react-native-vision-camera') as {
      usePhotoOutput: () => { capturePhoto: jest.Mock };
    };
    usePhotoOutput().capturePhoto.mockResolvedValueOnce({
      width: 1080,
      height: 1620,
      // A portrait-locked app against a landscape sensor: always a quarter turn,
      // which is what makes "did pass 1 apply the EXIF?" answerable at all.
      orientation: 'right',
      isMirrored: true,
      saveToTemporaryFileAsync: jest.fn(async () => '/mock-scan.jpg'),
      dispose: jest.fn(() => {}),
    });

    const whosThatPokemon = jest.fn(async (_payload: WhosThatPokemonPayload) => mockMatches);
    renderScreen(createTestSpotlightRepository({ whosThatPokemon }));

    await act(async () => {
      fireEvent.press(await screen.findByTestId('wtp-shutter'));
    });
    await waitFor(
      () => {
        expect(whosThatPokemon).toHaveBeenCalledTimes(1);
      },
      { timeout: 4000 },
    );

    const { manipulateAsync } = imageManipulatorMock();
    // Pass 1 carries the flip, which on iOS composes AFTER the module's own
    // fix-orientation transformer — the ordering the cancellation depends on.
    expect(manipulateAsync.mock.calls[0][1]).toEqual([{ flip: 'horizontal' }]);

    /*
      Pass 2 runs here because the mock's dimensions never come back upright —
      the Android shape, where pass 1 did nothing and its flipped output is
      discarded unread. It rebuilds from the ORIGINAL, so re-flipping would
      mirror an image whose mirror flag was never applied.
    */
    expect(manipulateAsync).toHaveBeenCalledTimes(2);
    expect(manipulateAsync.mock.calls[1][0]).toBe(RAW_CAPTURE_URI);
    expect(manipulateAsync.mock.calls[1][1]).toEqual([{ rotate: -90 }]);
  });

  it('leaves a capture the camera never mirrored alone', async () => {
    // The back camera, and any front camera the platform declines to mirror.
    // `isMirrored` is the only signal — never assume the position.
    const whosThatPokemon = jest.fn(async (_payload: WhosThatPokemonPayload) => mockMatches);
    renderScreen(createTestSpotlightRepository({ whosThatPokemon }));

    await act(async () => {
      fireEvent.press(await screen.findByTestId('wtp-shutter'));
    });
    await waitFor(
      () => {
        expect(whosThatPokemon).toHaveBeenCalledTimes(1);
      },
      { timeout: 4000 },
    );

    expect(imageManipulatorMock().manipulateAsync.mock.calls[0][1]).toEqual([]);
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

  /*
    ─────────────────────────────────────────────────────────────────────────
    THE CAMERA SURVIVES EVERY PHASE, INCLUDING "TRY AGAIN".
    ─────────────────────────────────────────────────────────────────────────
    It used to be rendered inside the capture phase, so each phase change tore
    the native session down and the next rebuilt it — and result → capture, the
    "Try again" path, hard-crashed the app on iOS.

    `raw-scanner-capture-surface.tsx` had already found and fixed exactly this:
    conditionally mounting the camera "reliably hard-crashed the app on the
    portfolio->scanner return", and the answer was vision-camera's documented
    mount-once / toggle-`isActive` pattern.

    The test above walks the same route and passed straight through the bug,
    because a crash in the native session is invisible to jest. So this asserts
    the STRUCTURE instead — the one node whose continuous existence is the
    whole fix — which is checkable without a camera.
  */
  it('keeps the camera mounted across every phase, and never remounts it on Try again', async () => {
    const whosThatPokemon = jest.fn(async () => mockMatches);
    const repository = createTestSpotlightRepository({ whosThatPokemon });

    renderScreen(repository);

    const cameraAtStart = await screen.findByTestId('wtp-camera');
    expect(cameraAtStart.props.isActive).toBe(true);

    await act(async () => {
      fireEvent.press(await screen.findByTestId('wtp-shutter'));
    });
    await waitFor(
      () => {
        expect(screen.getByTestId('wtp-result-try-again')).toBeTruthy();
      },
      { timeout: 4000 },
    );

    // Still mounted while the result is up — just stopped. This is the
    // assertion that fails if anyone puts <Camera> back inside a phase.
    const cameraOnResult = screen.getByTestId('wtp-camera');
    expect(cameraOnResult).toBeTruthy();
    expect(cameraOnResult.props.isActive).toBe(false);

    await act(async () => {
      fireEvent.press(screen.getByTestId('wtp-result-try-again'));
    });

    const cameraAfterRetry = screen.getByTestId('wtp-camera');
    expect(cameraAfterRetry.props.isActive).toBe(true);
    // The session was re-activated, not rebuilt: one continuous camera.
    expect(screen.getAllByTestId('wtp-camera')).toHaveLength(1);
  });

  /*
    ───────────────────────────────────────────────────────────────────────────
    THE SELFIE MUST NOT LEAK INTO TELEMETRY.
    ───────────────────────────────────────────────────────────────────────────
    Selfies are never persisted — that is a product guarantee, and analytics is
    the obvious place for it to be quietly broken, because adding one more
    property to an event never feels like storing a photo.

    This asserts the guarantee against EVERY property of EVERY event the screen
    sends, rather than against the three call sites as written, so a future
    event added to this file is covered the day it is written.

    The check is deliberately in two parts: no value may contain the image or
    its file URI, and no KEY may be one of the face-derived signals the screen
    holds (`palette`, `headBox`, `personOutline`, `speciesOutline`). The second
    part is the one that matters — a dominant-colour palette of a picture of a
    person carries more about them than it looks like it does.
  */
  it('never puts the selfie, its URI, or anything derived from the face into an event', async () => {
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
      expect(mockShareAsync).toHaveBeenCalled();
    });

    // The run really happened, so the assertions below are not vacuous.
    const eventNames = mockCapturePostHogEvent.mock.calls.map(([name]) => name);
    expect(eventNames).toEqual(
      expect.arrayContaining(['whos_that_started', 'whos_that_completed', 'whos_that_shared']),
    );

    const forbiddenKeys = ['palette', 'headBox', 'personOutline', 'speciesOutline', 'selfie'];
    mockCapturePostHogEvent.mock.calls.forEach(([name, properties]) => {
      const serialized = JSON.stringify(properties ?? {});
      expect(serialized).not.toContain(RAW_CAPTURE_BASE64);
      expect(serialized).not.toContain(UPRIGHT_BASE64);
      expect(serialized).not.toContain(RAW_CAPTURE_URI);
      expect(serialized).not.toContain('data:image');
      expect(serialized).not.toContain('file://');
      forbiddenKeys.forEach((key) => {
        expect(Object.keys((properties ?? {}) as Record<string, unknown>)).not.toContain(key);
      });
      // The species IS allowed to travel — it is a game outcome, and the only
      // way to notice the model returning one answer for every face.
      if (name === 'whos_that_completed') {
        expect(properties).toEqual(expect.objectContaining({ matched: true, pokemon: 'Pikachu' }));
      }
    });
  });
});
