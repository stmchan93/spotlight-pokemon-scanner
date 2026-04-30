import { Image as ExpoImage, type ImageProps as ExpoImageProps } from 'expo-image';

export type CardImageUse = 'backdrop' | 'large' | 'small' | 'thumbnail';
export type ImagePrefetchCachePolicy = Extract<
  NonNullable<ExpoImageProps['cachePolicy']>,
  'disk' | 'memory' | 'memory-disk'
>;

export type CardImageLike = {
  [key: string]: unknown;
  imageUrl?: string | null;
  largeImageUrl?: string | null;
};

const thumbnailKeys = [
  'thumbnailImageUrl',
  'thumbnailImageURL',
  'imageThumbnailUrl',
  'imageThumbnailURL',
  'thumbnailUrl',
  'thumbnailURL',
] as const;

const smallKeys = [
  'smallImageUrl',
  'smallImageURL',
  'imageSmallUrl',
  'imageSmallURL',
] as const;

const largeKeys = [
  'largeImageUrl',
  'largeImageURL',
  'imageLargeUrl',
  'imageLargeURL',
] as const;

const keyOrderByUse: Record<CardImageUse, readonly string[]> = {
  backdrop: [...smallKeys, ...thumbnailKeys, 'imageUrl', ...largeKeys],
  large: [...largeKeys, 'imageUrl', ...smallKeys, ...thumbnailKeys],
  small: [...smallKeys, ...thumbnailKeys, 'imageUrl', ...largeKeys],
  thumbnail: [...thumbnailKeys, ...smallKeys, 'imageUrl', ...largeKeys],
};

function normalizedUrl(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getCardImageUrl(card: CardImageLike | null | undefined, use: CardImageUse) {
  if (!card) {
    return null;
  }

  const fields = card as Record<string, unknown>;
  for (const key of keyOrderByUse[use]) {
    const value = normalizedUrl(fields[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

export function getCardImageSource(card: CardImageLike | null | undefined, use: CardImageUse) {
  const uri = getCardImageUrl(card, use);
  return uri ? { uri } : null;
}

function prefetchableUrl(value: string | null) {
  return value && /^https?:\/\//i.test(value) ? value : null;
}

export async function prefetchImageUrls(
  urls: readonly (string | null | undefined)[],
  cachePolicy: ImagePrefetchCachePolicy = 'memory-disk',
) {
  const uniqueUrls = [
    ...new Set(
      urls
        .map((url) => prefetchableUrl(url ?? null))
        .filter((url): url is string => Boolean(url)),
    ),
  ];
  if (uniqueUrls.length === 0) {
    return false;
  }

  try {
    return await ExpoImage.prefetch(uniqueUrls, cachePolicy);
  } catch {
    return false;
  }
}

export function prefetchCardImages(
  cards: readonly (CardImageLike | null | undefined)[],
  use: CardImageUse = 'thumbnail',
  cachePolicy: ImagePrefetchCachePolicy = 'memory-disk',
) {
  return prefetchImageUrls(cards.map((card) => getCardImageUrl(card, use)), cachePolicy);
}
