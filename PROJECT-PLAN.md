# NMOGA NationBuilder API — Project Plan

## Overview

MCP server that connects Claude to NMOGA's NationBuilder nation via the NationBuilder v2 API. Deployed on Railway for remote access by multiple Claude instances.

## Architecture

- **Tech stack:** TypeScript, Express, MCP SDK
- **Transport:** SSE (Railway) + stdio (local dev)
- **API:** NationBuilder v2 (JSON:API spec)
- **Auth:** Bearer token (NB test token) + MCP auth token for endpoint protection
- **Rate limiting:** 250 req/10s sliding window (using 200 for headroom)

## Tools (48)

See the [README](README.md#available-tools) for the full, current table — this
list drifted badly in the past (claimed 17 tools, two of which never existed:
`log_contact`, `get_donation`) and the README is the version kept in sync with
`src/tools/*.ts`. Categories: People/Signups, Tags, Contacts, Donations,
Events, Lists, Relationships, Memberships, Paths, Petitions, Mailings, Pages,
Automations, Imports, Signup Profiles, Status.

## Deployment

- Hosted on Railway (auto-deploy on push)
- Env vars: `NATIONBUILDER_SLUG`, `NATIONBUILDER_ACCESS_TOKEN`, `MCP_AUTH_TOKEN`, `PORT`
- Claude Desktop connects via `mcp-remote` to the Railway SSE endpoint
