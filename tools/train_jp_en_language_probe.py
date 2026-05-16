#!/usr/bin/env python3
"""Train a binary logistic-regression probe that classifies a CLIP card
embedding as English vs Japanese.

The backend uses this at inference time to bias the matcher away from
returning a Japanese-language card for a user whose device locale is
English (and vice versa). Stage 1 cosine retrieval is unchanged; the
probe is consulted only as a soft prior over candidate languages.

Output schema (consumed by backend/raw_visual_matcher.py):

    coef       : float32 (2, 512)   softmax-ready, rows = classes
    intercept  : float32 (2,)
    classes    : object  (2,)       e.g. ['English', 'Japanese']

We reformat sklearn's (1, 512) binary LR weights into a (2, 512) one-hot
softmax shape so the backend can use a uniform softmax interface for
binary and multi-class probes in the future.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
)
from sklearn.model_selection import train_test_split


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE_INDEX = REPO_ROOT / "backend" / "data" / "visual-index" / "visual_index_active_clip-vit-base-patch32.npz"
DEFAULT_SOURCE_MANIFEST = REPO_ROOT / "backend" / "data" / "visual-index" / "visual_index_active_manifest.json"
DEFAULT_OUTPUT = REPO_ROOT / "backend" / "data" / "visual-models" / "language_probe_v1.npz"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source-index", type=Path, default=DEFAULT_SOURCE_INDEX)
    parser.add_argument("--source-manifest", type=Path, default=DEFAULT_SOURCE_MANIFEST)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--report-only",
        action="store_true",
        help="Train and print metrics but skip writing the output npz.",
    )
    parser.add_argument("--test-size", type=float, default=0.2)
    parser.add_argument("--random-state", type=int, default=42)
    parser.add_argument("--C", type=float, default=1.0)
    parser.add_argument("--max-iter", type=int, default=2000)
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    source_index = args.source_index.resolve()
    source_manifest = args.source_manifest.resolve()
    output_path = args.output.resolve()

    print(f"Loading manifest: {source_manifest}", flush=True)
    with source_manifest.open() as handle:
        manifest = json.load(handle)
    entries: list[dict[str, Any]] = manifest.get("entries") or []
    if not entries:
        raise SystemExit("Source manifest has no entries.")

    print(f"Loading embeddings: {source_index}", flush=True)
    with np.load(source_index) as data:
        if "embeddings" not in data:
            raise SystemExit(f"Source index missing 'embeddings' key. Found: {list(data.keys())}")
        embeddings = data["embeddings"].astype(np.float32, copy=True)

    if embeddings.shape[0] != len(entries):
        raise SystemExit(
            f"Manifest/embedding length mismatch: {len(entries)} entries vs {embeddings.shape[0]} rows."
        )

    kept_rows: list[int] = []
    kept_labels: list[str] = []
    rejected_counts: dict[str, int] = {"missing_language": 0, "non_target_language": 0}
    for entry in entries:
        language = str(entry.get("language") or "").strip()
        if not language:
            rejected_counts["missing_language"] += 1
            continue
        if language not in {"English", "Japanese"}:
            rejected_counts["non_target_language"] += 1
            continue
        row_index = int(entry.get("rowIndex"))
        kept_rows.append(row_index)
        kept_labels.append(language)

    print(f"Kept rows: {len(kept_rows)} (rejected counts={rejected_counts})", flush=True)
    if len(kept_rows) < 100:
        raise SystemExit("Too few rows after language filter; refusing to train.")

    X = embeddings[kept_rows].astype(np.float32, copy=True)
    y = np.array(kept_labels, dtype=object)

    from collections import Counter
    print(f"Class counts: {dict(Counter(kept_labels))}", flush=True)

    X_train, X_test, y_train, y_test = train_test_split(
        X,
        y,
        test_size=args.test_size,
        random_state=args.random_state,
        stratify=y,
    )
    print(f"Train: {X_train.shape[0]} | Test: {X_test.shape[0]}", flush=True)

    clf = LogisticRegression(max_iter=args.max_iter, C=args.C)
    clf.fit(X_train, y_train)

    train_pred = clf.predict(X_train)
    test_pred = clf.predict(X_test)
    train_acc = accuracy_score(y_train, train_pred)
    test_acc = accuracy_score(y_test, test_pred)

    print()
    print(f"Train accuracy: {train_acc:.4f}")
    print(f"Test accuracy:  {test_acc:.4f}")
    print()
    print("Confusion matrix (rows=true, cols=pred):")
    print(f"  labels: {list(clf.classes_)}")
    cm = confusion_matrix(y_test, test_pred, labels=list(clf.classes_))
    for true_label, row in zip(clf.classes_, cm):
        formatted = " ".join(f"{v:>6d}" for v in row)
        print(f"  {true_label!s:>10}: {formatted}")
    print()
    print("Per-class report:")
    print(classification_report(y_test, test_pred, labels=list(clf.classes_)))

    if args.report_only:
        print("--report-only set; skipping write.")
        return

    # sklearn binary LR stores coef_ as (1, n_features) -- the positive class only.
    # Reformat to a softmax-shaped (2, 512) so the backend can use a single code
    # path for binary and multi-class probes in the future.
    if clf.coef_.shape[0] != 1:
        raise SystemExit(
            f"Expected binary LR coef shape (1, n_features); got {clf.coef_.shape}."
        )
    coef_row = clf.coef_[0].astype(np.float32, copy=True)
    intercept_scalar = float(clf.intercept_[0])
    coef_array = np.vstack([-coef_row, coef_row]).astype(np.float32)
    intercept_array = np.array([-intercept_scalar, intercept_scalar], dtype=np.float32)
    classes_array = np.array(list(clf.classes_), dtype=object)

    # Quick consistency check: the softmax-form weights should reproduce the
    # original sklearn decision on the test set.
    logits = X_test @ coef_array.T + intercept_array
    softmax_pred = classes_array[np.argmax(logits, axis=1)]
    if not np.array_equal(softmax_pred, test_pred):
        raise SystemExit("Softmax-form weights disagree with sklearn predictions; aborting.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        output_path,
        coef=coef_array,
        intercept=intercept_array,
        classes=classes_array,
    )
    print(f"Wrote probe weights: {output_path}")
    print(f"  coef={coef_array.shape} intercept={intercept_array.shape} classes={list(classes_array)}")


if __name__ == "__main__":
    main()
