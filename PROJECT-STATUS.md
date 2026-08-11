# NMOGA NationBuilder API — Project Status

## Current Status

**Phase:** Development complete, ready for Railway deployment and testing

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

## To-Do

- [ ] Deploy to Railway
- [ ] Set Railway env vars (NATIONBUILDER_SLUG, NATIONBUILDER_ACCESS_TOKEN, MCP_AUTH_TOKEN)
- [ ] Configure Claude Desktop with mcp-remote connection
- [ ] Test all 17 tools end-to-end against live NationBuilder
- [x] Add error reporting (error-reporter.ts) — 2026-08-11: full coverage (process/exit paths, all three Express routes, remaining OAuth paths, client retry diagnostics) with throttling and PII/secret scrubbing; see CHANGELOG.md
- [x] Org filter fix (2026-08-10): `search_people`'s `is_organization` param was sending `filter[is_organization]`, an attribute that doesn't exist in V2 — every call 400'd. Now maps to `filter[signup_type]` (0=person, 1=organization, confirmed against the nation's own OpenAPI spec); `advanced_search` and the MCP instructions corrected to match; `signup_type` added to default sparse fields so orgs render a `Type: Organization` line. See CHANGELOG.md.
- [ ] Update CLAUDE.md Active Projects table
- [ ] Update PROJECTS-STATUS.md
