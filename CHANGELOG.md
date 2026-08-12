# Changelog

## [2026-08-12]

### Fixed
- **`advanced_search`'s `include` parameter fetched sideloaded data and then silently dropped it.** The tool requested `include=memberships`/`petition_signatures`/etc., NationBuilder returned the records in `response.included`, and the rendering loop iterated only `response.data` — the call paid the round-trip and the caller never saw the data, with no error and no indication anything was omitted. This produced at least one wrong client-facing conclusion: a session using `include='tags'` to find a person's tags got a clean (but tag-less) response and concluded "NationBuilder's API doesn't expose a person's tag list" — a false conclusion the silent drop made look confirmed.
- **`list_memberships` and `get_membership` requested `include=signup,membership_type` and rendered neither.** Every membership rendered as a bare status/date block with no indication of whose membership it was or what type it was.
- The tool description's own example for `include` (`'tags,memberships,petition_signatures'`) advertised a value that cannot work: NationBuilder's `signups` endpoint validates includes and rejects `tags` outright (`HTTP 400: "The requested included relationship \"tags\" is not supported"`), confirmed live against the production nation. That error message is the more likely root of the "API doesn't expose tags" conclusion above than a genuinely empty result. Verified support matrix for `include` on `signups`: `memberships` ✅, `petition_signatures` ✅, `tags` ❌ (400), `signup_taggings` ❌ (400). A person's tags require a different query — `signup_taggings` filtered by `filter[signup_id]` with `include=tag` — which `remove_tags_from_person` already runs internally.

### Added
- `formatIncludedResource` / `formatIncludedSection` in `src/utils/formatting.ts` — a shared, type-dispatching renderer for any `response.included` array. Dispatches to the existing per-resource formatter (`formatSignup`, `formatTag`, `formatMembership`, etc.) by JSON:API `type`; an unmapped type renders generically (id, type, scalar attributes) rather than being dropped, so a future NationBuilder relationship we haven't wired a formatter for still shows up instead of vanishing. Output is grouped by type and capped at 25 records per type, with the truncation stated explicitly rather than silent. `advanced_search` now appends this section after the person list.
- `formatMembership` now accepts the sideloaded `included` array (matching the `(resource, included?)` convention already used by `formatRsvp`, `formatPathJourney`, etc.) and renders the person's name and membership type name when available.
- `advanced_search`'s `include` param description and the server-wide `INSTRUCTIONS` block (in `src/index.ts`) now both state plainly that tags cannot be sideloaded from `signups` and point to the correct query instead of leaving that gap for the next session to rediscover the hard way.

## [2026-08-10]

### Fixed
- **Connector no longer goes dark after a session is lost.** A request carrying a session ID the server didn't recognise (after a restart, or once a session was reaped) got `400 Invalid or missing session ID`. The MCP Streamable HTTP spec reserves `404` for that case — it's the client's cue to start a fresh session with a new `initialize`. A `400` reads as a fatal protocol error instead, so the client stopped trying and the connector showed as unreachable with **zero tools loaded** until someone reconnected it by hand. Unknown sessions now return `404` with a JSON-RPC error body, and clients recover on their own.
- **OAuth token persistence to Railway was failing silently every day.** The deploy log had been showing `Railway variable update error: Not Authorized` on every refresh since at least 2026-08-02, while the in-memory refresh succeeded. Because NationBuilder rotates the refresh token on each refresh, `NATIONBUILDER_REFRESH_TOKEN` in Railway env had been stale for months — so the next restart would have hydrated a dead token and left the connector with no NationBuilder access until a human re-ran `/oauth/authorize`. Persistence now tries both Railway credential styles (`Authorization: Bearer` for account/workspace tokens, `Project-Access-Token` for project tokens — sending a project token as a Bearer is exactly what produces "Not Authorized"), and a failure is logged as CRITICAL and reported to the Error Reporter instead of passing as one quiet line.
- **Session map no longer grows without bound.** Every `initialize` built a fresh `McpServer` with all tools and stored the transport in a `Map` that was only cleaned on `onclose` — which Claude's connector never triggers, since it doesn't send `DELETE`. Memory drifted 0.342 → 0.397 GB over a week. Sessions idle for 30 minutes are now closed and evicted, and `DELETE` cleanup runs through the transport so `onclose` clears both maps.
- `search_people`'s `is_organization` parameter now works. It previously sent `filter[is_organization]` to the V2 `signups` endpoint, which has no attribute by that name, so every call using it failed with `HTTP 400 bad_request — Tried to filter on attribute :is_organization, but could not find an attribute with that name.` The person/organization distinction actually lives on `signup_type` (`0` = person, `1` = organization), confirmed against the nation's own OpenAPI spec at `/api/v2/docs/v2/released.yaml`. The parameter is kept as a convenience boolean and now maps to `filter[signup_type]`.
- Global MCP instructions no longer advertise a non-existent attribute. The "People vs Organizations" section claimed "Organizations have is_organization: true"; it now documents `signup_type` and tells callers to filter on `signup_type` in `advanced_search`.

