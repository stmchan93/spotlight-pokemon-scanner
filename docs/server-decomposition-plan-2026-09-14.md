# server.py decomposition — a zero-regression plan

**Status:** proposed, not started. Written 2026-09-14.

## The problem, stated correctly

`backend/server.py` is 24,503 lines, but "big file" is the wrong diagnosis.
The file is three things, and only one of them is a problem:

| Unit | Lines | |
|---|---|---|
| `SpotlightScanService` | 18,400 | **the problem** — one class, 420 methods |
| `SpotlightRequestHandler` | 4,046 | a routing table; different shape of change |
| module-level helpers | ~2,000 | fine as they are |

The service class holds **16 instance attributes** across 420 methods, and
almost all of them are infrastructure (`database_path`, `repo_root`, the
stores, the locks, the caches). Almost nothing shares state. This is not a
tangled object that needs untangling — it is a namespace that grew, and the
domains inside it barely touch each other.

Why it matters beyond aesthetics: on 2026-09-14 a single wrong price
(One Piece P-043, $460.66 where $89.78 was correct) turned out to have
causes in *three independent layers* of this class. Nobody could see the
seams, so nobody could see that the same symptom had three sources.

## The technique: mixins, not extraction

The obvious refactor — pull methods out into new modules as plain functions —
requires rewriting every call site. There are **319** of them (268 `self.X()`,
51 `SpotlightScanService.X()`). Every rewritten call site is a chance to
introduce a bug, and a 319-edit diff is unreviewable.

Instead, move methods into mixin base classes:

```python
class SpotlightScanService(
    SlabMixin,
    PortfolioMixin,
    PricingMixin,
    ScanMixin,
    ReviewMixin,
    CatalogMixin,
    SocialMixin,
):
```

Python resolves `self._normalized_slab_title_text(...)` through the MRO
identically whether the method is defined on the class or inherited from a
base. `SpotlightScanService._normalized_slab_title_text` also still resolves,
because class attribute lookup walks the MRO too.

**Zero call sites change.** The diff for each phase is: delete N methods from
one file, paste them unchanged into another, add one name to the bases tuple.

### Why this codebase qualifies

Checked before proposing, because mixins break under certain patterns:

| Risk | Finding |
|---|---|
| Code introspecting `SpotlightScanService.__dict__` | none |
| Tests monkeypatching class attributes (`Service.X = ...`) | none |
| Subclassing / `__new__` shims in tests | 5 sites, all inheritance-safe |
| `@staticmethod` (no `self`, trivially movable) | 93 methods, 2,217 lines |

If any of those had turned up, this plan would need revising. They did not.

## The safety net

Before moving anything, add a **surface snapshot test**: record every method
name on `SpotlightScanService`, its signature, and a hash of its source text;
assert the set is unchanged.

A pure move leaves all three identical. If a method is dropped, renamed, or
accidentally edited during a move, the snapshot fails on that commit — and
it fails for a *specific method*, not as a mysterious downstream error.

That gives two independent proofs per step:

1. the surface snapshot — nothing was lost or altered
2. `bash backend/run_all_tests.sh` — 1,746 tests, all modules (since 7c48b782)

## Phases

Ordered by isolation and risk, sized from the actual method distribution.
One phase per commit. Gate green before the next.

| # | Domain | Methods | Lines | Why here |
|---|---|---|---|---|
| 1 | social/profile | 7 | 111 | Trivial. Proves the machinery and the snapshot test. |
| 2 | review/labeling | 29 | 795 | Internal tooling; not on any user-facing path. |
| 3 | slab | 47 | 1,960 | Self-contained domain, few cross-calls. |
| 4 | catalog | 40 | 1,436 | |
| 5 | scan | 57 | 2,335 | |
| 6 | portfolio | 77 | 5,221 | Biggest single domain. |
| 7 | pricing | 78 | 3,274 | **Last.** See below. |
| — | other | 85 | 3,268 | Triage individually; most should stay put. |

Pricing goes last for two reasons: it shipped to production on 2026-09-14
(release gate `20260914T054534Z`), and it is the code that produced three
separate bugs that day. Move it only after the machinery has worked six
times without incident.

## Rules for every phase

- **No renames. No signature changes. No "while I'm here" fixes.** A commit
  that both moves and edits is unreviewable and unbisectable. Improvements
  land afterward, as their own commits, against the now-visible seams.
- **One domain per commit**, so a problem found weeks later bisects to a
  single domain.
- **The request handler is out of scope** until the service split is done.
  Its 4,046 lines are a routing table — a different kind of change.

## Sequencing against the flag retirement

Four flags are permanently set in both environments, so their off-branch is
unreachable:

| Flag | Value | Dead call sites |
|---|---|---|
| `PRICE_HISTORY_SOURCE` | `cells` | 14 |
| `RAW_MAIN_PRICE_SOURCE` | `tcgcsv` | 8 |
| `TCGCSV_SYNC_ENABLED` | `1` | 2 |
| `SPOTLIGHT_EBAY_BROWSE_ENABLED` | `1` | 2 |

These are migration scaffolding — the "flag off is byte-identical" tests all
over the pricing code exist to prove those migrations were safe. Both
migrations are complete and live in production, so retiring the scaffolding
is correct.

**Do it before the decomposition, not after**, and in a quiet week: removing
a flag means deleting the tests that proved its migration, which is the one
safety net that cannot be recovered afterward. Retiring flags first also
means Phase 7 moves less code.

## Separate finding: config drift

`SPOTLIGHT_VISUAL_COLLECTOR_TIEBREAK=1` (with `_MARGIN=0.03`, `_BETA=0.04`)
is set on staging and **absent from production**. That is a scanner accuracy
feature running on staging that production users do not get. Not cleanup —
it needs a decision: ship it or drop it from staging.
