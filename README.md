# NMOGA NationBuilder API — MCP Server

MCP server that connects Claude to NMOGA's NationBuilder nation. Manage people, tags, contacts, donations, events, and lists through natural language.

## Available Tools

| Tool | Description |
|------|-------------|
| `search_people` | Search people by name, email, support level, or date |
| `get_person` | Get full details for a person by ID |
| `create_person` | Create a new person/supporter |
| `update_person` | Update a person's details |
| `list_tags` | List all tags with optional search |
| `add_tags_to_person` | Add tags to a person |
| `remove_tags_from_person` | Remove tags from a person |
| `list_people_with_tag` | List people with a specific tag (case-insensitive name lookup; includes total count) |
| `log_contact` | Log a call, email, meeting, or other interaction |
| `list_contacts` | View interaction history for a person |
| `list_donations` | List donations with date filtering |
| `get_donation` | Get donation details |
| `list_events` | List events with date filtering |
| `get_event` | Get event details |
| `list_event_rsvps` | List RSVPs for an event |
| `list_lists` | List saved lists/segments |
| `get_list_people` | Get people in a specific list |

## Setup

### Prerequisites

- Node.js 18+
- NationBuilder API test token (Settings > Developer > API tokens)

### Install & Build

```bash
npm install
npm run build
```

### Claude Desktop Configuration

**Remote (Railway-hosted):**

```json
{
  "mcpServers": {
    "nmoga-nationbuilder": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://your-railway-url.up.railway.app/sse"
      ]
    }
  }
}
```

**Local development:**

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

| Variable | Required | Description |
|----------|----------|-------------|
| `NATIONBUILDER_SLUG` | Yes | Your NationBuilder nation slug |
| `NATIONBUILDER_ACCESS_TOKEN` | Yes | API test token from NB Settings. In OAuth mode this is only a first-boot fallback — the token file on the volume takes precedence once it exists. |
| `NATIONBUILDER_CLIENT_ID` / `NATIONBUILDER_CLIENT_SECRET` | OAuth only | Enables the `/oauth/*` routes |
| `NATIONBUILDER_REFRESH_TOKEN` | No | First-boot fallback only, same as the access token above |
| `TOKEN_STORE_PATH` | No | Overrides where tokens are persisted. Defaults to `$RAILWAY_VOLUME_MOUNT_PATH/nb-tokens.json`. |
| `PORT` | No | HTTP port for SSE mode (Railway sets automatically) |
| `MCP_AUTH_TOKEN` | No | Currently **unused** — the `/mcp` endpoint is not gated. Present in the Railway env but not read by the code. |

### Token persistence (OAuth mode) — requires a volume

NationBuilder rotates the refresh token on every refresh, so the persisted copy
is the only way back after a restart. This service writes tokens to
`$RAILWAY_VOLUME_MOUNT_PATH/nb-tokens.json` (mode `0600`, written via a temp
file + rename so a crash can't truncate it).

**A volume must be mounted or tokens live in memory only** — the service will
come up, work fine, and then lose NationBuilder access on its next restart until
someone re-runs `/oauth/authorize`. The production service has a volume at
`/data`. If persistence isn't working you'll see a `CRITICAL:` line in the deploy
logs, and the `/oauth/callback` success page says so explicitly.

Check current auth state any time at `/oauth/status`.

## Development

```bash
npm run dev    # Run with tsx (hot reload)
npm run build  # Compile TypeScript
npm start      # Run from dist/
```
