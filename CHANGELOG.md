# Changelog

## [2026-03-26]

### Added
- Custom field filtering in search_people — filter by any NationBuilder custom field value (e.g. member_type = "service company")
- Organization filter in search_people — filter to organizations only or people only
- Custom field values now shown in search results
- OAuth token persistence — token is saved to Railway env var after authorization so it survives server restarts

## [2026-03-27]

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
