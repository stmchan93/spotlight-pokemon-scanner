import { mockSpotlightEventMap } from '@spotlight/api-client';

import {
  MAP_MAX_SCALE,
  clampTransform,
  contentSize,
  filterVendors,
  fitTablesTransform,
  restingTransform,
  tableAtPoint,
  vendorForTable,
} from '@/features/events/event-floor-map-model';

const { vendors, tables } = mockSpotlightEventMap;
const viewport = { width: 360, height: 440 };
const content = contentSize(mockSpotlightEventMap, viewport.width, viewport.height);

describe('filterVendors', () => {
  it('matches name, booth and tag, accent- and case-insensitively', () => {
    expect(filterVendors(vendors, 'main', null).map((v) => v.id)).toEqual(['main-street-cards']);
    expect(filterVendors(vendors, 'a2', null).map((v) => v.id)).toEqual(['dokidoki-collectibles']);
    expect(filterVendors(vendors, 'pokemon', null).map((v) => v.id)).toEqual(['dokidoki-collectibles']);
    expect(filterVendors(vendors, '  ', null)).toHaveLength(vendors.length);
  });

  it('requires the selected tag', () => {
    expect(filterVendors(vendors, '', 'Food').map((v) => v.id)).toEqual(['aloha-puddin']);
    expect(filterVendors(vendors, 'main', 'Food')).toEqual([]);
  });
});

describe('map geometry', () => {
  it('fits the image inside the viewport and centers it at rest', () => {
    // 1000x2000 image in 360x440: height-bound.
    expect(content).toEqual({ width: 220, height: 440 });
    expect(restingTransform(content, viewport)).toEqual({ scale: 1, translateX: 70, translateY: 0 });
  });

  it('clamps scale and keeps a zoomed map covering the viewport', () => {
    const clamped = clampTransform({ scale: 10, translateX: 500, translateY: -99999 }, content, viewport);
    expect(clamped.scale).toBe(MAP_MAX_SCALE);
    expect(clamped.translateX).toBe(0);
    expect(clamped.translateY).toBe(viewport.height - content.height * MAP_MAX_SCALE);
  });

  it('zooms in on a vendor and centers its tables', () => {
    const fit = fitTablesTransform(tables.filter((t) => t.id === 'C14'), content, viewport);
    expect(fit.scale).toBeGreaterThan(1);
    const centerX = (0.5 + 0.01) * content.width * fit.scale + fit.translateX;
    expect(Math.abs(centerX - viewport.width / 2)).toBeLessThan(1);
  });

  it('finds the table under a tap, with a little slop', () => {
    const rest = restingTransform(content, viewport);
    const c14 = tables.find((t) => t.id === 'C14')!;
    const x = rest.translateX + (c14.x + c14.width / 2) * content.width;
    const y = rest.translateY + (c14.y + c14.height / 2) * content.height;
    expect(tableAtPoint(tables, { x, y }, rest, content)?.id).toBe('C14');
    expect(tableAtPoint(tables, { x: 5, y: 5 }, rest, content)).toBeNull();
    expect(vendorForTable(vendors, 'C14')?.id).toBe('main-street-cards');
  });
});
