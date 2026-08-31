#!/usr/bin/env python3
"""Throwaway local web tool for fast, multi-person labeling of exported scans.

Feeds off the review worksheet produced by tools/export_scan_training_rows.py
(CSV + images/) and lets a labeler, per scan: see the normalized capture, pick
the correct card from the model's top-10 as one-tap buttons, OR search the
catalog when the right card isn't in the ten, OR mark it "unclear"/"skip".

Decisions are appended to a sidecar JSONL (append-only, last write per scan
wins) so several people can label at once on one host without corrupting the
CSV. When you're done, run with --write-csv to merge the decisions back into a
final review CSV that tools/import_confirmed_scans_to_training.py consumes.

This tool is read-only against the scan DB (catalog search only) and never
touches GCS.

Serve (one host, friends point browsers at it):
  python3 tools/scan_labeling_server.py \
      --csv ~/spotlight-datasets/raw-visual-train/scan-review-exports/<batch>/scan_review.csv \
      --db backend/data/spotlight_scanner.sqlite \
      --host 0.0.0.0 --port 8765

Merge decisions into a final CSV for import:
  python3 tools/scan_labeling_server.py \
      --csv .../scan_review.csv --write-csv .../scan_review.reviewed.csv
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import os
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT / "tools") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "tools"))

from export_labeling_sessions_batch import default_database_path  # noqa: E402

# Another labeler's claim on a scan expires after this many seconds so a scan is
# never stuck "in progress" if someone closes their tab mid-card.
CLAIM_TTL_SECONDS = 120

CSV_FIELDS = [
    "scan_id", "created_at", "owner_user_id", "image_file", "normalized_object_path",
    "upload_status", "predicted_card_id", "predicted_card_name", "confirmed_card_id",
    "confirmed_card_name", "chosen_card_id", "top10_json", "notes",
]


# --------------------------------------------------------------------------- #
# Data loading / persistence
# --------------------------------------------------------------------------- #
def load_worklist(csv_path: Path) -> list[dict[str, str]]:
    with csv_path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def load_labels(labels_path: Path) -> dict[str, dict[str, Any]]:
    """Replay the append-only JSONL; the last decision per scan_id wins."""
    decisions: dict[str, dict[str, Any]] = {}
    if not labels_path.exists():
        return decisions
    with labels_path.open() as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            scan_id = str(record.get("scan_id") or "").strip()
            if scan_id:
                decisions[scan_id] = record
    return decisions


def append_label(labels_path: Path, record: dict[str, Any], lock: threading.Lock) -> None:
    with lock:
        with labels_path.open("a") as handle:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")


# --------------------------------------------------------------------------- #
# Catalog search (read-only against the scan DB's cards table)
# --------------------------------------------------------------------------- #
def search_catalog(db_path: Path | None, query: str, limit: int = 30) -> list[dict[str, str]]:
    query = (query or "").strip()
    if not query or not db_path or not db_path.exists():
        return []
    like = f"%{query}%"
    try:
        connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        try:
            rows = connection.execute(
                """
                SELECT id, name, number, set_name, image_small_url, image_url
                FROM cards
                WHERE name LIKE ? OR number LIKE ? OR set_name LIKE ?
                ORDER BY (CASE WHEN name LIKE ? THEN 0 ELSE 1 END), length(name), name
                LIMIT ?
                """,
                (like, like, like, f"{query}%", limit),
            ).fetchall()
        finally:
            connection.close()
    except sqlite3.Error:
        return []
    return [
        {
            "card_id": str(row["id"] or ""),
            "name": str(row["name"] or ""),
            "number": str(row["number"] or ""),
            "set": str(row["set_name"] or ""),
            "img": str(row["image_small_url"] or row["image_url"] or ""),
        }
        for row in rows
    ]


# --------------------------------------------------------------------------- #
# Server state
# --------------------------------------------------------------------------- #
class LabelingState:
    def __init__(self, *, worklist: list[dict[str, str]], labels_path: Path, db_path: Path | None,
                 images_root: Path, token: str | None = None):
        self.worklist = worklist
        self.order = [str(row["scan_id"]) for row in worklist]
        self.by_id = {str(row["scan_id"]): row for row in worklist}
        self.token = token
        # Rows that already carry a chosen_card_id are done — never hand them out
        # again, and (privacy) never expose their images over the link.
        self.prefilled = {
            str(row["scan_id"]) for row in worklist if str(row.get("chosen_card_id") or "").strip()
        }
        self.image_path_by_id = {
            str(row["scan_id"]): (images_root / Path(str(row.get("image_file") or "")).name)
            for row in worklist
            if str(row["scan_id"]) not in self.prefilled
        }
        self.labels_path = labels_path
        self.db_path = db_path
        self.decisions = load_labels(labels_path)
        self.claims: dict[str, tuple[str, float]] = {}  # scan_id -> (labeler, ts)
        self.lock = threading.Lock()

    def progress(self) -> dict[str, int]:
        labeled = sum(
            1 for sid in self.order
            if sid in self.prefilled or (sid in self.decisions and self.decisions[sid].get("disposition") == "labeled")
        )
        decided = sum(1 for sid in self.order if sid in self.prefilled or sid in self.decisions)
        return {"total": len(self.order), "labeled": labeled, "decided": decided, "remaining": len(self.order) - decided}

    def next_scan(self, labeler: str) -> dict[str, Any] | None:
        now = time.time()
        with self.lock:
            for sid in self.order:
                if sid in self.decisions or sid in self.prefilled:
                    continue
                claim = self.claims.get(sid)
                if claim and claim[0] != labeler and (now - claim[1]) < CLAIM_TTL_SECONDS:
                    continue  # someone else is actively on it
                self.claims[sid] = (labeler, now)
                return self.scan_payload(sid)
        return None

    def scan_payload(self, scan_id: str) -> dict[str, Any] | None:
        row = self.by_id.get(scan_id)
        if row is None:
            return None
        try:
            top10 = json.loads(row.get("top10_json") or "[]")
        except ValueError:
            top10 = []
        self._attach_candidate_images(top10)
        return {
            "scan_id": scan_id,
            "created_at": row.get("created_at", ""),
            "owner_user_id": row.get("owner_user_id", ""),
            "predicted_card_id": row.get("predicted_card_id", ""),
            "predicted_card_name": row.get("predicted_card_name", ""),
            "image_url": f"/img/{scan_id}",
            "top10": top10,
        }

    def _attach_candidate_images(self, candidates: list) -> None:
        """Fill each candidate's 'img' with the catalog reference thumbnail so the
        labeler can visually compare printings instead of guessing from numbers."""
        ids = [str(c.get("card_id") or "") for c in candidates if isinstance(c, dict) and not c.get("img")]
        ids = [i for i in ids if i]
        if not ids or not self.db_path or not Path(self.db_path).exists():
            return
        try:
            conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)
            try:
                marks = ",".join("?" * len(ids))
                lookup = {
                    str(r[0]): str(r[1] or r[2] or "")
                    for r in conn.execute(
                        f"SELECT id, image_small_url, image_url FROM cards WHERE id IN ({marks})", ids)
                }
            finally:
                conn.close()
        except sqlite3.Error:
            return
        for c in candidates:
            if isinstance(c, dict) and not c.get("img"):
                c["img"] = lookup.get(str(c.get("card_id") or ""), "")

    def record(self, *, scan_id: str, chosen_card_id: str, chosen_card_name: str, disposition: str, labeler: str) -> None:
        record = {
            "scan_id": scan_id,
            "chosen_card_id": chosen_card_id,
            "chosen_card_name": chosen_card_name,
            "disposition": disposition,  # labeled | unclear | skip
            "labeler": labeler,
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        append_label(self.labels_path, record, self.lock)
        with self.lock:
            self.decisions[scan_id] = record
            self.claims.pop(scan_id, None)


# --------------------------------------------------------------------------- #
# HTTP handler
# --------------------------------------------------------------------------- #
def make_handler(state: LabelingState):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):  # quiet
            pass

        def _send_json(self, payload: Any, status: int = 200) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            if state.token and params.get("k", [""])[0] != state.token:
                self.send_error(403, "forbidden")
                return
            if parsed.path == "/":
                body = INDEX_HTML.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if parsed.path == "/api/state":
                labeler = (params.get("labeler", [""])[0] or "anon").strip() or "anon"
                self._send_json({"progress": state.progress(), "next": state.next_scan(labeler)})
                return
            if parsed.path == "/api/search":
                q = params.get("q", [""])[0]
                self._send_json({"results": search_catalog(state.db_path, q)})
                return
            if parsed.path.startswith("/img/"):
                scan_id = parsed.path[len("/img/"):]
                self._serve_image(scan_id)
                return
            self.send_error(404)

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if state.token and parse_qs(parsed.query).get("k", [""])[0] != state.token:
                self.send_error(403, "forbidden")
                return
            if parsed.path != "/api/label":
                self.send_error(404)
                return
            length = int(self.headers.get("Content-Length", "0") or "0")
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                self._send_json({"error": "bad json"}, status=400)
                return
            scan_id = str(payload.get("scan_id") or "").strip()
            if scan_id not in state.by_id:
                self._send_json({"error": "unknown scan"}, status=400)
                return
            disposition = str(payload.get("disposition") or "labeled")
            state.record(
                scan_id=scan_id,
                chosen_card_id=str(payload.get("chosen_card_id") or "").strip(),
                chosen_card_name=str(payload.get("chosen_card_name") or "").strip(),
                disposition=disposition,
                labeler=str(payload.get("labeler") or "anon").strip() or "anon",
            )
            labeler = str(payload.get("labeler") or "anon").strip() or "anon"
            self._send_json({"progress": state.progress(), "next": state.next_scan(labeler)})

        def _serve_image(self, scan_id: str) -> None:
            path = state.image_path_by_id.get(scan_id)
            if path is None or not path.exists():
                self.send_error(404)
                return
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

    return Handler


# --------------------------------------------------------------------------- #
# Merge mode (no server): write decisions back into a final review CSV
# --------------------------------------------------------------------------- #
def write_reviewed_csv(*, worklist: list[dict[str, str]], decisions: dict[str, dict[str, Any]], out_path: Path) -> dict[str, int]:
    counts = {"labeled": 0, "unclear": 0, "skip": 0, "untouched": 0}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for row in worklist:
            out = {key: row.get(key, "") for key in CSV_FIELDS}
            decision = decisions.get(str(row["scan_id"]))
            if decision is None:
                counts["untouched"] += 1
            elif decision.get("disposition") == "labeled" and decision.get("chosen_card_id"):
                out["chosen_card_id"] = decision["chosen_card_id"]
                counts["labeled"] += 1
            else:
                disposition = decision.get("disposition") or "unclear"
                # Leave chosen_card_id blank so the importer skips it; record why.
                out["chosen_card_id"] = ""
                note = (out.get("notes") or "").strip()
                out["notes"] = f"{note + ' ' if note else ''}[{disposition} by {decision.get('labeler', 'anon')}]"
                counts[disposition] = counts.get(disposition, 0) + 1
            writer.writerow(out)
    return counts


# --------------------------------------------------------------------------- #
def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--csv", type=Path, required=True, help="Review worksheet CSV from export_scan_training_rows.py.")
    parser.add_argument("--db", type=Path, default=default_database_path(), help="Scan DB for catalog search (read-only).")
    parser.add_argument("--labels", type=Path, help="Sidecar decisions JSONL (default: labels.jsonl next to the CSV).")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (use 0.0.0.0 to share on your LAN).")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--access-token", help="Require ?k=TOKEN on every request (gate a shared/tunneled link).")
    parser.add_argument("--write-csv", type=Path, help="Merge decisions into this CSV and exit (no server).")
    args = parser.parse_args()

    if not args.csv.exists():
        print(f"error: review CSV not found at {args.csv}", file=sys.stderr)
        return 2

    worklist = load_worklist(args.csv)
    labels_path = args.labels or (args.csv.parent / "labels.jsonl")
    images_root = args.csv.parent / "images"

    if args.write_csv:
        counts = write_reviewed_csv(
            worklist=worklist, decisions=load_labels(labels_path), out_path=args.write_csv
        )
        print(json.dumps({"reviewedCsv": str(args.write_csv), "counts": counts}, indent=2))
        print(
            "\nNext: python3 tools/import_confirmed_scans_to_training.py "
            f"--csv {args.write_csv} --db {args.db} --run-batch"
        )
        return 0

    db_path = args.db if args.db and args.db.exists() else None
    if db_path is None:
        print(f"warning: catalog search disabled (DB not found at {args.db}); top-10 picking still works.", file=sys.stderr)

    state = LabelingState(worklist=worklist, labels_path=labels_path, db_path=db_path,
                          images_root=images_root, token=args.access_token)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(state))
    progress = state.progress()
    suffix = f"/?k={args.access_token}" if args.access_token else "/"
    print(f"Labeling {progress['total']} scans ({progress['decided']} already decided, {progress['remaining']} to go).")
    print(f"Decisions append to: {labels_path}")
    if args.access_token:
        print(f"Access token REQUIRED. Share links as http://HOST:{args.port}{suffix}")
    print(f"Open http://{args.host}:{args.port}{suffix}  (have each friend set their name top-right)")
    print("Stop with Ctrl-C, then re-run with --write-csv to produce the import CSV.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
    finally:
        server.server_close()
    return 0


INDEX_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scan labeling</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family: system-ui, sans-serif; background:#0b0b0c; color:#f2f2f2; }
  header { display:flex; align-items:center; gap:16px; padding:10px 16px; background:#151517; position:sticky; top:0; }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  header .spacer { flex:1; }
  header input { background:#000; border:1px solid #444; color:#fff; border-radius:8px; padding:6px 10px; font-size:13px; }
  #progress { font-size:13px; color:#bbb; }
  main { display:flex; gap:24px; padding:20px; align-items:flex-start; max-width:1100px; margin:0 auto; }
  #imgwrap { flex:0 0 320px; }
  #imgwrap img { width:320px; border-radius:8px; background:#000; box-shadow:0 0 24px rgba(0,0,0,0.5); }
  #imgwrap .meta { color:#888; font-size:12px; margin-top:8px; word-break:break-all; }
  #panel { flex:1; }
  .pred { color:#aaa; font-size:13px; margin-bottom:12px; }
  .pred b { color:#fee333; }
  .btnrow { display:flex; flex-direction:column; gap:8px; }
  button.card { text-align:left; background:#1c1c1f; border:1px solid #2c2c30; color:#fff; border-radius:10px; padding:10px 12px; font-size:14px; cursor:pointer; display:flex; gap:10px; align-items:center; }
  button.card img.thumb { width:56px; height:78px; object-fit:cover; border-radius:4px; background:#000; flex:none; }
  button.card:hover { border-color:#fee333; }
  button.card .k { color:#fee333; font-weight:700; width:20px; flex:0 0 20px; }
  button.card .sub { color:#999; font-size:12px; }
  .actions { display:flex; gap:10px; margin:16px 0; }
  .actions button { background:#26181a; border:1px solid #553; color:#f2c; border-radius:10px; padding:8px 14px; cursor:pointer; }
  .actions button.skip { background:#1a1a1a; border-color:#444; color:#aaa; }
  #search { width:100%; box-sizing:border-box; background:#000; border:1px solid #444; color:#fff; border-radius:8px; padding:9px 12px; font-size:14px; margin:14px 0 8px; }
  #done { padding:40px; text-align:center; color:#8c8; font-size:18px; }
  .hint { color:#666; font-size:12px; margin-top:18px; }
</style></head>
<body>
<header>
  <h1>Scan labeling</h1>
  <span id="progress">…</span>
  <span class="spacer"></span>
  <label style="font-size:12px;color:#888">you: <input id="labeler" placeholder="your name" size="10"></label>
</header>
<main id="main"></main>
<script>
let cur = null;
// Session-local stack of already-decided scans so 'b' can step back and
// re-decide (the server is last-write-wins per scan_id, so a re-label just
// overwrites the earlier decision in labels.jsonl).
const history = [];
const labelerEl = document.getElementById('labeler');
labelerEl.value = localStorage.getItem('labeler') || '';
labelerEl.addEventListener('change', () => localStorage.setItem('labeler', labelerEl.value));
function labeler(){ return (labelerEl.value || 'anon').trim() || 'anon'; }
const K = new URLSearchParams(location.search).get('k') || '';
const KS = K ? ('&k=' + encodeURIComponent(K)) : '';

function setProgress(p){ document.getElementById('progress').textContent =
  p.labeled + ' labeled · ' + p.decided + '/' + p.total + ' done · ' + p.remaining + ' left'; }

async function load(){
  const r = await fetch('/api/state?labeler=' + encodeURIComponent(labeler()) + KS);
  const d = await r.json(); setProgress(d.progress); render(d.next);
}
async function send(disposition, card){
  if(!cur) return;
  const body = { scan_id: cur.scan_id, disposition, labeler: labeler(),
    chosen_card_id: card ? card.card_id : '', chosen_card_name: card ? card.name : '' };
  const decided = cur;
  const r = await fetch('/api/label' + (K ? '?k=' + encodeURIComponent(K) : ''), {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
  const d = await r.json(); setProgress(d.progress);
  if(decided && (!history.length || history[history.length-1].scan_id !== decided.scan_id)) history.push(decided);
  render(d.next);
}
function goBack(){
  if(!history.length) return;
  render(history.pop());
}
function cardButton(c, idx){
  const b = document.createElement('button'); b.className='card';
  const k = idx!=null ? (idx<9 ? (idx+1) : 0) : '';
  const thumb = c.img ? '<img class="thumb" loading="lazy" src="'+esc(c.img)+'" onerror="this.style.display=\'none\'">' : '';
  b.innerHTML = '<span class="k">'+(k!==''?k:'')+'</span>'+thumb+'<span>'+esc(c.name||'(no name)')+
    '<div class="sub">'+esc([c.number, c.set].filter(Boolean).join(' · '))+'</div></span>';
  b.onclick = () => send('labeled', c);
  return b;
}
function esc(s){ const d=document.createElement('div'); d.textContent=s==null?'':s; return d.innerHTML; }
function render(next){
  cur = next; const main = document.getElementById('main');
  if(!next){ main.innerHTML = '<div id="done">🎉 All done — nothing left to label.<br>Stop the server and run with --write-csv.</div>'; return; }
  main.innerHTML = '';
  const imgwrap = document.createElement('div'); imgwrap.id='imgwrap';
  imgwrap.innerHTML = '<img src="'+next.image_url+'?t='+Date.now()+KS+'"><div class="meta">'+esc(next.scan_id)+'</div>';
  const panel = document.createElement('div'); panel.id='panel';
  const pred = document.createElement('div'); pred.className='pred';
  pred.innerHTML = 'Model guessed: <b>'+esc(next.predicted_card_name||'(none)')+'</b>';
  panel.appendChild(pred);
  const row = document.createElement('div'); row.className='btnrow';
  (next.top10||[]).slice(0,10).forEach((c,i)=> row.appendChild(cardButton(c,i)));
  if(!(next.top10||[]).length) row.innerHTML = '<div class="sub" style="color:#888">No stored candidates — search below.</div>';
  panel.appendChild(row);
  const actions = document.createElement('div'); actions.className='actions';
  const u = document.createElement('button'); u.textContent='Unclear (u)'; u.onclick=()=>send('unclear');
  const s = document.createElement('button'); s.className='skip'; s.textContent='Skip (s)'; s.onclick=()=>send('skip');
  const bk = document.createElement('button'); bk.className='skip'; bk.textContent='Back (b)'; bk.onclick=goBack;
  actions.append(u,s,bk); panel.appendChild(actions);
  const search = document.createElement('input'); search.id='search'; search.placeholder='Search the catalog (name / number / set)…';
  const results = document.createElement('div'); results.className='btnrow';
  let timer=null;
  search.addEventListener('input', ()=>{ clearTimeout(timer); timer=setTimeout(async()=>{
    if(search.value.trim().length<2){ results.innerHTML=''; return; }
    const r = await fetch('/api/search?q='+encodeURIComponent(search.value)+KS); const d = await r.json();
    results.innerHTML=''; (d.results||[]).forEach(c=> results.appendChild(cardButton(c,null)));
  },180); });
  panel.append(search, results);
  const hint = document.createElement('div'); hint.className='hint';
  hint.textContent='Keys: 1–9,0 pick a candidate · u = unclear · s = skip · b = back (re-decide)';
  panel.appendChild(hint);
  main.append(imgwrap, panel);
}
document.addEventListener('keydown', (e)=>{
  if(document.activeElement && document.activeElement.id==='search') return;
  if(!cur) return;
  if(e.key==='u'){ send('unclear'); }
  else if(e.key==='s'){ send('skip'); }
  else if(e.key==='b'){ goBack(); }
  else if(/^[0-9]$/.test(e.key)){
    const idx = e.key==='0' ? 9 : (parseInt(e.key,10)-1);
    const c = (cur.top10||[])[idx]; if(c) send('labeled', c);
  }
});
load();
</script>
</body></html>"""


if __name__ == "__main__":
    raise SystemExit(main())
