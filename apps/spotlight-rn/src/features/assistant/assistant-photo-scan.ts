// SDK 55: file APIs only from the /legacy entry (the new one throws at runtime).
import { deleteAsync, readAsStringAsync } from 'expo-file-system/legacy';

import type {
  CardGame,
  CatalogSearchResult,
  ScannerCapturePayload,
  SpotlightRepository,
} from '@spotlight/api-client';

import { loadNativeImagePicker } from '@/lib/native-image-picker';

/*
  "Photo in chat": the composer's + takes or picks a photo of ONE card, crops
  it to the scanner's normalized card size and runs it through the same raw
  visual match the scanner uses. Only the confirmed card id goes to the
  assistant, never the image. The cropped JPEG stays in the cache dir for the
  bubble thumbnail and is deleted when the chat closes.

  Raw lane only: the slab lane needs on-device label OCR the picker path
  doesn't have. A slab photo still matches the card inside it.
*/

export type AssistantPhotoSource = 'camera' | 'library';

/** The scanner's normalized raw-card crop (630x880, 5:7). */
export const ASSISTANT_PHOTO_WIDTH = 630;
export const ASSISTANT_PHOTO_HEIGHT = 880;
/** Matches offered in the picker: the top 10, best first (owner, 2026-11-22). */
export const ASSISTANT_PHOTO_MAX_CANDIDATES = 10;
const CROP_COMPRESS = 0.82;
/** Recorded as the scan's capture_source so chat photos never pass for camera scans. */
export const ASSISTANT_PHOTO_CAPTURE_SOURCE = 'assistant_photo';

export type AssistantPhotoPickResult =
  | { kind: 'picked'; uri: string; width: number; height: number }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' }
  | { kind: 'denied' };

/** A photo the scanner identified: the crop on disk plus the top candidates. */
export type AssistantPhotoMatch = {
  photoUri: string;
  candidates: CatalogSearchResult[];
};

/** What a sent message carries: the confirmed card + the local thumbnail. */
export type AssistantPhotoAttachment = {
  photoUri: string;
  cardId: string;
  label: string;
};

/** "Charizard · Base Set 4/102" */
export function assistantPhotoCardLabel(card: Pick<CatalogSearchResult, 'name' | 'setName' | 'cardNumber'>): string {
  const number = (card.cardNumber ?? '').replace(/^#/, '').trim();
  const where = [card.setName?.trim(), number].filter(Boolean).join(' ');
  return where ? `${card.name} · ${where}` : card.name;
}

/**
 * The largest centred 5:7 rect in a width x height image. The picker's crop
 * step frames the card; on iOS that crop is square, so this trims the sides
 * back to the card's own shape.
 */
export function centeredCardCrop(width: number, height: number) {
  const ratio = ASSISTANT_PHOTO_WIDTH / ASSISTANT_PHOTO_HEIGHT;
  let cropWidth = width;
  let cropHeight = height;
  if (width / height > ratio) {
    cropWidth = height * ratio;
  } else {
    cropHeight = width / ratio;
  }
  const w = Math.max(1, Math.floor(cropWidth));
  const h = Math.max(1, Math.floor(cropHeight));
  return {
    originX: Math.max(0, Math.floor((width - w) / 2)),
    originY: Math.max(0, Math.floor((height - h) / 2)),
    width: w,
    height: h,
  };
}

/** Opens the camera or the photo library with a crop step. Never throws. */
export async function pickAssistantPhoto(source: AssistantPhotoSource): Promise<AssistantPhotoPickResult> {
  const ImagePicker = loadNativeImagePicker();
  const launch = source === 'camera' ? ImagePicker?.launchCameraAsync : ImagePicker?.launchImageLibraryAsync;
  if (!ImagePicker || typeof launch !== 'function') {
    return { kind: 'unavailable' };
  }
  const permission = source === 'camera'
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (permission?.granted === false) {
    return { kind: 'denied' };
  }
  const result = await launch({
    // The crop step is how the user frames ONE card: there is no card detector.
    // Android honours the 5:7 aspect; iOS always crops square.
    allowsEditing: true,
    aspect: [5, 7],
    mediaTypes: ['images'],
    quality: 1,
  });
  const asset = result?.canceled ? null : result?.assets?.[0];
  if (!asset?.uri) {
    return { kind: 'cancelled' };
  }
  return {
    kind: 'picked',
    uri: asset.uri,
    width: asset.width ?? 0,
    height: asset.height ?? 0,
  };
}

type ImageManipulatorModule = {
  manipulateAsync: (
    uri: string,
    actions?: unknown[],
    saveOptions?: { base64?: boolean; compress?: number; format?: string },
  ) => Promise<{ uri: string; width: number; height: number }>;
  SaveFormat?: { JPEG: string };
};

function loadImageManipulator(): ImageManipulatorModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module, same guard as the other photo screens
    return require('expo-image-manipulator') as ImageManipulatorModule;
  } catch {
    return null;
  }
}

