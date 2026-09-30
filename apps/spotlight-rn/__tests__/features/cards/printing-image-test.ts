import type { CatalogSearchResult } from '@spotlight/api-client';

import {
  candidateImageForPrinting,
  cardNumberWithVersion,
  matchedVariantImageEnabled,
  printingImageFor,
  printingImagesForCandidate,
  resetMatchedVariantImageFlagForTests,
  versionLabelForPrinting,
} from '@/features/cards/printing-image';
import { cardDetailPreviewFromCatalogResult } from '@/features/cards/card-detail-preview-session';

const candidate = {
  id: 'boa',
  cardId: 'onepiece~op01-078',
  name: 'Boa Hancock',
  cardNumber: '#OP01-078',
  setName: 'Romance Dawn',
  imageUrl: 'https://img/boa.png',
  smallImageUrl: 'https://img/boa-small.png',
  matchedVariant: { label: 'Alt Art', tcgplayerProductId: '453505', imageUrl: null, source: 'tcgplayer' },
} as CatalogSearchResult;
const versionImage = 'https://tcgplayer-cdn.tcgplayer.com/product/453505_in_1000x1000.jpg';

describe('printing images', () => {
  const originalFlag = process.env.EXPO_PUBLIC_SPOTLIGHT_SHOW_MATCHED_VARIANT_IMAGE;
  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.EXPO_PUBLIC_SPOTLIGHT_SHOW_MATCHED_VARIANT_IMAGE;
    } else {
      process.env.EXPO_PUBLIC_SPOTLIGHT_SHOW_MATCHED_VARIANT_IMAGE = originalFlag;
    }
    resetMatchedVariantImageFlagForTests();
  });

  it('shows the matched version by default and can be switched off', () => {
    delete process.env.EXPO_PUBLIC_SPOTLIGHT_SHOW_MATCHED_VARIANT_IMAGE;
    resetMatchedVariantImageFlagForTests();
    expect(matchedVariantImageEnabled()).toBe(true);

    process.env.EXPO_PUBLIC_SPOTLIGHT_SHOW_MATCHED_VARIANT_IMAGE = '0';
    resetMatchedVariantImageFlagForTests();
    expect(matchedVariantImageEnabled()).toBe(false);
    expect(candidateImageForPrinting(candidate, null)).toBe('https://img/boa.png');
  });

  it('picks the image per printing', () => {
    expect(candidateImageForPrinting(candidate, null)).toBe(versionImage);
    expect(candidateImageForPrinting(candidate, 'alt  art')).toBe(versionImage);
    expect(candidateImageForPrinting(candidate, 'Normal')).toBe('https://img/boa.png');
    expect(candidateImageForPrinting(candidate, 'Normal', { preferSmall: true })).toBe('https://img/boa-small.png');
    expect(candidateImageForPrinting({ ...candidate, matchedVariant: null }, null)).toBe('https://img/boa.png');
  });

  it('names the version only while it is shown', () => {
    expect(versionLabelForPrinting(candidate, null)).toBe('Alt Art');
    expect(versionLabelForPrinting(candidate, 'Normal')).toBeNull();
    expect(cardNumberWithVersion(candidate.cardNumber, 'Alt Art')).toBe('#OP01-078 · Alt Art');
    expect(cardNumberWithVersion('OP01-078', null)).toBe('#OP01-078');
    expect(cardNumberWithVersion('', null)).toBeNull();
  });

  it('carries the version image into the card page preview', () => {
    expect(printingImagesForCandidate(candidate)).toEqual([{ label: 'Alt Art', imageUrl: versionImage }]);
    const preview = cardDetailPreviewFromCatalogResult(candidate);
    expect(printingImageFor(preview.printingImages, 'Alt Art')).toBe(versionImage);
    expect(printingImageFor(preview.printingImages, 'Normal')).toBeNull();
    expect('printingImages' in cardDetailPreviewFromCatalogResult({ ...candidate, matchedVariant: null })).toBe(false);
  });

  it('switches to an art-changing printing the scan did not match', () => {
    const altArt = 'https://tcgplayer-cdn.tcgplayer.com/product/693257_in_1000x1000.jpg';
    const altArtSmall = 'https://tcgplayer-cdn.tcgplayer.com/product/693257_400w.jpg';
    const luffy = {
      ...candidate,
      matchedVariant: null,
      printingImages: [{ label: 'Alt Art', imageUrl: altArt, smallImageUrl: altArtSmall }],
    } as CatalogSearchResult;
    expect(candidateImageForPrinting(luffy, null)).toBe('https://img/boa.png');
    expect(candidateImageForPrinting(luffy, 'Foil')).toBe('https://img/boa.png');
    expect(candidateImageForPrinting(luffy, 'Alt Art')).toBe(altArt);
    expect(candidateImageForPrinting(luffy, 'Alt Art', { preferSmall: true })).toBe(altArtSmall);
    expect(versionLabelForPrinting(luffy, 'alt art')).toBe('Alt Art');
    expect(versionLabelForPrinting(luffy, 'Foil')).toBeNull();
    expect(printingImagesForCandidate(luffy)).toEqual([{ label: 'Alt Art', imageUrl: altArt }]);
  });
});
