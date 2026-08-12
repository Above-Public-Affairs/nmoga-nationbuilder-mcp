# Session Handoff

## Where things stand (2026-08-12)

The server is live on Railway (`nmoga-nationbuilder-mcp`, production environment) at
`https://nmoga-nationbuilder-mcp-production.up.railway.app`, using Streamable HTTP
(`/mcp`) as an org Connector, with legacy SSE (`/sse`) kept for older clients. Auth is
OAuth against the `nmoga` NationBuilder nation, with a static-token fallback.

**This session's fix (about to ship via `/push`):** root incident — a session asked which
committee/workgroup tags a 9-person roster carried, found no person→tags tool, read
`get_person`'s "returns all available fields" claim, and concluded *"NationBuilder's API
doesn't expose a person's tag list."* False — it was a tool gap. It then ran 34 reverse
tag scans, stopped at page 1 of each, and reported six people as tag-less; that report
reached a coworker as fact. Fixed:

- **Honest pagination everywhere.** NationBuilder V2 sends no result total on any endpoint
  this server calls — confirmed live against `signups`, `signup_tags`, `signup_taggings`,
  `lists`. Every paginated tool now states plainly whether more results exist and the
  exact next `page_number`, instead of a bare `Page N` that read as complete.
- **New `get_person_tags` tool** — the reverse of `list_people_with_tag`, batch-capable.
  Zero tags renders as an explicit "No tags," never omitted.
- **A real, previously-unknown attribute-naming bug**, found while auditing
  `search_people`'s filters against the nation's own OpenAPI spec: `phone`, `mobile`, and
  every flat `registered_address_*` field used throughout this codebase are not real V2
  attribute names (the real ones are `phone_number`/`mobile_number`, and address is a
  nested `extra_fields[signups]=registered_address` object, not a sparse-fieldset
  attribute). NationBuilder silently omits unknown sparse-field names rather than
  erroring — so **no read tool in this server has ever actually shown a phone number,
  mobile number, or address**, and `create_person` has likely been silently discarding
  address data on every call that included one, since its write payload used the same
  wrong flat keys. Fixed end-to-end (types, client, every tool's field list,
  `create_person`'s write payload). `search_people`'s `state`/`city`/`has_email`/
  `has_phone` filters were removed rather than fixed — confirmed against the spec and
  live that none of the four can work at all (address isn't filterable; NB has no
  presence/absence filter operator).

Full detail in `CHANGELOG.md`'s `[2026-08-12]` entry (the second one — same date as the
`advanced_search`/`include` fix below, different session).

**Known gotcha for whoever picks this up next:** a sibling session
(`claude/nationbuilder-tag-matching-issues-21c879`) built an independent, uncommitted
implementation of the *same* incident's pagination/tag fixes in a different worktree, with
a different architecture (an eager `fetchAllPages()` helper vs. this session's honest-but-lazy
per-page reporting). Neither had committed as of this handoff. If you're resuming either
branch, check whether the other has since been merged before continuing — otherwise you'll
be redoing work that already shipped, or shipping something that conflicts with what did.

Earlier fixes, landed and merged to `main`:

- **`advanced_search`'s `include` parameter fetched sideloaded data and never rendered it**
  (`response.included` fetched, dropped on the floor) — same root incident as above, a
  different session's fix, already merged. A shared `formatIncludedResource`/
  `formatIncludedSection` renderer now handles any `include`d resource; `list_memberships`/
  `get_membership` got the same fix for their hardcoded includes.
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
- **Not yet live-verified:** this session's `phone_number`/`mobile_number` rename and the
  new `extra_fields[signups]=registered_address` query — no static token or deploy access
  was available in-session to exercise them against the real nation. First live call after
  deploy should confirm a person's phone/mobile/address actually renders now, and that
  `create_person` with an address round-trips correctly.
- **Reconcile with the sibling session's tag/pagination work** (see "Known gotcha" above)
  before or shortly after this ships — two independent implementations of the same fix
  shouldn't both land.
- No `LESSONS.md` yet in this repo — consider starting one if patterns worth compounding
  keep showing up (e.g. "NB V2 attribute names don't match their marketing docs — check
  the nation's own OpenAPI spec before trusting a HOWTO article or an assumed name"; this
  session found a second instance of exactly that pattern with `phone`/`mobile`/
  `registered_address`).
