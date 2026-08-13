#!/usr/bin/env python3
"""Produce the CUTOVER SQLite database: prod base + per-owner union of staging.

Context: docs/production-promotion-plan-2026-08-12.md (ADDENDUM: both SQLites
kept receiving writes after the 2026-07-10 fork), docs/production-promotion-
checklist-2026-08-12.md Phase 2, and the identity migration companion
tools/migrate_identity_staging_to_prod.py whose uuid remap this script consumes
(tools/migration_out/uuid_remap_staging_prod.json).

WHAT THIS DOES (all LOCAL — never touches a VM or Supabase)
  1. Copies the PROD snapshot to the output path: prod's fresh catalog/pricing/
     cell tables and its ~24k post-split user rows are the BASE.
  2. Schema-reconciles the base to staging's user-table schema (staging ran the
     newer backend): creates missing user tables (collections, ...), adds
     missing nullable columns (deck_entries.collection_id, added_market_*, ...),
     replaces the outdated deck_entries unique index — exactly what the new
     server.py startup patches would do, done ahead of time so staging rows fit.
  3. Applies the uuid remap old-prod-uuid -> staging-uuid across ALL text
     columns of user-owned tables (owner columns AND embedded JSON), so e.g.
     johnsonma626's two histories become one owner.
  4. Deletes test@test.com entirely (BOTH its uuids; excluded from the remap).
     Drops staging's anonymous users (cannot re-authenticate on prod).
  5. Per-owner merge of every user-owned table, owner keyed by CANONICAL
     (post-remap) uuid:
       - owner only in staging ................ INSERT staging rows
       - owner in both, post-fork writes only
         on staging ........................... REPLACE (staging wins; deletions
                                                 made on staging stay deleted)
       - owner in both, post-fork writes on
         BOTH (dual-activity) ................. UNION by primary key; on PK
                                                 collision newest-updated wins
       - owner in both, post-fork writes only
         on prod (or dormant) ................. KEEP base rows, staging skipped
     Child tables without owner columns (scan_prediction_candidates,
     scan_price_observations, portfolio_import_rows, labeling_session_artifacts)
     follow their parent row's decision. NULL-owner rows: union by PK, base wins.
  6. INTEGER PRIMARY KEY AUTOINCREMENT tables (scan_prediction_candidates,
     scan_price_observations, access_waitlist — the only three, none of whose
     ids are referenced by any other table) get fresh ids on insert; every other
     user table has a TEXT uuid/ULID PK which is preserved verbatim (cross-DB
     collisions are asserted absent outside intentional shared pre-fork rows).
  7. Catalog/pricing tables ride from prod untouched. runtime_settings ride
     from prod untouched — but scan_artifact_uploads and card_show_mode values
     from BOTH DBs are listed in the report for the runbook to decide.
  8. Verification: catalog counts == prod's; per-owner row counts preserved;
     PRAGMA foreign_key_check + explicit orphan queries per FK edge; zero
     remap-source uuids and zero test@test.com uuids anywhere in user tables;
     20 random deck_entries resolve to valid cards/collections; quick_check.

MODES
  --dry-run (default)  full merge into a THROWAWAY work copy + verification +
                       report; the work copy is deleted (keep with
                       --keep-merged). Nothing outside the local machine is
                       touched in ANY mode.
  --apply              writes the merged DB to --out and keeps it. Requires
                       MERGE_CONFIRM=yes in the environment. Shipping the file
                       to the prod VM is a separate manual runbook step —
                       deliberately not scripted here.

USAGE
  python3 tools/merge_sqlite_staging_prod.py \
      --staging-snapshot /path/staging.sqlite --prod-snapshot /path/prod.sqlite
  MERGE_CONFIRM=yes python3 tools/merge_sqlite_staging_prod.py --apply \
      --staging-snapshot ... --prod-snapshot ... --out /path/merged.sqlite

Snapshots must be standalone SQLite files (WAL already recovered/checkpointed;
the script aborts if a -wal sits next to a snapshot). The staging snapshot may
be a full copy OR an extract that contains at least every user-owned table —
the script cross-checks the live table inventory embedded below and reports
any table it does not recognize instead of guessing.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import random
import shutil
import sqlite3
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_REMAP = os.path.join(REPO_ROOT, "tools", "migration_out", "uuid_remap_staging_prod.json")
DEFAULT_REPORT_DIR = os.path.join(REPO_ROOT, "tools", "migration_out")

# The moment the two DBs forked (VM split 2026-07-10). Rows stamped after this
# on a side mean that side saw post-split activity for the owner.
DEFAULT_FORK_TS = "2026-07-10T00:00:00"

# USER DECISION 2026-08-12: test@test.com is fully removed, not remapped.
# Left = its pre-split prod uuid, right = its staging uuid (both deleted).
TEST_ACCOUNT_UUIDS = {
    "681c96c3-4b25-4e89-a177-9c7d9f664c68",  # old prod uuid (~190 rows on prod)
    "2baa9c54-07ad-442a-892b-e5e94a3d6752",  # staging uuid
}
TEST_ACCOUNT_REMAP_OLD = "681c96c3-4b25-4e89-a177-9c7d9f664c68"

# USER DECISION 2026-08-12: staging's two anonymous users are dropped (an anon
# identity cannot re-authenticate on the prod Supabase project).
DEFAULT_DROP_OWNERS = {
    "e6b5bdce-0dd3-45c1-8518-c9fd938f148e",
    "b79834d3-44cd-468e-b4f2-560fd493ab73",
}

# ---------------------------------------------------------------------------
# Schema ownership map — verified against backend/schema.sql, the server.py
# startup patches, server.py _ACCOUNT_DELETION_TABLES, and the LIVE table
# inventories of both VMs on 2026-08-12. Any table found in either snapshot
# that is not classified below ABORTS the merge (open question, never a guess).
# ---------------------------------------------------------------------------

# Catalog / pricing / provider-cache tables: prod's are fresh (daily sync),
# staging's frozen since ~2026-07-19. Base (prod) rows are kept untouched.
CATALOG_TABLES = {
    "cards",
    "expansions",
    "card_name_aliases",
    "card_artist_aliases",
    "card_price_snapshots",
    "card_price_history_daily",
    "card_price_history_cell",
    "_dead_partial_cell",           # cell-migration leftover, identical on both
    "fx_rate_snapshots",
    "ppt_graded_signals",
    "card_language_links",
    "slab_recent_sales",
    "slab_recent_sales_cache",
    "card_ebay_listings_cache",     # short-TTL cache; created empty if missing
    "card_external_refs",
    "provider_sync_runs",           # ops telemetry of the catalog sync
}

# Infra/runtime tables that ride from prod untouched.
RUNTIME_TABLES = {
    "runtime_settings",   # prod's rows kept; both sides' values in the report
    "_litestream_lock",
    "_litestream_seq",
    "sqlite_sequence",
}

# User-owned tables with a direct owner column.
#   pk: the primary key columns (TEXT uuids/ULIDs unless integer_auto)
#   ts: column used for "newest wins" + post-fork activity detection
#   integer_auto: INTEGER PRIMARY KEY AUTOINCREMENT — ids reassigned on insert
USER_TABLES = {
    "scan_events":          {"owner": "owner_user_id", "pk": ["scan_id"], "ts": "created_at"},
    "scan_artifacts":       {"owner": "owner_user_id", "pk": ["scan_id"], "ts": "created_at"},
    "scan_confirmations":   {"owner": "owner_user_id", "pk": ["id"], "ts": "created_at"},
    "deck_entries":         {"owner": "owner_user_id", "pk": ["id"], "ts": "updated_at"},
    "sale_events":          {"owner": "owner_user_id", "pk": ["id"], "ts": "created_at"},
    "deck_entry_events":    {"owner": "owner_user_id", "pk": ["id"], "ts": "created_at"},
    "collections":          {"owner": "owner_user_id", "pk": ["id"], "ts": "created_at"},
    "card_transactions":    {"owner": "owner_user_id", "pk": ["id"], "ts": "created_at"},
    "card_favorites":       {"owner": "owner_user_id", "pk": ["owner_user_id", "card_id"], "ts": "created_at"},
    "card_likes":           {"owner": "owner_user_id", "pk": ["owner_user_id", "card_id"], "ts": "created_at"},
    "card_views":           {"owner": "owner_user_id", "pk": ["owner_user_id", "card_id", "viewed_on"], "ts": "viewed_at"},
    "vendor_wallet_handles": {"owner": "owner_user_id", "pk": ["owner_user_id"], "ts": "updated_at"},
    "portfolio_import_jobs": {"owner": "owner_user_id", "pk": ["id"], "ts": "updated_at"},
    "labeling_sessions":    {"owner": "labeler_user_id", "pk": ["session_id"], "ts": "updated_at"},
    "scan_labeling_reviews": {"owner": "reviewer_user_id", "pk": ["id"], "ts": "created_at"},
    "access_grants":        {"owner": "user_id", "pk": ["user_id"], "ts": "granted_at"},
    "user_emails":          {"owner": "user_id", "pk": ["user_id"], "ts": "updated_at"},
    "access_waitlist":      {"owner": "user_id", "pk": None, "ts": "created_at",
                             "integer_auto": True,
                             "dedupe_cols": ["email", "user_id", "created_at"]},
}

# Owner-less child tables: rows belong to whichever side won their PARENT row.
CHILD_TABLES = {
    "scan_prediction_candidates": {"parent": "scan_events", "key": "scan_id",
                                   "parent_key": "scan_id", "integer_auto": True},
    "scan_price_observations":    {"parent": "scan_events", "key": "scan_id",
                                   "parent_key": "scan_id", "integer_auto": True},
    "portfolio_import_rows":      {"parent": "portfolio_import_jobs", "key": "job_id",
                                   "parent_key": "id", "pk": ["id"]},
    "labeling_session_artifacts": {"parent": "labeling_sessions", "key": "session_id",
                                   "parent_key": "session_id", "pk": ["id"]},
}

# FK edges among user-owned tables, used for explicit orphan verification.
# (child_table, child_col, parent_table, parent_col, nullable)
FK_EDGES = [
    ("scan_artifacts", "scan_id", "scan_events", "scan_id", False),
    ("scan_confirmations", "scan_id", "scan_events", "scan_id", False),
    ("scan_prediction_candidates", "scan_id", "scan_events", "scan_id", False),
    ("scan_price_observations", "scan_id", "scan_events", "scan_id", False),
    ("deck_entries", "card_id", "cards", "id", False),
    ("deck_entries", "source_scan_id", "scan_events", "scan_id", True),
    ("deck_entries", "source_confirmation_id", "scan_confirmations", "id", True),
    ("deck_entries", "collection_id", "collections", "id", True),
    ("sale_events", "deck_entry_id", "deck_entries", "id", False),
    ("sale_events", "card_id", "cards", "id", False),
    ("sale_events", "source_scan_id", "scan_events", "scan_id", True),
    ("sale_events", "source_confirmation_id", "scan_confirmations", "id", True),
    ("deck_entry_events", "deck_entry_id", "deck_entries", "id", False),
    ("deck_entry_events", "sale_id", "sale_events", "id", True),
    ("deck_entry_events", "card_id", "cards", "id", False),
    ("deck_entry_events", "source_scan_id", "scan_events", "scan_id", True),
    ("deck_entry_events", "source_confirmation_id", "scan_confirmations", "id", True),
    ("portfolio_import_rows", "job_id", "portfolio_import_jobs", "id", False),
    ("portfolio_import_rows", "matched_card_id", "cards", "id", True),
    ("labeling_sessions", "card_id", "cards", "id", False),
    ("labeling_sessions", "first_capture_scan_id", "scan_events", "scan_id", True),
    ("labeling_session_artifacts", "session_id", "labeling_sessions", "session_id", False),
    ("labeling_session_artifacts", "card_id", "cards", "id", False),
    ("labeling_session_artifacts", "scan_id", "scan_events", "scan_id", True),
    ("card_favorites", "card_id", "cards", "id", False),
    ("card_likes", "card_id", "cards", "id", False),
    ("card_views", "card_id", "cards", "id", False),
]
# Informational only (no SQL FK; cross-owner by design, may legitimately dangle
# if the scanned owner's rows were replaced):
FK_EDGES_INFORMATIONAL = [
    ("scan_labeling_reviews", "scan_id", "scan_events", "scan_id", False),
    ("scan_events", "deck_entry_id", "deck_entries", "id", True),
    ("scan_confirmations", "deck_entry_id", "deck_entries", "id", True),
]

RUNTIME_KEYS_OF_INTEREST = ("scan_artifact_uploads", "card_show_mode")


# ---------------------------------------------------------------------------
def parse_ts(value):
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    s = s.replace(" ", "T", 1)
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        d = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    if d.tzinfo is not None:
        d = d.astimezone(dt.timezone.utc).replace(tzinfo=None)
    return d


def newest_wins(ts_a, ts_b):
    """True if a (staging) should win over b (base). Ties/None -> staging."""
    a, b = parse_ts(ts_a), parse_ts(ts_b)
    if a is None and b is None:
        return True
    if a is None:
        return False
    if b is None:
        return True
    return a >= b


class Merger:
    def __init__(self, args):
        self.args = args
        self.lines = []
        self.problems = []       # verification failures
        self.open_questions = []
        self.fork = parse_ts(args.fork_ts)
        if self.fork is None:
            sys.exit(f"unparseable --fork-ts {args.fork_ts!r}")
        self.drop_owners = set(DEFAULT_DROP_OWNERS) | set(args.drop_owner or [])
        self.load_remap()
        self.union_expect = {}   # (owner, table) -> expected merged row count

    # ----- report plumbing --------------------------------------------------
    def emit(self, s=""):
        print(s, flush=True)
        self.lines.append(s)

    def load_remap(self):
        with open(self.args.remap) as f:
            payload = json.load(f)
        remap = dict(payload["remap"])
        if TEST_ACCOUNT_REMAP_OLD not in remap:
            sys.exit("remap json does not contain the test@test.com entry — "
                     "expected to strip it; refusing to guess")
        stripped = remap.pop(TEST_ACCOUNT_REMAP_OLD)
        if stripped not in TEST_ACCOUNT_UUIDS:
            sys.exit("remap json test@test.com target uuid does not match "
                     "TEST_ACCOUNT_UUIDS — refusing")
        self.remap = remap  # old-prod-uuid -> canonical staging uuid (4 entries)

    # ----- helpers ----------------------------------------------------------
    def canon(self, uuid):
        if uuid is None:
            return None
        return self.remap.get(uuid, uuid)

    def canon_sql(self, col):
        """SQL expression canonicalizing a uuid column through temp.uuid_remap."""
        return (f"COALESCE((SELECT new FROM temp.uuid_remap r WHERE r.old = {col}), {col})")

    def table_exists(self, con, db, name):
        return con.execute(
            f"SELECT 1 FROM {db}.sqlite_master WHERE type='table' AND name=?",
            (name,)).fetchone() is not None

    def columns(self, con, db, table):
        return [dict(r) for r in con.execute(f"PRAGMA {db}.table_info(\"{table}\")")]

    def text_columns(self, con, db, table):
        return [c["name"] for c in self.columns(con, db, table)
                if not str(c["type"]).upper().startswith(("INT", "REAL", "BIGINT", "FLOAT", "NUM", "BOOL"))]

    def count(self, con, db, table, where="1=1", params=()):
        return con.execute(f"SELECT COUNT(*) FROM {db}.\"{table}\" WHERE {where}", params).fetchone()[0]

    # ----- step 0: classification ------------------------------------------
    def classify_or_abort(self, con):
        known = CATALOG_TABLES | RUNTIME_TABLES | set(USER_TABLES) | set(CHILD_TABLES)
        for db in ("main", "stg"):
            tables = {r[0] for r in con.execute(
                f"SELECT name FROM {db}.sqlite_master WHERE type='table'")}
            unknown = tables - known
            if unknown:
                sys.exit(f"UNCLASSIFIED tables in {db} snapshot: {sorted(unknown)} — "
                         "classify them in the ownership map before merging (no guessing).")
        # staging snapshot must contain every user-owned + child table it has
        # data for; user tables missing from stg are treated as empty on stg.
        missing = [t for t in list(USER_TABLES) + list(CHILD_TABLES)
                   if not self.table_exists(con, "stg", t)]
        if missing:
            self.open_questions.append(
                f"staging snapshot lacks user tables {missing} — treated as empty on "
                "staging; confirm the snapshot/extract was complete")

    # ----- step 1: schema reconcile ----------------------------------------
    def reconcile_schema(self, con):
        self.emit("== schema reconciliation (base -> staging user-table schema) ==")
        for t in list(USER_TABLES) + list(CHILD_TABLES):
            if not self.table_exists(con, "stg", t):
                continue
            if not self.table_exists(con, "main", t):
                ddl = con.execute(
                    "SELECT sql FROM stg.sqlite_master WHERE type='table' AND name=?",
                    (t,)).fetchone()[0]
                con.execute(ddl)
                self.emit(f"  created missing table {t}")
                continue
            base_cols = {c["name"] for c in self.columns(con, "main", t)}
            stg_cols = self.columns(con, "stg", t)
            for c in stg_cols:
                if c["name"] in base_cols:
                    continue
                if c["notnull"] and c["dflt_value"] is None:
                    sys.exit(f"cannot add NOT NULL column {t}.{c['name']} without default")
                decl = f'{c["name"]} {c["type"] or "TEXT"}'
                if c["dflt_value"] is not None:
                    decl += f' DEFAULT {c["dflt_value"]}'
                con.execute(f'ALTER TABLE main."{t}" ADD COLUMN {decl}')
                self.emit(f"  added column {t}.{c['name']}")
            prod_only = [c["name"] for c in self.columns(con, "main", t)
                         if c["name"] not in {s["name"] for s in stg_cols}]
            if prod_only:
                self.open_questions.append(
                    f"{t}: columns exist on prod but not staging: {prod_only} — kept, "
                    "staging inserts leave them NULL")
        # catalog-cache table that only exists on staging: create EMPTY (cache
        # repopulates; staging's cached prices are stale).
        if not self.table_exists(con, "main", "card_ebay_listings_cache") and \
                self.table_exists(con, "stg", "card_ebay_listings_cache"):
            ddl = con.execute("SELECT sql FROM stg.sqlite_master WHERE type='table' "
                              "AND name='card_ebay_listings_cache'").fetchone()[0]
            con.execute(ddl)
            self.emit("  created card_ebay_listings_cache EMPTY (cache; staging rows stale)")

        # indexes: create staging's user-table indexes that are missing; drop
        # UNIQUE indexes the new schema no longer has (the old
        # idx_deck_entries_owner_identity blocks multi-collection rows — the
        # new server.py startup patch does this same replacement).
        stg_idx = {r[0]: (r[1], r[2]) for r in con.execute(
            "SELECT name, tbl_name, sql FROM stg.sqlite_master WHERE type='index' AND sql IS NOT NULL")}
        main_idx = {r[0]: (r[1], r[2]) for r in con.execute(
            "SELECT name, tbl_name, sql FROM main.sqlite_master WHERE type='index' AND sql IS NOT NULL")}
        user_set = set(USER_TABLES) | set(CHILD_TABLES)
        for name, (tbl, sql) in main_idx.items():
            if tbl in user_set and name not in stg_idx and "UNIQUE" in (sql or "").upper():
                con.execute(f'DROP INDEX main."{name}"')
                self.emit(f"  dropped outdated unique index {name} on {tbl}")
        for name, (tbl, sql) in stg_idx.items():
            if tbl in user_set and name not in main_idx and self.table_exists(con, "main", tbl):
                con.execute(sql)
                self.emit(f"  created index {name} on {tbl}")
        self.emit("")

    # ----- step 2: owner inventory ------------------------------------------
    def owner_inventory(self, con, db):
        """canonical owner -> {"tables": {t: n}, "last": max_ts} (None owner key
        for NULL-owner rows)."""
        inv = {}
        for t, spec in USER_TABLES.items():
            if not self.table_exists(con, db, t):
                continue
            owner, ts = spec["owner"], spec["ts"]
            has_ts = any(c["name"] == ts for c in self.columns(con, db, t))
            ts_expr = f'MAX("{ts}")' if has_ts else "NULL"
            # Tables whose PK contains the owner column: a remapped owner's rows
            # can exist under both uuid aliases and collapse on merge, so count
            # DISTINCT canonical PKs (that is what survives the merge).
            if self.owner_in_pk(t):
                pk_concat = " || '|' || ".join(
                    ("COALESCE(%s, '')" % self.canon_sql('"%s"' % c))
                    if c == owner else f'COALESCE("{c}", \'\')'
                    for c in spec["pk"])
                count_expr = f"COUNT(DISTINCT {pk_concat})"
            else:
                count_expr = "COUNT(*)"
            for o, n, last in con.execute(
                    f'SELECT {self.canon_sql(owner)} AS o, {count_expr}, {ts_expr} '
                    f'FROM {db}."{t}" GROUP BY o'):
                e = inv.setdefault(o, {"tables": {}, "last": None})
                e["tables"][t] = n
                if last is not None and (e["last"] is None or str(last) > str(e["last"])):
                    e["last"] = last
        # children counted under their parent's canonical owner
        for t, spec in CHILD_TABLES.items():
            if not (self.table_exists(con, db, t) and self.table_exists(con, db, spec["parent"])):
                continue
            powner = USER_TABLES[spec["parent"]]["owner"]
            for o, n in con.execute(
                    f'SELECT {self.canon_sql("p." + powner)} AS o, COUNT(*) '
                    f'FROM {db}."{t}" c JOIN {db}."{spec["parent"]}" p '
                    f'ON p."{spec["parent_key"]}" = c."{spec["key"]}" GROUP BY o'):
                e = inv.setdefault(o, {"tables": {}, "last": None})
                e["tables"][t] = n
        return inv

    def owner_emails(self, con):
        emails = {}
        for db in ("main", "stg"):
            if not self.table_exists(con, db, "user_emails"):
                continue
            for uid, email in con.execute(f'SELECT user_id, email FROM {db}.user_emails'):
                emails[self.canon(uid)] = email  # stg iterated last -> wins
        return emails

    # ----- step 3: delete test account --------------------------------------
    def delete_test_rows(self, con):
        self.emit("== test@test.com removal (both uuids, all user tables) ==")
        total = 0
        for uuid in sorted(TEST_ACCOUNT_UUIDS):
            n = self.delete_owner_rows(con, uuid, raw=True)
            self.emit(f"  {uuid}: deleted {n} base rows")
            total += n
        self.emit(f"  total deleted: {total}")
        self.emit("")

    def delete_owner_rows(self, con, owner_uuid, raw=False):
        """Delete an owner's rows from main (children first). raw=True matches
        the exact uuid; raw=False matches the canonical owner (post-remap)."""
        deleted = 0
        for t, spec in CHILD_TABLES.items():
            if not self.table_exists(con, "main", t):
                continue
            powner = USER_TABLES[spec["parent"]]["owner"]
            match = f'p."{powner}" = ?' if raw else f'{self.canon_sql("p." + powner)} = ?'
            cur = con.execute(
                f'DELETE FROM main."{t}" WHERE "{spec["key"]}" IN '
                f'(SELECT p."{spec["parent_key"]}" FROM main."{spec["parent"]}" p WHERE {match})',
                (owner_uuid,))
            deleted += cur.rowcount
        for t, spec in USER_TABLES.items():
            if not self.table_exists(con, "main", t):
                continue
            col = f'"{spec["owner"]}"'
            match = f'{col} = ?' if raw else f'{self.canon_sql(col)} = ?'
            cur = con.execute(f'DELETE FROM main."{t}" WHERE {match}', (owner_uuid,))
            deleted += cur.rowcount
        return deleted

    # ----- step 4: uuid remap over base -------------------------------------
    def apply_remap(self, con, label):
        pairs = sorted(self.remap.items())
        if not pairs:
            return
        self.emit(f"== uuid remap pass ({label}): {len(pairs)} old-prod uuids -> staging uuids ==")
        changed_total = 0
        for t in list(USER_TABLES) + list(CHILD_TABLES):
            if not self.table_exists(con, "main", t):
                continue
            for col in self.text_columns(con, "main", t):
                expr = f'"{col}"'
                for old, new in pairs:
                    expr = f"replace({expr}, '{old}', '{new}')"
                where = " OR ".join(f'"{col}" LIKE \'%{old}%\'' for old, _ in pairs)
                cur = con.execute(f'UPDATE main."{t}" SET "{col}" = {expr} WHERE {where}')
                if cur.rowcount:
                    self.emit(f"  {t}.{col}: {cur.rowcount} rows rewritten")
                    changed_total += cur.rowcount
        self.emit(f"  total rewritten values: {changed_total}")
        self.emit("")

    # ----- step 5: per-owner merge ------------------------------------------
    def classify_owners(self, stg_inv, base_inv):
        """owner -> mode in insert/replace/union/keep_base (+ skip lists)."""
        modes, dual, kept = {}, [], []
        for owner, e in stg_inv.items():
            if owner is None:
                continue
            if owner in TEST_ACCOUNT_UUIDS or owner in self.drop_owners:
                modes[owner] = "drop"
                continue
            stg_active = parse_ts(e["last"]) is not None and parse_ts(e["last"]) > self.fork
            b = base_inv.get(owner)
            if b is None:
                modes[owner] = "insert"
            elif not stg_active:
                modes[owner] = "keep_base"
                kept.append(owner)
            else:
                base_active = parse_ts(b["last"]) is not None and parse_ts(b["last"]) > self.fork
                if base_active:
                    modes[owner] = "union"
                    dual.append(owner)
                else:
                    modes[owner] = "replace"
        return modes, dual, kept

    def insert_cols(self, con, t, spec_auto_pk=None):
        """Column list for copying stg -> main (staging's columns; auto ids dropped)."""
        cols = [c["name"] for c in self.columns(con, "stg", t)]
        if spec_auto_pk:
            cols = [c for c in cols if c != spec_auto_pk]
        return cols

    def auto_pk_col(self, con, t):
        for c in self.columns(con, "stg", t):
            if c["pk"] and str(c["type"]).upper() == "INTEGER":
                return c["name"]
        return None

    def owner_in_pk(self, t):
        spec = USER_TABLES.get(t)
        return bool(spec and spec.get("pk") and spec["owner"] in spec["pk"])

    def copy_rows(self, con, t, where, params, integer_auto):
        """INSERT INTO main.t SELECT ... FROM stg.t WHERE ...

        The owner column is canonicalized (old-prod uuid -> staging uuid) at
        insert time: a remapped owner's staging rows exist under BOTH uuids, and
        tables whose PK contains the owner column (card_favorites, card_views,
        user_emails, ...) would otherwise collide when the final remap pass
        rewrites them. For those tables alias-duplicates are collapsed with
        INSERT OR IGNORE ordered newest-first (newest alias row wins); all other
        tables insert loudly so an unexpected PK collision aborts the merge.
        """
        spec = USER_TABLES.get(t)
        auto = self.auto_pk_col(con, t) if integer_auto else None
        cols = self.insert_cols(con, t, auto)
        col_list = ", ".join(f'"{c}"' for c in cols)
        sel = []
        for c in cols:
            if spec and c == spec["owner"]:
                sel.append(self.canon_sql('"%s"' % c) + f' AS "{c}"')
            else:
                sel.append(f'"{c}"')
        sel_list = ", ".join(sel)
        verb, order = "INSERT", ""
        if self.owner_in_pk(t):
            verb = "INSERT OR IGNORE"
            ts = spec["ts"]
            if any(c["name"] == ts for c in self.columns(con, "stg", t)):
                order = f' ORDER BY "{ts}" DESC'
        sql = (f'{verb} INTO main."{t}" ({col_list}) '
               f'SELECT {sel_list} FROM stg."{t}" WHERE {where}{order}')
        try:
            return con.execute(sql, params).rowcount
        except sqlite3.IntegrityError as e:
            if verb.endswith("IGNORE"):
                raise
            # A secondary UNIQUE constraint rejected a row whose PK was new
            # (e.g. deck_entries (owner,identity_key,collection_id) or
            # scan_labeling_reviews (scan_id,reviewer_user_id) collided across
            # the two histories). Keep the merge going: base wins for the
            # conflicting rows, and the drop is surfaced as an open question.
            want = con.execute(
                f'SELECT COUNT(*) FROM stg."{t}" WHERE {where}', params).fetchone()[0]
            got = con.execute(
                f'INSERT OR IGNORE INTO main."{t}" ({col_list}) '
                f'SELECT {sel_list} FROM stg."{t}" WHERE {where}{order}', params).rowcount
            self.open_questions.append(
                f"{t}: {want - got} staging row(s) dropped by a secondary UNIQUE "
                f"constraint during merge ({e}); base rows won — review whether "
                "newest-wins should apply to this constraint instead")
            return got

    def merge_owners(self, con, modes, stg_inv, base_inv):
        self.emit("== per-owner merge ==")
        stats = {"insert": 0, "replace": 0, "union": 0, "keep_base": 0, "drop": 0}
        for owner in sorted(modes, key=lambda o: (modes[o], o)):
            mode = modes[owner]
            stats[mode] += 1
            if mode in ("drop", "keep_base"):
                continue
            if mode in ("insert", "replace"):
                if mode == "replace":
                    n_del = self.delete_owner_rows(con, owner)
                else:
                    n_del = 0
                n_ins = self.copy_owner_rows(con, owner)
                self.emit(f"  [{mode:7s}] {owner}  deleted {n_del} base rows, "
                          f"inserted {n_ins} staging rows")
            elif mode == "union":
                self.union_owner(con, owner)
        self.emit(f"  owner modes: {stats}")
        self.emit("")
        return stats

    def copy_owner_rows(self, con, owner):
        inserted = 0
        for t, spec in USER_TABLES.items():
            if not self.table_exists(con, "stg", t):
                continue
            where = f'{self.canon_sql(spec["owner"])} = ?'
            inserted += self.copy_rows(con, t, where, (owner,), spec.get("integer_auto"))
        for t, spec in CHILD_TABLES.items():
            if not self.table_exists(con, "stg", t):
                continue
            powner = USER_TABLES[spec["parent"]]["owner"]
            where = (f'"{spec["key"]}" IN (SELECT p."{spec["parent_key"]}" '
                     f'FROM stg."{spec["parent"]}" p WHERE {self.canon_sql("p." + powner)} = ?)')
            inserted += self.copy_rows(con, t, where, (owner,), spec.get("integer_auto"))
        return inserted

    def union_owner(self, con, owner):
        """Dual-activity owner: union rows by PK; newest ts wins on collision.
        Children follow their parent's winner."""
        detail = []
        for t, spec in USER_TABLES.items():
            if not self.table_exists(con, "stg", t):
                continue
            if spec.get("integer_auto"):
                # access_waitlist: no stable PK — dedupe on content columns
                dcols = spec["dedupe_cols"]
                cond = " AND ".join(f'm."{c}" IS stg."{t}"."{c}"' for c in dcols)
                owner_col = '"%s"' % spec["owner"]
                where = (f'{self.canon_sql(owner_col)} = ? AND NOT EXISTS '
                         f'(SELECT 1 FROM main."{t}" m WHERE {cond})')
                n = self.copy_rows(con, t, where, (owner,), True)
                if n:
                    detail.append(f"{t}:+{n}")
                continue
            pk = spec["pk"]
            ts = spec["ts"]
            has_ts = any(c["name"] == ts for c in self.columns(con, "stg", t))

            def s_col(c):  # canonical value of a staging PK column
                return self.canon_sql('s."%s"' % c) if c == spec["owner"] else f's."{c}"'

            pk_expr_s = ", ".join(s_col(c) for c in pk)
            join = " AND ".join(f'm."{c}" IS {s_col(c)}' for c in pk)
            ts_s = f's."{ts}"' if has_ts else "NULL"
            ts_m = f'm."{ts}"' if has_ts else "NULL"
            owner_expr = self.canon_sql('s."%s"' % spec["owner"])
            # collisions: same canonical PK on both sides
            rows = con.execute(
                f'SELECT {pk_expr_s}, {ts_s}, {ts_m} '
                f'FROM stg."{t}" s JOIN main."{t}" m ON {join} '
                f'WHERE {owner_expr} = ?',
                (owner,)).fetchall()
            stg_wins_pks = []
            base_wins = 0
            for r in rows:
                pkv, s_ts, m_ts = list(r[:len(pk)]), r[len(pk)], r[len(pk) + 1]
                # identical pre-fork rows: either side fine; ties -> staging
                if newest_wins(s_ts, m_ts):
                    stg_wins_pks.append(pkv)
                else:
                    base_wins += 1
            # delete base losers (+ their children), then insert staging rows
            for pkv in stg_wins_pks:
                cond = " AND ".join(f'"{c}" = ?' for c in pk)
                self.delete_children_of(con, t, pk, pkv)
                con.execute(f'DELETE FROM main."{t}" WHERE {cond}', pkv)
            # staging rows not in base + staging collision winners

            def stg_col(c):  # canonical value of a staging PK column (outer query)
                col = 'stg."%s"."%s"' % (t, c)
                return self.canon_sql(col) if c == spec["owner"] else col

            not_exists = (f'NOT EXISTS (SELECT 1 FROM main."{t}" m WHERE '
                          + " AND ".join(f'm."{c}" IS {stg_col(c)}' for c in pk) + ")")
            where = f'{self.canon_sql(chr(34) + spec["owner"] + chr(34))} = ? AND {not_exists}'
            n_ins = self.copy_rows(con, t, where, (owner,), False)
            if n_ins or stg_wins_pks or base_wins:
                detail.append(f"{t}:+{n_ins}"
                              + (f" (pk collisions: {len(stg_wins_pks)} stg-newer, "
                                 f"{base_wins} base-newer)" if rows else ""))
            self.union_expect[(owner, t)] = None  # verified via per-owner counts below
        # children of union-owner parents: copy stg children whose parent row in
        # main came from staging AND whose own row is not already present.
        for t, spec in CHILD_TABLES.items():
            if not self.table_exists(con, "stg", t):
                continue
            n = self.copy_union_children(con, owner, t, spec)
            if n:
                detail.append(f"{t}:+{n}")
        self.emit(f"  [union  ] {owner}  " + (", ".join(detail) if detail else "no changes"))

    def delete_children_of(self, con, parent_table, pk, pkv):
        for t, spec in CHILD_TABLES.items():
            if spec["parent"] != parent_table or not self.table_exists(con, "main", t):
                continue
            cond = " AND ".join(f'p."{c}" = ?' for c in pk)
            con.execute(
                f'DELETE FROM main."{t}" WHERE "{spec["key"]}" IN '
                f'(SELECT p."{spec["parent_key"]}" FROM main."{parent_table}" p WHERE {cond})',
                pkv)

    def copy_union_children(self, con, owner, t, spec):
        """Insert stg children for this owner's parents when main is missing
        them (parent came from staging, or base's children were deleted with a
        losing parent). Dedupe: for integer-auto children on (key, rank) when a
        rank column exists, else on TEXT pk."""
        powner = USER_TABLES[spec["parent"]]["owner"]
        cols = [c["name"] for c in self.columns(con, "stg", t)]
        has_rank = "rank" in cols
        if spec.get("integer_auto"):
            if has_rank:
                dedupe = (f'NOT EXISTS (SELECT 1 FROM main."{t}" m WHERE '
                          f'm."{spec["key"]}" = stg."{t}"."{spec["key"]}" AND m."rank" IS stg."{t}"."rank")')
            else:
                dedupe = (f'NOT EXISTS (SELECT 1 FROM main."{t}" m WHERE '
                          f'm."{spec["key"]}" = stg."{t}"."{spec["key"]}")')
        else:
            pk = spec["pk"]
            dedupe = ('NOT EXISTS (SELECT 1 FROM main."' + t + '" m WHERE '
                      + " AND ".join(f'm."{c}" IS stg."{t}"."{c}"' for c in pk) + ")")
        # only children whose parent row EXISTS in main (winner rows)
        parent_in_main = (f'"{spec["key"]}" IN (SELECT mp."{spec["parent_key"]}" '
                          f'FROM main."{spec["parent"]}" mp)')
        powner_col = 'p."%s"' % powner
        parent_owned = (f'"{spec["key"]}" IN (SELECT p."{spec["parent_key"]}" '
                        f'FROM stg."{spec["parent"]}" p '
                        f'WHERE {self.canon_sql(powner_col)} = ?)')
        where = f'{parent_owned} AND {parent_in_main} AND {dedupe}'
        return self.copy_rows(con, t, where, (owner,), spec.get("integer_auto"))

    # ----- step 5b: NULL-owner rows -----------------------------------------
    def merge_null_owner(self, con):
        self.emit("== NULL-owner rows (union by PK, base wins) ==")
        for t, spec in USER_TABLES.items():
            if not self.table_exists(con, "stg", t) or spec.get("integer_auto"):
                continue
            pk = spec["pk"]
            not_exists = ('NOT EXISTS (SELECT 1 FROM main."' + t + '" m WHERE '
                          + " AND ".join(f'm."{c}" IS stg."{t}"."{c}"' for c in pk) + ")")
            where = f'"{spec["owner"]}" IS NULL AND {not_exists}'
            n = self.copy_rows(con, t, where, (), False)
            if n:
                self.emit(f"  {t}: +{n} staging NULL-owner rows")
                # their children
                for ct, cspec in CHILD_TABLES.items():
                    if cspec["parent"] != t or not self.table_exists(con, "stg", ct):
                        continue
                    cn = self.copy_union_children_nullowner(con, ct, cspec)
                    if cn:
                        self.emit(f"    {ct}: +{cn}")
        self.emit("")

    def copy_union_children_nullowner(self, con, t, spec):
        powner = USER_TABLES[spec["parent"]]["owner"]
        cols = [c["name"] for c in self.columns(con, "stg", t)]
        if spec.get("integer_auto"):
            if "rank" in cols:
                dedupe = (f'NOT EXISTS (SELECT 1 FROM main."{t}" m WHERE '
                          f'm."{spec["key"]}" = stg."{t}"."{spec["key"]}" AND m."rank" IS stg."{t}"."rank")')
            else:
                dedupe = (f'NOT EXISTS (SELECT 1 FROM main."{t}" m WHERE '
                          f'm."{spec["key"]}" = stg."{t}"."{spec["key"]}")')
        else:
            pk = spec["pk"]
            dedupe = ('NOT EXISTS (SELECT 1 FROM main."' + t + '" m WHERE '
                      + " AND ".join(f'm."{c}" IS stg."{t}"."{c}"' for c in pk) + ")")
        where = (f'"{spec["key"]}" IN (SELECT p."{spec["parent_key"]}" FROM stg."{spec["parent"]}" p '
                 f'WHERE p."{powner}" IS NULL) AND {dedupe}')
        return self.copy_rows(con, t, where, (), spec.get("integer_auto"))

    # ----- runtime settings report ------------------------------------------
    def report_runtime_settings(self, con):
        self.emit("== runtime_settings (merged DB keeps PROD's rows verbatim) ==")
        for db, label in (("main", "PROD (kept in merged DB)"), ("stg", "STAGING (NOT copied)")):
            self.emit(f"  {label}:")
            for k, v, u in con.execute(
                    f"SELECT key, value_json, updated_at FROM {db}.runtime_settings ORDER BY key"):
                mark = "  <-- runbook decision" if any(x in k for x in RUNTIME_KEYS_OF_INTEREST) else ""
                self.emit(f"    {k} = {v}  (updated {u}){mark}")
        self.emit("  NOTE: scan_artifact_uploads and card_show_mode ride along from PROD;")
        self.emit("  the cutover runbook must decide final values (DB rows BEAT env—")
        self.emit("  POST /api/v1/admin/scan-artifact-uploads after cutover).")
        self.emit("")

    # ----- verification ------------------------------------------------------
    def check(self, name, ok, detail=""):
        self.emit(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" ({detail})" if detail else ""))
        if not ok:
            self.problems.append(f"{name}: {detail}")

    def verify(self, con, stg_inv, base_inv, modes, prod_counts):
        self.emit("== verification ==")
        # catalog table counts == prod snapshot's
        for t in sorted(CATALOG_TABLES):
            if t not in prod_counts:
                continue
            n = self.count(con, "main", t)
            self.check(f"catalog {t} count == prod", n == prod_counts[t],
                       f"merged {n} vs prod {prod_counts[t]}")

        # per-owner counts
        merged_inv = self.owner_inventory(con, "main")
        bad = 0
        for owner, mode in modes.items():
            if mode in ("insert", "replace"):
                want = stg_inv[owner]["tables"]
            elif mode == "keep_base":
                want = base_inv[owner]["tables"]
            elif mode == "drop":
                got = merged_inv.get(owner, {"tables": {}})["tables"]
                if got:
                    bad += 1
                    self.check(f"dropped owner {owner} has no rows", False, str(got))
                continue
            else:  # union: merged >= max(stg-only inserts...) — verified per table below
                got = merged_inv.get(owner, {"tables": {}})["tables"]
                s, b = stg_inv[owner]["tables"], base_inv[owner]["tables"]
                for t in set(s) | set(b):
                    lo = max(s.get(t, 0), b.get(t, 0))
                    hi = s.get(t, 0) + b.get(t, 0)
                    g = got.get(t, 0)
                    if not (lo <= g <= hi):
                        bad += 1
                        self.check(f"union owner {owner} {t} count in [{lo},{hi}]", False, str(g))
                continue
            got = merged_inv.get(owner, {"tables": {}})["tables"]
            if got != want:
                bad += 1
                diff = {t: (want.get(t, 0), got.get(t, 0))
                        for t in set(want) | set(got) if want.get(t, 0) != got.get(t, 0)}
                self.check(f"owner {owner} ({mode}) per-table counts", False, f"want/got {diff}")
        # prod-only owners (never in staging) must be untouched
        for owner, e in base_inv.items():
            if owner is None or owner in modes:
                continue
            if owner in TEST_ACCOUNT_UUIDS:
                continue
            got = merged_inv.get(owner, {"tables": {}})["tables"]
            if got != e["tables"]:
                bad += 1
                self.check(f"prod-only owner {owner} untouched", False,
                           f"want {e['tables']} got {got}")
        self.check("per-owner row counts preserved", bad == 0, f"{bad} owners off")

        # uuid scans: no remap-source uuid, no test uuid anywhere in user tables
        residue = []
        needles = sorted(set(self.remap.keys()) | TEST_ACCOUNT_UUIDS)
        for t in list(USER_TABLES) + list(CHILD_TABLES):
            if not self.table_exists(con, "main", t):
                continue
            for col in self.text_columns(con, "main", t):
                where = " OR ".join(f'"{col}" LIKE \'%{u}%\'' for u in needles)
                n = self.count(con, "main", t, where)
                if n:
                    residue.append(f"{t}.{col}:{n}")
        self.check("no remap-source or test-account uuid remains in user tables",
                   not residue, ", ".join(residue))

        # FK integrity
        for child, ccol, parent, pcol, nullable in FK_EDGES:
            if not (self.table_exists(con, "main", child) and self.table_exists(con, "main", parent)):
                continue
            nullw = f'"{ccol}" IS NOT NULL AND ' if nullable else ""
            n = self.count(con, "main", child,
                           f'{nullw}"{ccol}" NOT IN (SELECT "{pcol}" FROM main."{parent}")')
            self.check(f"no orphans {child}.{ccol} -> {parent}.{pcol}", n == 0, f"{n} orphans")
        for child, ccol, parent, pcol, nullable in FK_EDGES_INFORMATIONAL:
            if not (self.table_exists(con, "main", child) and self.table_exists(con, "main", parent)):
                continue
            nullw = f'"{ccol}" IS NOT NULL AND ' if nullable else ""
            n = self.count(con, "main", child,
                           f'{nullw}"{ccol}" NOT IN (SELECT "{pcol}" FROM main."{parent}")')
            self.emit(f"  [info] dangling {child}.{ccol} -> {parent}.{pcol}: {n} "
                      "(no SQL FK; cross-owner references are legal here)")
        # authoritative: SQLite's own FK checker on user/child tables
        fk_bad = []
        for t in list(USER_TABLES) + list(CHILD_TABLES):
            if not self.table_exists(con, "main", t):
                continue
            rows = con.execute(f'PRAGMA main.foreign_key_check("{t}")').fetchall()
            if rows:
                fk_bad.append(f"{t}:{len(rows)}")
        self.check("PRAGMA foreign_key_check clean on user tables", not fk_bad, ", ".join(fk_bad))

        # sample 20 random deck_entries resolve
        rows = con.execute(
            'SELECT id, card_id, collection_id, owner_user_id FROM main.deck_entries '
            'ORDER BY id').fetchall()
        sample = random.sample(rows, min(20, len(rows)))
        bad_rows = []
        for de_id, card_id, coll_id, owner in sample:
            card_ok = con.execute('SELECT 1 FROM main.cards WHERE id=?', (card_id,)).fetchone()
            coll_ok = True
            if coll_id is not None:
                coll_ok = con.execute('SELECT 1 FROM main.collections WHERE id=?', (coll_id,)).fetchone()
            if not card_ok or not coll_ok:
                bad_rows.append(de_id)
        self.check(f"{len(sample)} random deck_entries resolve to valid card/collection",
                   not bad_rows, ", ".join(bad_rows))

        # runtime_settings identical to prod snapshot
        merged_rs = [tuple(r) for r in con.execute(
            "SELECT key, value_json FROM main.runtime_settings ORDER BY key")]
        self.check("runtime_settings == prod's", merged_rs == self.prod_runtime_rows,
                   f"{merged_rs} vs {self.prod_runtime_rows}")

        # integer-auto sequence sanity
        for t in ("scan_prediction_candidates", "scan_price_observations", "access_waitlist"):
            if not self.table_exists(con, "main", t):
                continue
            mx = con.execute(f'SELECT MAX(rowid) FROM main."{t}"').fetchone()[0] or 0
            seq = con.execute('SELECT seq FROM main.sqlite_sequence WHERE name=?', (t,)).fetchone()
            seq_val = seq[0] if seq is not None else None
            self.check(f"sqlite_sequence >= max(id) for {t}",
                       seq_val is not None and seq_val >= mx, f"seq={seq_val} max={mx}")

        if not self.args.skip_integrity_check:
            res = con.execute("PRAGMA main.quick_check").fetchone()[0]
            self.check("PRAGMA quick_check", res == "ok", str(res))
        self.emit("")

    # ----- main flow ---------------------------------------------------------
    def run(self):
        a = self.args
        for path in (a.staging_snapshot, a.prod_snapshot):
            if not os.path.isfile(path):
                sys.exit(f"snapshot not found: {path}")
            if os.path.exists(path + "-wal") and os.path.getsize(path + "-wal") > 0:
                sys.exit(f"{path} has a non-empty -wal — checkpoint/recover it first "
                         "(open once with sqlite3 and run PRAGMA wal_checkpoint(TRUNCATE))")
        ts = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        mode_label = "APPLY" if a.apply else "DRY-RUN"
        self.emit(f"merge_sqlite_staging_prod {mode_label} at {ts}")
        self.emit(f"  prod snapshot (BASE):    {a.prod_snapshot}")
        self.emit(f"  staging snapshot:        {a.staging_snapshot}")
        self.emit(f"  fork threshold:          {a.fork_ts}")
        self.emit(f"  remap:                   {a.remap} ({len(self.remap)} live entries "
                  "after stripping test@test.com)")
        self.emit("")

        out = a.out
        if not out:
            out = os.path.join(a.workdir or os.path.dirname(a.prod_snapshot),
                               f"merged_dryrun_{ts}.sqlite")
        self.emit(f"copying prod snapshot -> {out} ...")
        shutil.copyfile(a.prod_snapshot, out)

        con = sqlite3.connect(out)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = OFF")   # we merge in dependency-safe order
        con.execute("PRAGMA journal_mode = OFF")   # local scratch copy; fastest
        con.execute("PRAGMA synchronous = OFF")
        con.execute(f"ATTACH DATABASE 'file:{a.staging_snapshot}?mode=ro' AS stg")
        con.execute("CREATE TEMP TABLE uuid_remap (old TEXT PRIMARY KEY, new TEXT NOT NULL)")
        con.executemany("INSERT INTO temp.uuid_remap VALUES (?, ?)", sorted(self.remap.items()))

        self.classify_or_abort(con)

        # snapshot facts for verification
        prod_counts = {t: self.count(con, "main", t)
                       for t in CATALOG_TABLES if self.table_exists(con, "main", t)}
        self.prod_runtime_rows = [tuple(r) for r in con.execute(
            "SELECT key, value_json FROM main.runtime_settings ORDER BY key")]

        self.report_runtime_settings(con)
        self.reconcile_schema(con)

        stg_inv = self.owner_inventory(con, "stg")
        base_inv = self.owner_inventory(con, "main")
        emails = self.owner_emails(con)
        modes, dual, kept = self.classify_owners(stg_inv, base_inv)

        self.emit("== owner census (canonical uuids after remap) ==")
        self.emit(f"  staging owners: {len([o for o in stg_inv if o is not None])} "
                  f"(+{1 if None in stg_inv else 0} NULL-owner bucket)")
        self.emit(f"  prod owners:    {len([o for o in base_inv if o is not None])} "
                  f"(+{1 if None in base_inv else 0} NULL-owner bucket)")
        self.emit("")
        self.emit("== owner merge plan ==")
        for owner in sorted(modes, key=lambda o: (modes[o], o)):
            m = modes[owner]
            e = emails.get(owner, "?")
            s_last = stg_inv.get(owner, {}).get("last")
            b_last = base_inv.get(owner, {}).get("last")
            s_n = sum(stg_inv.get(owner, {}).get("tables", {}).values())
            b_n = sum(base_inv.get(owner, {}).get("tables", {}).values())
            self.emit(f"  [{m:9s}] {owner}  {e}")
            self.emit(f"              staging rows={s_n} last={s_last}   prod rows={b_n} last={b_last}")
        self.emit("")
        if dual:
            self.emit("== DUAL-ACTIVITY owners (post-fork writes on BOTH sides; union by PK, newest wins) ==")
            for o in dual:
                self.emit(f"  {o}  {emails.get(o, '?')}  "
                          f"staging last={stg_inv[o]['last']}  prod last={base_inv[o]['last']}")
            self.emit("")
        if kept:
            self.emit("== owners kept from PROD base (no post-fork staging writes) ==")
            for o in kept:
                self.emit(f"  {o}  {emails.get(o, '?')}  prod last={base_inv[o]['last']}")
            self.emit("")

        self.delete_test_rows(con)
        self.apply_remap(con, "base rows before merge")
        self.merge_owners(con, modes, stg_inv, base_inv)
        self.merge_null_owner(con)
        self.apply_remap(con, "final pass incl. staging-copied rows")
        con.commit()

        self.verify(con, stg_inv, base_inv, modes, prod_counts)

        self.emit("== KNOWN CAVEATS (inherent to the approved per-owner-union strategy) ==")
        self.emit("  - A row DELETED on one side after the fork leaves no tombstone, so for")
        self.emit("    dual-activity owners the union resurrects it (newest-wins only applies")
        self.emit("    to edits, not deletions). Same for an owner whose ONLY post-fork staging")
        self.emit("    action was a deletion (no writes -> classified keep_base).")
        self.emit("  - Catalog rides from prod; staging user rows referencing a card id absent")
        self.emit("    from prod's catalog would orphan — the FK checks above would catch it.")
        self.emit("  - card_ebay_listings_cache is created EMPTY (staging's cached prices are")
        self.emit("    stale; it self-repopulates).")
        self.emit("  - _litestream_* tables ride from prod; litestream restarts its generation")
        self.emit("    when the merged file replaces the live DB (runbook step).")
        self.emit("")
        if self.open_questions:
            self.emit("== OPEN QUESTIONS (resolve before cutover) ==")
            for q in self.open_questions:
                self.emit(f"  - {q}")
            self.emit("")

        ok = not self.problems
        self.emit(f"RESULT: {'ALL CHECKS PASSED' if ok else f'{len(self.problems)} CHECK(S) FAILED'}")
        if a.apply:
            self.emit(f"merged database written: {out}")
            self.emit("NEXT (manual runbook steps, deliberately not scripted): write-freeze, "
                      "re-pull fresh snapshots, re-run --apply on them, ship the file to the "
                      "prod VM, flip runtime settings, catalog catch-up sync.")
        else:
            self.emit("DRY-RUN: no VM or Supabase was touched; the merged file is a local scratch product.")
        con.close()

        report = a.report or os.path.join(
            DEFAULT_REPORT_DIR,
            "merge_dry_run_report.txt" if not a.apply else f"merge_apply_report_{ts}.txt")
        os.makedirs(os.path.dirname(report), exist_ok=True)
        with open(report, "w") as f:
            f.write("\n".join(self.lines) + "\n")
        print(f"report written: {report}")

        if not a.apply and not a.keep_merged:
            os.remove(out)
            print(f"dry-run scratch DB removed: {out}")
        elif not a.apply:
            print(f"dry-run merged DB kept: {out}")
        return 0 if ok else 3


