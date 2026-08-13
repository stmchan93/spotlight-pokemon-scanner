#!/usr/bin/env python3
"""Staging -> Prod Supabase identity + social-data migration (promotion cutover).

Context: docs/production-promotion-plan-2026-08-12.md ("identity is the crux"),
docs/production-promotion-checklist-2026-08-12.md Phase 0.5 / Phase 1,
docs/supabase-migration-runbook-if-ever-needed-2026-08-06.md (invariants I1-I5).

WHAT THIS DOES
  Phase A (auth):   copy staging `auth.users` + `auth.identities` into prod,
                    PRESERVING UUIDS (I1) and bcrypt password hashes (I3), after
                    deleting the 5 pre-split prod duplicate accounts (same email,
                    different uuid — enumerated in EXPECTED_COLLISIONS below).
                    GoTrue tolerates direct SQL inserts into its schema — this is
                    the runbook's own `pg_dump auth` pattern, done surgically.
                    The prod auth.users triggers (social_10 mirror, social_14
                    profile seed) stay ENABLED during Phase A on purpose: they
                    create `public.users` + seed `user_profiles` rows exactly as a
                    normal signup would, and the duplicate DELETE fires the
                    mirror-delete trigger whose cascade removes every public-schema
                    row the old accounts owned (their profiles + the owner's July
                    test post/comments/likes).
  Phase B (social): copy the public-schema social tables staging -> prod in
                    FK-safe order, preserving ids, timestamps and counter values.
                    USER TRIGGERS ARE DISABLED for the copy (single transaction):
                    the engagement-counter triggers (social_09/20) and
                    notification triggers (social_11) would otherwise double-count
                    / duplicate — staging's rows already carry the final state.
                    `user_profiles` is UPSERTed over the trigger-seeded rows.
  Storage:          nothing to do — verified 0 rows in storage.objects on both
                    projects (user bytes live on GCS per runbook D6). The script
                    asserts this and aborts if it changes.
  NOT migrated:     auth.sessions / refresh tokens (users re-sign-in once —
                    expected per the plan), blocked_terms (server-owned seed,
                    already applied to prod by social_18), staging anonymous
                    users (default: an anon identity cannot re-authenticate on a
                    different project, so migrating it strands a row forever;
                    override with --include-anon).

OUTPUTS (dry-run and apply)
  tools/migration_out/identity_migration_report_<ts>.txt   full action plan
  tools/migration_out/uuid_remap_staging_prod.json         old-prod-uuid -> staging-uuid
      map for the 5 colliding accounts. Phase 2 (SQLite promotion) MUST consume
      this: the staging SQLite holds rows under BOTH uuids for these users, and
      the prod SQLite holds pre-split rows under the old uuids only.

SAFETY
  - Default mode is --dry-run: every statement is printed/planned, nothing
    executes against prod. Staging is NEVER written in any mode (reads only).
  - Apply requires BOTH `--apply` and env `MIGRATE_CONFIRM=yes`.
  - Preflight re-derives the collision set from live data and ABORTS if it does
    not exactly match EXPECTED_COLLISIONS (guards against new signups / drift
    between dry-run and cutover).
  - Idempotent: every insert is `on conflict do nothing` (or a deterministic
    upsert for user_profiles); a re-run converges.

USAGE
  python3 tools/migrate_identity_staging_to_prod.py                  # dry-run
  python3 tools/migrate_identity_staging_to_prod.py --dry-run
  MIGRATE_CONFIRM=yes python3 tools/migrate_identity_staging_to_prod.py --apply
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

STAGING_REF = "mphjenaaorntwkyivqtm"
PROD_REF = "lvnjshymwvagwadqeofm"
API_BASE = "https://api.supabase.com/v1/projects/{ref}/database/query"

# ---------------------------------------------------------------------------
# The collision ledger — verified against live data 2026-08-12.
# email -> {staging: uuid that KEEPS the identity, prod: pre-split duplicate to
# delete}. Preflight aborts if live derivation differs in any way.
# ---------------------------------------------------------------------------
EXPECTED_COLLISIONS = {
    "trogdor85@gmail.com": {
        "staging": "0482bd43-c8bd-4884-8dcb-011d19c1f175",
        "prod": "866d4a1b-bacf-4501-a1b5-0d8a945b5019",
    },
    "stmchan8953@gmail.com": {
        "staging": "0084c543-8167-4609-9fa4-d6b0252cfe66",
        "prod": "61dcef8a-c2e2-439d-9211-ae1232293187",
    },
    "johnsonma626@gmail.com": {
        "staging": "a938d7e3-be67-415b-b939-5d1381b9e931",
        "prod": "00b7fc4e-19b7-4583-a798-0e65e380d1c1",
    },
    "t4g58ygwb6@privaterelay.appleid.com": {
        "staging": "6be6d057-611e-48d8-ab81-cd606478d5f6",
        "prod": "eb5c58e4-0919-4b20-97ca-7a69da0daa13",
    },
    "test@test.com": {
        "staging": "2baa9c54-07ad-442a-892b-e5e94a3d6752",
        "prod": "681c96c3-4b25-4e89-a177-9c7d9f664c68",
    },
}

# Phase B copy order (FK-safe). (table, conflict_mode) where conflict_mode is
# "nothing" or "update" (full-row upsert; used only for trigger-seeded tables).
# PK columns are derived live from information_schema — nothing hard-coded.
COPY_TABLES = [
    ("users", "nothing"),                    # mirror; Phase A triggers pre-seed
    ("user_profiles", "update"),             # overwrite social_14 seeds with real profiles
    ("follows", "nothing"),
    ("blocks", "nothing"),
    ("mutes", "nothing"),
    ("posts", "nothing"),
    ("post_media", "nothing"),
    ("comments", "nothing"),                 # ordered by created_at (self-FK parents first)
    ("post_likes", "nothing"),
    ("comment_likes", "nothing"),
    ("post_reposts", "nothing"),
    ("conversations", "nothing"),
    ("conversation_participants", "nothing"),
    ("messages", "nothing"),                 # after posts/users (shared_post/shared_profile FKs)
    ("notifications", "nothing"),
    ("reports", "nothing"),
    ("moderation_actions", "nothing"),
    ("deleted_content_bodies", "nothing"),
]
SKIPPED_TABLES = {"blocked_terms": "server-owned seed data, already on prod via social_18"}

DOLLAR_TAG = "$MIGJ$"  # dollar-quote tag for embedded JSON payloads


# ---------------------------------------------------------------------------
# Management API plumbing
# ---------------------------------------------------------------------------
class Api:
    def __init__(self, apply_mode: bool):
        self.apply_mode = apply_mode
        self._token = subprocess.check_output(
            ["security", "find-generic-password", "-s", "Supabase CLI", "-w"],
            text=True,
        ).strip()

    def query(self, ref: str, sql: str, *, write: bool = False):
        """Run SQL. Writes are only ever permitted against PROD in apply mode."""
        if ref == STAGING_REF and write:
            raise RuntimeError("BUG: attempted write against STAGING — refusing")
        if write and not self.apply_mode:
            raise RuntimeError("BUG: attempted write in dry-run mode — refusing")
        if not write:
            head = sql.lstrip().split(None, 1)[0].lower()
            if head not in ("select", "with"):
                raise RuntimeError(f"BUG: read query does not start with select/with: {head}")
        req = urllib.request.Request(
            API_BASE.format(ref=ref),
            data=json.dumps({"query": sql}).encode(),
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
                "User-Agent": "spotlight-identity-migration/1.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                body = resp.read().decode()
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:2000]
            raise RuntimeError(f"Management API {e.code} on {ref}: {detail}") from e
        return json.loads(body) if body.strip() else []


def sql_uuid_array(uuids) -> str:
    inner = ",".join(f"'{u}'" for u in uuids)
    return f"array[{inner}]::uuid[]"


def jsonb_literal(rows) -> str:
    payload = json.dumps(rows, default=str)
    if DOLLAR_TAG in payload:
        raise RuntimeError("payload contains the dollar-quote tag; refusing")
    return f"{DOLLAR_TAG}{payload}{DOLLAR_TAG}::jsonb"


# ---------------------------------------------------------------------------
# Schema introspection (run on both projects; parity is asserted)
# ---------------------------------------------------------------------------
def table_columns(api: Api, ref: str, schema: str, table: str):
    rows = api.query(ref, f"""
        select column_name, is_generated
        from information_schema.columns
        where table_schema = '{schema}' and table_name = '{table}'
        order by ordinal_position""")
    return [(r["column_name"], r["is_generated"] != "NEVER") for r in rows]


def pk_columns(api: Api, ref: str, schema: str, table: str):
    rows = api.query(ref, f"""
        select kcu.column_name
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on kcu.constraint_name = tc.constraint_name
         and kcu.table_schema = tc.table_schema
        where tc.table_schema = '{schema}' and tc.table_name = '{table}'
          and tc.constraint_type = 'PRIMARY KEY'
        order by kcu.ordinal_position""")
    return [r["column_name"] for r in rows]


def user_ref_columns(api: Api, ref: str, table: str):
    """Columns of `table` that FK auth.users(id) or public.users(id)."""
    rows = api.query(ref, f"""
        select kcu.column_name
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
        join information_schema.constraint_column_usage ccu
          on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
        where tc.constraint_type = 'FOREIGN KEY'
          and tc.table_schema = 'public' and tc.table_name = '{table}'
          and ccu.table_name = 'users'""")
    return sorted({r["column_name"] for r in rows})


def fetch_table_rows(api: Api, ref: str, schema: str, table: str, where: str = "true"):
    cols = table_columns(api, ref, schema, table)
    plain = [c for c, gen in cols if not gen]
    col_list = ", ".join(f'"{c}"' for c in plain)
    order = "created_at" if any(c == "created_at" for c, _ in cols) else plain[0]
    rows = api.query(ref, f"""
        select to_jsonb(t) as r from (
          select {col_list} from {schema}."{table}" where {where} order by "{order}"
        ) t""")
    return plain, [r["r"] for r in rows]


# ---------------------------------------------------------------------------
# Preflight — read-only against both projects; derives + asserts the plan
# ---------------------------------------------------------------------------
def preflight(api: Api, include_anon: bool):
    plan = {"errors": [], "warnings": []}

    staging_users = api.query(STAGING_REF, """
        select id::text, lower(email) as email, is_anonymous, created_at::text,
               (encrypted_password is not null and encrypted_password <> '') as has_pw,
               raw_app_meta_data->'providers' as providers
        from auth.users order by created_at""")
    prod_users = api.query(PROD_REF, """
        select id::text, lower(email) as email, is_anonymous, created_at::text
        from auth.users order by created_at""")
    plan["staging_users"] = staging_users
    plan["prod_user_count"] = len(prod_users)

    prod_by_email, prod_ids = {}, set()
    for u in prod_users:
        prod_ids.add(u["id"])
        if u["email"]:
            prod_by_email.setdefault(u["email"], []).append(u["id"])

    # 1. uuid overlap: a staging uuid already present in prod is only legal if
    # it IS the same account (idempotent re-run) — same email.
    already = []
    for su in staging_users:
        if su["id"] in prod_ids:
            match = next(p for p in prod_users if p["id"] == su["id"])
            if (match["email"] or "") == (su["email"] or ""):
                already.append(su["id"])
            else:
                plan["errors"].append(
                    f"uuid {su['id']} exists in prod under a DIFFERENT email — manual review")
    plan["already_migrated"] = already

    # 2. derive email collisions and assert they match the ledger
    derived = {}
    for su in staging_users:
        if su["email"] and su["email"] in prod_by_email:
            clashing = [p for p in prod_by_email[su["email"]] if p != su["id"]]
            if clashing:
                derived[su["email"]] = {"staging": su["id"], "prod": clashing}
    expected = {e: [v["prod"]] for e, v in EXPECTED_COLLISIONS.items()}
    live = {e: v["prod"] for e, v in derived.items()}
    if live != expected:
        plan["errors"].append(
            "collision drift: live email collisions do not match EXPECTED_COLLISIONS.\n"
            f"  live:     {json.dumps(live, indent=2)}\n"
            f"  expected: {json.dumps(expected, indent=2)}\n"
            "  Update the ledger only after reviewing what changed.")
    for email, v in derived.items():
        if email in EXPECTED_COLLISIONS and v["staging"] != EXPECTED_COLLISIONS[email]["staging"]:
            plan["errors"].append(f"collision drift: staging uuid changed for {email}")
    plan["collisions"] = EXPECTED_COLLISIONS
    delete_ids = [v["prod"] for v in EXPECTED_COLLISIONS.values()]
    plan["delete_prod_ids"] = delete_ids

    # 3. provider-level collisions (google/apple subject ids are per-person and
    # unique per project): every prod identity clashing with an incoming staging
    # identity must belong to an account we are deleting.
    staging_idents = api.query(STAGING_REF, """
        select user_id::text, provider, provider_id from auth.identities""")
    plan["staging_identities"] = staging_idents
    pairs = ",".join(f"('{i['provider']}','{i['provider_id']}')" for i in staging_idents)
    prod_clash = api.query(PROD_REF, f"""
        select user_id::text, provider, provider_id from auth.identities
        where (provider, provider_id) in ({pairs})""")
    for c in prod_clash:
        if c["user_id"] not in delete_ids and c["user_id"] not in {
                s["user_id"] for s in staging_idents}:
            plan["errors"].append(
                f"prod identity ({c['provider']},{c['provider_id']}) belongs to "
                f"{c['user_id']} which is neither deleted nor migrated — would conflict")
    plan["prod_identity_clashes"] = prod_clash

    # 4. migrated user set (anon policy)
    anons = [u for u in staging_users if u["is_anonymous"]]
    plan["staging_anon"] = [u["id"] for u in anons]
    migrate_ids = [u["id"] for u in staging_users if include_anon or not u["is_anonymous"]]
    skipped_ids = [u["id"] for u in staging_users if u["id"] not in migrate_ids]
    plan["migrate_ids"], plan["skipped_ids"] = migrate_ids, skipped_ids

    # 5. per-table counts + skipped-user references + column parity
    plan["tables"] = {}
    for table, mode in COPY_TABLES:
        # Set comparison, not ordered: staging's tables grew via ALTERs while
        # prod's replayed from zero, so ordinal positions differ. Inserts are
        # name-based (explicit column lists + jsonb_populate_recordset).
        s_cols = table_columns(api, STAGING_REF, "public", table)
        p_cols = table_columns(api, PROD_REF, "public", table)
        if set(s_cols) != set(p_cols):
            plan["errors"].append(
                f"column mismatch on public.{table}: only-staging="
                f"{set(s_cols) - set(p_cols)} only-prod={set(p_cols) - set(s_cols)}")
        n = api.query(STAGING_REF, f'select count(*) as n from public."{table}"')[0]["n"]
        refs = user_ref_columns(api, STAGING_REF, table)
        entry = {"rows": int(n), "mode": mode, "user_ref_cols": refs,
                 "pk": pk_columns(api, STAGING_REF, "public", table)}
        if skipped_ids and refs and int(n):
            conds = " or ".join(
                f'"{c}" = any({sql_uuid_array(skipped_ids)})' for c in refs)
            bad = api.query(STAGING_REF,
                            f'select count(*) as n from public."{table}" where {conds}')[0]["n"]
            if int(bad):
                plan["errors"].append(
                    f"public.{table}: {bad} rows reference skipped (anonymous) users — "
                    "re-run with --include-anon or resolve first")
        plan["tables"][table] = entry
    if set(table_columns(api, STAGING_REF, "auth", "users")) != \
            set(table_columns(api, PROD_REF, "auth", "users")):
        plan["errors"].append("auth.users column mismatch between projects")
    if set(table_columns(api, STAGING_REF, "auth", "identities")) != \
            set(table_columns(api, PROD_REF, "auth", "identities")):
        plan["errors"].append("auth.identities column mismatch between projects")

    # 6. storage must still be empty on staging (bytes live on GCS)
    n_store = api.query(
        STAGING_REF, "select count(*) as n from storage.objects")[0]["n"]
    if int(n_store):
        plan["errors"].append(
            f"storage.objects on staging has {n_store} rows — this script does not "
            "copy storage; the GCS-only assumption (runbook D6) no longer holds")
    plan["staging_storage_objects"] = int(n_store)

    # 7. enumerate exactly what the 5 prod deletions cascade away
    plan["prod_delete_cascade"] = {}
    for email, v in EXPECTED_COLLISIONS.items():
        pid = v["prod"]
        owned = api.query(PROD_REF, f"""
            select 'posts' t, count(*) n from public.posts where author_id = '{pid}' union all
            select 'comments', count(*) from public.comments where author_id = '{pid}' union all
            select 'post_likes', count(*) from public.post_likes where user_id = '{pid}' union all
            select 'comment_likes', count(*) from public.comment_likes where user_id = '{pid}' union all
            select 'follows', count(*) from public.follows
              where follower_id = '{pid}' or followee_id = '{pid}' union all
            select 'messages_sent', count(*) from public.messages where sender_id = '{pid}' union all
            select 'user_profiles', count(*) from public.user_profiles where user_id = '{pid}' union all
            select 'identities', count(*) from auth.identities where user_id = '{pid}'""")
        plan["prod_delete_cascade"][email] = {
            r["t"]: int(r["n"]) for r in owned if int(r["n"])}

    return plan


# ---------------------------------------------------------------------------
# Phase A / Phase B SQL builders (pure functions of fetched staging data)
# ---------------------------------------------------------------------------
def build_phase_a(api: Api, plan):
    migrate = [u for u in plan["staging_users"] if u["id"] in set(plan["migrate_ids"])]
    delete_ids = plan["delete_prod_ids"]
    delete_emails = list(EXPECTED_COLLISIONS.keys())

    u_cols, u_rows = fetch_table_rows(
        api, STAGING_REF, "auth", "users",
        f"id = any({sql_uuid_array([u['id'] for u in migrate])})")
    i_cols, i_rows = fetch_table_rows(
        api, STAGING_REF, "auth", "identities",
        f"user_id = any({sql_uuid_array([u['id'] for u in migrate])})")

    u_list = ", ".join(f'"{c}"' for c in u_cols)
    i_list = ", ".join(f'"{c}"' for c in i_cols)
    emails = ",".join(f"'{e}'" for e in delete_emails)
    sql = f"""
