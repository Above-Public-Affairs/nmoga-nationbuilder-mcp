# Session Handoff

## Update (2026-08-12, latest session) — five code-quality fixes, merged on top of the auth fix

A separate same-day review (independent of the "HTTP endpoints authenticated" work below)
found and fixed five issues: `add_tags_to_person` could create near-duplicate tags on a
casing mismatch; concurrent 401s could race two OAuth token refreshes against
NationBuilder's refresh-token rotation; outbound NationBuilder requests had no timeout;
the rate limiter was built fresh per HTTP session instead of shared across the whole
process (so concurrent connector sessions each thought they had the full request budget);
and `.env.example` still described the abandoned `RAILWAY_API_TOKEN` mechanism. Full detail
in `CHANGELOG.md`'s `[2026-08-12] — Five code-quality fixes` entry.

**Branch history note:** this work started on this branch before the "HTTP endpoints
authenticated" fix below landed on `main` from a concurrent session. Reconciled via
`git stash` + fast-forward + `git stash pop`, with two real conflicts (`.env.example`,
`src/index.ts` — both files the auth fix also touched) resolved by hand; `src/oauth.ts`
merged clean since the two fixes touch disjoint functions. Rebuilt and re-verified
(`npm run build`, plus the single-flight-refresh and shared-rate-limiter checks) against
the merged result before pushing — the auth fix's `/mcp`/`/sse` restructuring (secret-path
routes, `handleMcpRequest`/`handleSseConnect`) is what the shared-client hoist now plugs
into. This confirms both fixes coexist correctly; it does not add new coverage beyond that.

## Update (2026-08-12, later session) — HTTP endpoints authenticated, not yet deployed

A same-day code review found `/mcp`, `/sse`, `/oauth/authorize`, and `/oauth/status` were
completely unauthenticated in production — see the CHANGELOG's `[2026-08-12] — HTTP
endpoints authenticated` entry for the fix. This resolves the "MCP_AUTH_TOKEN never read"
gap noted in "Next steps" below — `MCP_AUTH_TOKEN` is now checked as a Bearer credential,
and a new `MCP_URL_SECRET` env var gates a secret-path route for the org connector (which
can't send headers). Built on the `claude/priceless-gagarin-c1c315` branch; **not merged or
deployed** — deploying it requires Josh to set `MCP_URL_SECRET` on Railway and update the
claude.ai org Connector URL to `/mcp/<that value>` in the same window, or the connector goes
dark the moment it ships. See PROJECT-STATUS.md's URGENT To-Do item.

## Where things stand (2026-08-12)

The server is live on Railway (`nmoga-nationbuilder-mcp`, production environment) at
`https://nmoga-nationbuilder-mcp-production.up.railway.app`, using Streamable HTTP
(`/mcp`) as an org Connector, with legacy SSE (`/sse`) kept for older clients. Auth is
OAuth against the `nmoga` NationBuilder nation, with a static-token fallback.

**This session's work (about to ship via `/push`):** four features from a same-day
codebase review, unrelated to the tag-truncation incident below — planned first (plan mode,
approved), then built.

1. **All 48 tools migrated from `server.tool()` to `server.registerTool()`** with explicit
   `title` + `annotations` (`readOnlyHint`/`destructiveHint`). 38 read-only, 8 non-destructive
   writes, 2 destructive (`remove_person_from_list`, `remove_tags_from_person`). No handler
   logic changed; verified via a live `tools/list` call against a locally-running instance.
2. **Connector icon groundwork**: `/favicon.ico` (`src/favicon.ts`, teal "N" monogram,
   multi-resolution) plus a matching `serverInfo.icons` entry on the `McpServer` constructor.
   **Not yet visible in the connector list** — Claude's connector UI still derives the icon
   from the server's domain on shared `*.up.railway.app` hosts, per the house rule in the
   global CLAUDE.md. A custom domain is the only current lever; that's a call for Josh, not
   assumed here.
3. **New `connection_status` tool** (`src/tools/status.ts`) — surfaces the same auth-state
   info as `/oauth/status` (active method, token expiry, refresh token, token-store
   writability) from inside a chat. Backed by a new `getAuthStatus()` export in `src/oauth.ts`
   that the HTTP route now calls too, instead of duplicating the logic inline.
