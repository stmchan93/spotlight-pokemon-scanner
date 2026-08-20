import { SpotlightRepositoryRequestError } from '@spotlight/api-client';

import { scannerLaneUnavailableReason } from '@/features/scanner/screens/scanner-screen-helpers';

/**
 * A game whose visual index has not been built yet makes the backend raise at
 * scan time, which reaches the client as a 500. Without this the tray row falls
 * back to "matches could not load. Please try again." and sends the user back to
 * the shutter to retry a scan that cannot succeed.
 */
describe('scannerLaneUnavailableReason', () => {
  const serverError = new SpotlightRepositoryRequestError('Visual scan match failed', 'request_failed', 500);

  it('names the lane on a server error in a non-Pokémon game', () => {
    expect(scannerLaneUnavailableReason('onepiece', serverError))
      .toBe("One Piece scanning isn't available yet. Switch lanes and try again.");
    expect(scannerLaneUnavailableReason('lorcana', serverError))
      .toBe("Disney Lorcana scanning isn't available yet. Switch lanes and try again.");
  });

  it('leaves the Pokémon failure copy untouched', () => {
    // Pokémon's index is eagerly loaded and always present, so a 500 there is a
    // real backend fault — not a lane that has yet to be built.
    expect(scannerLaneUnavailableReason('pokemon', serverError)).toBeNull();
    expect(scannerLaneUnavailableReason(undefined, serverError)).toBeNull();
  });

  it('does not blame the lane for a timeout or an offline phone', () => {
    // These carry no HTTP status. Telling a user their game is unsupported when
    // their wifi dropped is a lie they would act on.
    expect(scannerLaneUnavailableReason('gundam', new Error('Network request failed'))).toBeNull();
    expect(scannerLaneUnavailableReason(
      'gundam',
      new SpotlightRepositoryRequestError('timeout', 'request_failed'),
    )).toBeNull();
  });

  it('does not blame the lane for a client-side (4xx) failure', () => {
    expect(scannerLaneUnavailableReason(
      'riftbound',
      new SpotlightRepositoryRequestError('unauthorized', 'request_failed', 401),
    )).toBeNull();
  });
});
