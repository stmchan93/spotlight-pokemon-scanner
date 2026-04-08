PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    set_name TEXT NOT NULL,
    number TEXT NOT NULL,
    rarity TEXT NOT NULL,
    variant TEXT NOT NULL,
    language TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_images (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    source_url TEXT,
    local_path TEXT,
    image_sha256 TEXT,
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_catalog_metadata (
    card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_record_id TEXT NOT NULL,
    set_id TEXT,
    set_series TEXT,
    set_ptcgo_code TEXT,
    set_release_date TEXT,
    supertype TEXT,
    subtypes_json TEXT,
    types_json TEXT,
    national_pokedex_numbers_json TEXT,
    artist TEXT,
    regulation_mark TEXT,
    images_small_url TEXT,
    images_large_url TEXT,
    tcgplayer_json TEXT,
    cardmarket_json TEXT,
    source_payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_price_summaries (
    card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    currency_code TEXT NOT NULL,
    variant TEXT,
    low_price REAL,
    market_price REAL,
    mid_price REAL,
    high_price REAL,
    direct_low_price REAL,
    trend_price REAL,
    source_updated_at TEXT,
    source_url TEXT,
    source_payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_price_mappings (
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT,
    url TEXT,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (card_id, provider)
);

CREATE TABLE IF NOT EXISTS slab_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    grader TEXT NOT NULL,
    grade TEXT NOT NULL,
    sale_price REAL NOT NULL,
    currency_code TEXT NOT NULL,
    sale_date TEXT NOT NULL,
    source TEXT NOT NULL,
    source_listing_id TEXT,
    source_url TEXT,
    cert_number TEXT,
    title TEXT,
    bucket_key TEXT,
    accepted INTEGER NOT NULL DEFAULT 1,
    source_payload_json TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS slab_price_snapshots (
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    grader TEXT NOT NULL,
    grade TEXT NOT NULL,
    pricing_tier TEXT NOT NULL,
    currency_code TEXT NOT NULL,
    low_price REAL,
    market_price REAL,
    mid_price REAL,
    high_price REAL,
    last_sale_price REAL,
    last_sale_date TEXT,
    comp_count INTEGER NOT NULL DEFAULT 0,
    recent_comp_count INTEGER NOT NULL DEFAULT 0,
    confidence_level INTEGER NOT NULL DEFAULT 1,
    confidence_label TEXT NOT NULL,
    bucket_key TEXT,
    source_url TEXT,
    source_payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (card_id, grader, grade)
);

CREATE TABLE IF NOT EXISTS embedding_models (
    id TEXT PRIMARY KEY,
    family TEXT NOT NULL,
    version TEXT NOT NULL,
    modality TEXT NOT NULL,
    dimension INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_embeddings (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    image_id TEXT REFERENCES card_images(id) ON DELETE SET NULL,
    model_id TEXT NOT NULL REFERENCES embedding_models(id),
    vector_json TEXT NOT NULL,
    vector_norm REAL NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_events (
    scan_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    request_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    matcher_source TEXT NOT NULL,
    matcher_version TEXT NOT NULL,
    selected_card_id TEXT,
    correction_type TEXT,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS scan_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT NOT NULL REFERENCES scan_events(scan_id) ON DELETE CASCADE,
    rank INTEGER NOT NULL,
    card_id TEXT NOT NULL REFERENCES cards(id),
    retrieval_score REAL NOT NULL,
    rerank_score REAL NOT NULL,
    final_score REAL NOT NULL,
    reasons_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT NOT NULL REFERENCES scan_events(scan_id) ON DELETE CASCADE,
    selected_card_id TEXT,
    was_top_prediction INTEGER NOT NULL,
    correction_type TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    feedback_json TEXT
);

CREATE TABLE IF NOT EXISTS catalog_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    sync_mode TEXT NOT NULL,
    trigger_source TEXT,
    query_text TEXT,
    status TEXT NOT NULL,
    cards_before INTEGER NOT NULL DEFAULT 0,
    cards_after INTEGER NOT NULL DEFAULT 0,
    cards_added INTEGER NOT NULL DEFAULT 0,
    cards_updated INTEGER NOT NULL DEFAULT 0,
    missing_after_sync INTEGER NOT NULL DEFAULT 0,
    summary_json TEXT NOT NULL DEFAULT '{}',
    error_text TEXT
);

CREATE TABLE IF NOT EXISTS pricing_refresh_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT,
    grader TEXT,
    grade TEXT,
    source TEXT NOT NULL,
    error_text TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_card_embeddings_card_id ON card_embeddings(card_id);
CREATE INDEX IF NOT EXISTS idx_card_catalog_metadata_set_id ON card_catalog_metadata(set_id);
CREATE INDEX IF NOT EXISTS idx_card_price_summaries_source ON card_price_summaries(source);
CREATE INDEX IF NOT EXISTS idx_external_price_mappings_provider ON external_price_mappings(provider);
CREATE INDEX IF NOT EXISTS idx_slab_sales_card_grade ON slab_sales(card_id, grader, grade);
CREATE INDEX IF NOT EXISTS idx_slab_sales_bucket_grade ON slab_sales(bucket_key, grader, grade);
CREATE INDEX IF NOT EXISTS idx_slab_sales_sale_date ON slab_sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_slab_sales_cert_lookup ON slab_sales(grader, cert_number);
CREATE INDEX IF NOT EXISTS idx_scan_candidates_scan_id ON scan_candidates(scan_id);
CREATE INDEX IF NOT EXISTS idx_scan_feedback_scan_id ON scan_feedback(scan_id);
CREATE INDEX IF NOT EXISTS idx_catalog_sync_runs_started_at ON catalog_sync_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_pricing_refresh_failures_created_at ON pricing_refresh_failures(created_at);
