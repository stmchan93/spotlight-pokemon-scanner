import type { ExpansionRecord } from '@spotlight/api-client';

import { buildMasterSetRows } from '@/features/portfolio/master-set';

function set(id: string, name: string, cardCount?: number): ExpansionRecord {
  return { id, name, series: null, code: null, releaseDate: null, imageUrl: null, cardCount };
}

describe('buildMasterSetRows', () => {
  it('orders by completion, then cards owned, then name; unknown sizes last', () => {
    const rows = buildMasterSetRows([
      {
        game: 'pokemon',
        progress: {
          game: 'pokemon',
          sets: [
            { expansionId: 'half-small', ownedCount: 1 },
            { expansionId: 'half-big', ownedCount: 50 },
            { expansionId: 'done', ownedCount: 10 },
            { expansionId: 'unsized', ownedCount: 99 },
            { expansionId: 'low', ownedCount: 5 },
            { expansionId: 'not-in-catalog', ownedCount: 7 },
          ],
        },
        expansions: [
          set('half-small', 'Half Small', 2),
          set('half-big', 'Half Big', 100),
          set('done', 'Done', 10),
          set('unsized', 'Unsized'),
          set('low', 'Low', 200),
        ],
      },
      {
        game: 'onepiece',
        progress: { game: 'onepiece', sets: [{ expansionId: 'op1', ownedCount: 60 }] },
        expansions: [set('op1', 'Romance Dawn', 100)],
      },
    ]);

    expect(rows.map((row) => row.key)).toEqual([
      'pokemon:done',
      'onepiece:op1',
      'pokemon:half-big',
      'pokemon:half-small',
      'pokemon:low',
      'pokemon:unsized',
    ]);
    expect(rows[0].completion).toEqual({ owned: 10, total: 10, fraction: 1, percent: 100 });
    expect(rows.at(-1)?.completion).toBeNull();
  });
});
