# Pokemon Scanner System Design

Date: 2026-04-02

Update: see [spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md) for the current source of truth. This document is now background/reference.

Purpose: Turn the scanner architecture into a concrete system diagram and implementation checklist.

## Short Answer

Yes, you have enough to start implementing a real v1 prototype.

No, you do not have every production question answered yet.

That is normal.

You now have enough clarity to build:

- single-card camera capture
- crop and normalize
- query a matcher
- return top candidates
- confirm or correct

That is the right implementation boundary.

## System Diagram

```text
                    OFFLINE / BATCH SIDE

  Reference Card Images + Card Metadata
                  |
                  v
      +----------------------------+
      | Catalog Build Pipeline     |
      | - normalize ref images     |
      | - generate embeddings      |
      | - attach card metadata     |
      +----------------------------+
                  |
                  v
      +----------------------------+
      | Catalog Store              |
      | cards                      |
      | card_images                |
      | card_embeddings            |
      +----------------------------+
                  |
                  v
      +----------------------------+
      | ANN Vector Index           |
      | top-K nearest retrieval    |
      +----------------------------+


                    ONLINE / RUNTIME SIDE

  User Camera / Photo Upload
                  |
                  v
      +----------------------------+
      | iOS Client                 |
      | - detect rectangle         |
      | - crop / perspective fix   |
      | - quality checks           |
      | - OCR tokens               |
      | - query embedding          |
      +----------------------------+
                  |
                  v
      +----------------------------+
      | Scan Match API             |
      | receives cropped image,    |
      | OCR tokens, query vector   |
      +----------------------------+
                  |
                  v
      +----------------------------+
      | Candidate Retrieval        |
      | ANN top-K search           |
      +----------------------------+
                  |
                  v
      +----------------------------+
      | Reranker / Confidence      |
      | - image similarity         |
      | - OCR number match         |
      | - name / set consistency   |
      | - ambiguity flags          |
      +----------------------------+
                  |
                  v
      +----------------------------+
      | Match Response             |
      | best match + alternates    |
      | + confidence + flags       |
      +----------------------------+
                  |
                  v
      +----------------------------+
      | Result UI                  |
      | accept / choose alternate  |
      | / manual search            |
      +----------------------------+
                  |
                  v
      +----------------------------+
      | Scan Logging               |
      | scan_events                |
      | scan_candidates            |
      | scan_feedback              |
      +----------------------------+
                  |
                  v
      +----------------------------+
      | Training / Improvement     |
      | hard negatives, weights,   |
      | thresholds, new refs       |
      +----------------------------+
```

## Sequence Diagram

```text
1. User captures photo
2. Client crops and normalizes card
3. Client runs OCR and creates query embedding
4. Client sends request to scan API
5. API queries ANN index for top K image candidates
6. Reranker scores candidates using OCR + metadata
7. API returns best match, alternates, confidence, flags
8. User accepts or corrects
9. System logs prediction and final outcome
```

## Runtime Data Flow

```text
photo
  -> crop / perspective fix
  -> quality checks
  -> OCR tokens
  -> query embedding
  -> ANN top-K candidates
  -> rerank with OCR + metadata
  -> confidence
  -> UI result
  -> user feedback
  -> learning data
```

## Component Breakdown

### 1. Client capture pipeline

Responsibilities:

- camera capture
- image import
- rectangle detection
- crop and normalize
- blur / glare checks
- OCR token extraction
- query embedding generation
- request retry / local queue

This is the part that keeps the product responsive on bad internet.

### 2. Catalog pipeline

Responsibilities:

- ingest Pokemon catalog
- ingest reference images
- compute embeddings in batch
- store metadata
- update index when new cards arrive

This is the part that makes retrieval possible.

### 3. ANN retrieval service

Responsibilities:

- nearest-neighbor vector lookup
- return top K candidate card/image ids fast

This is the part that avoids brute-force comparison over all vectors.

### 4. Reranker

Responsibilities:

- combine image similarity with OCR and metadata
- detect ambiguities
- compute confidence

This is the part that turns “close visual candidates” into “best likely identity.”

### 5. Logging and feedback loop

Responsibilities:

- store every prediction
- store top K candidates
- store user correction or acceptance
- store quality issues and timing

This is the moat layer.

## What You Can Build Immediately

You can start implementation now if you freeze the v1 boundary to:

- one card
- one photo
- one result
- alternates
- manual correction

Immediate implementation tracks:

### Track A: Client prototype

- camera / upload
- crop and normalize
- OCR token extraction
- request to stub API
- result screen

### Track B: Catalog prototype

- choose a small Pokemon subset
- collect reference images
- compute reference embeddings
- build a small ANN index

### Track C: Matching API prototype

- accept cropped image or query embedding
- return top K nearest cards
- add simple OCR reranking
- return confidence label

### Track D: Logging

- store scan event
- store candidates
- store final selected card

Do not wait for the full production catalog before proving the loop.

## What Is Decided

These decisions are clear enough now:

- use hybrid architecture
- use image retrieval first
- use OCR as a supporting reranking signal
- use ANN indexing instead of brute-force search
- keep offline support degraded, not fully offline
- log prediction and correction data from day one
- defer pricing until identity works

## What Is Still Open

These are the biggest unresolved implementation choices:

### 1. Catalog source and image rights

You still need to decide:

- where the reference metadata comes from
- where the reference images come from
- what usage rights you have

This is not optional.

### 2. Embedding model choice

You still need to decide:

- Apple Vision feature prints only
- a pretrained image embedding model
- a custom/fine-tuned model later

For v1, choose the simplest model that works.

### 3. ANN infrastructure

You still need to choose:

- pgvector
- FAISS
- another ANN store

For v1, choose something easy to operate.

### 4. OCR extraction scope

You still need to define:

- which text regions to read
- what normalization rules to apply
- whether you extract full text or just targeted fields

### 5. Confidence thresholds

You still need to define:

- what score difference counts as high confidence
- when to jump directly to result
- when to force alternate matches

### 6. Data retention policy

You still need rules for:

- whether raw images are stored
- how long they are stored
- whether cropped images are retained
- privacy and deletion behavior

### 7. Evaluation set

You still need a benchmark set with:

- good photos
- bad lighting
- glare
- sleeves
- promos
- holo / reverse holo / non-holo

Otherwise you cannot measure real progress.

## What You Do Not Need To Decide Yet

You do not need these to start the first prototype:

- full pricing provider
- bundle pricing UX
- deal log
- eBay sync
- full offline catalog
- perfect model moat on day one

## Moat Checklist

If you want the moat later, do these from the start:

- version the embedding model
- log top K candidates, not just final winner
- log whether user accepted or corrected the top prediction
- log OCR tokens and OCR confidence
- log glare / blur / crop metrics
- log time to confirmation
- log ambiguity flags
- keep reference image lineage and source metadata

If you fail to log those, you lose a lot of the compounding value.

## Recommended First Prototype Plan

### Week 1 shape

1. build scanner UI
2. crop card from photo
3. generate one query embedding
4. query a tiny ANN index
5. return top 5 candidates
6. let user confirm or correct
7. log everything

### First benchmark goal

On a constrained Pokemon subset:

- return top 5 candidates quickly
- top 1 is often right
- correction flow is fast when top 1 is wrong

That is enough to validate the architecture.

## Final Answer

You do have enough answered to start implementing the first real scanner loop.

You do not yet have enough answered for a production-ready nationwide system, and you do not need to.

The right move is:

- start with the scanner loop
- log rich metadata
- measure failure modes
- improve retrieval and reranking from real show-floor corrections

That is how you get both a working v1 and the foundation for a real moat.
