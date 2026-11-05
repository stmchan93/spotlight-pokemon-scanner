# Art-tags gold set (v1)

A hand-reviewed test set of 200 Pokémon cards tagged for **what is in the
artwork**: scene, weather/time, activity, mood, objects, style, composition,
every Pokémon that appears, any named human characters, and one plain alt-text
sentence. Its job is to compare Claude models before one of them tags the full
catalog, so accuracy matters more than coverage.

`draft-v1.jsonl` holds one JSON object per card. The first pass was drafted by a
model (`drafted_by`) and every line starts as `review_state: "draft"`. A human
then checks each line.

## Stratification (200 cards)

| Stratum | Count | What it covers |
|---|---|---|
| Modern IR / SIR (Scarlet & Violet and Mega Evolution eras) | 70 | Illustration Rare and Special Illustration Rare full-art scenes, where most background and cameo Pokémon show up |
| Pre-2010 | 50 | WotC, e-Card, EX, DP and Platinum eras: framed-window art, older painterly and CGI styles, Trainer and Energy cards |
| 2010–2022 | 50 | BW, XY, SM and SWSH eras: regular rares, V/GX, rainbow and secret rares, promos, Trainer items |
| Japanese | 30 | Japanese-only prints and sets across all eras, including promos and Energy cards with no listed artist |

## Line format

```json
{"card_id": "...", "name": "...", "set": "...",
 "scene": [...], "weather_time": [...], "activity": [...], "mood": [...], "objects": [...],
 "art_style": "...", "composition": "...",
 "appearing_pokemon": [{"name": "Pikachu", "role": "main", "confidence": 0.98}],
 "characters": [], "alt_text": "...", "notes": "...",
 "review_state": "draft", "drafted_by": "..."}
```

If the image could not be fetched, the line has only `card_id`, `name`, `set`,
`"error": "image_unavailable"`, `review_state` and `drafted_by`.

Artist, set, rarity and price are **not** tagged. They come from the catalog,
not from the art.

## Vocab v1

Use only these values. `validate.py` enforces them, along with the list-length limits.

- **scene** (1–2): beach, ocean_underwater, river_lake, forest, jungle, field_meadow, flowers_garden, mountain, cave, desert, snow_ice, volcano, sky_clouds, space_stars, city_street, town_village, indoor_home, bedroom, kitchen_food, restaurant_cafe, shop_market, school_library, lab, stadium_arena, festival_fair, ruins_temple, abstract_background, other
- **weather_time** (0–2): day, sunset_sunrise, night, rain, snow, storm, fog, rainbow, none_visible (`none_visible` is never combined with another value)
- **activity** (0–3): sleeping, eating, cooking, playing, swimming, flying, running, battling, posing, reading, celebrating, resting, hugging_group, hiding, other
- **mood** (1–2): cozy, cute, funny, dramatic, fierce, peaceful, spooky, melancholy, festive, majestic
- **objects** (0–8): food, drinks, sweets, umbrella, books, toys, balloons, flowers, gifts, lanterns, pokeballs, instruments, vehicles, furniture, bed_pillow, tableware, trees, rocks, water_splash, other
- **art_style** (exactly 1): painterly, watercolor, pencil_sketch, anime_cel, cgi_3d, papercraft, clay_model, pixel, graphic_flat, photo_composite, mixed
- **composition** (exactly 1): full_art_scene, framed_window, character_closeup, panorama, group_shot, text_heavy
- **appearing_pokemon**: every visible Pokémon, as `{name, role, confidence}`.
  - `name` is the English species name.
  - `role` is one of `main`, `secondary`, `background` or `cameo`. A `cameo` is a Pokémon other than the subject that is small or hidden.
  - `confidence` is from 0 to 1. This is the most important field. Never guess a species you can't identify; lower the confidence instead.
- **characters**: identifiable humans or trainers (max 5), otherwise `[]`.
- **alt_text**: one plain sentence.
- **notes** (free text): the drafter's doubts, alternatives it considered and reasons for using `other`. Reviewers should read it first.

## Review workflow

1. Open the card image next to its line. The URL is `https://images.scrydex.com/pokemon/<card_id>/large`.
2. Read `notes`, then check every field. Pay most attention to `appearing_pokemon`: zoom into backgrounds and look for missed cameos or wrong species.
3. Set `review_state` on that line:
   - `human_ok`: the draft is correct as written.
   - `human_fixed`: you corrected one or more fields. Optionally add what you changed to `notes`.
4. Do not change `drafted_by`. It records which model produced the draft being scored.
5. Run `python3 qa/art-tags-gold/validate.py` before committing. It exits non-zero on vocab, bounds, role, confidence or duplicate-`card_id` errors, and it prints how often `other` was used. A high `other` count points to gaps in the vocab.

When all 200 lines are `human_ok` or `human_fixed`, the file becomes the gold
labels that candidate models are scored against.

## Images are not in the repo

Card images are third-party artwork. They are **not** committed here and must
not be. Tag and review from the public Scrydex URL above, downloaded to a temp
directory outside the repo.
