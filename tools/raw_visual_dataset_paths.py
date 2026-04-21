#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def default_dataset_root() -> Path:
    configured = os.environ.get("SPOTLIGHT_DATASET_ROOT")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / "spotlight-datasets"


def _env_or_default(env_name: str, relative_path: str) -> Path:
    configured = os.environ.get(env_name)
    if configured:
        return Path(configured).expanduser()
    return default_dataset_root() / relative_path


def default_raw_visual_train_root() -> Path:
    return _env_or_default("SPOTLIGHT_RAW_VISUAL_TRAIN_ROOT", "raw-visual-train")


def default_raw_visual_train_excluded_root() -> Path:
    return _env_or_default("SPOTLIGHT_RAW_VISUAL_TRAIN_EXCLUDED_ROOT", "raw-visual-train-excluded")


def default_reference_image_cache_root() -> Path:
    configured = os.environ.get("SPOTLIGHT_REFERENCE_IMAGE_CACHE_ROOT")
    if configured:
        return Path(configured).expanduser()
    return default_dataset_root() / "reference-image-cache"


def default_raw_footer_layout_reference_cache_root() -> Path:
    return default_reference_image_cache_root() / "raw-footer-layout-check"


def default_raw_footer_layout_query_cache_path() -> Path:
    return default_raw_footer_layout_reference_cache_root() / "provider_search_cache.json"


def default_raw_visual_train_manifest_path() -> Path:
    return default_raw_visual_train_root() / "raw_visual_training_manifest.jsonl"


def default_raw_visual_train_manifest_summary_path() -> Path:
    return default_raw_visual_train_root() / "raw_visual_training_manifest_summary.json"


def default_raw_visual_train_reference_cache_root() -> Path:
    return default_raw_visual_train_root() / ".visual_reference_cache"


def default_raw_visual_train_query_cache_path() -> Path:
    return default_raw_visual_train_reference_cache_root() / "provider_search_cache.json"


def default_raw_visual_train_reference_image_root() -> Path:
    return default_raw_visual_train_reference_cache_root() / "reference_images"


def default_raw_visual_train_expansion_snapshot_path() -> Path:
    return default_raw_visual_train_reference_cache_root() / "scrydex_expansions_snapshot.json"


def default_raw_visual_train_auto_label_summary_path() -> Path:
    return default_raw_visual_train_root() / "auto_label_summary.json"


def default_raw_visual_train_manual_label_overrides_path() -> Path:
    return default_raw_visual_train_root() / "manual_label_overrides_2026-04-12.json"


def default_raw_visual_train_manual_label_summary_path() -> Path:
    return default_raw_visual_train_root() / "manual_label_application_summary.json"


def default_raw_visual_train_hard_negatives_path() -> Path:
    return default_raw_visual_train_root() / "raw_visual_hard_negatives.json"


def default_raw_visual_scan_registry_path() -> Path:
    return default_raw_visual_train_root() / "raw_scan_registry.json"


def default_raw_visual_batch_audit_root() -> Path:
    return default_raw_visual_train_root() / "batch-audits"


def default_raw_visual_expansion_holdout_root() -> Path:
    return _env_or_default("SPOTLIGHT_RAW_VISUAL_EXPANSION_HOLDOUT_ROOT", "raw-visual-expansion-holdouts")
