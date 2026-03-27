# NMOGA NationBuilder API — Project Plan

## Overview

MCP server that connects Claude to NMOGA's NationBuilder nation via the NationBuilder v2 API. Deployed on Railway for remote access by multiple Claude instances.

## Architecture

- **Tech stack:** TypeScript, Express, MCP SDK
- **Transport:** SSE (Railway) + stdio (local dev)
- **API:** NationBuilder v2 (JSON:API spec)
- **Auth:** Bearer token (NB test token) + MCP auth token for endpoint protection
- **Rate limiting:** 250 req/10s sliding window (using 200 for headroom)

## Tools (17)

| Category | Tools |
|----------|-------|
| People/Signups | search_people, get_person, create_person, update_person |
| Tags | list_tags, add_tags_to_person, remove_tags_from_person, list_people_with_tag |
| Contacts | log_contact, list_contacts |
| Donations | list_donations, get_donation |
| Events | list_events, get_event, list_event_rsvps |
| Lists | list_lists, get_list_people |

## Deployment

- Hosted on Railway (auto-deploy on push)
- Env vars: `NATIONBUILDER_SLUG`, `NATIONBUILDER_ACCESS_TOKEN`, `MCP_AUTH_TOKEN`, `PORT`
- Claude Desktop connects via `mcp-remote` to the Railway SSE endpoint
