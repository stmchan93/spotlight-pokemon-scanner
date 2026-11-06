# MCP auth plan (2026-11-04)

Scope: how Claude (claude.ai, Claude Desktop, Claude Code) and ChatGPT connectors sign Ekalight users in to the remote MCP server (`backend/mcp_server/`, Streamable HTTP at `/mcp`). Phase 2 builds only the **resource-server** side. This doc decides the authorization-server side.

Research date: 2026-11-05. Sources:
- supabase/supabase docs at the 2026-11-04 commit: `guides/auth/oauth-server*.mdx`, `guides/ai-tools/byo-mcp.mdx`
- supabase/auth (GoTrue) code at the 2026-11-03 commit: `internal/api/oauthserver/`
- the MCP spec repo at the 2026-11-02 commit (latest revision 2026-07-28)
- Claude's connector auth docs: https://claude.com/docs/connectors/building/authentication.md
- OpenAI Apps SDK auth docs: https://developers.openai.com/apps-sdk/build/auth

supabase.com could not be reached from the research session, so the claims below come from the docs source and code on GitHub.

## Findings

### Supabase Auth is an OAuth 2.1 authorization server (beta)

It is called "OAuth 2.1 server". It is in beta, available on all plans, and turned on per project under Dashboard → Authentication → OAuth Server.

**Endpoints**, under the issuer `https://<ref>.supabase.co/auth/v1`:
- `/oauth/authorize`
- `/oauth/token`
- `/oauth/userinfo`
- `/oauth/clients/register` (Dynamic Client Registration)
- `/.well-known/jwks.json`

**Discovery:**
- `https://<ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1` (RFC 8414 path-insert form)
- `/auth/v1/.well-known/oauth-authorization-server`
- `/auth/v1/.well-known/openid-configuration`

All three report `issuer` = `<SUPABASE_URL>/auth/v1`.

**PKCE** is required (S256). The only grants are `authorization_code` and `refresh_token`, and refresh tokens are rotated. Public clients (`token_endpoint_auth_method=none`) are supported.

**Dynamic Client Registration (RFC 7591)** is supported but off by default; it has its own per-project toggle. CIMD (Client ID Metadata Documents) is **not** supported.

**Consent UI is ours to host.** Supabase redirects to `<Site URL><authorization path>?authorization_id=…`. That page must:
1. make sure the user is signed in;
2. call `supabase.auth.oauth.getAuthorizationDetails(id)`;
3. show the client name, redirect URI and scopes;
4. call `approveAuthorization(id)` or `denyAuthorization(id)`;
5. redirect the browser to the returned `redirect_url`.

The consent POST checks `Origin` against the Site URL. The page has to be a web page, because the flow runs in the browser, not in the RN app.

**Scopes** are only `openid`, `email`, `profile` and `phone`. Custom scopes are rejected, which is why we advertise none.

**Issued access tokens** are ordinary Supabase JWTs signed with the project's normal keys and JWKS. They carry:
- `iss=<SUPABASE_URL>/auth/v1`
- `aud="authenticated"`
- `sub`, `role`, `is_anonymous`, `session_id`
- **`client_id`**

**Resource indicators (RFC 8707):** the `resource` parameter is accepted and validated, but it is **not** written into `aud`. A Custom Access Token Hook, which receives `client_id`, is the only way to set `aud` to our MCP URL.

**Anonymous users:** the docs don't say whether they can complete the flow. Reading the code, nothing blocks them, so we reject `is_anonymous=true` ourselves.

### MCP spec (2025-11-25 and 2026-07-28)

- **The resource server must:**
  - serve RFC 9728 protected-resource metadata;
  - answer unauthenticated requests with `401` and `WWW-Authenticate: Bearer resource_metadata="…"`;
  - accept only tokens issued for itself, with no token passthrough.
- **Discovery:** clients probe `/.well-known/oauth-protected-resource/<path>` and then the root `/.well-known/oauth-protected-resource`.
- **Client registration**, in order of preference: a pre-registered client, then CIMD, then DCR. DCR is deprecated in 2026-07-28 but kept as a fallback.
- **Claude:**
  - supports DCR and CIMD, and uses CIMD only when the authorization server advertises it;
  - uses the first `authorization_servers` entry;
  - needs a 401 to start sign-in;
  - sends `resource` set to the exact URL the user typed;
  - hosted callback is `https://claude.ai/api/mcp/auth_callback`; Claude Code uses a loopback redirect.
