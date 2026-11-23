/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk, 2000).
 *
 * Items are placed largest-first in rows along the rectangle's shorter side;
 * an item joins the current row only while that does not worsen the row's
 * worst aspect ratio. Pure and cheap: ~40 tiles lay out in well under a
 * millisecond, so it runs on render.
 */

export type TreemapRect = { x: number; y: number; width: number; height: number };

export type TreemapItem<T> = { value: number; data: T };

export type TreemapTile<T> = TreemapRect & { data: T };

type Scaled<T> = { area: number; data: T };

/** Worst (largest) aspect ratio of a row with these area stats laid along `side`. */
function worstRatio(sum: number, min: number, max: number, side: number): number {
  if (sum <= 0 || side <= 0) {
    return Infinity;
  }
  const sideSq = side * side;
  const sumSq = sum * sum;
  return Math.max((sideSq * max) / sumSq, sumSq / (sideSq * min));
}

function layoutRow<T>(row: Scaled<T>[], rect: TreemapRect, out: TreemapTile<T>[]): TreemapRect {
  const sum = row.reduce((total, item) => total + item.area, 0);
  if (rect.width >= rect.height) {
    // Wide: the row is a column down the left edge.
    const columnWidth = rect.height > 0 ? sum / rect.height : 0;
    let y = rect.y;
    for (const item of row) {
      const height = columnWidth > 0 ? item.area / columnWidth : 0;
      out.push({ x: rect.x, y, width: columnWidth, height, data: item.data });
      y += height;
    }
    return { x: rect.x + columnWidth, y: rect.y, width: Math.max(0, rect.width - columnWidth), height: rect.height };
  }
  // Tall: the row is a strip across the top.
  const rowHeight = rect.width > 0 ? sum / rect.width : 0;
  let x = rect.x;
  for (const item of row) {
    const width = rowHeight > 0 ? item.area / rowHeight : 0;
    out.push({ x, y: rect.y, width, height: rowHeight, data: item.data });
    x += width;
  }
  return { x: rect.x, y: rect.y + rowHeight, width: rect.width, height: Math.max(0, rect.height - rowHeight) };
}

/**
 * Lays `items` out inside `rect`. Non-positive and non-finite values are
 * dropped; output is in descending value order (stable for ties), tile areas
 * are proportional to value, and together they exactly fill the rect.
 */
export function squarify<T>(items: readonly TreemapItem<T>[], rect: TreemapRect): TreemapTile<T>[] {
  const valid = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => Number.isFinite(item.value) && item.value > 0)
    .sort((a, b) => b.item.value - a.item.value || a.index - b.index)
    .map(({ item }) => item);
  const total = valid.reduce((sum, item) => sum + item.value, 0);
  const area = rect.width * rect.height;
  if (valid.length === 0 || total <= 0 || !(area > 0)) {
    return [];
  }
  const scale = area / total;
  const scaled: Scaled<T>[] = valid.map((item) => ({ area: item.value * scale, data: item.data }));

  const out: TreemapTile<T>[] = [];
  let remaining = { ...rect };
  let row: Scaled<T>[] = [];
  let rowSum = 0;
  let rowMin = Infinity;
  let rowMax = 0;

  for (const item of scaled) {
    if (row.length > 0) {
      const side = Math.min(remaining.width, remaining.height);
      const current = worstRatio(rowSum, rowMin, rowMax, side);
      const next = worstRatio(rowSum + item.area, Math.min(rowMin, item.area), Math.max(rowMax, item.area), side);
      if (next <= current) {
        row.push(item);
        rowSum += item.area;
        rowMin = Math.min(rowMin, item.area);
        rowMax = Math.max(rowMax, item.area);
        continue;
      }
      remaining = layoutRow(row, remaining, out);
    }
    row = [item];
    rowSum = item.area;
    rowMin = item.area;
    rowMax = item.area;
  }
  layoutRow(row, remaining, out);
  return out;
}
