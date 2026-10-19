import type { ImageSourcePropType } from 'react-native';
// App Store screenshot fixtures for the scanner dev screens (`spotlight://dev/*`).
// Real staging catalog ids/sets/numbers/printings; prices are the staging TCGCSV market snapshot from 2026-10-15.

export type DevScanCard = {
  cardId: string;
  name: string;
  setName: string;
  collectorNumber: string;
  printing: string;
  priceUsd: number;
  /** Catalog art, loaded from the image CDN at capture time (no bundled PNGs). */
  image: ImageSourcePropType;
};

/** Hero single scan: the Japanese SAR printing (インフェルノX / Inferno X, 2025-09-26). */
export const DEV_SCAN_SINGLE_JP: DevScanCard = {
  cardId: 'm2_ja-110',
  name: 'Mega Charizard X ex',
  setName: 'インフェルノX',
  collectorNumber: '110/080',
  printing: 'Holofoil',
  priceUsd: 705.97,
  image: { uri: 'https://images.scrydex.com/pokemon/m2_ja-110/large' },
};

/** Hero single scan: English Special Illustration Rare (Phantasmal Flames). */
export const DEV_SCAN_SINGLE: DevScanCard = {
  cardId: 'me2-125',
  name: 'Mega Charizard X ex',
  setName: 'Phantasmal Flames',
  collectorNumber: '125/094',
  printing: 'Holofoil',
  priceUsd: 619.14,
  image: { uri: 'https://images.scrydex.com/pokemon/me2-125/large' },
};

/** 3x3 binder page, row-major. Page total $1,524.78. */
export const DEV_SCAN_BINDER: DevScanCard[] = [
  {
    cardId: 'svp_ja-67',
    name: 'Umbreon',
    setName: 'Scarlet & Violet Promos',
    collectorNumber: '067/SV-P',
    printing: 'Holofoil',
    priceUsd: 225.04,
    image: { uri: 'https://images.scrydex.com/pokemon/svp_ja-67/large' },
  },
  {
    cardId: 'sv8pt5-155',
    name: 'Espeon ex',
    setName: 'Prismatic Evolutions',
    collectorNumber: '155/131',
    printing: 'Holofoil',
    priceUsd: 283.62,
    image: { uri: 'https://images.scrydex.com/pokemon/sv8pt5-155/large' },
  },
  {
    cardId: 'sv2d_ja-96',
    name: 'Iono',
    setName: 'クレイバースト',
    collectorNumber: '096/071',
    printing: 'Holofoil',
    priceUsd: 296.26,
    image: { uri: 'https://images.scrydex.com/pokemon/sv2d_ja-96/large' },
  },
  {
    cardId: 'swsh11tg-TG06',
    name: 'Gengar',
    setName: 'Lost Origin Trainer Gallery',
    collectorNumber: 'TG06/TG30',
    printing: 'Holofoil',
    priceUsd: 45.28,
    image: { uri: 'https://images.scrydex.com/pokemon/swsh11tg-TG06/large' },
  },
  {
    cardId: 'sv8-239',
    name: 'Latias ex',
    setName: 'Surging Sparks',
    collectorNumber: '239/191',
    printing: 'Holofoil',
    priceUsd: 178.83,
    image: { uri: 'https://images.scrydex.com/pokemon/sv8-239/large' },
  },
  {
    cardId: 'sv1a_ja-80',
    name: 'Magikarp',
    setName: 'トリプレットビート',
    collectorNumber: '080/073',
    printing: 'Holofoil',
    priceUsd: 142.4,
    image: { uri: 'https://images.scrydex.com/pokemon/sv1a_ja-80/large' },
  },
  {
    cardId: 'sv5a_ja-90',
    name: 'Greninja ex',
    setName: 'クリムゾンヘイズ',
    collectorNumber: '090/066',
    printing: 'Holofoil',
    priceUsd: 234.6,
    image: { uri: 'https://images.scrydex.com/pokemon/sv5a_ja-90/large' },
  },
  {
    cardId: 'swsh12a_ja-183',
    name: 'Mew',
    setName: 'VSTARユニバース',
    collectorNumber: '183/172',
    printing: 'Holofoil',
    priceUsd: 48.18,
    image: { uri: 'https://images.scrydex.com/pokemon/swsh12a_ja-183/large' },
  },
  {
    cardId: 'sv2-222',
    name: 'Tyranitar',
    setName: 'Paldea Evolved',
    collectorNumber: '222/193',
    printing: 'Holofoil',
    priceUsd: 70.57,
    image: { uri: 'https://images.scrydex.com/pokemon/sv2-222/large' },
  },
];

/** 1320x2868 dark felt scan mat the cards are composited over. */
export const DEV_SCAN_SURFACE: number = require('./assets/scanner/surface.jpg');