export function deleteAssistantPhoto(uri: string | null | undefined) {
  if (uri && uri.startsWith('file:')) {
    void deleteAsync(uri, { idempotent: true }).catch(() => undefined);
  }
}

/**
 * Centred 5:7 crop resized to 630x880, as a new cache JPEG. The picker's crop
 * step already wrote upright pixels on both platforms (iOS's manipulator also
 * applies any EXIF itself), so no rotation here.
 */
export async function cropAssistantPhoto(
  picked: Extract<AssistantPhotoPickResult, { kind: 'picked' }>,
): Promise<string | null> {
  const manipulator = loadImageManipulator();
  if (!manipulator?.manipulateAsync) {
    return null;
  }
  const format = manipulator.SaveFormat?.JPEG ?? 'jpeg';
  try {
    const upright = await manipulator.manipulateAsync(picked.uri, [], { format });
    if (!upright?.uri || upright.width <= 0 || upright.height <= 0) {
      return null;
    }
    const cropped = await manipulator.manipulateAsync(
      upright.uri,
      [
        { crop: centeredCardCrop(upright.width, upright.height) },
        { resize: { width: ASSISTANT_PHOTO_WIDTH, height: ASSISTANT_PHOTO_HEIGHT } },
      ],
      { compress: CROP_COMPRESS, format },
    );
    deleteAssistantPhoto(upright.uri);
    return cropped?.uri ?? null;
  } catch {
    return null;
  }
}

async function readAsBase64(fileUri: string): Promise<string | null> {
  try {
    return (await readAsStringAsync(fileUri, { encoding: 'base64' })) || null;
  } catch {
    return null;
  }
}

/** The raw visual-match payload for a chat photo: no training artifact (no normalizedImage). */
export function assistantPhotoScanPayload(photoUri: string, game: CardGame | null | undefined): ScannerCapturePayload {
  return {
    mode: 'raw',
    game: game ?? 'pokemon',
    fileUri: photoUri,
    width: ASSISTANT_PHOTO_WIDTH,
    height: ASSISTANT_PHOTO_HEIGHT,
    captureSource: ASSISTANT_PHOTO_CAPTURE_SOURCE,
    submittedAt: new Date().toISOString(),
    readFileAsBase64: readAsBase64,
  };
}

/** Match a cropped chat photo with the scanner's raw lane; the top few cards, best first. */
export async function identifyAssistantPhoto(
  repository: Pick<SpotlightRepository, 'matchScannerCapture'>,
  photoUri: string,
  game: CardGame | null | undefined,
): Promise<CatalogSearchResult[]> {
  const result = await repository.matchScannerCapture(assistantPhotoScanPayload(photoUri, game));
  const seen = new Set<string>();
  return result.candidates
    .filter((card) => card.cardId && !seen.has(card.cardId) && seen.add(card.cardId))
    .slice(0, ASSISTANT_PHOTO_MAX_CANDIDATES);
}
