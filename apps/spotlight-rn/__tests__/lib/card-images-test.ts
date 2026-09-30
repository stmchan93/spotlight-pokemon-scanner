import { Image as ExpoImage } from 'expo-image';

import {
  getCardImageUrl,
  prefetchCardImages,
  prefetchImageUrls,
} from '@/lib/card-images';

describe('card image helpers', () => {
  beforeEach(() => {
    jest.mocked(ExpoImage.prefetch).mockClear();
  });

  it('keeps large images for hero views and prefers smaller sources for thumbnail/backdrop views', () => {
    const card = {
      imageUrl: 'https://cdn.spotlight.test/card-default.png',
      imageSmallURL: 'https://cdn.spotlight.test/card-small.png',
      largeImageUrl: 'https://cdn.spotlight.test/card-large.png',
      thumbnailImageUrl: 'https://cdn.spotlight.test/card-thumb.png',
    };

    expect(getCardImageUrl(card, 'large')).toBe('https://cdn.spotlight.test/card-large.png');
    expect(getCardImageUrl(card, 'small')).toBe('https://cdn.spotlight.test/card-small.png');
    expect(getCardImageUrl(card, 'thumbnail')).toBe('https://cdn.spotlight.test/card-thumb.png');
    expect(getCardImageUrl(card, 'backdrop')).toBe('https://cdn.spotlight.test/card-small.png');
  });

  it('prefers an owned alt-art printing image over the card image for every use', () => {
    const entry = {
      imageUrl: 'https://cdn.spotlight.test/card-default.png',
      smallImageUrl: 'https://cdn.spotlight.test/card-small.png',
      largeImageUrl: 'https://cdn.spotlight.test/card-large.png',
      printingImageUrl: 'https://cdn.spotlight.test/printing-large.png',
      printingImageSmallUrl: 'https://cdn.spotlight.test/printing-small.png',
    };

    expect(getCardImageUrl(entry, 'large')).toBe('https://cdn.spotlight.test/printing-large.png');
    expect(getCardImageUrl(entry, 'small')).toBe('https://cdn.spotlight.test/printing-small.png');
    expect(getCardImageUrl(entry, 'thumbnail')).toBe('https://cdn.spotlight.test/printing-small.png');
    expect(getCardImageUrl(entry, 'backdrop')).toBe('https://cdn.spotlight.test/printing-small.png');
    // Only the large printing image: small uses fall back to it, not the base art.
    expect(getCardImageUrl({ ...entry, printingImageSmallUrl: undefined }, 'small'))
      .toBe('https://cdn.spotlight.test/printing-large.png');
  });

  it('falls back to the current imageUrl contract until small or thumbnail props are available', () => {
    expect(getCardImageUrl({
      imageUrl: 'https://cdn.spotlight.test/card-default.png',
    }, 'thumbnail')).toBe('https://cdn.spotlight.test/card-default.png');
  });

  it('prefetches unique remote card thumbnail URLs with a memory-disk cache policy', async () => {
    await expect(prefetchCardImages([
      {
        imageUrl: 'https://cdn.spotlight.test/card-large.png',
        thumbnailImageUrl: 'https://cdn.spotlight.test/card-thumb.png',
      },
      {
        imageUrl: 'https://cdn.spotlight.test/card-large.png',
        thumbnailImageUrl: 'https://cdn.spotlight.test/card-thumb.png',
      },
      {
        imageUrl: 'file:///local-card.png',
      },
    ])).resolves.toBe(true);

    expect(ExpoImage.prefetch).toHaveBeenCalledWith(
      ['https://cdn.spotlight.test/card-thumb.png'],
      'memory-disk',
    );
  });

  it('does not ask Expo Image to prefetch when there are no remote URLs', async () => {
    await expect(prefetchImageUrls(['file:///local-card.png', null])).resolves.toBe(false);

    expect(ExpoImage.prefetch).not.toHaveBeenCalled();
  });
});
