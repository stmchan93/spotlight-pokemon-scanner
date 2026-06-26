PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    set_name TEXT NOT NULL,
    number TEXT NOT NULL,
    rarity TEXT NOT NULL,
    variant TEXT NOT NULL,
    language TEXT NOT NULL,
    source_provider TEXT,
    source_record_id TEXT,
    set_id TEXT,
    set_series TEXT,
    set_ptcgo_code TEXT,
    set_release_date TEXT,
    supertype TEXT,
    subtypes_json TEXT NOT NULL DEFAULT '[]',
    types_json TEXT NOT NULL DEFAULT '[]',
    artist TEXT,
    regulation_mark TEXT,
    national_pokedex_numbers_json TEXT NOT NULL DEFAULT '[]',
    image_url TEXT,
    image_small_url TEXT,
    tcgplayer_id TEXT,
    source_payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_tcgplayer_id ON cards(tcgplayer_id);

CREATE TABLE IF NOT EXISTS expansions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    series TEXT,
    code TEXT,
    language TEXT,
    release_date TEXT,
    logo_url TEXT,
    symbol_url TEXT,
    image_url TEXT,
    source_provider TEXT,
    source_payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expansions_release_date ON expansions(release_date);
CREATE INDEX IF NOT EXISTS idx_expansions_series ON expansions(series);

CREATE TABLE IF NOT EXISTS card_name_aliases (
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    normalized_alias TEXT NOT NULL,
    alias_language TEXT,
    alias_kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (card_id, normalized_alias, alias_kind)
);

