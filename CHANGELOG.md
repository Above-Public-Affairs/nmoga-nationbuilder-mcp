# Changelog

## [2026-03-26]

### Added
- Custom field filtering in search_people — filter by any NationBuilder custom field value (e.g. member_type = "service company")
- Organization filter in search_people — filter to organizations only or people only
- Custom field values now shown in search results

## [2026-03-27]

### Fixed
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
