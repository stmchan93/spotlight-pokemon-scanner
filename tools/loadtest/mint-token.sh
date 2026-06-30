#!/usr/bin/env bash
# Mint a short-lived Supabase access token (JWT) for the load test and write it
# to tools/loadtest/.token (gitignored). Run this YOURSELF — it uses the
# service-role admin key from backend/.env.staging.secrets, which is privileged.
#
# It does NOT change any password and does NOT send an email: the admin
# generate_link call just returns a one-time link, which we immediately verify
# to exchange for a session. Token lasts ~1h, so run the load test soon after.
#
# Usage:
#   bash tools/loadtest/mint-token.sh                      # default admin email
#   EMAIL=someone@example.com bash tools/loadtest/mint-token.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
SECRETS=backend/.env.staging.secrets
SUPABASE_URL="${SUPABASE_URL:-https://lvnjshymwvagwadqeofm.supabase.co}"
EMAIL="${EMAIL:-stmchan8953@gmail.com}"

val() { grep "^$1=" "$SECRETS" | head -1 | cut -d= -f2- | tr -d '"'\'' '; }
SERVICE_ROLE="$(val SUPABASE_SERVICE_ROLE_KEY)"
ANON="$(val EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY)"

[ -n "$SERVICE_ROLE" ] || { echo "Missing SUPABASE_SERVICE_ROLE_KEY in $SECRETS"; exit 1; }
[ -n "$ANON" ] || { echo "Missing anon key in $SECRETS"; exit 1; }

echo "Minting token for $EMAIL via $SUPABASE_URL ..."

RESP="$(curl -s -X POST "$SUPABASE_URL/auth/v1/admin/generate_link" \
  -H "apikey: $SERVICE_ROLE" -H "Authorization: Bearer $SERVICE_ROLE" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"magiclink\",\"email\":\"$EMAIL\"}")"

HASHED="$(printf '%s' "$RESP" | python3 -c "import sys,json
try:
  d=json.load(sys.stdin)
  print(d.get('hashed_token') or (d.get('properties') or {}).get('hashed_token') or '')
except Exception: print('')")"

if [ -z "$HASHED" ]; then
  echo "generate_link failed. Response (first 300 chars):"; printf '%s' "$RESP" | head -c 300; echo; exit 1
fi

SESS="$(curl -s -X POST "$SUPABASE_URL/auth/v1/verify" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"type\":\"magiclink\",\"token_hash\":\"$HASHED\"}")"

printf '%s' "$SESS" | python3 -c "
import sys,json,base64,datetime
d=json.load(sys.stdin)
at=d.get('access_token')
if not at:
    print('verify failed. Response (first 300 chars):'); print(json.dumps(d)[:300]); sys.exit(1)
open('tools/loadtest/.token','w').write(at)
p=at.split('.')[1]; p+='='*(-len(p)%4)
c=json.loads(base64.urlsafe_b64decode(p))
print('Saved tools/loadtest/.token')
print('  sub  :', c.get('sub'))
print('  email:', c.get('email'))
print('  exp  :', datetime.datetime.utcfromtimestamp(c['exp']).isoformat(), 'UTC')
"
