#!/usr/bin/env python3
"""Measure precision + recall of card_language_links against INDEPENDENT ground
truth — collector-number correspondence within EN↔JP set pairs.

Ground truth is built WITHOUT the art embedding (the signal the linker uses), so
this is a non-circular eval:
  1. Detect EN↔JP set pairs: two sets correspond when many cards share the same
     normalized collector number AND English name (JP rows store the English name
     via Scrydex translation.en). Requires >= MIN_OVERLAP matches.
  2. Ground-truth pair = (EN card, JP card) at the same number in a paired set.
  3. Grade the linker:
       recall    = GT pairs the linker linked to the exact GT counterpart / all GT pairs
       precision = of linked GT-EN cards, how many hit the exact GT counterpart
     Also reports "same name+number" matches (counts an alt-print of the same card
     as art-correct, separating true errors from SKU-choice differences).

Usage: python3 tools/eval_card_language_links.py --db backend/data/spotlight_scanner.local.sqlite
"""
from __future__ import annotations

import argparse
import re
import sqlite3
from collections import defaultdict
from pathlib import Path

MIN_OVERLAP = 15  # min same-number+name cards for two sets to count as a pair


def norm_num(value: str | None) -> str:
    s = (value or "").split("/")[0].strip().lower()
    if s.isdigit():
        return str(int(s))
    return re.sub(r"\s+", "", s)


def norm_name(value: str | None) -> str:
    return (value or "").strip().lower()


def run(db_path: Path) -> None:
    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row

    # set_id -> { norm_num: (name, card_id) }, per language
    en_sets: dict[str, dict[str, tuple[str, str]]] = defaultdict(dict)
    jp_sets: dict[str, dict[str, tuple[str, str]]] = defaultdict(dict)
    for r in con.execute("SELECT id, set_id, language, name, number FROM cards"):
        if not r["set_id"]:
            continue
        bucket = en_sets if r["language"] == "English" else jp_sets if r["language"] == "Japanese" else None
        if bucket is None:
            continue
        bucket[r["set_id"]].setdefault(norm_num(r["number"]), (norm_name(r["name"]), r["id"]))

    # Co-occurrence: count same (num,name) between each EN set and JP set.
    key_en: dict[tuple[str, str], list[str]] = defaultdict(list)
    key_jp: dict[tuple[str, str], list[str]] = defaultdict(list)
    for sid, m in en_sets.items():
        for num, (name, _) in m.items():
            key_en[(num, name)].append(sid)
    for sid, m in jp_sets.items():
        for num, (name, _) in m.items():
            key_jp[(num, name)].append(sid)

    pair_count: dict[tuple[str, str], int] = defaultdict(int)
    for key, en_ids in key_en.items():
        for jp_id in key_jp.get(key, ()):
            for en_id in en_ids:
                pair_count[(en_id, jp_id)] += 1

    # Best JP set per EN set (1:1), above the overlap floor.
    best_jp: dict[str, tuple[str, int]] = {}
    for (en_id, jp_id), cnt in pair_count.items():
        if cnt < MIN_OVERLAP:
            continue
        if en_id not in best_jp or cnt > best_jp[en_id][1]:
            best_jp[en_id] = (jp_id, cnt)

    # Ground-truth (EN card, JP card) pairs from confirmed set pairs.
    gt: list[tuple[str, str]] = []
    for en_id, (jp_id, _) in best_jp.items():
        em, jm = en_sets[en_id], jp_sets[jp_id]
        for num, (name, en_card) in em.items():
            if num in jm and jm[num][0] == name:
                gt.append((en_card, jm[num][1]))

    # Linker output + a name/number lookup for "art-correct" scoring.
    linked = {r[0]: r[1] for r in con.execute("SELECT card_id, counterpart_card_id FROM card_language_links")}
    card_key = {
        r["id"]: (norm_num(r["number"]), norm_name(r["name"]))
        for r in con.execute("SELECT id, number, name FROM cards")
    }

    total = len(gt)
    linked_any = exact = same_name_num = 0
    mism = []
    for en_card, jp_card in gt:
        cp = linked.get(en_card)
        if cp is None:
            continue
        linked_any += 1
        if cp == jp_card:
            exact += 1
        else:
            if card_key.get(cp) == card_key.get(jp_card):
                same_name_num += 1  # different print, but same card identity
            elif len(mism) < 12:
                mism.append((en_card, cp, jp_card))

    con.close()
    print(f"confirmed EN->JP set pairs: {len(best_jp)}")
    print(f"ground-truth card pairs:    {total}")
    print(f"GT EN cards the linker linked (to anything): {linked_any} ({linked_any*100//max(total,1)}% of GT)")
    print()
    art_ok = exact + same_name_num
    print(f"RECALL  (exact GT counterpart found):      {exact}/{total} = {exact*100/max(total,1):.1f}%")
    print(f"RECALL  (art-correct: same card identity):  {art_ok}/{total} = {art_ok*100/max(total,1):.1f}%")
    if linked_any:
        print(f"PRECISION (exact, among linked GT cards):  {exact}/{linked_any} = {exact*100/linked_any:.1f}%")
        print(f"PRECISION (art-correct, among linked):     {art_ok}/{linked_any} = {art_ok*100/linked_any:.1f}%")
        wrong = linked_any - art_ok
        print(f"TRUE ERRORS (linked to a different card):  {wrong}/{linked_any} = {wrong*100/linked_any:.1f}%")
    print("\nsample true errors (EN -> linked, expected GT):")
    for e, c, g in mism:
        print(f"  {e} -> {c}   (expected {g})")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", required=True)
    args = ap.parse_args()
    run(Path(args.db))


if __name__ == "__main__":
    main()
