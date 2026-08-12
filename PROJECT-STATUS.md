# NMOGA NationBuilder API — Project Status

## Current Status

**Phase:** Deployed and in production use as an org Connector. **A security fix on this
branch (2026-08-12) gates every HTTP route and requires a coordinated deploy — see the
To-Do item below before merging/deploying.**

Live at `https://nmoga-nationbuilder-mcp-production.up.railway.app/mcp` (Streamable HTTP;
legacy `/sse` retained for older clients). NationBuilder auth is OAuth against the `nmoga`
nation, with tokens persisted to a Railway volume at `/data`.

**HTTP endpoint auth (separate from the above — this gates who can reach the server at
all):** every route except `/health` and `/oauth/callback` requires either `MCP_URL_SECRET`
as a URL path segment (`/mcp/<secret>`, `/sse/<secret>`, `/oauth/<secret>/authorize`,
`/oauth/<secret>/status`) or a Bearer `MCP_AUTH_TOKEN` header on the bare path. See
`src/utils/httpAuth.ts` and the CHANGELOG entry below. Check `/oauth/<secret>/status` for
NationBuilder auth and token-store state; `/health` for liveness (unauthenticated, for
Railway's health probe).

## Completed

- [x] **HTTP endpoints authenticated (2026-08-12, URGENT security fix):** `/mcp` and `/sse` were completely open in production — anyone with the URL got all 47 tools with the org's OAuth token (full member PII plus write tools). `/oauth/authorize` and `/oauth/status` were equally open. Fixed with a secret-path route (`MCP_URL_SECRET`, since claude.ai org connectors can't send headers) plus a Bearer `MCP_AUTH_TOKEN` check on the bare routes — either credential works. `/oauth/callback` stays unauthenticated and at its existing path (NationBuilder's registered callback URL points there; it's protected by the CSRF state check instead). Streamable HTTP sessions are now capped at 100 concurrent. **Not yet deployed — see To-Do.** See CHANGELOG.md.
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

## To-Do

- [ ] **URGENT — coordinate the auth-fix deploy (2026-08-12).** This branch requires Josh to: (1) set `MCP_URL_SECRET` on Railway (a long random value — `openssl rand -hex 32` or similar); (2) deploy; (3) update the claude.ai org Connector URL from the bare `/mcp` to `/mcp/<that value>` **at the same time** — the bare `/mcp` route now demands a Bearer header the connector can't send, so the connector goes dark the moment this deploys unless the URL is updated in the same window. Not something this session can do (Railway env + claude.ai connector config are Josh's to change). See CHANGELOG.md and the PR/branch for the actual code.
- [x] Deploy to Railway — done long ago; this list was stale
- [x] Set Railway env vars — done. `RAILWAY_API_TOKEN` is now **unused** (persistence moved to the volume) and can be deleted. `MCP_AUTH_TOKEN` is set and, as of 2026-08-12, **is now read** — it's checked as a Bearer credential on the bare `/mcp`/`/sse`/`/oauth/*` routes (see the URGENT item above for what else needs to happen before this actually protects anything in production).
- [x] Configure Claude Desktop — in use as an org Connector
- [x] Token persistence proven across a restart (2026-08-11) — volume at `/data`, verified by restarting the service and watching it come back authenticated with no human action
- [ ] Test all 47 tools end-to-end against live NationBuilder — the phone_number/mobile_number/registered_address field-name fix (2026-08-12) and the new extra_fields[signups] client support haven't been exercised live yet; needs either a redeploy or a local static token
- [x] Add error reporting (error-reporter.ts) — 2026-08-11: full coverage (process/exit paths, all three Express routes, remaining OAuth paths, client retry diagnostics) with throttling and PII/secret scrubbing; see CHANGELOG.md
- [x] Org filter fix (2026-08-10): `search_people`'s `is_organization` param was sending `filter[is_organization]`, an attribute that doesn't exist in V2 — every call 400'd. Now maps to `filter[signup_type]` (0=person, 1=organization, confirmed against the nation's own OpenAPI spec); `advanced_search` and the MCP instructions corrected to match; `signup_type` added to default sparse fields so orgs render a `Type: Organization` line. See CHANGELOG.md.
- [x] Included-data drop fixed (2026-08-12) — see Completed above.
- [x] Honest pagination + get_person_tags + signup field-name audit (2026-08-12) — see Completed above.
- [ ] Update CLAUDE.md Active Projects table
- [x] Update PROJECTS-STATUS.md
- [x] README.md tool table fixed (2026-08-12) — now lists all 47 tools, grouped by resource area, kept in sync with `src/tools/*.ts`; PROJECT-PLAN.md's stale duplicate table now points at it instead of drifting independently
