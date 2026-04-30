import { Image as ExpoImage, type ImageProps as ExpoImageProps } from 'expo-image';

export type CachedImageCachePolicy = NonNullable<ExpoImageProps['cachePolicy']>;

export const imageCachePolicy = {
  backdrop: 'disk',
  full: 'disk',
  hero: 'disk',
  localPreview: 'memory-disk',
  thumbnail: 'memory-disk',
} as const satisfies Record<string, CachedImageCachePolicy>;

type CachedImageProps = Omit<ExpoImageProps, 'cachePolicy' | 'contentFit' | 'source'> & {
  cachePolicy?: CachedImageCachePolicy;
  contentFit?: ExpoImageProps['contentFit'];
  source?: ExpoImageProps['source'];
  uri?: string | null;
};

export function CachedImage({
  cachePolicy = imageCachePolicy.thumbnail,
  contentFit = 'cover',
  source,
  uri,
  ...props
}: CachedImageProps) {
  const resolvedSource = source ?? (uri ? { uri } : null);

  return (
    <ExpoImage
      cachePolicy={cachePolicy}
      contentFit={contentFit}
      source={resolvedSource}
      {...props}
    />
  );
}
