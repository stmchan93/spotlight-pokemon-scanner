// App Store screenshot fixtures for the scanner dev screens (`spotlight://dev/*`).
// Real staging catalog ids/sets/numbers/printings; prices are the staging TCGCSV market snapshot from 2026-10-15.

export type DevScanCard = {
  cardId: string;
  name: string;
  setName: string;
  collectorNumber: string;
  printing: string;
  priceUsd: number;
  image: number;
};

/** Hero single scan: the Japanese SAR printing (インフェルノX / Inferno X, 2025-09-26). */
export const DEV_SCAN_SINGLE_JP: DevScanCard = {
  cardId: 'm2_ja-110',
  name: 'Mega Charizard X ex',
  setName: 'インフェルノX',
  collectorNumber: '110/080',
  printing: 'Holofoil',
  priceUsd: 705.97,
  image: require('./assets/scanner/single.png'),
};

/** Hero single scan: English Special Illustration Rare (Phantasmal Flames). */
export const DEV_SCAN_SINGLE: DevScanCard = {
  cardId: 'me2-125',
  name: 'Mega Charizard X ex',
  setName: 'Phantasmal Flames',
  collectorNumber: '125/094',
  printing: 'Holofoil',
  priceUsd: 619.14,
  image: require('./assets/scanner/single-sir.png'),
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
    image: require('./assets/scanner/binder-1.png'),
  },
  {
    cardId: 'sv8pt5-155',
    name: 'Espeon ex',
    setName: 'Prismatic Evolutions',
    collectorNumber: '155/131',
    printing: 'Holofoil',
    priceUsd: 283.62,
    image: require('./assets/scanner/binder-2.png'),
  },
  {
    cardId: 'sv2d_ja-96',
    name: 'Iono',
    setName: 'クレイバースト',
    collectorNumber: '096/071',
    printing: 'Holofoil',
    priceUsd: 296.26,
    image: require('./assets/scanner/binder-3.png'),
  },
  {
    cardId: 'swsh11tg-TG06',
    name: 'Gengar',
    setName: 'Lost Origin Trainer Gallery',
    collectorNumber: 'TG06/TG30',
    printing: 'Holofoil',
    priceUsd: 45.28,
    image: require('./assets/scanner/binder-4.png'),
  },
  {
    cardId: 'sv8-239',
    name: 'Latias ex',
    setName: 'Surging Sparks',
    collectorNumber: '239/191',
    printing: 'Holofoil',
    priceUsd: 178.83,
    image: require('./assets/scanner/binder-5.png'),
  },
  {
    cardId: 'sv1a_ja-80',
    name: 'Magikarp',
    setName: 'トリプレットビート',
    collectorNumber: '080/073',
    printing: 'Holofoil',
    priceUsd: 142.4,
    image: require('./assets/scanner/binder-6.png'),
  },
  {
    cardId: 'sv5a_ja-90',
    name: 'Greninja ex',
    setName: 'クリムゾンヘイズ',
    collectorNumber: '090/066',
    printing: 'Holofoil',
    priceUsd: 234.6,
    image: require('./assets/scanner/binder-7.png'),
  },
  {
    cardId: 'swsh12a_ja-183',
    name: 'Mew',
    setName: 'VSTARユニバース',
    collectorNumber: '183/172',
    printing: 'Holofoil',
    priceUsd: 48.18,
    image: require('./assets/scanner/binder-8.png'),
  },
  {
    cardId: 'sv2-222',
    name: 'Tyranitar',
    setName: 'Paldea Evolved',
    collectorNumber: '222/193',
    printing: 'Holofoil',
    priceUsd: 70.57,
    image: require('./assets/scanner/binder-9.png'),
  },
];

/** 1320x2868 dark felt scan mat the cards are composited over. */
export const DEV_SCAN_SURFACE: number = require('./assets/scanner/surface.jpg');