begin;

-- Phase A.1: remove the pre-split duplicate accounts (id AND email must both
-- match the ledger — belt and braces). Fires the social_10 mirror-delete
-- trigger; the cascade removes every public-schema row these accounts own.
delete from auth.users
 where id = any({sql_uuid_array(delete_ids)})
   and lower(coalesce(email, '')) in ({emails});

-- Phase A.2: insert staging users, uuids preserved. auth triggers stay enabled
-- (mirror + profile seed run exactly as for a live signup). Idempotent.
insert into auth.users ({u_list})
select {u_list}
  from jsonb_populate_recordset(null::auth.users, {jsonb_literal(u_rows)})
on conflict (id) do nothing;

-- Phase A.3: provider identities (google/apple subject ids + email identities).
insert into auth.identities ({i_list})
select {i_list}
  from jsonb_populate_recordset(null::auth.identities, {jsonb_literal(i_rows)})
on conflict (provider_id, provider) do nothing;

commit;"""
    summary = {
        "delete_prod_users": len(delete_ids),
        "insert_auth_users": len(u_rows),
        "insert_auth_identities": len(i_rows),
    }
    return sql, summary


def build_phase_b(api: Api, plan):
    migrate_ids = plan["migrate_ids"]
    stmts, summary = [], {}
    for table, mode in COPY_TABLES:
        entry = plan["tables"][table]
        where = "true"
        if table == "users":
            where = f"id = any({sql_uuid_array(migrate_ids)})"
        cols, rows = fetch_table_rows(api, STAGING_REF, "public", table, where)
        summary[table] = len(rows)
        if not rows:
            continue
        col_list = ", ".join(f'"{c}"' for c in cols)
        pk = entry["pk"]
        pk_list = ", ".join(f'"{c}"' for c in pk)
        if mode == "update":
            sets = ", ".join(f'"{c}" = excluded."{c}"' for c in cols if c not in pk)
            conflict = f"on conflict ({pk_list}) do update set {sets}"
        else:
            conflict = f"on conflict ({pk_list}) do nothing"
        stmts.append(f"""
