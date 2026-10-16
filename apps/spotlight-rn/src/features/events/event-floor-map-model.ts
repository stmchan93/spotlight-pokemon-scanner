import type { SpotlightEventMap, SpotlightEventMapTable, SpotlightEventMapVendor } from '@spotlight/api-client';

export type MapTransform = { scale: number; translateX: number; translateY: number };

export const MAP_MIN_SCALE = 1;
export const MAP_MAX_SCALE = 4;
/** Fitting a vendor never zooms past this; one table at max scale fills the screen. */
const FIT_MAX_SCALE = 3.5;
/** Fraction of the viewport a fitted vendor's tables may cover. */
const FIT_FILL = 0.5;
/** Tables are a few points wide at 1x; widen the tap target in screen points. */
const TAP_SLOP = 10;

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Name, location ("C14") or tag; a selected tag chip must also match. */
export function filterVendors(
  vendors: readonly SpotlightEventMapVendor[],
  query: string,
  tag: string | null,
): SpotlightEventMapVendor[] {
  const needle = normalize(query.trim());
  return vendors.filter((vendor) => {
    if (tag && !vendor.tags.includes(tag)) {
      return false;
    }
    if (!needle) {
      return true;
    }
    return (
      normalize(vendor.name).includes(needle) ||
      normalize(vendor.location).includes(needle) ||
      vendor.tags.some((item) => normalize(item).includes(needle))
    );
  });
}

export function vendorForTable(
  vendors: readonly SpotlightEventMapVendor[],
  tableId: string,
): SpotlightEventMapVendor | null {
  return vendors.find((vendor) => vendor.tableIds.includes(tableId)) ?? null;
}

/** Map content is the image fitted ("contain") into the viewport at scale 1. */
export function contentSize(map: Pick<SpotlightEventMap, 'imageWidth' | 'imageHeight'>, viewportWidth: number, viewportHeight: number) {
  const fit = Math.min(viewportWidth / map.imageWidth, viewportHeight / map.imageHeight);
  return { width: map.imageWidth * fit, height: map.imageHeight * fit };
}

function clampAxis(translate: number, size: number, viewport: number): number {
  'worklet';
  if (size <= viewport) {
    return (viewport - size) / 2;
  }
  return Math.min(0, Math.max(viewport - size, translate));
}

/** Keeps the content covering the viewport (or centered when smaller). Origin is the content's top-left. */
export function clampTransform(
  transform: MapTransform,
  content: { width: number; height: number },
  viewport: { width: number; height: number },
): MapTransform {
  'worklet';
  const scale = Math.min(MAP_MAX_SCALE, Math.max(MAP_MIN_SCALE, transform.scale));
  return {
    scale,
    translateX: clampAxis(transform.translateX, content.width * scale, viewport.width),
    translateY: clampAxis(transform.translateY, content.height * scale, viewport.height),
  };
}

export function restingTransform(content: { width: number; height: number }, viewport: { width: number; height: number }): MapTransform {
  return clampTransform({ scale: 1, translateX: 0, translateY: 0 }, content, viewport);
}

/** Zoom/pan so the given tables sit centered and comfortably sized. */
export function fitTablesTransform(
  tables: readonly SpotlightEventMapTable[],
  content: { width: number; height: number },
  viewport: { width: number; height: number },
): MapTransform {
  if (tables.length === 0) {
    return restingTransform(content, viewport);
  }
  const left = Math.min(...tables.map((table) => table.x)) * content.width;
  const top = Math.min(...tables.map((table) => table.y)) * content.height;
  const right = Math.max(...tables.map((table) => table.x + table.width)) * content.width;
  const bottom = Math.max(...tables.map((table) => table.y + table.height)) * content.height;
  const boxWidth = Math.max(right - left, 1);
  const boxHeight = Math.max(bottom - top, 1);
  const scale = Math.min(
    FIT_MAX_SCALE,
    Math.max(MAP_MIN_SCALE, Math.min((viewport.width * FIT_FILL) / boxWidth, (viewport.height * FIT_FILL) / boxHeight)),
  );
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  return clampTransform(
    {
      scale,
      translateX: viewport.width / 2 - centerX * scale,
      translateY: viewport.height / 2 - centerY * scale,
    },
    content,
    viewport,
  );
}

/** The table under a viewport point, nearest first within the tap slop. */
export function tableAtPoint(
  tables: readonly SpotlightEventMapTable[],
  point: { x: number; y: number },
  transform: MapTransform,
  content: { width: number; height: number },
): SpotlightEventMapTable | null {
  const contentX = (point.x - transform.translateX) / transform.scale;
  const contentY = (point.y - transform.translateY) / transform.scale;
  const slop = TAP_SLOP / transform.scale;
  let best: SpotlightEventMapTable | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const table of tables) {
    const left = table.x * content.width;
    const top = table.y * content.height;
    const right = left + table.width * content.width;
    const bottom = top + table.height * content.height;
    const dx = contentX < left ? left - contentX : contentX > right ? contentX - right : 0;
    const dy = contentY < top ? top - contentY : contentY > bottom ? contentY - bottom : 0;
    const distance = Math.hypot(dx, dy);
    if (distance <= slop && distance < bestDistance) {
      best = table;
      bestDistance = distance;
    }
  }
  return best;
}
