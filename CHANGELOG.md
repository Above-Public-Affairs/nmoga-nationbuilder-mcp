# Changelog

## [2026-03-26]

### Added
- Custom field filtering in search_people — filter by any NationBuilder custom field value (e.g. member_type = "service company")
- Organization filter in search_people — filter to organizations only or people only
- Custom field values now shown in search results
- OAuth token persistence — token is saved to Railway env var after authorization so it survives server restarts

## [2026-03-27]

### Fixed
- When NationBuilder returns a 401 auth error, tools now show a direct link to re-authorize instead of a cryptic error message

### Added
- Auto-refresh on 401: if the token expires mid-session, the server automatically refreshes it and retries the request
- Refresh token persisted to Railway alongside access token so token refresh works after restarts
- Token hydration on startup from env vars so the server doesn't lose OAuth state across deploys
- Switched to Streamable HTTP transport (`/mcp` endpoint) for compatibility with mcp-remote 0.1.38+
- Legacy SSE endpoint (`/sse`) retained as fallback for older clients
- Removed global express.json() middleware that was causing "Parse error: Invalid JSON" on connection

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
