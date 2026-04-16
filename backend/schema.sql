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
    source_payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

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
    source_object_path TEXT NOT NULL,
    normalized_object_path TEXT NOT NULL,
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
    confirmed_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    confirmation_source TEXT NOT NULL,
    selected_rank INTEGER,
    was_top_prediction INTEGER NOT NULL,
    deck_entry_id TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deck_entries (
    id TEXT PRIMARY KEY,
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
    source_confirmation_id TEXT REFERENCES scan_confirmations(id)
);

CREATE TABLE IF NOT EXISTS sale_events (
    id TEXT PRIMARY KEY,
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
    source_scan_id TEXT REFERENCES scan_events(scan_id),
    source_confirmation_id TEXT REFERENCES scan_confirmations(id),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deck_entry_events (
    id TEXT PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_cards_name_set_number
    ON cards(name, set_name, number);

CREATE INDEX IF NOT EXISTS idx_cards_set_name
    ON cards(set_name);

CREATE INDEX IF NOT EXISTS idx_cards_number
    ON cards(number);

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

CREATE INDEX IF NOT EXISTS idx_card_price_history_daily_lookup
    ON card_price_history_daily(card_id, price_date DESC);

CREATE INDEX IF NOT EXISTS idx_card_price_history_daily_date
    ON card_price_history_daily(price_date DESC, card_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_fx_rate_snapshots_lookup
    ON fx_rate_snapshots(base_currency, quote_currency, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_scan_events_created_at
    ON scan_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_scan_events_selected_card_id
    ON scan_events(selected_card_id);

CREATE INDEX IF NOT EXISTS idx_scan_events_predicted_card_id
    ON scan_events(predicted_card_id);

CREATE INDEX IF NOT EXISTS idx_scan_events_confirmed_card_id
    ON scan_events(confirmed_card_id);

CREATE INDEX IF NOT EXISTS idx_scan_events_deck_entry_id
    ON scan_events(deck_entry_id);

CREATE INDEX IF NOT EXISTS idx_scan_prediction_candidates_scan_rank
    ON scan_prediction_candidates(scan_id, rank);

CREATE INDEX IF NOT EXISTS idx_scan_price_observations_scan_rank
    ON scan_price_observations(scan_id, rank);

CREATE INDEX IF NOT EXISTS idx_scan_confirmations_scan_id
    ON scan_confirmations(scan_id);

CREATE INDEX IF NOT EXISTS idx_deck_entries_card_id
    ON deck_entries(card_id);

CREATE INDEX IF NOT EXISTS idx_deck_entries_added_at
    ON deck_entries(added_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_deck_entries_quantity
    ON deck_entries(quantity, added_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sale_events_deck_entry_id
    ON sale_events(deck_entry_id, sold_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sale_events_sold_at
    ON sale_events(sold_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deck_entry_events_deck_entry_id
    ON deck_entry_events(deck_entry_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_deck_entry_events_created_at
    ON deck_entry_events(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_provider_sync_runs_provider_scope_started
    ON provider_sync_runs(provider, sync_scope, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_settings_updated_at
    ON runtime_settings(updated_at DESC);
