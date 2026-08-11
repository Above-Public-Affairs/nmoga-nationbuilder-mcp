# Session Handoff

## Where things stand (2026-08-11)

The server is live on Railway (`nmoga-nationbuilder-mcp`, production environment) at
`https://nmoga-nationbuilder-mcp-production.up.railway.app`, using Streamable HTTP
(`/mcp`) as an org Connector, with legacy SSE (`/sse`) kept for older clients. Auth is
OAuth against the `nmoga` NationBuilder nation, with a static-token fallback.

Two independent fixes landed and merged to `main` around the same time:

- **Session/OAuth robustness** (`claude/nmoga-nationbuilder-connector-1f497b`, merged via
  PR #1): unknown session IDs now return 404 (so clients auto-recover instead of going
  dark), OAuth token persistence to Railway now tries both credential styles, idle
  sessions are reaped, and error reporting covers process-level failures, all three
  Express routes, and API-client retry exhaustion.
- **`search_people` org filter fix** (this session): `is_organization` was mapped to a
  nonexistent `filter[is_organization]` and 400'd on every call. Now maps to
  `filter[signup_type]` (0=person, 1=organization) — confirmed against the nation's own
  OpenAPI spec at `/api/v2/docs/v2/released.yaml`. See CHANGELOG.md for full detail.

## Known gotcha: the stored OAuth credential goes dead easily

The Railway env `NATIONBUILDER_ACCESS_TOKEN` / `NATIONBUILDER_REFRESH_TOKEN` pair has died
twice in the last two days — once found expired at session start, re-authorized by the
user, then found dead again ~24h later after a Railway redeploy (the redeploy re-hydrated
the stale env token instead of keeping the freshly-refreshed in-memory one). The
persistence fix above should stop this going forward, but it hasn't been proven to hold
across a redeploy yet. If tools start failing with "access token is missing or expired",
re-authorize at `/oauth/authorize` on the deployed URL — don't try to refresh the token
out-of-band from a local shell, since NationBuilder rotates the refresh token on every use
and a local refresh will invalidate whatever the server is holding.

## Next steps

- Confirm the persistence fix survives a real redeploy without losing the token (nobody's
  watched one happen yet).
- The `PROJECT-STATUS.md` to-do list still lists "Deploy to Railway" / "Configure Claude
  Desktop" as open items — those are stale; the server has been deployed and in use as an
  org Connector for a while. Worth a pass to reconcile that file with reality.
- No `LESSONS.md` yet in this repo — consider starting one if patterns worth compounding
  keep showing up (e.g. "NB V2 attribute names don't match their marketing docs — check
  the nation's own OpenAPI spec before trusting a HOWTO article or an assumed name").
