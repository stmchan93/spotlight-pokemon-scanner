import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, SLAB_FRAME_ASPECT, SlabFrame, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage } from '@/components/cached-image';

type AssistantCardArtProps = {
  imageUrl: string | null;
  /** A graded copy renders inside its grader's slab case (same SlabFrame as the Collection). */
  grader?: string | null;
  grade?: string | null;
  name?: string | null;
  setName?: string | null;
  number?: string | null;
  /** The slot; a slab fits its height and centers at the slab's narrower ratio. */
  width: number;
  height: number;
  radius: number;
  slabSize: 'sm' | 'md';
  testID?: string;
};

/** Card art for chat tiles, rows and the chart header: a plain card image, or the slab-framed one. */
export function AssistantCardArt({
  imageUrl,
  grader,
  grade,
  name,
  setName,
  number,
  width,
  height,
  radius,
  slabSize,
  testID,
}: AssistantCardArtProps) {
  const theme = useSpotlightTheme();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [imageUrl]);
  const showImage = Boolean(imageUrl) && !failed;
  const graderText = (grader ?? '').trim();

  const image = showImage ? (
    <CachedImage
      // cover inside the slab: the case's card window crops the art to its printed border.
      contentFit={graderText ? 'cover' : 'contain'}
      onError={() => setFailed(true)}
      style={styles.fill}
      testID={testID ? `${testID}-image` : undefined}
      uri={imageUrl}
    />
  ) : (
    // Same "CARD" placeholder as the inventory tile and list rows.
    <View style={[styles.placeholder, { backgroundColor: theme.colors.field }]}>
      <AppText color="textSecondary" testID={testID ? `${testID}-placeholder` : undefined} variant="micro">
        CARD
      </AppText>
    </View>
  );

  if (graderText) {
    return (
      <View style={[styles.slot, { height, width }]}>
        <View style={{ height, width: Math.round(height * SLAB_FRAME_ASPECT) }}>
          <SlabFrame
            cardNumber={number}
            grade={(grade ?? '').trim() || null}
            grader={graderText}
            setLine={setName}
            size={slabSize}
            testID={testID ? `${testID}-slab-frame` : undefined}
            title={name}
          >
            {image}
          </SlabFrame>
        </View>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.slot,
        styles.card,
        { backgroundColor: showImage ? theme.colors.gray100 : theme.colors.field, borderRadius: radius, height, width },
      ]}
    >
      {image}
    </View>
  );
}

const styles = StyleSheet.create({
  slot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    width: '100%',
  },
  placeholder: {
    alignItems: 'center',
    height: '100%',
    justifyContent: 'center',
    width: '100%',
  },
});