4. **Batch tagging**: `add_tags_to_person`/`remove_tags_from_person` now take comma-separated
   `person_ids` (cap 50, matching `get_person_tags`'s existing convention) instead of a single
   `person_id`, with per-person/per-tag reporting. `add_tags_to_person` resolves each tag name
   once per call, not once per person.

**Verified so far:** clean `tsc` build; a locally-running instance (dummy token) confirmed
`/favicon.ico` serves correctly, `serverInfo.icons` appears in `initialize`, all 48 tools
appear in `tools/list` with correct titles/annotations, `connection_status` reports
accurately, and the 50-person cap rejects a 51-ID batch cleanly. **Not yet verified:** batch
tagging against real NationBuilder data (no live credential in-session) — first live use
after deploy should confirm a multi-person tag add/remove actually round-trips.

**Previously merged for the tag-truncation incident** (`69d6225`, `5d02630` — already
shipped, unrelated to this session's work above):

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

**Resolved — the duplicate-work collision.** A sibling session
(`claude/nationbuilder-tag-matching-issues-21c879`) had independently built the *same*
incident's pagination/tag fixes in another worktree, with a different architecture (an
eager `fetchAllPages()` helper vs. this codebase's honest-but-lazy per-page reporting).
Both shipped-ready at once. `69d6225` won on merit — broader coverage, live-verified
findings, and the signup field-name audit the other branch never found — and the sibling
branch was deleted, local and remote, without merging. Merging it would have crashed the
server at startup: the MCP SDK throws on duplicate tool registration, and both had added
`get_person_tags`. Nothing from it is outstanding; the two items in this session's fix
above are the only pieces of that branch's work that weren't already covered.

**Lesson worth keeping:** `git stash` is one stack shared across *every* worktree of a
repo, not per-worktree. Two sessions stashing concurrently in different worktrees of this
repo popped each other's entries. Nothing was lost, but if more than one session may be
touching a repo, name the stash and pop by explicit `stash@{n}` — or commit WIP to a
throwaway branch instead.

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

- **Decide on a custom domain for the connector icon** — `/favicon.ico` and `serverInfo.icons`
  are live, but won't visibly change the connector-list icon until either Claude honors
  those fields or this server moves off the shared `*.up.railway.app` host. Josh's call.
- **Verify batch tagging live** — `add_tags_to_person`/`remove_tags_from_person` with
  comma-separated `person_ids` was only exercised against a dummy local token this session.
  First live call should confirm a multi-person add/remove round-trips and the tag-resolution
  hoist (resolve each tag once per call, not once per person) behaves as expected.
- ~~Confirm the persistence fix survives a real redeploy~~ — done 2026-08-11, verified by
  an actual restart.
- ~~Reconcile `PROJECT-STATUS.md` with reality~~ — done 2026-08-11.
- ~~`MCP_AUTH_TOKEN` is set in the Railway env but never read by the code — `/mcp` is
  ungated.~~ — fixed in the later 2026-08-12 session above; not yet deployed.
- `RAILWAY_API_TOKEN` is now unused and can be deleted from the service.
- **Not yet live-verified:** this session's `phone_number`/`mobile_number` rename and the
  new `extra_fields[signups]=registered_address` query — no static token or deploy access
  was available in-session to exercise them against the real nation. First live call after
  deploy should confirm a person's phone/mobile/address actually renders now, and that
  `create_person` with an address round-trips correctly.
- ~~Reconcile with the sibling session's tag/pagination work~~ — done; that branch was
  deleted unmerged in favour of `69d6225` (see "Resolved" above).
- **The original incident has still never been re-run against live data.** Every fix for it
  so far — across three sessions — was verified against mocked clients and synthetic
  fixtures only. Nobody has re-pulled the actual 9-person roster and called
  `get_person_tags` on it to find out whether the six people reported as carrying no
  WG/CMTE tags actually do. That is the question the coworker originally asked, and it is
  still unanswered. The tooling to answer it is now deployed.
- No `LESSONS.md` yet in this repo — consider starting one if patterns worth compounding
  keep showing up (e.g. "NB V2 attribute names don't match their marketing docs — check
  the nation's own OpenAPI spec before trusting a HOWTO article or an assumed name"; this
  session found a second instance of exactly that pattern with `phone`/`mobile`/
  `registered_address`).