### Changed
- **Token persistence moved from Railway env vars to a file on a mounted volume** (`$RAILWAY_VOLUME_MOUNT_PATH/nb-tokens.json`, mode `0600`, temp-file + rename so a crash can't leave a truncated file). The old approach had the service rewrite its own Railway environment variables through the platform API, which meant a privileged `RAILWAY_API_TOKEN` with infrastructure write access living inside the container — a large blast radius for what is really just "save two strings across a restart." Both credential styles were rejected with `Not Authorized` in production, so it had never worked. `RAILWAY_API_TOKEN` is no longer used and can be deleted from the service.
- On startup the volume is now the source of truth; `NATIONBUILDER_ACCESS_TOKEN` / `NATIONBUILDER_REFRESH_TOKEN` are only a first-boot fallback. Preferring env over file would hand back an already-rotated token.
- The `/oauth/callback` success page now states whether tokens were actually persisted. Whoever just authorized is the one person positioned to fix a bad volume mount; previously that only appeared in the logs and would surface at the next restart as an outage.

### Added
- Startup token check (`bootstrapToken`). Hydrating from env left `expiresAt` null, which made the periodic refresh a no-op — nothing touched the token until a user's first tool call took a 401. The server now exercises the refresh token at boot, so a restart either re-establishes the rotation chain (and re-persists it) or surfaces a dead token in the deploy logs immediately, rather than as a broken connector for whoever tries first.
- `signup_type` is now requested in the default sparse-field set for `search_people` and `advanced_search`, and signups with `signup_type: 1` render a `Type: Organization` line — so organization records are identifiable in results instead of looking like people.
- `advanced_search` tool description now states that org filtering uses `signup_type`, mirroring the existing warning about tag filtering.

### Fixed (error reporting rollout)
- **A single bad `/mcp`, `/sse`, or `/messages` request could crash the whole server for every connected user.** Express 4 doesn't catch async rejections, so one rejected `await` in any of the three routes reached `unhandledRejection` and exited the process. All three now catch and either return a scoped `500` or close the stream — guarded on `res.headersSent`, since the SDK's `/messages` handler already writes a `500` and ends the response before throwing, and an unguarded second `res.status(500)` there would itself crash the process from inside the catch.
- The API client's retry loop lost the real HTTP status whenever a request exhausted all 3 attempts via a 429 or 5xx `continue` path (which never throws), so the eventual report said only `"Request failed after retries"` with no status and no body. Status and attempt count are now tracked through the loop and carried into the report regardless of which path exhausted the retries.
- A missing access token retried up to 3 times and could report up to 3 times per call — it now fails fast on the first attempt, since a missing token won't fix itself on retry.

### Added (error reporting rollout)
- Error reporting now covers every layer, not just the 46 tool/client call sites that already existed: process-level `uncaughtException` / `unhandledRejection` / startup failure now flush a report (bounded to 1.5s) before exiting instead of dropping it in the fire-and-forget POST that a bare `process.exit()` would have thrown away; the three Express routes; the remaining OAuth failure paths (refresh rejection, token exchange, callback CSRF/code validation); and API-client retry exhaustion, now classified by status (`auth_error` / `rate_limit` / `api_error`) instead of one catch-all `api_error`.
- Auth-failure and public-endpoint reports are throttled (1h windows by default, 24h+ backstop via a healthy→broken transition bypass) so a revoked refresh token — which the client force-refreshes on every 401 — can't flood the digest with one row per tool call.
- Centralized secret/PII hygiene: OAuth token-endpoint response bodies, query strings, and raw `params` objects are never passed through to a report — only a bounded OAuth2 error code, HTTP status, path shape (query string stripped), and which filter keys were set (not their values). `search_people`/`advanced_search` error context no longer includes the raw `params` object, which could carry a member's email, name, or note text.

## [2026-04-28]

### Fixed
- `list_people_with_tag` now actually scopes results to the requested tag. Previously the tool sent `filter[tag]=<name>` to the V2 `signups` endpoint, which has no tag attribute, so the filter was silently dropped and the tool returned the first page of *all* signups regardless of input. It now resolves the tag name to an ID and queries `signup_taggings` (sideloading signups via `include=signup`).
- Tag-name lookup is now case-insensitive — `cmte_legislative` and `CMTE_Legislative` both resolve to the same tag.
- `list_people_with_tag` response now includes the total number of people on the tag, so callers don't have to paginate to get the count.

### Added
- `advanced_search` accepts a top-level `tag` parameter (case-insensitive). The tag is intersected with the rest of the filter set via `filter[id][in]=…`, so e.g. `tag="wg_seismicity"` + `filters={state:"NM"}` returns workgroup members in NM.
- New shared helpers `resolveTagByName` and `getTaggingsPageForTagId` / `getAllSignupIdsForTagId` in `src/utils/tagLookup.ts`.

## [2026-03-30]

### Fixed
- `get_signup_profile` and `update_signup_profile` now use the correct two-step lookup: sideload the signup to get the profile ID, then fetch/update by that ID (confirmed with NB support)
- `list_event_rsvps` restored using correct top-level `/api/v2/event_rsvps` endpoint (confirmed with NB support)

### Removed
- `list_signup_sources` — NB support confirmed this endpoint does not exist in V2
- `list_identity_mappings` — NB support confirmed this endpoint does not exist in V2

## [2026-03-29]

### Added
- `add_person_to_list` — Add a person to a saved list by list ID and signup ID
- `remove_person_from_list` — Remove a person from a saved list by list ID and signup ID

### Fixed
- `add_person_to_list` and `remove_person_from_list` now use the V1 API (NationBuilder V2 has no list membership resource)

## [2026-03-26]

### Added
- Custom field filtering in search_people — filter by any NationBuilder custom field value (e.g. member_type = "service company")
- Organization filter in search_people — filter to organizations only or people only
- Custom field values now shown in search results
- OAuth token persistence — token is saved to Railway env var after authorization so it survives server restarts

## [2026-03-27]

### Added
- Global MCP instructions — any Claude instance connecting to this server now receives guidance on NationBuilder's data model, relationship types, custom fields, and tool selection

### Changed
- Corrected tool descriptions for list_org_members and list_org_members_batch to clarify they match on the employer text field, not formal NationBuilder relationships

### Removed
- `log_contact` — V2 API field names unknown, removed until NB confirms correct attributes
- `update_contact` — same reason as log_contact
- `list_event_rsvps` — nested route 404s, endpoint may not exist in V2
- `list_petition_signatures` — filter attribute name rejected by V2 API
- `get_donation` — no donations in NB instance to test against; removed until needed

### Fixed
- When NationBuilder returns a 401 auth error, tools now show a direct link to re-authorize instead of a cryptic error message
- Fixed auth header: switched from `access_token` header to `Authorization: Bearer` for NB V2 OAuth compatibility
- Fixed XSS vulnerability in OAuth callback error display — error messages are now HTML-escaped

### Added
- CSRF protection via OAuth `state` parameter — prevents cross-site request forgery on the authorization flow
- PKCE (S256) support on OAuth flow — prevents authorization code interception attacks
- Authorization code input validation before token exchange
- Auto-refresh on 401: if the token expires mid-session, the server automatically refreshes it and retries the request
- Refresh token persisted to Railway alongside access token so token refresh works after restarts
- Token hydration on startup from env vars so the server doesn't lose OAuth state across deploys
- Organization relationship tools (list_org_members, list_org_members_batch) — find people linked to organizations by employer name matching
- Switched to Streamable HTTP transport (`/mcp` endpoint) for compatibility with mcp-remote 0.1.38+
- Legacy SSE endpoint (`/sse`) retained as fallback for older clients
- Removed global express.json() middleware that was causing "Parse error: Invalid JSON" on connection
- Signup source tools (list_signup_sources) — see where a person came from
- Identity mapping tools (list_identity_mappings) — view cross-system ID links
- Contact update tool (update_contact) — modify existing interaction records
- List creation tool (create_list) — create new saved lists/segments

### Fixed (endpoint paths)
- Signup sources and identity mappings now use top-level endpoints with filter params instead of nested routes that returned 404
- Contacts list now uses top-level `/contacts` with `filter[signup_id]` instead of nested route

## [2026-03-26]

### Added
- Initial MCP server with 17 tools across 6 categories
- People tools: search, get, create, update contacts
- Tag tools: list tags, add/remove tags on people, list people by tag
- Contact tools: log interactions (calls, emails, meetings), view history
- Donation tools: list and view donation details
- Event tools: list events, get details, view RSVPs
- List tools: view saved lists/segments and their members
- Dual transport support: SSE for Railway deployment, stdio for local dev
- Bearer token authentication for SSE endpoint
- Rate limiting (250 req/10s with headroom)
- NationBuilder v2 JSON:API client with retries and error handling