def main():
    ap = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=None,
                      help="full merge on a throwaway copy + report (DEFAULT)")
    mode.add_argument("--apply", action="store_true",
                      help="write the merged DB to --out (requires MERGE_CONFIRM=yes); "
                           "still 100%% local — shipping to the VM is a manual runbook step")
    ap.add_argument("--staging-snapshot", required=True,
                    help="local staging SQLite snapshot (full copy or user-table extract)")
    ap.add_argument("--prod-snapshot", required=True,
                    help="local prod SQLite snapshot (FULL copy; becomes the base)")
    ap.add_argument("--out", help="output path for the merged DB (required with --apply)")
    ap.add_argument("--remap", default=DEFAULT_REMAP,
                    help="uuid remap json from migrate_identity_staging_to_prod.py")
    ap.add_argument("--fork-ts", default=DEFAULT_FORK_TS,
                    help=f"fork moment for activity classification (default {DEFAULT_FORK_TS})")
    ap.add_argument("--drop-owner", action="append",
                    help="additional staging owner uuid to drop (staging anons are "
                         "always dropped)")
    ap.add_argument("--report", help="report path (default tools/migration_out/...)")
    ap.add_argument("--workdir", help="where the dry-run scratch copy is built "
                                      "(default: next to the prod snapshot)")
    ap.add_argument("--keep-merged", action="store_true",
                    help="keep the dry-run merged DB instead of deleting it")
    ap.add_argument("--skip-integrity-check", action="store_true",
                    help="skip the final PRAGMA quick_check (slow on the 28GB file)")
    args = ap.parse_args()

    if args.apply:
        if os.environ.get("MERGE_CONFIRM") != "yes":
            sys.exit("Refusing to apply: set MERGE_CONFIRM=yes for this invocation.")
        if not args.out:
            sys.exit("--apply requires --out")

    sys.exit(Merger(args).run())


if __name__ == "__main__":
    main()