- **ChatGPT** supports CIMD (preferred), DCR and pre-registered clients.
- With Supabase, both Claude and ChatGPT will use **DCR**.

## Recommendation

1. **Use Supabase's OAuth 2.1 server. Don't build or run our own authorization server.**
   - Enable OAuth Server and Dynamic Client Registration in the project.
   - Set the authorization path to `/oauth/consent` on the Site URL origin.
   - Move the project to asymmetric signing keys (RS256/ES256) if it isn't on them already. The verifier already handles JWKS.
2. **Protected-resource metadata** (already implemented): serve it at both paths with
   - `resource` = the exact public `https://…/mcp` URL (`SPOTLIGHT_MCP_RESOURCE_URL`);
   - `authorization_servers` = `["<SUPABASE_URL>/auth/v1"]`, the issuer string exactly, with no trailing slash;
   - no `scopes_supported`.
3. **Token checks** (implemented):
   - JWKS signature, `iss` and `exp`, plus a non-empty `sub`;
   - reject guests (`is_anonymous=true`) with a "create an account" message.
   - Once the OAuth server is on, set `SPOTLIGHT_MCP_REQUIRE_OAUTH_CLIENT=1`. Tokens then need a `client_id`, so the app's own session tokens, which are also `aud=authenticated`, can't be replayed at `/mcp`.
   - Optionally add a Custom Access Token Hook that sets `aud` to the MCP URL when `client_id` is present, then set `SPOTLIGHT_MCP_TOKEN_AUDIENCE` for strict audience binding.
4. **App work** (not in this phase). A small web consent page at `<Site URL>/oauth/consent` that:
   - signs the user in by email, Google or Apple, and never offers guest sign-in or `signUp`;
   - shows the client name and redirect host, with an extra warning for loopback redirects;
   - has Approve and Deny buttons.

   Also add a "Connected apps" screen that lists grants and revokes them with `revokeGrant`.
5. **Ops:** with DCR, anyone can register a client, and Claude registers one per fresh connection. Watch the registered-client count.

## Config flags (resource server)

| Env | Default | Meaning |
| --- | --- | --- |
| `SPOTLIGHT_MCP_RESOURCE_URL` | `http://localhost:8790/mcp` | Public `/mcp` URL. Used as the PRM `resource` and also allowed by the DNS-rebinding guard. |
| `SPOTLIGHT_MCP_AUTHORIZATION_SERVER_URL` | `<SUPABASE_URL>/auth/v1` | PRM `authorization_servers[0]`. |
| `SUPABASE_URL` / `SUPABASE_JWKS_URL` / `SUPABASE_JWT_SECRET` | — | Token verification. HS secret only for legacy projects. |
| `SPOTLIGHT_MCP_REQUIRE_OAUTH_CLIENT` | off | Require a `client_id` claim, i.e. only tokens minted by the OAuth server. |
| `SPOTLIGHT_MCP_TOKEN_AUDIENCE` | unset | Require this `aud`. Needs the Custom Access Token Hook. |
| `SPOTLIGHT_MCP_RATE_PER_MINUTE` / `_PER_DAY` | 60 / 2000 | Per-user limits. |
| `SPOTLIGHT_MCP_TIER` | `user` | `public` switches to API-key auth plus the stripped response policy (`mcp_server/policy.py`). |
| `SPOTLIGHT_MCP_PUBLIC_API_KEYS` | — | Public tier only: `<sha256hex>:<plan>,…`. |
| `SPOTLIGHT_MCP_PLAN_QUOTAS` | `free:30/500` | Public tier only: `<plan>:<per_min>/<per_day>,…`. |
| `SPOTLIGHT_MCP_ALLOWED_HOSTS` | — | Extra allowed `Host` headers. |

## Unconfirmed

- When the beta becomes GA.
- Whether anonymous users can finish the consent flow. Read from the code only; we reject them either way.
- Whether the root path-insert discovery URL is live on every hosted project. It is documented but was not tested live.
