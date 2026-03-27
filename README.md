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
| `list_people_with_tag` | List people with a specific tag |
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
| `NATIONBUILDER_ACCESS_TOKEN` | Yes | API test token from NB Settings |
| `PORT` | No | HTTP port for SSE mode (Railway sets automatically) |
| `MCP_AUTH_TOKEN` | No | Bearer token to protect SSE endpoint |

## Development

```bash
npm run dev    # Run with tsx (hot reload)
npm run build  # Compile TypeScript
npm start      # Run from dist/
```
