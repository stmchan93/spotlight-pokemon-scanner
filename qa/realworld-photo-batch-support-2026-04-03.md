# Real-World Photo Batch Support Matrix

Date: 2026-04-03

Purpose: record expected outcomes for the photo batch discussed in chat so those images can be added to regression later once they exist as local files.

## Expected Supported Real Cards

- Lugia Neo Genesis PSA slab
  - expected card id: `neo1-9`
  - resolver: `psa_label`
  - pricing: raw-card provider snapshot available

- Mewtwo Star Holon Phantoms PSA slab
  - expected card id: `ex13-103`
  - resolver: `psa_label`
  - pricing: raw-card provider snapshot available

- Charizard Skyridge PSA slab
  - expected card id: `ecard3-146`
  - resolver: `psa_label`
  - pricing: raw-card provider snapshot available

- Charizard Legendary Collection reverse holo PSA slab
  - expected card id: `base6-3`
  - resolver: `psa_label`
  - pricing: raw-card provider snapshot available

- Snorlax Legendary Collection reverse holo PSA slab
  - expected card id: `base6-64`
  - resolver: `psa_label`
  - pricing: raw-card provider snapshot available

- Latias & Latios-GX Team Up PSA slab
  - expected card id: `sm9-170`
  - resolver: `psa_label`
  - pricing: raw-card provider snapshot available

- Charmander 151 art rare
  - expected card id: `sv3pt5-168`
  - resolver: `direct_lookup`
  - pricing: provider snapshot available

- Simisear VSTAR Galarian Gallery
  - expected card id: `swsh12pt5gg-GG37`
  - resolver: `direct_lookup`
  - pricing: provider snapshot available

- Espeon Star POP Series 5
  - expected card id: `pop5-16`
  - resolver: `direct_lookup`
  - pricing: provider snapshot available

- Starmie Skyridge raw
  - expected card ids: `ecard3-30` or `ecard3-H28`
  - resolver: likely `direct_lookup` if bottom strip is readable, otherwise review
  - pricing: provider snapshot available

- Blastoise Base raw/slab
  - expected card id: `base1-2`
  - resolver: `psa_label` for slab, likely review or fallback for difficult raw photos
  - pricing: provider snapshot available

- M Gengar-EX variants
  - expected card ids: `xy4-35`, `xy4-121`, or `xyp-XY166`
  - resolver: depends on visible number/label
  - pricing: provider snapshot available

## Expected Review / Unsupported Cases

- Japanese PSA slab Mimikyu promo
  - expected behavior: review / unsupported
  - reason: current imported catalog path is English-focused and this exact Japanese promo is not in the current local import

- Custom/fake Mega Starmie style card
  - expected behavior: low confidence / review
  - reason: should not be silently matched to a real card

- Custom/fake gold Mega Charizard style card
  - expected behavior: low confidence / review
  - reason: should not be silently matched to a real card

## How To Use This Later

Once the real photo files are saved locally:

1. add them into [qa/images](/Users/stephenchan/Code/spotlight/qa/images) or a new real-world subfolder
2. extend [scanner-regression.local.json](/Users/stephenchan/Code/spotlight/qa/scanner-regression.local.json)
3. use the ids above as expected outcomes
4. keep fake/custom examples as `expect low confidence / review`, not forced exact matches
