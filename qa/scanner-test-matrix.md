# Scanner Test Matrix

Use these cards first because they hit the exact ambiguity classes the current MVP cares about.

## Must Pass

- `pokemon-charizard-ex-223-197`
  - `Charizard ex`
  - `Obsidian Flame`
  - `223/197`
  - Why: same-name disambiguation with a strong collector number

- `pokemon-charizard-ex-125-197`
  - `Charizard ex`
  - `Obsidian Flame`
  - `125/197`
  - Why: same name, same set, different number and rarity

- `pokemon-charizard-ex-svp-056`
  - `Charizard ex`
  - `Scarlet & Violet Promo`
  - `SVP 056`
  - Why: promo vs set-card ambiguity

- `pokemon-pikachu-svp-160`
  - `Pikachu`
  - `Scarlet & Violet Promo`
  - `SVP 160`
  - Why: simpler promo sanity check

- `pokemon-basic-lightning-energy-257-198`
  - `Basic Lightning Energy`
  - `Scarlet & Violet`
  - `257/198`
  - Why: energy cards are a known hard class

## Good Next Cases

- `pokemon-iono-254-193`
  - `Iono`
  - `Paldea Evolved`
  - `254/193`
  - Why: trainer full-art OCR stress

- `pokemon-mew-ex-205-165`
  - `Mew ex`
  - `151`
  - `205/165`
  - Why: different set layout

- `pokemon-gardevoir-ex-245-198`
  - `Gardevoir ex`
  - `Scarlet & Violet`
  - `245/198`
  - Why: another ex full-art style

- `pokemon-umbreon-vmax-tg23`
  - `Umbreon VMAX`
  - `Brilliant Stars Trainer Gallery`
  - `TG23/TG30`
  - Why: trainer-gallery numbering format

- `pokemon-lugia-v-186-195`
  - `Lugia V`
  - `Silver Tempest`
  - `186/195`
  - Why: alternate artwork and set variation

## Hard-Mode Variations

- glare across the bottom metadata strip
- slight blur
- sleeve reflection
- angled photo
- darker background
- partial crop near one corner

If the scanner fails, note:
- did crop fail or just identity?
- was the collector number wrong or missing?
- was the top match close but variant-wrong?
