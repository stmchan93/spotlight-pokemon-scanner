# Art-tag seed: Illustration Rare / Special Illustration Rare (v1)

Seed data for the in-app "search by what's in the picture" feature
(e.g. "Pikachu sleeping", "beach", "rain"). It covers the 706 English
Illustration Rare / Special Illustration Rare cards listed in `cards.txt`,
tagged before the full-catalog batch runs.

**This is an unreviewed AI seed.** Each line was drafted by a model looking
at the card image (`drafted_by` says which). Nothing here has been checked by
a person yet. Treat it as a starting point for review, not as ground truth.

## Files

- `cards.txt`: the card list (`card_id|name`), in tagging order.
- `ir-seed-v1.jsonl`: one JSON object per card.
- `progress.txt`: where tagging stopped, for resuming.
- `validate.py`: stdlib-only vocab checker.
  Run `python3 qa/art-tags-seed/validate.py --stats`.

Card images (third-party art) are never committed. They come from
`https://images.scrydex.com/pokemon/<card_id>/large` at tagging time.

## Line format

```json
{"card_id": "...", "name": "...", "scene": [...], "weather_time": [...],
 "activity": [...], "mood": [...], "objects": [...], "art_style": "...",
 "composition": "...",
 "appearing_pokemon": [{"name": "Pikachu", "role": "main", "confidence": 0.95}],
 "characters": [], "alt_text": "One plain sentence.",
 "drafted_by": "<model id>", "vocab_version": "v1"}
```

If the image 404s, the line is
`{"card_id", "name", "error": "image_unavailable", "drafted_by", "vocab_version"}`.

Artist, set, rarity and price are deliberately not tagged.

## Vocab v1

| field | count | values |
|---|---|---|
| scene | 1–2 | beach, ocean_underwater, river_lake, forest, jungle, field_meadow, flowers_garden, mountain, cave, desert, snow_ice, volcano, sky_clouds, space_stars, city_street, town_village, indoor_home, bedroom, kitchen_food, restaurant_cafe, shop_market, school_library, lab, stadium_arena, festival_fair, ruins_temple, abstract_background, other |
| weather_time | 0–2 | day, sunset_sunrise, night, rain, snow, storm, fog, rainbow, none_visible |
| activity | 0–3 | sleeping, eating, cooking, playing, swimming, flying, running, battling, posing, reading, celebrating, resting, hugging_group, hiding, other |
| mood | 1–2 | cozy, cute, funny, dramatic, fierce, peaceful, spooky, melancholy, festive, majestic |
| objects | 0–8 | food, drinks, sweets, umbrella, books, toys, balloons, flowers, gifts, lanterns, pokeballs, instruments, vehicles, furniture, bed_pillow, tableware, trees, rocks, water_splash, other |
| art_style | 1 | painterly, watercolor, pencil_sketch, anime_cel, cgi_3d, papercraft, clay_model, pixel, graphic_flat, photo_composite, mixed |
| composition | 1 | full_art_scene, framed_window, character_closeup, panorama, group_shot, text_heavy |

- `appearing_pokemon`: every visible Pokémon, as `{name, role, confidence}`.
  `name` is the English species. `role` is `main`, `secondary`, `background`
  or `cameo` (a Pokémon other than the subject that is small or hidden).
  `confidence` is 0–1. Species that can't be identified are left out rather
  than guessed.
- `characters`: identifiable humans/trainers (at most 5), else `[]`.
- `alt_text`: one plain sentence.

## Backend mapping

These records map onto the backend tables `card_art_groups` and
`card_art_tags` on branch `feat/art-tags-phase1` (loader:
`backend/tools/tag_card_art.py`). This directory only holds the seed. It does
not import anything.
