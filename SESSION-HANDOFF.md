# Session Handoff

## Where things stand (2026-08-12)

The server is live on Railway (`nmoga-nationbuilder-mcp`, production environment) at
`https://nmoga-nationbuilder-mcp-production.up.railway.app`, using Streamable HTTP
(`/mcp`) as an org Connector, with legacy SSE (`/sse`) kept for older clients. Auth is
OAuth against the `nmoga` NationBuilder nation, with a static-token fallback.

**This session's fix (about to ship via `/push`):** `advanced_search`'s `include`
parameter — and `list_memberships`/`get_membership`'s hardcoded `include=signup,membership_type`
— fetched JSON:API sideloaded data into `response.included` and never rendered it. The
call succeeded, paid the round-trip, and the caller never saw the data, with no error or
signal anything was omitted. This produced a wrong conclusion in a sibling session: a
clean-but-empty `advanced_search(include='tags')` response was read as "the API doesn't
expose a person's tags." That's doubly wrong — `formatting.ts` already had a `formatTag`
formatter (the bug was wiring, not missing code), and `include=tags` on `signups` actually
hard-400s (confirmed live) rather than returning empty; NB validates includes and rejects
unsupported ones outright. Fix: a shared `formatIncludedResource`/`formatIncludedSection`
renderer in `src/utils/formatting.ts` (dispatches by JSON:API type to the existing
formatters; unmapped types get a generic id/type/attrs fallback rather than being
dropped), wired into `advanced_search` and both membership tools. Also corrected the
`tags` example in `advanced_search`'s description and the server `INSTRUCTIONS` block —
both had advertised it as a working value. Full detail in CHANGELOG.md `[2026-08-12]`.

Earlier fixes, landed and merged to `main`:

- **Session/OAuth robustness** (`claude/nmoga-nationbuilder-connector-1f497b`, merged via
  PR #1): unknown session IDs now return 404 (so clients auto-recover instead of going
  dark), OAuth token persistence to Railway now tries both credential styles, idle
  sessions are reaped, and error reporting covers process-level failures, all three
  Express routes, and API-client retry exhaustion.
- **`search_people` org filter fix**: `is_organization` was mapped to a
  nonexistent `filter[is_organization]` and 400'd on every call. Now maps to
  `filter[signup_type]` (0=person, 1=organization) — confirmed against the nation's own
  OpenAPI spec at `/api/v2/docs/v2/released.yaml`. See CHANGELOG.md for full detail.

## Resolved: the OAuth credential no longer dies on restart

This was the big one, and it is fixed as of 2026-08-11.

**What was wrong.** Token persistence wrote back to Railway env vars through the platform
API, using `RAILWAY_API_TOKEN`. That call had been failing with `Not Authorized` on every
daily refresh since at least 2026-08-02 — logged as a single quiet line, so nobody noticed.
The in-memory refresh kept succeeding, so the service looked healthy while the *stored*
credential went stale. Because NationBuilder rotates the refresh token on every use, the
env copy was dead within a day of the first failed write, and every restart from then on
hydrated a corpse. Both Railway credential styles (`Authorization: Bearer` and
`Project-Access-Token`) were rejected, so the token itself was bad — not the header.

**What changed.** Persistence now writes `/data/nb-tokens.json` on a Railway volume
(`0600`, temp-file + rename). No Railway API call, no privileged credential in the
container. On boot the volume wins over the env vars — that ordering is load-bearing, since
preferring env would hand back an already-rotated token. `RAILWAY_API_TOKEN` is now unused.

**Proven, not assumed.** The service was restarted and came back authenticated with no
human action. `/oauth/status` now reports `tokenStore.writable`, so "will this token
survive a restart?" is answerable *before* authorizing rather than after.

If tools ever do fail with "access token is missing or expired", re-authorize at
`/oauth/authorize` on the deployed URL. Don't refresh out-of-band from a local shell —
NationBuilder rotates the refresh token on every use, so a local refresh invalidates
whatever the server is holding.

**Watch for:** a `CRITICAL:` line in the deploy logs mentioning the token store. That means
the volume came unmounted and tokens are in memory only — the next restart will need a
manual re-authorize until it's fixed.

## Next steps

- ~~Confirm the persistence fix survives a real redeploy~~ — done 2026-08-11, verified by
  an actual restart.
- ~~Reconcile `PROJECT-STATUS.md` with reality~~ — done 2026-08-11.
- `MCP_AUTH_TOKEN` is set in the Railway env but never read by the code — `/mcp` is
  ungated. Either wire it up (and configure the Connector to send it) or drop the variable,
  so it stops reading like protection that isn't there.
- `RAILWAY_API_TOKEN` is now unused and can be deleted from the service.
- No `LESSONS.md` yet in this repo — consider starting one if patterns worth compounding
  keep showing up (e.g. "NB V2 attribute names don't match their marketing docs — check
  the nation's own OpenAPI spec before trusting a HOWTO article or an assumed name").
