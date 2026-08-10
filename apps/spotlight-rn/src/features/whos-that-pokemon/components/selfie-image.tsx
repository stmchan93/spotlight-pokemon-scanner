import { type ComponentProps } from 'react';
import { CachedImage } from '@/components/cached-image';

type SelfieImageProps = ComponentProps<typeof CachedImage>;

/**
 * The captured selfie, shown in its TRUE orientation.
 *
 * This used to flip horizontally on the theory that the front camera saves
 * un-mirrored and that reads "reversed" against the live preview. In practice
 * the flip is what reads as wrong — reported as "the photo is mirrored, it
 * should not be" — and it also put the displayed photo out of step with the
 * silhouette traced from it, so your outline did not match your body.
 *
 * The mirror is now gone on BOTH sides: here, and `mirrorPerson` in
 * `outline-morph`. They have to move together — mirroring one and not the
 * other is exactly the mismatch being fixed — so if this ever comes back,
 * change both.
 *
 * Kept as a named component rather than inlined so "where is the selfie
 * drawn" stays answerable, and so the two sides keep one obvious pairing.
 */
export function SelfieImage({ style, ...props }: SelfieImageProps) {
  return <CachedImage style={style} {...props} />;
}
