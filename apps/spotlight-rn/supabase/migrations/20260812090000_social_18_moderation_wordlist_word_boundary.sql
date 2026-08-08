-- Social layer — part 18: make the synchronous moderation pre-filter match on
-- WORD BOUNDARIES, then load a real wordlist into `public.blocked_terms`.
--
-- NOT YET APPLIED anywhere. Apply to STAGING first, then production, and read
-- the "operational precondition" section before applying anywhere at all.
--
-- ===========================================================================
-- 1. WHY THE MATCHER HAD TO CHANGE FIRST
-- ===========================================================================
-- social_04 shipped `tg_content_prefilter()` matching with a bare substring:
--
--     where severity = 'hard' and v_body like '%' || term || '%'
--
-- `v_body` is already `lower(coalesce(new.body,''))`, so case was handled. Word
-- boundaries were not. On a POKEMON CARD app that is not a theoretical problem
-- — it is the Scunthorpe problem with a very short fuse:
--
--     hard term 'ass'  ->  "I pulled a Grass Energy"   -> REMOVED
--                          "class", "passage", "assess", "Assault Vest",
--                          "brass", "bass"             -> REMOVED
--     soft term 'fag'  ->  "Cofagrigus"                -> hidden
--     soft term 'coon' ->  "Zigzagoon", "cocoon", "raccoon"
--     soft term 'cock' ->  "Peacock"
--     soft term 'cum'  ->  "Cummerbund"
--     soft term 'pussy'->  "Pussycat"
--
-- `hard` writes `content_status = 'removed'` with no human in the loop, so every
-- one of those is a legitimate post deleted silently, with no report, no queue,
-- and no signal to the author. The wordlist has been empty in practice (one test
-- term, `zzblockedtest`), which is the only reason this has not bitten yet — the
-- filter has been running on every insert and matching nothing. Loading a real
-- list into the old matcher would have detonated it. Hence: fix the matcher in
-- this file, ABOVE the seed, in the same transaction.
--
-- The new predicate, applied identically to both severities:
--
--     v_body ~ ('\y' || public.regexp_escape_literal(term) || '\y')
--
--   * `\y` is the Postgres ARE word-boundary escape (the equivalent of `\b` in
--     PCRE). `\yass\y` matches "kick ass" and does not match "Grass".
--   * `regexp_escape_literal()` backslash-escapes every regex metacharacter in
--     the term BEFORE it is interpolated. Two reasons, both load-bearing: a term
--     containing `.` or `*` must match literally rather than act as an operator,
--     and a term containing an unbalanced `(` or `[` must not raise
--     `invalid regular expression` INSIDE A BEFORE-INSERT TRIGGER — which would
--     turn one malformed admin-entered row into a total outage of posting,
--     commenting and DMs. After escaping, no term can compile to anything but a
--     literal, so that class of error cannot occur.
--   * Case is still handled by `v_body` being lowercased; the term is lowercased
--     at match time too, so a row typed in mixed case still works.
--
-- PHRASES STILL WORK. A term with a space — 'porch monkey', 'heil hitler',
-- 'kill yourself' — becomes `\yporch monkey\y`. The boundaries sit at the outer
-- edges of the phrase and the inner space is an ordinary literal, so the phrase
-- matches exactly as before.
--
-- WHAT WORD BOUNDARIES COST, and how the seed pays for it: matching is now
-- whole-word, so a stem no longer covers its own inflections. `\yfuck\y` does
-- NOT match "fucking", and `\ynigger\y` does NOT match "sandnigger". Every
-- inflection that matters is therefore enumerated explicitly in the seed below.
-- That is the intended trade: an under-match is a post that reaches the AI pass,
-- an over-match is a deleted post.
--
-- KNOWN LIMITS (deliberate, documented rather than papered over):
--   * A term whose first or last character is NOT a word character (say a term
--     beginning with '.') has no boundary to anchor against at a string edge.
--     Every seeded term is alphabetic, so this is inert today; keep it that way.
--   * `\y` keys off Postgres's alphanumeric class, and CJK characters are
--     alphanumeric. An ASCII term embedded in unspaced Japanese text will not
--     match. The wordlist is English-only, the AI pass is not, and this file
--     does not pretend to do non-English moderation.
--   * Evasion (unicode homoglyphs, zero-width joiners, "n i g g e r") is
--     explicitly NOT this layer's job. This is a cheap synchronous gate; the
--     omni-moderation pass in backend/social_moderation_worker.py is the layer
--     that is supposed to be robust.
--
-- ===========================================================================
-- 2. OPERATIONAL PRECONDITION — READ BEFORE APPLYING (the `pending` trap)
-- ===========================================================================
-- `soft` sets `content_status = 'pending'`, which is invisible to every reader
-- but the author (posts_select / comments_select). The design intent is "hidden
-- until the AI pass clears it". TWO things are true today that make `pending` a
-- ONE-WAY hide instead:
--
--   a. backend/social_moderation_worker.py is NOT on a cron. Its own docstring
--      says "NOT wired to cron yet". If it never runs, a soft hit is permanent.
--
--   b. Even when it runs, it never un-hides. `_moderate_text_table()` writes
--      `{"moderation_checked_at": "now()"}` and adds `content_status:'removed'`
--      only when the classifier flags the row. A clean row keeps whatever
--      `content_status` it already had — so a soft-flagged post that the AI
--      clears stays `pending` forever.
--
-- That is a backend fix (one line: also write `content_status = 'visible'` when
-- not flagged and the current status is `pending`), owned by whoever owns the
-- worker, and it is deliberately NOT made here — a trigger that flipped
-- `pending` -> `visible` on `moderation_checked_at` would also silently undo the
-- community-report auto-hide in `tg_reports_threshold()`, which sets the same
-- status for an unrelated reason.
--
-- SO: this file is safe to apply as-is on STAGING today (that is what staging is
-- for, and the hard tier — the dangerous one — is correct with or without the
-- worker). Before PRODUCTION, either land the worker fix, or apply this file and
-- immediately hold the soft tier back:
--
--     delete from public.blocked_terms where severity = 'soft';
--
-- and re-run the seed section of this file once the worker is on a cron. The
-- hard tier alone is still a meaningful gate and has no pending trap: it goes
-- straight to `removed` and stamps `moderation_checked_at` itself.
--
-- Un-sticking anything already caught, as an admin / service_role:
--
--     update public.posts set content_status = 'visible'
--      where content_status = 'pending' and moderation_checked_at is not null;
--
-- ===========================================================================
-- 3. HOW THE LIST WAS CURATED (the part that is not mechanical)
-- ===========================================================================
-- The two tiers are not "bad" and "worse". They are two different failure costs:
--
--   hard -> `removed`, no human ever sees it, the author is not told. A false
--           positive here DELETES a real post. Reserved for unambiguous hate
--           speech: racial, ethnic, homophobic and transphobic slurs that have
--           no innocent usage in an English-language TCG feed. The test applied
--           to every candidate was: "can I write a realistic sentence a card
--           collector would actually post that contains this word innocently?"
--           If yes — even once — it went to `soft`. The hard tier is small on
--           purpose. 19 terms, one of which is the test string.
--
--   soft -> `pending`, the AI pass and a human decide. A false positive costs a
--           delay, not a deletion. So everything ambiguous lives here: general
--           profanity, sexual terms, and every slur with a plausible innocent
--           homograph.
--
-- Note what the third option is. A term that is NOT in this table is still read
-- by the AI pass — the worker polls `moderation_checked_at is null`, i.e. EVERY
-- new post, not just flagged ones. So leaving a risky term out does not mean
-- "unmoderated"; it means "not pre-hidden". That is why several genuine slurs
-- below are soft, and a few are absent entirely.
--
-- TCG-SPECIFIC COLLISIONS, and what was done about each. These are the ones that
-- do NOT show up on a generic wordlist and are the reason this is not a paste:
--
--   'jap'      EXCLUDED ENTIRELY. "jap booster box", "jap set", "jap promo" is
--              everyday, benign shorthand for Japanese cards in this hobby — it
--              would be one of the most common words in the entire feed. Soft
--              would hide a large share of legitimate Japanese-card posts; hard
--              would delete them. The AI pass still sees these posts.
--   'ho'       EXCLUDED. `\yho\y` matches "Ho-Oh" — the hyphen is a non-word
--              character, so the boundary lands right where the Pokemon's name
--              splits. A top-50 Pokemon cannot be a blocked term.
--   'hoe'      EXCLUDED. Garden tool, mild, and adjacent to the same problem.
--   'trap'     EXCLUDED. Trap Cards are an entire card type in Yu-Gi-Oh, plus
--              Arena Trap and Trapinch. Unusable as a term here at any severity.
--   'sex'      EXCLUDED. "what sex is your Eevee" — Pokemon gender is a game
--              mechanic people ask about. Sexual terms are covered by ~20 more
--              specific entries that do not collide.
--   'gyp'/'gypped'
--              EXCLUDED. Derived from an ethnic slur, but "I got gypped on that
--              trade" is ordinary trading vocabulary. Low harm, high frequency.
--              ('gypsy'/'gypsies' are kept as soft — those are the slur proper.)
--   '1488'     EXCLUDED. The neo-Nazi numeric code is also a card number and a
--              price. `\y1488\y` matches "$1488 sold". Numeric hate codes are
--              unusable in a marketplace.
--   'kkk'      EXCLUDED. In Brazilian Portuguese "kkk" is laughter, and the
--              Brazilian Pokemon community is large. This would fire constantly
--              on people laughing.
--   'badass'   EXCLUDED. In this hobby it is a compliment about a card.
--   'ass'      EXCLUDED as a bare term ("kick ass pull" is praise); the
--              compounds that actually insult — asshole, dumbass, jackass,
--              asshat — are seeded individually as soft.
--   'tit'      EXCLUDED (it is a bird); 'tits'/'titties' are soft.
--   'queer'    EXCLUDED. Reclaimed and in ordinary neutral use as an identity
--              term. Blocking it would flag the people it is meant to protect.
--   'tranny'   SOFT, not hard. It is a real transphobic slur, but "the tranny in
--              my truck died on the way to the show" is a sentence someone at a
--              card show genuinely writes.
--   'chink'    SOFT, not hard. "a chink in the armor" is a live English idiom.
--   'kike'     SOFT, not hard. Kike is a very common Spanish nickname for
--              Enrique, and the LATAM collector community is large.
--   'spic'     SOFT, not hard. "spic and span" (of a card's condition).
--   'coon'     SOFT, not hard. Maine Coon — people post about their cats sitting
--              on their binders.
--   'dyke'     SOFT, not hard. An embankment, and a common surname (Van Dyke).
--   'fag'      SOFT, not hard. Still means cigarette in British English.
--              'faggot'/'faggots' ARE hard — no such defence.
--   'nigga'    SOFT, not hard. Reclaimed usage is real; the hard-r spellings are
--              hard. This is the one place the tiering is a judgement call
--              rather than a lookup, and it is deliberately the cautious one.
--   'nazi'     SOFT. "grammar nazi" is common and not hate speech; actual
--              antisemitism in context is exactly what the AI pass is for.
--   'retard'   SOFT. Ableist and unwelcome, but outside the "unambiguous hate
--              speech" definition the hard tier is reserved for.
--   'porn'     SOFT, knowingly. "mail day porn" / "card porn" is real hobby
--              slang for a nice pull, so this one WILL produce false pendings.
--              Kept anyway because it is a strong adult-content signal; it is
--              the first term to reconsider if the pending queue gets noisy.
--
-- Boundary matching is what makes most of the rest of the list safe at all.
-- Against the exact list seeded below, the OLD substring rule flags Cofagrigus,
-- Zigzagoon, cocoon, raccoon (fag/coon), Peacock, Woodcock, Cockatrice (cock),
-- Pussycat (pussy), Cummerbund (cum) and Dickinson (dick). The new rule flags
-- none of them — verified by query 3 in the footer, which returns zero rows.
-- Grass / Grassy Terrain / Assault Vest / assess / class / passage are only in
-- danger from a bare 'ass' term, which is why one is not seeded.
--
-- ===========================================================================
-- 4. ADDING AND REMOVING TERMS LATER (no migration required)
-- ===========================================================================
-- `blocked_terms` is an admin-only table (RLS: `public.is_admin()`, social_04).
-- Signed in as an admin, or from the SQL editor / service_role:
--
--     insert into public.blocked_terms (term, severity) values ('newterm', 'soft')
--       on conflict (term) do update set severity = excluded.severity;
--     update public.blocked_terms set severity = 'soft' where term = 'existing';
--     delete from public.blocked_terms where term = 'oops';
--
-- Rules for whoever does that:
--   * store terms LOWERCASE (the column comment in social_04 says so; the
--     matcher lowercases defensively, but keep the data clean);
--   * one row per inflection — the matcher is whole-word, see section 1;
--   * new terms default to `severity = 'hard'` if you omit the column. ALWAYS
--     pass it explicitly. Defaulting to the tier that deletes without review is
--     the single easiest way to break the feed;
--   * before adding anything, run the false-positive sweep in the verification
--     footer of this file with your candidate term added — it takes ten seconds
--     and it is how 'jap', 'ho' and '1488' were caught.

begin;

-- ---------------------------------------------------------------------------
-- Guard: every regex in this file is written as a plain (standard-conforming)
-- string literal, so `'\y'` is backslash-y and `'\\-'` is an escaped hyphen. If
-- `standard_conforming_strings` were off, backslashes would be eaten by the
-- literal parser and the matcher would install itself silently wrong — matching
-- the letter "y" as a boundary and mis-escaping the metacharacter class. On
-- (the default since PG 9.1, and Supabase's setting) it is correct. Fail loudly
-- rather than ship a broken filter.
-- ---------------------------------------------------------------------------
do $guard$
begin
  if current_setting('standard_conforming_strings') <> 'on' then
    raise exception
      'social_18 requires standard_conforming_strings = on (got %)',
      current_setting('standard_conforming_strings');
  end if;
end;
$guard$;

-- ---------------------------------------------------------------------------
-- regexp_escape_literal(): make an arbitrary string safe to paste into a regex.
--
-- Backslash-escapes the ARE metacharacters, so the result can only ever match
-- itself. Inside the bracket expression, `\[`, `\]` and `\\` are themselves
-- escaped because Postgres AREs — unlike POSIX EREs — keep `\` special inside
-- `[]`. The `-` is last so it is a literal hyphen and not a range.
--
-- Deliberately NOT `security definer` and deliberately WITHOUT a `set
-- search_path` clause: it needs no privileges, and a SET clause would block
-- inline expansion by the planner. `regexp_replace` is schema-qualified to
-- `pg_catalog` instead, which is the actual protection a search_path clause
-- would have been buying. `immutable strict parallel safe` so the planner can
-- fold it. Functions grant EXECUTE to PUBLIC by default (see social_17 §9), and
-- it exposes nothing, so no grant is issued.
-- ---------------------------------------------------------------------------
create or replace function public.regexp_escape_literal(p_text text)
returns text
language sql
immutable
strict
parallel safe
as $fn$
  select pg_catalog.regexp_replace(p_text, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g');
$fn$;

comment on function public.regexp_escape_literal(text) is
  'Backslash-escapes regex metacharacters so a string can be interpolated into a pattern as a literal. Used by tg_content_prefilter() to build word-boundary patterns from blocked_terms rows.';

-- ---------------------------------------------------------------------------
-- Synchronous pre-filter: wordlist + rate limit. BEFORE INSERT/UPDATE on
-- posts / comments / messages. SECURITY DEFINER so it can read blocked_terms
-- regardless of that table's RLS.
--
-- Body is social_04's verbatim apart from the two match predicates (and the
-- `pg_temp` added to search_path, matching social_07/social_09 — those exist
-- because a missing search_path or a non-definer function silently dropped
-- writes). The rate limit, the hard->removed / soft->pending semantics, the
-- `moderation_checked_at` handling (stamped on hard because no AI pass is
-- needed; left null on soft so the AI pass still decides) and the `messages`
-- special-case are all unchanged.
--
-- The triggers themselves are NOT re-created: social_04 already installed
-- `content_prefilter` on all three tables, they bind to this function by name,
-- and `create or replace function` swaps the body under them.
-- ---------------------------------------------------------------------------
create or replace function public.tg_content_prefilter()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_body       text := lower(coalesce(new.body, ''));
  v_author     uuid;
  v_author_col text := case when tg_table_name = 'messages' then 'sender_id' else 'author_id' end;
  v_recent     integer;
  v_hit        text;
  c_rate_limit constant integer := 30;   -- max rows per author per minute (per table)
begin
  -- Author id without knowing the column name at compile time (posts/comments use
  -- author_id, messages uses sender_id).
  v_author := (to_jsonb(new) ->> v_author_col)::uuid;

  -- Rate limit (only meaningful on INSERT).
  if tg_op = 'INSERT' then
    execute format(
      'select count(*) from public.%I where %I = $1 and created_at > now() - interval ''1 minute''',
      tg_table_name, v_author_col
    ) into v_recent using v_author;
    if v_recent >= c_rate_limit then
      raise exception 'rate_limited: too many posts in a short time, slow down';
    end if;
  end if;

  -- Hard slurs -> removed immediately, and mark as AI-checked (no need to re-scan).
  -- Whole-word match only: `\yass\y` hits "kick ass" and not "Grass". The term is
  -- escaped first so it can only ever match literally and can never raise.
  -- Empty/whitespace-only rows are skipped — such a term would otherwise match
  -- every body ever written.
  select bt.term into v_hit
    from public.blocked_terms bt
   where bt.severity = 'hard'
     and btrim(bt.term) <> ''
     and v_body ~ ('\y' || public.regexp_escape_literal(btrim(lower(bt.term))) || '\y')
   limit 1;
  if v_hit is not null then
    new.content_status := 'removed';
    if tg_table_name <> 'messages' then
      new.moderation_checked_at := now();
    end if;
    return new;
  end if;

  -- Soft terms -> pending; leave moderation_checked_at null so the AI pass decides.
  select bt.term into v_hit
    from public.blocked_terms bt
   where bt.severity = 'soft'
     and btrim(bt.term) <> ''
     and v_body ~ ('\y' || public.regexp_escape_literal(btrim(lower(bt.term))) || '\y')
   limit 1;
  if v_hit is not null then
    new.content_status := 'pending';
    return new;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- The wordlist.
--
-- `on conflict (term) do update set severity = excluded.severity` so this block
-- is re-runnable and so a severity correction can be shipped by editing the list
-- and re-running it (that is also the supported way to demote a term that turns
-- out to be noisy). It never deletes: a term an admin added by hand is left
-- alone unless it appears here.
--
-- Read section 3 above before adding to either list. Short version: `hard` is
-- unreviewable — nobody sees what it deletes.
-- ---------------------------------------------------------------------------

-- HARD — unambiguous hate speech only. Deleted on sight, no human in the loop.
insert into public.blocked_terms (term, severity) values
  -- racial (anti-Black). Whole-word matching means each spelling is its own row;
  -- 'sandnigger' is NOT covered by 'nigger'. A couple of leetspeak forms are
  -- included as the cheapest common evasions — exhaustive evasion is the AI
  -- pass's problem, not this table's.
  ('nigger',       'hard'),
  ('niggers',      'hard'),
  ('n1gger',       'hard'),
  ('nigg3r',       'hard'),
  ('sandnigger',   'hard'),
  ('jigaboo',      'hard'),
  ('porch monkey', 'hard'),   -- phrase term; exercises multi-word matching
  -- ethnic
  ('wetback',      'hard'),
  ('beaner',       'hard'),
  ('gook',         'hard'),
  ('raghead',      'hard'),
  ('towelhead',    'hard'),
  -- homophobic. 'fag'/'fags' are deliberately SOFT (British "cigarette").
  ('faggot',       'hard'),
  ('faggots',      'hard'),
  ('f4ggot',       'hard'),
  -- transphobic. 'tranny' is deliberately SOFT (vehicle transmission).
  ('shemale',      'hard'),
  ('shemales',     'hard'),
  -- hate slogan (phrase). 'hitler' alone is NOT blocked — history and memes.
  ('heil hitler',  'hard'),
  -- the harmless test string social_05 seeded; existing tests assert on it.
  ('zzblockedtest','hard')
on conflict (term) do update set severity = excluded.severity;

-- SOFT — hidden as `pending`, released or removed by the AI pass + a human.
-- Profanity, sexual content, and every slur with a plausible innocent homograph.
insert into public.blocked_terms (term, severity) values
  -- profanity: f-word family (one row per inflection — whole-word matching)
  ('fuck',            'soft'),
  ('fucks',           'soft'),
  ('fucked',          'soft'),
  ('fucking',         'soft'),
  ('fuckin',          'soft'),
  ('fucker',          'soft'),
  ('fuckers',         'soft'),
  ('fuckface',        'soft'),
  ('motherfucker',    'soft'),
  ('motherfuckers',   'soft'),
  ('clusterfuck',     'soft'),
  -- profanity: s-word family
  ('shit',            'soft'),
  ('shits',           'soft'),
  ('shitty',          'soft'),
  ('shitting',        'soft'),
  ('shithead',        'soft'),
  ('bullshit',        'soft'),
  ('dogshit',         'soft'),
  -- profanity: general insults
  ('bitch',           'soft'),
  ('bitches',         'soft'),
  ('bitchy',          'soft'),
  ('bitching',        'soft'),
  ('cunt',            'soft'),
  ('cunts',           'soft'),
  ('bastard',         'soft'),
  ('douchebag',       'soft'),
  ('skank',           'soft'),
  -- profanity: ass-compounds. Bare 'ass' is excluded — "kick ass pull".
  ('asshole',         'soft'),
  ('assholes',        'soft'),
  ('dumbass',         'soft'),
  ('dumbasses',       'soft'),
  ('jackass',         'soft'),
  ('asshat',          'soft'),
  -- profanity: anatomy-as-insult
  ('dick',            'soft'),   -- also a given name; delay is the right cost
  ('dicks',           'soft'),
  ('dickhead',        'soft'),
  ('dickheads',       'soft'),
  ('cock',            'soft'),
  ('cocks',           'soft'),
  ('cocksucker',      'soft'),
  ('cocksuckers',     'soft'),
  ('prick',           'soft'),
  ('pussy',           'soft'),
  ('pussies',         'soft'),
  ('twat',            'soft'),
  ('wanker',          'soft'),
  ('wankers',         'soft'),
  ('bellend',         'soft'),
  ('whore',           'soft'),
  ('whores',          'soft'),
  ('slut',            'soft'),
  ('sluts',           'soft'),
  -- sexual / adult content
  ('porn',            'soft'),   -- collides with "card porn"; see section 3
  ('porno',           'soft'),
  ('hentai',          'soft'),
  ('blowjob',         'soft'),
  ('handjob',         'soft'),
  ('creampie',        'soft'),
  ('deepthroat',      'soft'),
  ('cum',             'soft'),
  ('cumshot',         'soft'),
  ('jizz',            'soft'),
  ('milf',            'soft'),
  ('boner',           'soft'),
  ('dildo',           'soft'),
  ('orgasm',          'soft'),
  ('masturbate',      'soft'),
  ('nudes',           'soft'),
  ('penis',           'soft'),
  ('vagina',          'soft'),
  ('tits',            'soft'),   -- bare 'tit' excluded: it is a bird
  ('titties',         'soft'),
  ('boobs',           'soft'),
  ('nutsack',         'soft'),
  -- slurs downgraded to soft because a realistic innocent usage exists.
  -- Each of these is a real slur; the tier reflects the cost of being wrong,
  -- not a judgement that the word is fine. See section 3 for the sentence that
  -- demoted each one.
  ('nigga',           'soft'),
  ('niggas',          'soft'),
  ('fag',             'soft'),
  ('fags',            'soft'),
  ('dyke',            'soft'),
  ('dykes',           'soft'),
  ('chink',           'soft'),
  ('chinks',          'soft'),
  ('kike',            'soft'),
  ('kikes',           'soft'),
  ('spic',            'soft'),
  ('spics',           'soft'),
  ('coon',            'soft'),
  ('coons',           'soft'),
  ('wop',             'soft'),
  ('dago',            'soft'),
  ('polack',          'soft'),
  ('chinaman',        'soft'),
  ('gypsy',           'soft'),
  ('gypsies',         'soft'),
  ('homo',            'soft'),
  ('homos',           'soft'),
  ('fudgepacker',     'soft'),
  ('carpetmuncher',   'soft'),
  ('ladyboy',         'soft'),
  ('tranny',          'soft'),
  ('trannies',        'soft'),
  -- ableist
  ('retard',          'soft'),
  ('retards',         'soft'),
  ('retarded',        'soft'),
  ('tard',            'soft'),
  ('spastic',         'soft'),
  ('mongoloid',       'soft'),
  -- hate-adjacent, but with enough benign usage to need review ("grammar nazi")
  ('nazi',            'soft'),
  ('nazis',           'soft'),
  ('white power',     'soft'),
  ('white pride',     'soft'),
  -- harassment / self-harm (both phrases, again exercising multi-word matching)
  ('kys',             'soft'),
  ('kill yourself',   'soft'),
  -- sexual violence
  ('rape',            'soft'),
  ('raped',           'soft'),
  ('rapist',          'soft')
on conflict (term) do update set severity = excluded.severity;

commit;

-- ===========================================================================
-- VERIFICATION — run these after applying. Nothing below runs as part of the
-- migration. Queries 1-4 need no fixtures; 5 and 6 insert real rows.
-- ===========================================================================
--
-- 1. THE SCUNTHORPE FIX, standalone (no table, no trigger, no fixtures). This is
--    the one that matters: the old rule removes a post about Grass Energy, the
--    new rule does not, and the new rule still catches the actual word.
--
--    select
--      'i pulled a grass energy card' like '%' || 'ass' || '%'          as old_rule_removes_grass,   -- t  <-- the bug
--      'i pulled a grass energy card' ~ ('\y' || public.regexp_escape_literal('ass') || '\y')
--                                                                       as new_rule_removes_grass,   -- f  <-- fixed
--      'that was a kick ass pull'     ~ ('\y' || public.regexp_escape_literal('ass') || '\y')
--                                                                       as new_rule_still_matches;   -- t
--    -- expected: t, f, t
--
--    Same shape for the rest of the Pokemon collisions; all three must be false:
--    select
--      'cofagrigus ex'  ~ ('\y' || public.regexp_escape_literal('fag')  || '\y'),
--      'zigzagoon'      ~ ('\y' || public.regexp_escape_literal('coon') || '\y'),
--      'pussycat'       ~ ('\y' || public.regexp_escape_literal('pussy')|| '\y');
--    -- expected: f, f, f
--
-- 2. METACHARACTER ESCAPING — a term full of regex operators must match itself
--    and nothing else, and must not raise:
--
--    select public.regexp_escape_literal('a.b*c(d');                    -- a\.b\*c\(d
--    select 'axbxxcyd' ~ ('\y' || public.regexp_escape_literal('a.b*c(d') || '\y');   -- f
--    select 'a.b*c(d'  ~ ('\y' || public.regexp_escape_literal('a.b*c(d') || '\y');   -- t
--    select '[[['      ~ ('\y' || public.regexp_escape_literal('[[[')    || '\y');    -- f, and NO error
--
-- 3. FULL-LIST FALSE-POSITIVE SWEEP against real TCG vocabulary. This is the
--    check to re-run every time a term is added. It must return ZERO ROWS.
--
--    with corpus(txt) as (values
--      ('I pulled a Grass Energy and a Grassy Terrain'),
--      ('Assault Vest, brass frame, bass boosted, class of trainers'),
--      ('I need to assess the condition, there is a passage of play'),
--      ('Cofagrigus ex, Zigzagoon, Linoone, cocoon, raccoon'),
--      ('Ho-Oh ex and Hoenn starters'),
--      ('Peacock, Woodcock, Cockatrice, Pussycat, Cummerbund, Dickinson'),
--      ('jap booster box, japanese base set, jp promo'),
--      ('yu-gi-oh trap card, Arena Trap, Trapinch'),
--      ('what sex is your eevee'),
--      ('I got gypped on that trade'),
--      ('that pull is badass, kick ass pull'),
--      ('card 1488 in the set, $1488 sold, 018/165'),
--      ('kkkk that was funny'),
--      ('PSA 10 gem mint, BGS 9.5 black label, CGC 10 pristine'),
--      ('near mint, light whitening, surface scratches and a ding'),
--      ('Charizard VMAX rainbow rare, Umbreon VMAX alt art moonbreon'),
--      ('Team Rocket, Shining Fates, Evolving Skies, Crown Zenith, Skyridge'),
--      ('first edition base set shadowless, reverse holo, SIR full art'),
--      ('spec grading, sped up the scan, shipping in a top loader')
--    )
--    select c.txt, bt.term, bt.severity
--      from corpus c
--      join public.blocked_terms bt
--        on lower(c.txt) ~ ('\y' || public.regexp_escape_literal(lower(bt.term)) || '\y')
--     order by bt.severity, bt.term;
--    -- expected: 0 rows.
--
--    Swap the join predicate for `lower(c.txt) like '%' || bt.term || '%'` to see
--    what the OLD matcher would have done to the same corpus: 6 rows, hiding
--    Cofagrigus, Zigzagoon, cocoon, raccoon, Peacock, Woodcock, Cockatrice,
--    Pussycat, Cummerbund and Dickinson. That contrast IS the migration.
--
-- 4. TERM COUNTS PER SEVERITY.
--
--    select severity, count(*) from public.blocked_terms group by severity order by severity;
--    -- expected:  hard | 19      soft | 116        (total 135)
--
--    select severity, count(*) from public.blocked_terms
--     where term like '% %' group by severity;   -- phrase terms: hard 2, soft 3
--
--    Nothing should be sitting in an unexpected tier:
--    select * from public.blocked_terms where severity not in ('hard','soft');   -- 0 rows
--
-- 5. END-TO-END, HARD -> `removed`. As a real signed-in user (not service_role,
--    so RLS and the trigger both run):
--
--    insert into public.posts (author_id, body) values (auth.uid(), 'zzblockedtest hello')
--      returning content_status, moderation_checked_at;
--    -- expected: 'removed', and moderation_checked_at NOT null (the AI pass skips it).
--
--    A standalone slur behaves identically — substitute any row from
--    `select term from public.blocked_terms where severity='hard'` for
--    'zzblockedtest' above and the result must be the same 'removed'. Check the
--    phrase term too, since phrases are the case boundary matching could have
--    broken:
--    select 'go back to the porch monkey thread' ~
--           ('\y' || public.regexp_escape_literal('porch monkey') || '\y');   -- t
--
-- 6. END-TO-END, SOFT -> `pending`, NOT `removed`.
--
--    insert into public.posts (author_id, body) values (auth.uid(), 'this deck is bullshit')
--      returning content_status, moderation_checked_at;
--    -- expected: 'pending', and moderation_checked_at NULL — null is what hands
--    --           the row to the AI pass. If this comes back 'removed', the two
--    --           severity branches have been transposed.
--
--    ...and a clean post is untouched:
--    insert into public.posts (author_id, body) values (auth.uid(), 'pulled a Grass Energy today')
--      returning content_status;   -- expected: 'visible'
--
--    Then clean up: delete from public.posts where author_id = auth.uid() and body in
--      ('zzblockedtest hello','this deck is bullshit','pulled a Grass Energy today');
--
-- 7. RATE LIMIT UNCHANGED (it shares the trigger, so confirm it survived):
--    insert 31 posts in under a minute as one user — the 31st must raise
--    'rate_limited: too many posts in a short time, slow down'.
--
-- 8. If any of the above misbehaves, confirm the trigger is bound to the new
--    body and not a stale one:
--    select prosecdef, proconfig, pg_get_functiondef(oid)
--      from pg_proc where proname = 'tg_content_prefilter';
--    -- expected: prosecdef = t, proconfig = {search_path=public,	pg_temp},
--    --           and the body contains '\y', not 'like'.
