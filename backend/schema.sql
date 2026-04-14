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
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    pricing_mode TEXT NOT NULL,
    provider TEXT NOT NULL,
    grader TEXT,
    grade TEXT,
    variant TEXT,
    currency_code TEXT NOT NULL,
    low_price REAL,
    market_price REAL,
    mid_price REAL,
    high_price REAL,
    direct_low_price REAL,
    trend_price REAL,
    source_url TEXT,
    source_updated_at TEXT,
    source_payload_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
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
    selected_card_id TEXT,
    confidence TEXT,
    review_disposition TEXT,
    correction_type TEXT,
    completed_at TEXT
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
    ON card_price_snapshots(card_id, pricing_mode, grader, grade, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_fx_rate_snapshots_lookup
    ON fx_rate_snapshots(base_currency, quote_currency, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_scan_events_created_at
    ON scan_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_scan_events_selected_card_id
    ON scan_events(selected_card_id);

CREATE INDEX IF NOT EXISTS idx_provider_sync_runs_provider_scope_started
    ON provider_sync_runs(provider, sync_scope, started_at DESC);
