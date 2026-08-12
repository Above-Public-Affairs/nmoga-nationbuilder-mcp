# NMOGA NationBuilder API — Project Status

## Current Status

**Phase:** A same-day sequel to the URL-secret auth fix (still on this branch, not yet
deployed — see the URGENT To-Do below). The URL-secret model went out, `MCP_URL_SECRET`
was never set on Railway, and the connector went dark for everyone. Rather than restore
that model, this branch replaces it entirely with **per-user NationBuilder OAuth**: each
person adds this MCP as their **own personal** claude.ai connector (no Organization
Connector, no shared secret) and logs into NationBuilder themselves. Every tool call runs
under that person's own NationBuilder token, so NationBuilder's own audit log attributes
every read and write to the real person — which is what the original security review was
actually trying to achieve; the URL-secret fix only ever addressed "who can reach the
server," not "who is this action attributed to."

Live at `https://nmoga-nationbuilder-mcp-production.up.railway.app/mcp` (Streamable HTTP
only — legacy `/sse` is deleted; nothing used it besides the removed shared-secret gate).

**Auth model:** this server plays two OAuth roles at once —

1. **Authorization Server to claude.ai**, mounted via the MCP SDK's own `mcpAuthRouter`
   (`/authorize`, `/token`, `/register`, `/.well-known/*`). Issues stateless HMAC tokens
   (`mcp_at_…`/`mcp_rt_…`, signed with `MCP_TOKEN_SIGNING_SECRET`) bound to a `userKey`.
2. **OAuth client to NationBuilder** (`src/oauth.ts` + `src/auth/provider.ts`), driving each
   person through NationBuilder's real login when they connect.

