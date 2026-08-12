# NMOGA NationBuilder API — MCP Server

MCP server that connects Claude to NMOGA's NationBuilder nation. Manage people, tags, contacts, donations, events, memberships, paths, petitions, mailings, pages, automations, imports, and lists through natural language.

## Available Tools

47 tools across 15 resource areas. This table is kept in sync with `src/tools/*.ts` — if you add or remove a tool, update it here too, so a future session doesn't have to rediscover the drift the hard way.

| Tool | Description |
|------|-------------|
| **People** | |
| `search_people` | Search people by name, email, support level, custom fields, or date. Does not filter by address or email/phone presence — NationBuilder's V2 API has no operator for either. |
| `advanced_search` | Power-user search with full V2 filter syntax, tag intersection, and `include` sideloading |
| `get_person` | Get details for a person by ID (contact info, address, custom values — not tags; use `get_person_tags`) |
| `create_person` | Create a new person/supporter |
| `update_person` | Update a person's details |
| **Tags** | |
| `list_tags` | List all tags with optional name search |
| `add_tags_to_person` | Add tags to a person (creates tags that don't exist) |
| `remove_tags_from_person` | Remove tags from a person (case-insensitive) |
| `list_people_with_tag` | List people with a specific tag (case-insensitive; `count_all` for an exact total) |
| `get_person_tags` | Get every tag on one or more people — the reverse of `list_people_with_tag`, batch-capable |
| **Contacts** | |
| `list_contacts` | View interaction history for a person |
| **Donations** | |
| `list_donations` | List donations with date and amount filtering |
| **Events** | |
| `list_events` | List events with date filtering |
| `get_event` | Get event details |
| `list_event_rsvps` | List RSVPs for an event |
| **Lists** | |
| `list_lists` | List saved lists/segments |
| `get_list_people` | Get people in a specific list |
| `create_list` | Create a new list |
| `add_person_to_list` | Add a person to a list |
| `remove_person_from_list` | Remove a person from a list |
| **Relationships** | |
| `list_native_relationships` | List formal NationBuilder relationships for a person (spouse, employer, board member, etc.) |
| `create_native_relationship` | Create a formal relationship between two people |
| `list_org_members` | People whose employer field matches an org's name (informational, not a formal relationship) |
| `list_org_members_batch` | Same, across multiple orgs in one call |
| **Memberships** | |
| `list_memberships` | List membership records |
| `get_membership` | Get membership details |
| `create_membership` | Create a membership record |
| `list_membership_types` | List membership tiers |
| `get_membership_type` | Get membership tier details |
| **Paths** | |
| `list_paths` | List workflows/pipelines |
| `get_path` | Get a path's steps |
| `list_path_journeys` | List people's progress through paths |
| `get_path_journey` | Get one journey's details |
| **Petitions** | |
| `list_petitions` | List petitions |
| `get_petition` | Get petition details |
| **Mailings** | |
| `list_mailings` | List email mailings |
| `get_mailing` | Get mailing details |
| **Pages** | |
| `list_pages` | List landing pages |
| `get_page` | Get page details |
| `list_sites` | List sites |
| **Automations** | |
| `list_automations` | List automations |
| `get_automation` | Get automation details |
| `list_automation_enrollments` | List who's enrolled in an automation |
| **Imports** | |
| `list_imports` | List data imports |
| `get_import` | Get import details |
| **Signup Profiles** | |
| `get_signup_profile` | Get a person's profile (bio, headline, social links) |
| `update_signup_profile` | Update a person's profile (overwrites — see the tool's warning) |

## Setup

### Prerequisites

- Node.js 18+
- NationBuilder API test token (Settings > Developer > API tokens)

### Install & Build

```bash
npm install
npm run build
```

### Connecting — per-person NationBuilder login, no shared credential

This server is a personal connector, not an org-wide one: **each person adds
it as their own claude.ai connector and logs into NationBuilder themselves.**
There is no shared secret, no URL-embedded credential, and no admin-run
authorize step — the server is an OAuth Authorization Server to claude.ai
(mounted at `/authorize`, `/token`, `/register`, `/.well-known/*`) as well as
an OAuth client to NationBuilder. Every tool call runs under *that person's*
own NationBuilder access token, so NationBuilder's own logs attribute every
read and write to the real person, not a shared service account.

**claude.ai (recommended):** Settings → Connectors → Add custom connector →
paste `https://your-railway-url.up.railway.app/mcp` (no path suffix, no
secret). Connect, and claude.ai will walk you through NationBuilder's real
login screen. Each teammate repeats this with their own account.

**Claude Desktop, via `mcp-remote`** (also drives the same OAuth flow, opening
a browser for the NationBuilder login):

```json
{
  "mcpServers": {
    "nmoga-nationbuilder": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://your-railway-url.up.railway.app/mcp"
      ]
    }
  }
}
```

**Local stdio development** (no OAuth — a static token, for working on the
tools themselves):

```json
{
  "mcpServers": {
    "nmoga-nationbuilder": {
      "command": "node",
      "args": ["<path-to-project>/dist/index.js"],
      "env": {
        "NATIONBUILDER_SLUG": "your-nation-slug",
        "NATIONBUILDER_ACCESS_TOKEN": "your-token"
      }
    }
  }
}
```

### Environment Variables

See `.env.example` for the full annotated list. The essentials:

| Variable | Required | Description |
|----------|----------|-------------|
| `NATIONBUILDER_SLUG` | Yes | Your NationBuilder nation slug |
| `NATIONBUILDER_ACCESS_TOKEN` | stdio mode only | Static token for local/Claude Desktop stdio use. **HTTP mode refuses to boot if this is set** — per-user OAuth is the only path to `/mcp` now. |
| `NATIONBUILDER_CLIENT_ID` / `NATIONBUILDER_CLIENT_SECRET` | HTTP mode — required | Registers this server as a NationBuilder OAuth app; every connecting person authorizes through NationBuilder's own login. |
| `NATIONBUILDER_OAUTH_CALLBACK_URL` | No | Falls back to `https://$RAILWAY_PUBLIC_DOMAIN/oauth/callback`. This is the one path registered with NationBuilder's app config. |
| `MCP_TOKEN_SIGNING_SECRET` | HTTP mode — recommended | Signs the tokens this server issues to claude.ai. Auto-generated and persisted if unset, but explicit is safer — see `.env.example`. |
| `TOKEN_STORE_PATH` | No | Overrides where the per-user credential store is persisted. Defaults to `$RAILWAY_VOLUME_MOUNT_PATH/nb-tokens.json`. |
| `PORT` | No | HTTP port (Railway sets automatically); presence selects HTTP mode over stdio. |

### Token persistence — requires a volume

NationBuilder rotates each person's refresh token on every refresh, so the
persisted copy is the only way back after a restart. This service writes the
per-user credential store to `$RAILWAY_VOLUME_MOUNT_PATH/nb-tokens.json`
(mode `0600`, written via a temp file + rename so a crash can't truncate it).

**A volume must be mounted or every connected person's session lives in
memory only** — the service will come up, work fine, and then force everyone
to reconnect their connector and log into NationBuilder again on the next
restart. The production service has a volume at `/data`. If persistence isn't
working you'll see a `CRITICAL:` line in the deploy logs.

Check current status any time at `/oauth/status` — public but tiered: the
baseline body has no secrets (connected-user count, whether any need
re-authorization, store writability); present your own bearer token and it
additionally shows your own record.

## Development

```bash
npm run dev    # Run with tsx (hot reload)
npm run build  # Compile TypeScript
npm start      # Run from dist/
```
