# NMOGA NationBuilder API — Project Status

## Current Status

**Phase:** Deployed and in production use as an org Connector.

Live at `https://nmoga-nationbuilder-mcp-production.up.railway.app/mcp` (Streamable HTTP;
legacy `/sse` retained for older clients). Auth is OAuth against the `nmoga` nation, with
tokens persisted to a Railway volume at `/data`. Check `/oauth/status` for current auth and
token-store state; `/health` for liveness.

## Completed

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
- [x] Bearer token auth for SSE endpoint
- [x] Clean TypeScript build (zero errors)
- [x] Included-data rendering fix (2026-08-12): `advanced_search`'s `include` param (and `list_memberships`/`get_membership`'s) fetched sideloaded data via `response.included` and never rendered it — silently dropped, no error. Added a shared `formatIncludedSection`/`formatIncludedResource` renderer (dispatches on JSON:API type, generic fallback for unmapped types, never drops silently); wired into both tool sets. Also corrected the `advanced_search` tool description and the server `INSTRUCTIONS` block, which advertised `include='tags'` as a working example — NationBuilder's `signups` endpoint actually rejects it with an HTTP 400 (confirmed live). See CHANGELOG.md.

## To-Do

- [x] Deploy to Railway — done long ago; this list was stale
- [x] Set Railway env vars — done. `RAILWAY_API_TOKEN` is now **unused** (persistence moved to the volume) and can be deleted. `MCP_AUTH_TOKEN` is set but **not read by the code** — `/mcp` is currently ungated; wiring it up would break the org Connector unless Claude is configured to send it.
- [x] Configure Claude Desktop — in use as an org Connector
- [x] Token persistence proven across a restart (2026-08-11) — volume at `/data`, verified by restarting the service and watching it come back authenticated with no human action
- [ ] Test all 17 tools end-to-end against live NationBuilder — note: the tool count is stale too, there are 46, not 17 (README table hasn't been updated since the early lists/events era)
- [x] Add error reporting (error-reporter.ts) — 2026-08-11: full coverage (process/exit paths, all three Express routes, remaining OAuth paths, client retry diagnostics) with throttling and PII/secret scrubbing; see CHANGELOG.md
- [x] Org filter fix (2026-08-10): `search_people`'s `is_organization` param was sending `filter[is_organization]`, an attribute that doesn't exist in V2 — every call 400'd. Now maps to `filter[signup_type]` (0=person, 1=organization, confirmed against the nation's own OpenAPI spec); `advanced_search` and the MCP instructions corrected to match; `signup_type` added to default sparse fields so orgs render a `Type: Organization` line. See CHANGELOG.md.
- [x] Included-data drop fixed (2026-08-12) — see Completed above.
- [ ] Update CLAUDE.md Active Projects table
- [x] Update PROJECTS-STATUS.md
- [ ] README.md tool table lists 17 tools; there are 46 — stopped being updated around the lists/events era, missing memberships/paths/relationships/profiles/petitions/mailings/pages/automations/imports/advanced_search