Per-user NationBuilder credentials live in `src/auth/store.ts`, persisted to the Railway
volume at `/data/nb-tokens.json` (one file, all users, synchronous+fsync'd writes). Session
ownership is re-checked on every `/mcp` request, not just at creation — see CHANGELOG.md's
"why" for that check. `/oauth/status` is public but tiered: no secrets in the baseline body,
your own record only behind your own bearer. `/health` is unauthenticated liveness only.

## Completed

- [x] **Per-user NationBuilder OAuth (2026-08-12):** replaces the URL-secret gate below entirely. `/mcp` now requires a real, individual NationBuilder login per person — see "Current Status" above for the architecture and CHANGELOG.md for the full list of what changed. Verified end-to-end against a scripted fake NationBuilder upstream (no live nation credential needed): the full register→authorize→NB→callback→token round trip, single-use code + PKCE-mismatch rejection, refresh rotation, identity-key stability across re-authorization, **the session-hijack test** (person B's own valid bearer + person A's session id → `403`, person A's session keeps working after), the per-user session cap, `/oauth/status` tiering, and the HTTP-mode boot refusal when a static token is set. During the merge with the concurrent five-fixes work below, this also absorbed the connector icon, `connection_status` tool (rewritten for per-user), and tool annotations. **Not yet deployed — see the URGENT To-Do below**, which also covers what's still unverifiable without a live nation and without Josh's action in claude.ai/Railway.
- [x] **Five code-quality fixes (2026-08-12, on a branch that diverged before the above landed):** `add_tags_to_person` near-duplicate-tag fix and the outbound-request timeout stand as-is; the concurrent-refresh-race and per-session-rate-limiter fixes were superseded during the merge by the per-user OAuth work's more general versions of the same fix (`refreshUserToken`'s dedupe, `getRateLimiter(slug)`); `.env.example`'s dead `RAILWAY_API_TOKEN` block removal carried forward. See CHANGELOG.md.
- [x] **HTTP endpoints authenticated (2026-08-12, URGENT security fix, superseded by the per-user OAuth entry above):** `/mcp` and `/sse` were completely open in production — anyone with the URL got all 47 tools with the org's OAuth token (full member PII plus write tools). `/oauth/authorize` and `/oauth/status` were equally open. Originally fixed with a secret-path route (`MCP_URL_SECRET`) plus a Bearer `MCP_AUTH_TOKEN` check — but `MCP_URL_SECRET` was never set on Railway, so this deployed as an outage rather than a fix, which is why the per-user OAuth work above replaces it rather than patching it. Streamable HTTP session cap (100 concurrent) carried forward. See CHANGELOG.md.
- [x] Project scaffolding (package.json, tsconfig, directory structure)
- [x] TypeScript types for all NationBuilder resources (JSON:API spec)
- [x] Rate limiter (250 req/10s sliding window)
- [x] Response formatting utilities
- [x] NationBuilder API client with retries and error handling
- [x] People/Signups tools (search, get, create, update)
- [x] Tags tools (list, add, remove, list people by tag)
- [x] Tag-filter fix (2026-04-28): `list_people_with_tag` and `advanced_search` now route through `signup_taggings` instead of the broken V2 `signups` tag filter; case-insensitive name lookup; total counts in response
- [x] Contacts tools (log interaction, list history)
- [x] Donations tools (list, get details)
- [x] Events tools (list, get details, list RSVPs)
- [x] Lists tools (list all, get people in list)
- [x] Dual transport: SSE (Railway) + stdio (local)
- [x] Clean TypeScript build (zero errors)
- [x] Included-data rendering fix (2026-08-12): `advanced_search`'s `include` param (and `list_memberships`/`get_membership`'s) fetched sideloaded data via `response.included` and never rendered it — silently dropped, no error. Added a shared `formatIncludedSection`/`formatIncludedResource` renderer (dispatches on JSON:API type, generic fallback for unmapped types, never drops silently); wired into both tool sets. Also corrected the `advanced_search` tool description and the server `INSTRUCTIONS` block, which advertised `include='tags'` as a working example — NationBuilder's `signups` endpoint actually rejects it with an HTTP 400 (confirmed live). See CHANGELOG.md.
- [x] Honest pagination + `get_person_tags` (2026-08-12): NationBuilder V2 sends no result total on any endpoint this server calls (confirmed live across `signups`/`signup_tags`/`signup_taggings`/`lists`) — every paginated tool now says explicitly whether more results exist instead of a bare "Page N" that read as complete. New `get_person_tags` tool (the reverse of `list_people_with_tag`) fixes the actual incident: a person's tags are queryable, there was just no tool for it. Also found and fixed a real V2 attribute-naming bug affecting every signup-reading tool: `phone`/`mobile`/`registered_address_*` aren't real attribute names (confirmed against the nation's OpenAPI spec) — no tool has ever actually shown a phone, mobile, or address, and `create_person` has likely been silently discarding address data on write. See CHANGELOG.md.

- [x] Remaining truncation gaps closed (2026-08-12): cross-checked the shipped fixes against the original nine-item defect list and found two still open — `resolveTagByName`'s case-insensitive fallback read only one 100-row page (so a real tag past page 1 reported as not existing at all), and a NationBuilder-rejected employer filter was returned as an empty result, making `list_org_members`/`_batch` unable to distinguish "search didn't run" from "organization has no members." Both now report explicitly. See CHANGELOG.md.
- [x] Tool annotations + connector icon + connection_status + batch tagging (2026-08-12): all 48 tools migrated to `server.registerTool()` with `title`/`readOnlyHint`/`destructiveHint` annotations (38 read-only, 8 non-destructive writes, 2 destructive); new `connection_status` tool surfaces auth state from inside a chat (shares `getAuthStatus()` with `/oauth/status`); `/favicon.ico` + `serverInfo.icons` added as connector-icon groundwork (won't be visible in the connector list until Claude honors it or this server gets a custom domain — flagged for Josh); `add_tags_to_person`/`remove_tags_from_person` now batch over comma-separated `person_ids` (cap 50) with per-person/per-tag reporting. Verified locally: clean `tsc` build, live `tools/list` showed all 48 tools with correct titles/annotations, `connection_status` and the batch cap both exercised over a real MCP session. See CHANGELOG.md.

## To-Do

- [ ] **URGENT — coordinate the per-user-OAuth deploy.** Unlike the previous fix, the
  connector is *already* dark (production is down right now, and has been since the
  URL-secret deploy), so there's no "second outage" risk to sequence around — but these
  steps still need to happen, roughly in order:
  1. Set `MCP_TOKEN_SIGNING_SECRET` on Railway (`openssl rand -base64 48`) — recommended,
     not required (a secret is auto-generated and persisted if absent, but explicit avoids
     the ephemeral-secret failure mode entirely).
  2. Delete `MCP_URL_SECRET` and `MCP_AUTH_TOKEN` from Railway env — dead vars, no code
     reads them anymore.
  3. Confirm the NationBuilder app's registered OAuth callback is still exactly
     `https://<railway-domain>/oauth/callback` (Settings → Developer → Your apps) — the
     code deliberately never moved this path, so no NationBuilder-side change *should* be
     needed, but it's worth eyeballing.
  4. Deploy this branch to `main`.
  5. **Every team member (and every non-team person using this MCP) adds their own
     personal claude.ai connector** pointed at the bare `https://…/mcp` URL and completes
     the NationBuilder login themselves. This is a one-time re-add per person — there is no
     org-wide connector anymore.
  6. **Acceptance test:** have one person run a write tool, then check NationBuilder's own
     audit log and confirm it names that person, not a shared service account. That's the
     actual point of this whole change.
  7. Once at least two people are confirmed working, remove `NATIONBUILDER_ACCESS_TOKEN`/
     `NATIONBUILDER_REFRESH_TOKEN` from Railway if either is still set (HTTP mode already
     refuses to boot with them present, so this is really just tidying env vars, not a
     behavior change).
  None of this can happen from this session — Railway env, the NationBuilder app config,
  and every person's own claude.ai connector are Josh's (and each teammate's) to change.
- [ ] **Cannot be verified without a live nation / without Josh:** whether
  `/api/v1/people/me` actually exists on the `nmoga` nation (decides identity Tier 1 vs. 2/3
  — non-blocking, attribution works either way, only display labels differ); whether
  claude.ai actually performs Dynamic Client Registration against this server in practice,
  and with which exact `redirect_uri` (only observable by watching `/register` during a
  real connect attempt — fall back to `MCP_STATIC_CLIENT_ID` if it doesn't); and the
  acceptance test itself (two different real people doing real writes, compared against
  NationBuilder's actual audit log).
- [x] Deploy to Railway — done long ago; this list was stale
- [x] Configure Claude Desktop — in use as a personal connector per person (was an org Connector; superseded, see above)
- [x] Token persistence proven across a restart (2026-08-11) — volume at `/data`, verified by restarting the service and watching it come back authenticated with no human action
- [ ] Test all 48 tools end-to-end against live NationBuilder — the phone_number/mobile_number/registered_address field-name fix (2026-08-12) and the new extra_fields[signups] client support haven't been exercised live yet; needs either a redeploy or a local static token
- [ ] Test batch `add_tags_to_person`/`remove_tags_from_person` (2026-08-12) against real NationBuilder — verified locally against a dummy token (schema, cap, error paths) but not against live tagging/tag-creation calls yet
- [ ] Decide on a custom domain for the connector icon (2026-08-12) — `/favicon.ico` and `serverInfo.icons` are live, but Claude's connector list won't show a distinct icon on the shared `*.up.railway.app` host until either Claude honors those fields or this server moves to a custom domain; Josh's call, not assumed
- [x] Add error reporting (error-reporter.ts) — 2026-08-11: full coverage (process/exit paths, all three Express routes, remaining OAuth paths, client retry diagnostics) with throttling and PII/secret scrubbing; see CHANGELOG.md
- [x] Org filter fix (2026-08-10): `search_people`'s `is_organization` param was sending `filter[is_organization]`, an attribute that doesn't exist in V2 — every call 400'd. Now maps to `filter[signup_type]` (0=person, 1=organization, confirmed against the nation's own OpenAPI spec); `advanced_search` and the MCP instructions corrected to match; `signup_type` added to default sparse fields so orgs render a `Type: Organization` line. See CHANGELOG.md.
- [x] Included-data drop fixed (2026-08-12) — see Completed above.
- [x] Honest pagination + get_person_tags + signup field-name audit (2026-08-12) — see Completed above.
- [ ] Update CLAUDE.md Active Projects table
- [x] Update PROJECTS-STATUS.md
- [x] README.md tool table fixed (2026-08-12) — now lists all 47 tools, grouped by resource area, kept in sync with `src/tools/*.ts`; PROJECT-PLAN.md's stale duplicate table now points at it instead of drifting independently