CREATE TABLE IF NOT EXISTS card_price_snapshots (
    card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    display_currency_code TEXT NOT NULL,
    default_raw_variant TEXT,
    default_raw_condition TEXT,
    default_raw_low_price REAL,
    default_raw_market_price REAL,
    default_raw_mid_price REAL,
    default_raw_high_price REAL,
    default_raw_direct_low_price REAL,
    default_raw_trend_price REAL,
    raw_contexts_json TEXT NOT NULL DEFAULT '{}',
    graded_contexts_json TEXT NOT NULL DEFAULT '{}',
    source_url TEXT,
    source_updated_at TEXT,
    source_payload_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_price_history_daily (
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    price_date TEXT NOT NULL,
    display_currency_code TEXT NOT NULL,
    default_raw_variant TEXT,
    default_raw_condition TEXT,
    default_raw_low_price REAL,
    default_raw_market_price REAL,
    default_raw_mid_price REAL,
    default_raw_high_price REAL,
    default_raw_direct_low_price REAL,
    default_raw_trend_price REAL,
    raw_contexts_json TEXT NOT NULL DEFAULT '{}',
    graded_contexts_json TEXT NOT NULL DEFAULT '{}',
    source_url TEXT,
    source_payload_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (card_id, price_date)
);

CREATE TABLE IF NOT EXISTS fx_rate_snapshots (
    id TEXT PRIMARY KEY,
    base_currency TEXT NOT NULL,
    quote_currency TEXT NOT NULL,
    rate REAL NOT NULL,
    source TEXT NOT NULL,
    effective_at TEXT,
    source_url TEXT,
    source_payload_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_events (
    scan_id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    created_at TEXT NOT NULL,
    resolver_mode TEXT,
    resolver_path TEXT,
    request_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    matcher_source TEXT,
    matcher_version TEXT,
    predicted_card_id TEXT,
    selected_card_id TEXT,
    selected_rank INTEGER,
    was_top_prediction INTEGER,
    selection_source TEXT,
    confirmed_card_id TEXT,
    confirmation_source TEXT,
    deck_entry_id TEXT,
    confidence TEXT,
    review_disposition TEXT,
    correction_type TEXT,
    completed_at TEXT,
    confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS scan_artifacts (
    scan_id TEXT PRIMARY KEY REFERENCES scan_events(scan_id) ON DELETE CASCADE,
    owner_user_id TEXT,
    -- Nullable: a scan may persist only the normalized_target (the training image)
    -- when the optional source_capture base64 is unavailable, or neither when an
    -- upload is attempted-but-failed (upload_status='failed'). See store_scan_artifacts.
    source_object_path TEXT,
    normalized_object_path TEXT,
    source_width INTEGER,
    source_height INTEGER,
    normalized_width INTEGER,
    normalized_height INTEGER,
    camera_zoom_factor REAL,
    capture_source TEXT,
    upload_status TEXT NOT NULL,
    uploaded_at TEXT,
    artifact_version TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS labeling_sessions (
    session_id TEXT PRIMARY KEY,
    labeler_user_id TEXT,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    provider_card_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('capturing', 'completed', 'aborted')),
    tier_assignment TEXT CHECK(tier_assignment IN ('tier2', 'tier3')),
    routed_batch_id TEXT,
    first_capture_scan_id TEXT REFERENCES scan_events(scan_id),
    selected_card_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    aborted_at TEXT,
    abort_reason TEXT
);

CREATE TABLE IF NOT EXISTS labeling_session_artifacts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES labeling_sessions(session_id) ON DELETE CASCADE,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    scan_id TEXT REFERENCES scan_events(scan_id) ON DELETE CASCADE,
    angle_index INTEGER NOT NULL,
    angle_label TEXT NOT NULL,
    dataset_role TEXT CHECK(dataset_role IN ('tier2', 'tier3')),
    source_object_path TEXT NOT NULL,
    normalized_object_path TEXT NOT NULL,
    source_width INTEGER,
    source_height INTEGER,
    normalized_width INTEGER,
    normalized_height INTEGER,
    native_metadata_json TEXT NOT NULL DEFAULT '{}',
    crop_metadata_json TEXT NOT NULL DEFAULT '{}',
    normalization_metadata_json TEXT NOT NULL DEFAULT '{}',
    source_branch TEXT,
    pixels_per_card_height REAL,
    processing_ms REAL,
    scanner_front_half_version TEXT,
    submitted_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(session_id, angle_index)
);

CREATE TABLE IF NOT EXISTS scan_prediction_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT NOT NULL REFERENCES scan_events(scan_id) ON DELETE CASCADE,
    rank INTEGER NOT NULL,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    final_score REAL,
    candidate_json TEXT NOT NULL,
    UNIQUE(scan_id, rank)
);

CREATE TABLE IF NOT EXISTS scan_price_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT NOT NULL REFERENCES scan_events(scan_id) ON DELETE CASCADE,
    rank INTEGER NOT NULL,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    pricing_source TEXT,
    pricing_mode TEXT,
    grader TEXT,
    grade TEXT,
    variant TEXT,
    currency_code TEXT,
    low_price REAL,
    market_price REAL,
    mid_price REAL,
    high_price REAL,
    trend_price REAL,
    source_updated_at TEXT,
    snapshot_updated_at TEXT,
    observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_confirmations (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL REFERENCES scan_events(scan_id) ON DELETE CASCADE,
    owner_user_id TEXT,
    confirmed_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    confirmation_source TEXT NOT NULL,
    selected_rank INTEGER,
    was_top_prediction INTEGER NOT NULL,
    deck_entry_id TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_favorites (
    owner_user_id TEXT NOT NULL,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_user_id, card_id)
);

CREATE TABLE IF NOT EXISTS deck_entries (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    identity_key TEXT,
    item_kind TEXT NOT NULL,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    grader TEXT,
    grade TEXT,
    cert_number TEXT,
    variant_name TEXT,
    condition TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    cost_basis_total REAL NOT NULL DEFAULT 0,
    cost_basis_currency_code TEXT,
    added_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    source_scan_id TEXT REFERENCES scan_events(scan_id),
    source_confirmation_id TEXT REFERENCES scan_confirmations(id),
    -- Per-unit cost basis in cents, captured at add-to-collection time (optional).
    -- When set, this is the authoritative cost basis for Insights aggregates;
    -- the legacy `cost_basis_total` (REAL dollars) is maintained in parallel for
    -- backward compatibility.
    cost_basis_cents BIGINT,
    -- Lightweight "Mark as Listed" tagging (no live eBay API). When listingUrl
    -- is set, the inventory tile shows the "Live on eBay" footer. Auto-cleared
    -- on sale with a snapshot copied into `sale_events.last_listing_snapshot`.
    listing_url TEXT,
    listing_price_cents BIGINT,
    listed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sale_events (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    deck_entry_id TEXT NOT NULL REFERENCES deck_entries(id) ON DELETE CASCADE,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price REAL,
    total_price REAL,
    currency_code TEXT,
    payment_method TEXT,
    cost_basis_total REAL,
    cost_basis_unit_price REAL,
    sale_source TEXT NOT NULL DEFAULT 'manual',
    show_session_id TEXT,
    note TEXT,
    sold_at TEXT NOT NULL,
    paid_at TEXT,
    voided_at TEXT,
    source_scan_id TEXT REFERENCES scan_events(scan_id),
    source_confirmation_id TEXT REFERENCES scan_confirmations(id),
    created_at TEXT NOT NULL,
    -- Cost-basis snapshot captured at sell-time (per-unit cents). Sourced from
    -- the inventory row's `cost_basis_cents` at the moment of sale so it stays
    -- stable even if the inventory row is later edited or deleted.
    cost_basis_per_unit_cents BIGINT,
    -- Derived profit in cents = (unit_price_cents − cost_basis_per_unit_cents) × quantity.
    -- Null when cost_basis_per_unit_cents is null.
    profit_cents BIGINT,
    -- Snapshot of the inventory row's active listing fields at the moment of
    -- sale, preserved for the Sales/Insights surfaces. JSON with keys:
    --   listing_url, listing_price_cents, listed_at
    last_listing_snapshot JSONB
);

-- Standalone "memory bank" transaction ledger. Decoupled from inventory: no
-- card_id/deck_entry_id, no profit/cost-basis. A single user-captured photo
-- lives on the row (private, served via an auth-gated proxy), mirroring the
-- scan_artifacts *_object_path / upload_status semantics.
CREATE TABLE IF NOT EXISTS card_transactions (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('bought','sold','traded')),
    amount_cents BIGINT,                    -- cents (nullable); matches profit_cents/cost_basis_*_cents convention
    item_count INTEGER NOT NULL DEFAULT 1,  -- number of items in the lot
    currency_code TEXT NOT NULL DEFAULT 'USD',
    note TEXT,
    photo_object_path TEXT,                 -- object path in the artifact store (GCS / filesystem)
    photo_upload_status TEXT,               -- 'uploaded' | 'failed' | NULL
    photo_uploaded_at TEXT,
    photo_width INTEGER,
    photo_height INTEGER,
    image_url TEXT,                         -- optional absolute catalog image URL for the card
    occurred_at TEXT NOT NULL,              -- the day it happened (client-supplied ISO)
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_transactions_owner_occurred
    ON card_transactions (owner_user_id, occurred_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS deck_entry_events (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    deck_entry_id TEXT NOT NULL REFERENCES deck_entries(id) ON DELETE CASCADE,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    event_kind TEXT NOT NULL,
    quantity_delta INTEGER NOT NULL DEFAULT 0,
    unit_price REAL,
    total_price REAL,
    currency_code TEXT,
    payment_method TEXT,
    condition TEXT,
    grader TEXT,
    grade TEXT,
    cert_number TEXT,
    variant_name TEXT,
    sale_id TEXT REFERENCES sale_events(id) ON DELETE CASCADE,
    source_scan_id TEXT REFERENCES scan_events(scan_id),
    source_confirmation_id TEXT REFERENCES scan_confirmations(id),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS slab_recent_sales_cache (
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    grader TEXT NOT NULL,
    grade TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('available', 'no_results')),
    result_count INTEGER NOT NULL DEFAULT 0,
    fetched_at TEXT NOT NULL,
    source_url TEXT,
    source_payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (card_id, grader, grade, source)
);

CREATE TABLE IF NOT EXISTS slab_recent_sales (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    grader TEXT NOT NULL,
    grade TEXT NOT NULL,
    source TEXT NOT NULL,
    source_sale_id TEXT,
    rank INTEGER NOT NULL,
    title TEXT,
    sold_at TEXT,
    price REAL,
    currency_code TEXT,
    listing_url TEXT,
    variant TEXT,
    source_payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY (card_id, grader, grade, source)
        REFERENCES slab_recent_sales_cache(card_id, grader, grade, source)
        ON DELETE CASCADE,
    UNIQUE(card_id, grader, grade, source, rank),
    UNIQUE(card_id, grader, grade, source, source_sale_id)
);

CREATE TABLE IF NOT EXISTS provider_sync_runs (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    sync_scope TEXT NOT NULL,
    status TEXT NOT NULL,
    scheduled_for TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    page_size INTEGER NOT NULL,
    pages_fetched INTEGER NOT NULL DEFAULT 0,
    cards_seen INTEGER NOT NULL DEFAULT 0,
    cards_upserted INTEGER NOT NULL DEFAULT 0,
    raw_snapshots_upserted INTEGER NOT NULL DEFAULT 0,
    graded_snapshots_upserted INTEGER NOT NULL DEFAULT 0,
    estimated_credits_used INTEGER,
    usage_before_json TEXT NOT NULL DEFAULT '{}',
    usage_after_json TEXT NOT NULL DEFAULT '{}',
    error_text TEXT,
    notes_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS runtime_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_import_jobs (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    source_type TEXT NOT NULL,
    status TEXT NOT NULL,
    source_file_name TEXT,
    source_sha256 TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    matched_count INTEGER NOT NULL DEFAULT 0,
    ambiguous_count INTEGER NOT NULL DEFAULT 0,
    unresolved_count INTEGER NOT NULL DEFAULT 0,
    unsupported_count INTEGER NOT NULL DEFAULT 0,
    committed_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    summary_json TEXT NOT NULL DEFAULT '{}',
    error_text TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    committed_at TEXT
);

CREATE TABLE IF NOT EXISTS portfolio_import_rows (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES portfolio_import_jobs(id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL,
    source_collection_name TEXT,
    raw_row_json TEXT NOT NULL DEFAULT '{}',
    normalized_row_json TEXT NOT NULL DEFAULT '{}',
    match_status TEXT NOT NULL,
    matched_card_id TEXT REFERENCES cards(id) ON DELETE SET NULL,
    match_strategy TEXT,
    candidate_card_ids_json TEXT NOT NULL DEFAULT '[]',
    quantity INTEGER,
    condition TEXT,
    variant_name TEXT,
    currency_code TEXT,
    acquisition_unit_price REAL,
    acquisition_total_price REAL,
    market_unit_price REAL,
    commit_action TEXT,
    commit_result_json TEXT,
    error_text TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(job_id, row_index)
);

CREATE TABLE IF NOT EXISTS card_external_refs (
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_cards_name_set_number
    ON cards(name, set_name, number);

CREATE INDEX IF NOT EXISTS idx_cards_set_name
    ON cards(set_name);

CREATE INDEX IF NOT EXISTS idx_cards_number
    ON cards(number);

CREATE INDEX IF NOT EXISTS idx_cards_number_upper
    ON cards(UPPER(number), language, set_release_date, id);

CREATE INDEX IF NOT EXISTS idx_cards_set_id
    ON cards(set_id);

CREATE INDEX IF NOT EXISTS idx_cards_set_ptcgo_code
    ON cards(set_ptcgo_code);

CREATE INDEX IF NOT EXISTS idx_card_name_aliases_normalized_alias
    ON card_name_aliases(normalized_alias);

CREATE INDEX IF NOT EXISTS idx_card_name_aliases_card_id
    ON card_name_aliases(card_id);

CREATE INDEX IF NOT EXISTS idx_card_price_snapshots_lookup
    ON card_price_snapshots(card_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_card_price_snapshots_provider_updated_at
    ON card_price_snapshots(provider, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_card_price_history_daily_lookup
    ON card_price_history_daily(card_id, price_date DESC);

CREATE INDEX IF NOT EXISTS idx_card_price_history_daily_card_provider_lookup
    ON card_price_history_daily(card_id, provider, price_date DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_card_price_history_daily_date
    ON card_price_history_daily(price_date DESC, card_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_fx_rate_snapshots_lookup
    ON fx_rate_snapshots(base_currency, quote_currency, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_scan_events_created_at
    ON scan_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_events_resolver_mode
    ON scan_events(resolver_mode, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_events_owner_user_id
    ON scan_events(owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_scan_events_selected_card_id
    ON scan_events(selected_card_id);

CREATE INDEX IF NOT EXISTS idx_scan_events_predicted_card_id
    ON scan_events(predicted_card_id);

CREATE INDEX IF NOT EXISTS idx_scan_events_confirmed_card_id
    ON scan_events(confirmed_card_id);

CREATE INDEX IF NOT EXISTS idx_scan_events_deck_entry_id
    ON scan_events(deck_entry_id);

CREATE INDEX IF NOT EXISTS idx_labeling_sessions_card_status
    ON labeling_sessions(card_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_labeling_sessions_provider_card
    ON labeling_sessions(provider_card_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_labeling_session_artifacts_session_angle
    ON labeling_session_artifacts(session_id, angle_index);

CREATE INDEX IF NOT EXISTS idx_labeling_session_artifacts_card
    ON labeling_session_artifacts(card_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_labeling_session_artifacts_scan_id
    ON labeling_session_artifacts(scan_id);

CREATE INDEX IF NOT EXISTS idx_scan_prediction_candidates_scan_rank
    ON scan_prediction_candidates(scan_id, rank);

CREATE INDEX IF NOT EXISTS idx_scan_price_observations_scan_rank
    ON scan_price_observations(scan_id, rank);

CREATE INDEX IF NOT EXISTS idx_scan_confirmations_scan_id
    ON scan_confirmations(scan_id);
CREATE INDEX IF NOT EXISTS idx_scan_confirmations_owner_user_id
    ON scan_confirmations(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_artifacts_owner_user_id
    ON scan_artifacts(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_card_favorites_owner_user_id
    ON card_favorites(owner_user_id, created_at DESC, card_id);
CREATE INDEX IF NOT EXISTS idx_card_favorites_card_id
    ON card_favorites(card_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deck_entries_card_id
    ON deck_entries(card_id);
CREATE INDEX IF NOT EXISTS idx_deck_entries_owner_user_id
    ON deck_entries(owner_user_id, added_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_entries_owner_identity
    ON deck_entries(owner_user_id, identity_key);

CREATE INDEX IF NOT EXISTS idx_deck_entries_added_at
    ON deck_entries(added_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_deck_entries_quantity
    ON deck_entries(quantity, added_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sale_events_deck_entry_id
    ON sale_events(deck_entry_id, sold_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sale_events_owner_user_id
    ON sale_events(owner_user_id, sold_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sale_events_sold_at
    ON sale_events(sold_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deck_entry_events_deck_entry_id
    ON deck_entry_events(deck_entry_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_deck_entry_events_owner_user_id
    ON deck_entry_events(owner_user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_deck_entry_events_created_at
    ON deck_entry_events(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_slab_recent_sales_context
    ON slab_recent_sales(card_id, grader, grade, source, rank);

CREATE INDEX IF NOT EXISTS idx_slab_recent_sales_cache_fetched_at
    ON slab_recent_sales_cache(fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_sync_runs_provider_scope_started
    ON provider_sync_runs(provider, sync_scope, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_settings_updated_at
    ON runtime_settings(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_portfolio_import_jobs_created_at
    ON portfolio_import_jobs(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_portfolio_import_jobs_status
    ON portfolio_import_jobs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_portfolio_import_jobs_owner_user_id
    ON portfolio_import_jobs(owner_user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_portfolio_import_rows_job_row
    ON portfolio_import_rows(job_id, row_index ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_portfolio_import_rows_job_status
    ON portfolio_import_rows(job_id, match_status, row_index ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_portfolio_import_rows_job_committed
    ON portfolio_import_rows(job_id, commit_result_json, row_index ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_card_external_refs_card_id
    ON card_external_refs(card_id);

-- Friend-reviewer labels for the reviewer-gated "label unlabeled scans" web
-- surface. These are not deck events: a trusted reviewer labels someone else's
-- scan without creating a deck entry. See
-- docs/scan-data-labeling-pipeline-spec-2026-04-23.md.
CREATE TABLE IF NOT EXISTS scan_labeling_reviews (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL,
    reviewer_user_id TEXT NOT NULL,
    reviewer_role TEXT NOT NULL,
    labeled_card_id TEXT,
    label_disposition TEXT NOT NULL,
    selected_rank INTEGER,
    was_top_prediction INTEGER,
    notes TEXT,
    queue_id TEXT,
    created_at TEXT NOT NULL,
    labeled_variant TEXT,
    UNIQUE(scan_id, reviewer_user_id)
);

CREATE INDEX IF NOT EXISTS idx_scan_labeling_reviews_scan_id
    ON scan_labeling_reviews(scan_id, label_disposition);

CREATE INDEX IF NOT EXISTS idx_scan_labeling_reviews_reviewer
    ON scan_labeling_reviews(reviewer_user_id, created_at DESC);

-- Public App Store ACCESS GATE. When the card-show gate is CLOSED, only allowed
-- users may use the protected backend. ``access_grants`` persists a redeemed
-- invite-code grant per account; ``access_waitlist`` captures early-access email
-- sign-ups from blocked users. Both are additive and reversible (DROP TABLE).
CREATE TABLE IF NOT EXISTS access_grants (
    user_id TEXT PRIMARY KEY,
    email TEXT,
    granted_via TEXT,
    granted_at TEXT
);

CREATE TABLE IF NOT EXISTS access_waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    user_id TEXT,
    created_at TEXT
);

-- Local mirror of Supabase user emails (we only receive them live from the JWT),
-- captured on access checks + backfilled from auth.users via the admin sync.
CREATE TABLE IF NOT EXISTS user_emails (
    user_id TEXT PRIMARY KEY,
    email TEXT,
    updated_at TEXT
);
