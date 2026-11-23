import { squarify } from '@/features/market/lib/squarify';
import {
  HEATMAP_CLAMP_PCT,
  heatmapColor,
  heatmapIntensity,
  mixHex,
  prefersLightText,
} from '@/features/market/lib/heatmap-color';

const rect = { x: 0, y: 0, width: 600, height: 400 };
const EPS = 1e-6;

function area(tile: { width: number; height: number }) {
  return tile.width * tile.height;
}

describe('squarify', () => {
  it('reproduces the paper example (6,6,4,3,2,2,1 in 6x4)', () => {
    const values = [6, 6, 4, 3, 2, 2, 1];
    const tiles = squarify(values.map((value, index) => ({ value, data: index })), { x: 0, y: 0, width: 6, height: 4 });
    expect(tiles).toHaveLength(7);
    // First row: the two 6s stacked in a 3-wide column.
    expect(tiles[0]).toMatchObject({ x: 0, y: 0, width: 3, height: 2 });
    expect(tiles[1]).toMatchObject({ x: 0, y: 2, width: 3, height: 2 });
    tiles.forEach((tile, index) => {
      expect(area(tile)).toBeCloseTo(values[index], 6);
    });
  });

  it('fills the rect exactly with areas proportional to value', () => {
    const values = [500, 300, 200, 120, 80, 40, 30, 20, 10, 5];
    const tiles = squarify(values.map((value) => ({ value, data: value })), rect);
    const total = values.reduce((sum, value) => sum + value, 0);
    expect(tiles.reduce((sum, tile) => sum + area(tile), 0)).toBeCloseTo(rect.width * rect.height, 4);
    for (const tile of tiles) {
      expect(area(tile)).toBeCloseTo((tile.data / total) * rect.width * rect.height, 4);
      expect(tile.x).toBeGreaterThanOrEqual(-EPS);
      expect(tile.y).toBeGreaterThanOrEqual(-EPS);
      expect(tile.x + tile.width).toBeLessThanOrEqual(rect.width + EPS);
      expect(tile.y + tile.height).toBeLessThanOrEqual(rect.height + EPS);
    }
  });

  it('never overlaps tiles', () => {
    const values = Array.from({ length: 40 }, (_, index) => 1000 / (index + 1));
    const tiles = squarify(values.map((value, index) => ({ value, data: index })), rect);
    for (let i = 0; i < tiles.length; i += 1) {
      for (let j = i + 1; j < tiles.length; j += 1) {
        const a = tiles[i];
        const b = tiles[j];
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(overlapX <= EPS || overlapY <= EPS).toBe(true);
      }
    }
  });

  it('keeps aspect ratios reasonable for a long tail', () => {
    const values = Array.from({ length: 30 }, (_, index) => 100 * Math.pow(0.85, index));
    const tiles = squarify(values.map((value, index) => ({ value, data: index })), rect);
    const worst = Math.max(...tiles.map((tile) => Math.max(tile.width / tile.height, tile.height / tile.width)));
    expect(worst).toBeLessThan(4);
  });

  it('sorts by value descending, stable for ties, and drops non-positive values', () => {
    const tiles = squarify(
      [
        { value: 1, data: 'a' },
        { value: 5, data: 'b' },
        { value: 0, data: 'zero' },
        { value: -3, data: 'neg' },
        { value: Number.NaN, data: 'nan' },
        { value: 1, data: 'c' },
      ],
      rect,
    );
    expect(tiles.map((tile) => tile.data)).toEqual(['b', 'a', 'c']);
  });

  it('returns nothing for empty input or an empty rect', () => {
    expect(squarify([], rect)).toEqual([]);
    expect(squarify([{ value: 1, data: 1 }], { x: 0, y: 0, width: 0, height: 100 })).toEqual([]);
  });

  it('gives a single item the whole rect, honouring the origin', () => {
    expect(squarify([{ value: 7, data: 'only' }], { x: 10, y: 20, width: 100, height: 50 })).toEqual([
      { x: 10, y: 20, width: 100, height: 50, data: 'only' },
    ]);
  });
});

describe('heatmap color scale', () => {
  const palette = { up: '#2D9148', down: '#D93025', neutral: '#E8E8E8' };

  it('is neutral near zero', () => {
    expect(heatmapColor(0, palette)).toBe('#E8E8E8');
    expect(heatmapColor(0.3, palette)).toBe('#E8E8E8');
    expect(heatmapColor(-0.4, palette)).toBe('#E8E8E8');
    expect(heatmapIntensity(Number.NaN)).toBe(0);
  });

  it('saturates at the clamp on both sides', () => {
    expect(heatmapColor(HEATMAP_CLAMP_PCT, palette)).toBe('#2D9148');
    expect(heatmapColor(80, palette)).toBe('#2D9148');
    expect(heatmapColor(-HEATMAP_CLAMP_PCT, palette)).toBe('#D93025');
    expect(heatmapColor(-80, palette)).toBe('#D93025');
  });

  it('deepens monotonically with the size of the move', () => {
    expect(heatmapIntensity(1)).toBeGreaterThan(0);
    expect(heatmapIntensity(5)).toBeGreaterThan(heatmapIntensity(1));
    expect(heatmapIntensity(-10)).toBeGreaterThan(heatmapIntensity(-5));
    expect(heatmapIntensity(5)).toBe(heatmapIntensity(-5));
  });

  it('mixes hex colors linearly', () => {
    expect(mixHex('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(mixHex('#000000', '#FFFFFF', 2)).toBe('#FFFFFF');
  });

  it('picks light text only on dark fills', () => {
    expect(prefersLightText('#2D9148')).toBe(true);
    expect(prefersLightText('#D93025')).toBe(true);
    expect(prefersLightText('#E8E8E8')).toBe(false);
  });
});
