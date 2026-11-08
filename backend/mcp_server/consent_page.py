"""OAuth consent page for "Log in with Ekalight" (Supabase OAuth 2.1 server).

Supabase redirects here as <Site URL>/oauth/consent?authorization_id=…; the page
signs the user in, shows who is asking, and approves or denies via supabase-js.

Sign-in is an email code with shouldCreateUser=false: this page must never mint
a new auth user (every auth user is a billable MAU). Guest (anonymous) sessions
are refused. The anon/publishable key is public by design.
"""

from __future__ import annotations

import html
import json

SUPABASE_JS_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.104.1/+esm"

_PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect to Ekalight</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.45 -apple-system,system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#0f0f14;color:#eee}
.card{width:min(420px,92vw);background:#1b1b24;border-radius:16px;padding:28px;box-shadow:0 8px 40px #0008}
h1{font-size:20px;margin:0 0 6px}p{margin:8px 0;color:#bbb}
input{width:100%;box-sizing:border-box;font-size:16px;padding:12px;border-radius:10px;border:1px solid #333;background:#111;color:#eee;margin:8px 0}
button{width:100%;font-size:16px;font-weight:600;padding:12px;border-radius:10px;border:0;margin-top:8px;cursor:pointer}
.primary{background:#7c5cff;color:#fff}.secondary{background:#2a2a36;color:#ddd}
.warn{background:#3a2a10;color:#ffcc80;border-radius:10px;padding:10px;font-size:14px}
.err{color:#ff8a80;font-size:14px;min-height:1em}.muted{color:#888;font-size:13px}
code{background:#111;padding:2px 6px;border-radius:6px;word-break:break-all}
.hidden{display:none}
</style></head>
<body><div class="card">
  <div id="loading"><p>Loading…</p></div>

  <div id="signin" class="hidden">
    <h1>Sign in to Ekalight</h1>
    <p>An app wants to connect to your Ekalight account. Sign in with the email on your account.</p>
    <input id="email" type="email" autocomplete="email" placeholder="you@example.com">
    <button class="primary" id="send">Email me a code</button>
    <div id="codebox" class="hidden">
      <input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code">
      <button class="primary" id="verify">Sign in</button>
    </div>
    <p class="muted">No account yet? Create one in the Ekalight app first.</p>
  </div>

  <div id="consent" class="hidden">
    <h1 id="title">Allow access?</h1>
    <p><b id="client"></b> wants to read your Ekalight collection, prices and wishlist.</p>
    <p class="muted">Signed in as <span id="who"></span> · <a href="#" id="switch" style="color:#9d8bff">not you?</a></p>
    <p class="muted">It will send you back to <code id="redirect"></code></p>
    <div id="loopback" class="warn hidden">This sends the approval to an app running on your own computer (for example Claude Code). Only approve if you just started this.</div>
    <button class="primary" id="approve">Approve</button>
    <button class="secondary" id="deny">Deny</button>
  </div>

  <div id="done" class="hidden"><h1 id="donetitle"></h1><p id="donetext"></p></div>
  <p class="err" id="err"></p>
</div>
<script type="module">
import { createClient } from "__SUPABASE_JS_URL__";
const CFG = __CONFIG__;
const sb = createClient(CFG.supabaseUrl, CFG.anonKey, { auth: { persistSession: true, detectSessionInUrl: false } });
const $ = (id) => document.getElementById(id);
const show = (id) => ["loading","signin","consent","done"].forEach(k => $(k).classList.toggle("hidden", k !== id));
const fail = (msg) => { $("err").textContent = msg || ""; };
const authId = new URLSearchParams(location.search).get("authorization_id");

function finish(title, text) { $("donetitle").textContent = title; $("donetext").textContent = text; show("done"); }

async function start() {
  fail("");
  if (!authId) { finish("Nothing to approve", "This page is opened by an app asking to connect to Ekalight."); return; }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { show("signin"); return; }
  if (session.user.is_anonymous) {
    await sb.auth.signOut();
    show("signin"); fail("Guest accounts can't connect apps. Create an account in the Ekalight app first."); return;
  }
  const { data, error } = await sb.auth.oauth.getAuthorizationDetails(authId);
  if (error) { finish("Couldn't load this request", error.message || "It may have expired. Start the connection again from your app."); return; }
  if (!("authorization_id" in data)) { location.href = data.redirect_url; return; }  // already approved before
  $("client").textContent = data.client?.name || "An app";
  $("who").textContent = data.user?.email || session.user.email || "";
  let host = data.redirect_uri;
  try { host = new URL(data.redirect_uri).origin; } catch (_) {}
  $("redirect").textContent = host;
  try {
    const h = new URL(data.redirect_uri).hostname;
    $("loopback").classList.toggle("hidden", !(h === "localhost" || h === "127.0.0.1" || h === "[::1]"));
  } catch (_) {}
  show("consent");
}

$("send").onclick = async () => {
  fail("");
  const email = $("email").value.trim();
  if (!email) return fail("Enter your email.");
  $("send").disabled = true;
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  $("send").disabled = false;
  if (error) return fail(/not found|signups not allowed|otp_disabled/i.test(error.message) ? "No Ekalight account uses that email. Create one in the app first." : error.message);
  $("codebox").classList.remove("hidden"); $("code").focus();
};
$("verify").onclick = async () => {
  fail("");
  const { error } = await sb.auth.verifyOtp({ email: $("email").value.trim(), token: $("code").value.trim(), type: "email" });
  if (error) return fail(error.message);
  start();
};
$("switch").onclick = async (e) => { e.preventDefault(); await sb.auth.signOut(); show("signin"); };
$("approve").onclick = async () => {
  $("approve").disabled = $("deny").disabled = true;
  const { data, error } = await sb.auth.oauth.approveAuthorization(authId);
  if (error) { $("approve").disabled = $("deny").disabled = false; return fail(error.message); }
  finish("Connected", "Returning you to the app…"); location.href = data.redirect_url;
};
$("deny").onclick = async () => {
  $("approve").disabled = $("deny").disabled = true;
  const { data, error } = await sb.auth.oauth.denyAuthorization(authId);
  if (error) { $("approve").disabled = $("deny").disabled = false; return fail(error.message); }
  finish("Not connected", "You denied access. You can close this page."); location.href = data.redirect_url;
};
start().catch((e) => finish("Something went wrong", String(e && e.message || e)));
</script></body></html>
"""


def render_consent_page(*, supabase_url: str, anon_key: str) -> str:
    config = json.dumps({"supabaseUrl": supabase_url, "anonKey": anon_key})
    # JSON inside <script>: neutralise "</" so a value can't close the tag.
    config = config.replace("</", "<\\/")
    return _PAGE.replace("__SUPABASE_JS_URL__", html.escape(SUPABASE_JS_URL, quote=True)).replace("__CONFIG__", config)