insert into public."{table}" ({col_list})
select {col_list}
  from jsonb_populate_recordset(null::public."{table}", {jsonb_literal(rows)})
{conflict};""")

    tables_with_rows = [t for t, _ in COPY_TABLES if summary.get(t)]
    disable = "\n".join(
        f'alter table public."{t}" disable trigger user;' for t in tables_with_rows)
    enable = "\n".join(
        f'alter table public."{t}" enable trigger user;' for t in tables_with_rows)
    sql = f"""
begin;

-- Phase B: copy social state verbatim. User triggers off so counter triggers
-- (social_09/20) and notification triggers (social_11) don't re-fire — the
-- copied rows already carry final counter values and staging's notifications
-- table is copied as data. FK (internal) triggers remain enforced.
{disable}
{''.join(stmts)}

{enable}

commit;"""
    return sql, summary


# ---------------------------------------------------------------------------
# Post-apply verification (read-only)
# ---------------------------------------------------------------------------
def verify(api: Api, plan):
    checks = []

    missing = api.query(PROD_REF, f"""
        select count(*) as n from unnest({sql_uuid_array(plan['migrate_ids'])}) m(id)
        where not exists (select 1 from auth.users u where u.id = m.id)""")[0]["n"]
    checks.append(("all staging uuids present in prod auth.users", int(missing) == 0,
                   f"{missing} missing"))

    dupes = api.query(PROD_REF, """
        select count(*) as n from (
          select lower(email) from auth.users
          where email is not null group by 1 having count(*) > 1) d""")[0]["n"]
    checks.append(("no duplicate emails in prod auth.users", int(dupes) == 0,
                   f"{dupes} duplicated emails"))

    for email, v in EXPECTED_COLLISIONS.items():
        row = api.query(PROD_REF, f"""
            select id::text from auth.users where lower(email) = '{email}'""")
        ok = len(row) == 1 and row[0]["id"] == v["staging"]
        checks.append((f"collision resolved: {email} -> staging uuid", ok, json.dumps(row)))

    n_id = api.query(PROD_REF, f"""
        select count(*) as n from auth.identities
        where user_id = any({sql_uuid_array(plan['migrate_ids'])})""")[0]["n"]
    checks.append(("identities for migrated users",
                   int(n_id) == len(plan["staging_identities"]),
                   f"prod {n_id} vs staging {len(plan['staging_identities'])}"))

    for table, _ in COPY_TABLES:
        want = plan["tables"][table]["rows"]
        got = api.query(PROD_REF, f'select count(*) as n from public."{table}"')[0]["n"]
        checks.append((f"public.{table} rows (prod >= staging copy)", int(got) >= want,
                       f"prod {got} vs staging {want}"))

    disabled = api.query(PROD_REF, """
        select count(*) as n from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and not t.tgisinternal and t.tgenabled = 'D'""")[0]["n"]
    checks.append(("no user triggers left disabled in public schema",
                   int(disabled) == 0, f"{disabled} disabled"))

    orphans = api.query(PROD_REF, """
        select count(*) as n from public.posts p
        where not exists (select 1 from public.users u where u.id = p.author_id)""")[0]["n"]
    checks.append(("no orphan posts (author in users mirror)", int(orphans) == 0,
                   f"{orphans} orphans"))
    return checks


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=None,
                      help="plan + print everything, mutate nothing (DEFAULT)")
    mode.add_argument("--apply", action="store_true",
                      help="execute against PROD (also requires MIGRATE_CONFIRM=yes)")
    ap.add_argument("--include-anon", action="store_true",
                    help="also migrate staging anonymous users (default: skip — "
                         "anon identities cannot re-authenticate on prod)")
    ap.add_argument("--out-dir", default=os.path.join(os.path.dirname(__file__), "migration_out"))
    args = ap.parse_args()

    apply_mode = bool(args.apply)
    if apply_mode and os.environ.get("MIGRATE_CONFIRM") != "yes":
        sys.exit("Refusing to apply: set MIGRATE_CONFIRM=yes in the environment "
                 "for this invocation (see AGENTS.md prod gating).")

    os.makedirs(args.out_dir, exist_ok=True)
    gi = os.path.join(args.out_dir, ".gitignore")
    if not os.path.exists(gi):
        with open(gi, "w") as f:
            f.write("*\n")

    api = Api(apply_mode)
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    report_path = os.path.join(args.out_dir, f"identity_migration_report_{ts}.txt")
    lines = []

    def emit(s=""):
        print(s)
        lines.append(s)

    emit(f"identity migration {'APPLY' if apply_mode else 'DRY-RUN'} at {ts}")
    emit(f"staging={STAGING_REF} (READ ONLY)  prod={PROD_REF}")
    emit("")

    plan = preflight(api, args.include_anon)

    emit("== staging users ==")
    for u in plan["staging_users"]:
        tag = "SKIP(anon)" if u["id"] in plan["skipped_ids"] else "migrate"
        extra = " [already in prod]" if u["id"] in plan["already_migrated"] else ""
        emit(f"  [{tag}] {u['id']}  {u['email'] or 'ANON'}  pw={u['has_pw']}  "
             f"providers={u['providers']}{extra}")
    emit("")
    emit("== collisions (prod duplicate deleted; staging uuid wins) ==")
    for email, v in EXPECTED_COLLISIONS.items():
        cascade = plan["prod_delete_cascade"].get(email, {})
        emit(f"  {email}: DELETE prod {v['prod']} -> KEEP staging {v['staging']}")
        emit(f"    prod rows cascading away: {cascade or 'none'}")
    emit("")
    emit("== social tables to copy (staging -> prod) ==")
    for table, m in COPY_TABLES:
        e = plan["tables"][table]
        emit(f"  {table:28s} {e['rows']:4d} rows  conflict={m}  pk={e['pk']}")
    for t, why in SKIPPED_TABLES.items():
        emit(f"  {t:28s} SKIPPED — {why}")
    emit(f"  storage.objects              {plan['staging_storage_objects']} objects — "
         "nothing to copy (bytes on GCS)")
    emit("")

    if plan["errors"]:
        emit("== PREFLIGHT ERRORS — refusing to proceed ==")
        for e in plan["errors"]:
            emit(f"  ERROR: {e}")
        with open(report_path, "w") as f:
            f.write("\n".join(lines) + "\n")
        sys.exit(2)

    remap = {v["prod"]: v["staging"] for v in EXPECTED_COLLISIONS.values()}
    remap_path = os.path.join(args.out_dir, "uuid_remap_staging_prod.json")
    with open(remap_path, "w") as f:
        json.dump({"comment": "old-prod-uuid -> canonical staging uuid; consume in "
                              "Phase 2 SQLite promotion (remap owner_user_id/user_id "
                              "rows before or after the DB copy)",
                   "remap": remap}, f, indent=2)
    emit(f"uuid remap written: {remap_path}")

    sql_a, sum_a = build_phase_a(api, plan)
    sql_b, sum_b = build_phase_b(api, plan)
    emit("")
    emit(f"== Phase A (auth) == {sum_a}")
    emit(f"== Phase B (social) == {json.dumps(sum_b)}")

    sql_a_path = os.path.join(args.out_dir, f"phase_a_{ts}.sql")
    sql_b_path = os.path.join(args.out_dir, f"phase_b_{ts}.sql")
    with open(sql_a_path, "w") as f:
        f.write(sql_a)
    with open(sql_b_path, "w") as f:
        f.write(sql_b)
    emit(f"generated SQL: {sql_a_path}  {sql_b_path}")

    if not apply_mode:
        emit("")
        emit("DRY-RUN: nothing was executed against prod. Pre-verification snapshot:")
        for name, ok, detail in verify(api, plan):
            emit(f"  [{'PASS' if ok else 'pending'}] {name} ({detail})")
        emit("")
        emit("To execute: MIGRATE_CONFIRM=yes python3 tools/migrate_identity_staging_to_prod.py --apply")
    else:
        emit("")
        emit("APPLY: executing Phase A ...")
        api.query(PROD_REF, sql_a, write=True)
        emit("APPLY: executing Phase B ...")
        api.query(PROD_REF, sql_b, write=True)
        emit("APPLY: verification ...")
        failures = 0
        for name, ok, detail in verify(api, plan):
            emit(f"  [{'PASS' if ok else 'FAIL'}] {name} ({detail})")
            failures += 0 if ok else 1
        if failures:
            emit(f"!! {failures} verification failures — investigate before proceeding")
        else:
            emit("All verification checks passed.")

    with open(report_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    emit(f"report written: {report_path}")
    if apply_mode and failures:
        sys.exit(3)


if __name__ == "__main__":
    main()
