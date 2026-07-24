import { type ComponentProps } from 'react';
import { StyleSheet } from 'react-native';

import { CachedImage } from '@/components/cached-image';

type SelfieImageProps = ComponentProps<typeof CachedImage>;

/**
 * The front camera saves its still un-mirrored (its true orientation), which
 * reads "reversed" next to the live mirror preview the user posed against.
 * SelfieImage flips it horizontally for DISPLAY only — the match/share payload
 * (`jpegBase64`) is a separate read of the original file and is left untouched.
 *
 * Use it everywhere a captured selfie — or its backend person-cutout, so the
 * morph stays consistent — is shown to the user.
 */
export function SelfieImage({ style, ...props }: SelfieImageProps) {
  return <CachedImage style={[style, styles.mirror]} {...props} />;
}

const styles = StyleSheet.create({
  mirror: {
    transform: [{ scaleX: -1 }],
  },
});
