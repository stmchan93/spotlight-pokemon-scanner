"""Local review page for the art-tag gold set (stdlib only).

    python3 qa/art-tags-gold/review_server.py      # then open http://127.0.0.1:8791

One card at a time: image on the left, editable tags on the right.
  a / Enter  = looks right   (review_state -> human_ok)
  s          = save my edits (review_state -> human_fixed)
  j / k      = next / previous card, u = jump to next unreviewed
Every save rewrites draft-v1.jsonl in place (atomic), so you can stop anytime.
Edits are validated against the vocab before they're written.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
JSONL = HERE / "draft-v1.jsonl"
sys.path.insert(0, str(HERE))
import validate  # noqa: E402

EDITABLE = ("scene", "weather_time", "activity", "mood", "objects", "art_style", "composition",
            "appearing_pokemon", "characters", "alt_text", "notes")


def load() -> list[dict]:
    return [json.loads(line) for line in JSONL.read_text().splitlines() if line.strip()]


def save(rows: list[dict]) -> None:
    fd, tmp = tempfile.mkstemp(dir=HERE, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
    os.replace(tmp, JSONL)


def check(row: dict) -> list[str]:
    return list(validate.check(row) or [])


PAGE = r"""<!doctype html><meta charset=utf-8><title>Art-tag review</title>
<style>
body{font:14px system-ui;margin:0;display:flex;height:100vh}
#l{flex:0 0 46%;display:flex;align-items:center;justify-content:center;background:#111}
#l img{max-height:96vh;max-width:96%}
#r{flex:1;padding:14px 18px;overflow:auto}
textarea{width:100%;height:58vh;font:12px ui-monospace,monospace}
button{font-size:14px;padding:6px 12px;margin-right:6px}
.ok{background:#1a7f37;color:#fff}.fix{background:#9a6700;color:#fff}
#err{color:#c00;white-space:pre-wrap}#bar{height:6px;background:#ddd}#bar>div{height:6px;background:#1a7f37}
small{color:#666}
</style>
<div id=l><img id=img></div>
<div id=r>
<div id=bar><div id=prog></div></div>
<h3 id=title></h3><small id=meta></small>
<p><button class=ok onclick=ok()>Looks right (a)</button><button class=fix onclick=fix()>Save edits (s)</button>
<button onclick=go(-1)>◀ k</button><button onclick=go(1)>j ▶</button><button onclick=nextTodo()>next unreviewed (u)</button></p>
<div id=err></div>
<p><small>Check: every Pokémon in the art incl. tiny background ones (role main/secondary/background/cameo), scene, mood, objects. Edit the JSON, then Save.</small></p>
<textarea id=ta spellcheck=false></textarea>
</div>
<script>
let rows=[],i=0;const ED=%EDITABLE%;
async function load(){rows=await (await fetch('/rows')).json();const q=+location.hash.slice(1);i=isNaN(q)?0:q;if(!location.hash){i=rows.length-1;nextTodo(true)}show()}
function show(){const r=rows[i];document.getElementById('img').src='https://images.scrydex.com/pokemon/'+r.card_id+'/large';
document.getElementById('title').textContent=(i+1)+'/'+rows.length+'  '+r.name+'  ('+r.card_id+')';
document.getElementById('meta').textContent=(r.set||'')+'  ·  state: '+(r.review_state||'draft');
const e={};ED.forEach(k=>{if(k in r)e[k]=r[k]});document.getElementById('ta').value=JSON.stringify(e,null,1);
document.getElementById('err').textContent='';const done=rows.filter(x=>(x.review_state||'').startsWith('human')).length;
document.getElementById('prog').style.width=(100*done/rows.length)+'%';location.hash=i}
function go(d){i=Math.max(0,Math.min(rows.length-1,i+d));show()}
function nextTodo(silent){for(let k=1;k<=rows.length;k++){const j=(i+k)%rows.length;if(!(rows[j].review_state||'').startsWith('human')){i=j;if(!silent)show();return}}if(!silent)alert('All reviewed 🎉')}
async function post(state,edits){const res=await fetch('/save',{method:'POST',body:JSON.stringify({index:i,state,edits})});const j=await res.json();
if(!res.ok){document.getElementById('err').textContent=j.error;return false}rows[i]=j.row;return true}
async function ok(){if(await post('human_ok',null)){nextTodo()}}
async function fix(){let e;try{e=JSON.parse(document.getElementById('ta').value)}catch(x){document.getElementById('err').textContent='Bad JSON: '+x;return}
if(await post('human_fixed',e)){nextTodo()}}
document.addEventListener('keydown',ev=>{if(ev.target.tagName=='TEXTAREA'&&!(ev.metaKey||ev.ctrlKey))return;
if(ev.key=='a'||ev.key=='Enter'){ev.preventDefault();ok()}else if(ev.key=='s'){ev.preventDefault();fix()}
else if(ev.key=='j')go(1);else if(ev.key=='k')go(-1);else if(ev.key=='u')nextTodo()});
load();
</script>"""


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, body) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/rows":
            return self._json(200, load())
        page = PAGE.replace("%EDITABLE%", json.dumps(EDITABLE)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def do_POST(self) -> None:
        if self.path != "/save":
            return self._json(404, {"error": "not found"})
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        rows = load()
        index = int(body.get("index", -1))
        if not 0 <= index < len(rows):
            return self._json(400, {"error": "bad index"})
        row = dict(rows[index])
        for key, value in (body.get("edits") or {}).items():
            if key in EDITABLE:
                row[key] = value
        row["review_state"] = body.get("state") if body.get("state") in ("human_ok", "human_fixed") else "human_ok"
        errors = check(row)
        if errors:
            return self._json(400, {"error": "\n".join(map(str, errors))})
        rows[index] = row
        save(rows)
        return self._json(200, {"row": row})

    def log_message(self, *args) -> None:  # quiet
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8791"))
    print(f"Review page: http://127.0.0.1:{port}  ({JSONL.name})")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
