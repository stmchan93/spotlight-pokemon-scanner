import { devImageUriFor, stableHash } from '@/dev/dev-image-uri';

// Five Metro asset URIs, shaped like `Image.resolveAssetSource(...).uri` in dev.
const placeholderUris = [1, 2, 3, 4, 5].map(
  (index) => `http://127.0.0.1:8081/assets/assets/dev/card-placeholder-${index}.png?platform=ios&hash=abc`,
);

// The browse grid's Pokémon mosaic fixture: sv3pt5 and sm7 both hash onto
// placeholder 3, which made `GameMosaicTile` (keyed by uri) warn about
// duplicate keys.
const logoUrls = ['sv8pt5', 'sv8', 'sv3pt5', 'sm7', 'swsh12pt5', 'base1', 'm2_ja', 'sv2a_ja'].map(
  (id) => `https://images.pokemontcg.io/${id}/logo.png`,
);

describe('devImageUriFor', () => {
  it('reproduces the placeholder collision the tag exists to disambiguate', () => {
    expect(stableHash(logoUrls[2]) % 5).toBe(stableHash(logoUrls[3]) % 5);
  });

  it('is stable for the same source URL', () => {
    expect(devImageUriFor(logoUrls[0], placeholderUris)).toBe(devImageUriFor(logoUrls[0], placeholderUris));
  });

  it('yields a distinct URI for every distinct source URL', () => {
    const uris = logoUrls.map((url) => devImageUriFor(url, placeholderUris));
    expect(new Set(uris).size).toBe(uris.length);
  });

  it('still points at a bundled placeholder, appending to the existing query', () => {
    expect(devImageUriFor(logoUrls[0], placeholderUris)).toMatch(
      /^http:\/\/127\.0\.0\.1:8081\/assets\/assets\/dev\/card-placeholder-[1-5]\.png\?platform=ios&hash=abc&dev=[0-9a-z]+$/,
    );
  });

  it('starts a query when the asset URI has none (release-style file URIs)', () => {
    expect(devImageUriFor(logoUrls[0], ['card-placeholder-1.png'])).toMatch(/^card-placeholder-1\.png\?dev=[0-9a-z]+$/);
  });
});
