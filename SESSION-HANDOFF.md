# Session Handoff

## Update (2026-08-12, third session) — per-user NationBuilder OAuth, not yet deployed

The URL-secret fix described in the section below **did deploy** (Railway auto-deployed
`990f436` successfully) — but `MCP_URL_SECRET` was never set on Railway, so the org
connector's bare `/mcp` calls started getting `401`, and the connector went dark for
everyone. Confirmed live: `/health` → 200, `POST /mcp` → 401.

Rather than fix the coordination gap and restart-ship the same URL-secret model, this
session rebuilt the auth story from scratch around per-user NationBuilder OAuth: each
person adds this MCP as their **own personal** claude.ai connector (explicitly decided —
no Organization Connector, no shared secret at all) and logs into NationBuilder themselves.
Every tool call runs under that person's own NationBuilder token, so NationBuilder's own
audit log attributes every action to the real person — which is what "fix the security
hole" actually needed to mean, not just "who can reach the URL."

Built on a **new branch, `claude/per-user-nationbuilder-oauth`** (off `main`, which already
has the URL-secret commit) — the old `claude/priceless-gagarin-c1c315` branch was already
merged and is done. Seven commits, each independently reviewable:
1. Groundwork (decouple the API client from the global token, rate-limiter singleton,
   throttle-key hygiene) — zero behavior change.
2. `src/auth/store.ts`, the per-user credential store — added but unused.
3. `oauth.ts`'s refresh/persistence rewired onto the store (still single-identity,
   `legacy:shared`) — external behavior unchanged.
4. The Authorization Server itself (`src/auth/{tokens,provider,wellKnown}.ts`) — mounted,
   verified end-to-end against a scripted fake NationBuilder upstream, but not yet gating
   `/mcp`.
5. **The gate flip** — `/mcp` now requires `requireBearerAuth`; session ownership
   re-checked on every request (the session-hijack test is the one worth re-reading in
   CHANGELOG.md); `httpAuth.ts`, the secret-path routes, and legacy SSE all deleted.
6. HTTP mode refuses to boot if a static NationBuilder token is set.
7. Docs (this file, README, .env.example, CHANGELOG, PROJECT-STATUS).

**Not merged or deployed.** See PROJECT-STATUS.md's URGENT To-Do for the full
Railway-env + claude.ai-connector + NationBuilder-callback-URL coordination checklist —
none of it can happen from this session. The connector is already dark, so there's no
*additional* outage risk in taking the time to do this coordination correctly, but every
person (team and non-team) will need to add their own personal connector once it ships.

## Update (2026-08-12, second session) — HTTP endpoints authenticated, deployed but broken

A same-day code review found `/mcp`, `/sse`, `/oauth/authorize`, and `/oauth/status` were
completely unauthenticated in production — see the CHANGELOG's `[2026-08-12] — HTTP
endpoints authenticated` entry for the fix. This resolves the "MCP_AUTH_TOKEN never read"
gap noted in "Next steps" below — `MCP_AUTH_TOKEN` is now checked as a Bearer credential,
and a new `MCP_URL_SECRET` env var gates a secret-path route for the org connector (which
can't send headers). Built on the `claude/priceless-gagarin-c1c315` branch, merged to
`main`, and **Railway auto-deployed it successfully** — but `MCP_URL_SECRET` was never
set, and nobody updated the claude.ai connector URL to match, so the connector went dark
the moment it shipped. That's the coordination failure the per-user OAuth session (above)
responded to by replacing the whole model rather than patching the sequencing.

## Where things stand (2026-08-12)

The server is live on Railway (`nmoga-nationbuilder-mcp`, production environment) at
`https://nmoga-nationbuilder-mcp-production.up.railway.app`, using Streamable HTTP
(`/mcp`) as an org Connector, with legacy SSE (`/sse`) kept for older clients. Auth is
OAuth against the `nmoga` NationBuilder nation, with a static-token fallback.

**This session's fix (about to ship via `/push`):** a cross-check of everything already
merged for the root incident (below) against the original nine-item defect list turned up
two gaps still open, both the same failure mode as the rest — a tool answering confidently
where the query never supported the answer:

- **`resolveTagByName`'s case-insensitive fallback read one 100-row page.** A tag whose
  stored casing differs from the caller's, sitting past the first 100 substring matches,
  resolved to *"Tag not found ... the tag must exist in the nation"* — wrong about a tag
  that exists. Fed `list_people_with_tag` and `advanced_search`'s `tag` param; being an
  internal lookup, the new pagination warnings never reached the caller. Now paged (50-page
  cap) with an early exit on match, so the common case still costs one request.
- **A NationBuilder-rejected employer filter looked exactly like an empty organization.**
  `findPeopleByEmployer` swallowed the 400 and returned `[]`; `list_org_members` said "No
  people found," and `list_org_members_batch` didn't even count the org as an error (the
  helper returned rather than threw), so it rendered as "searched successfully, 0 people."
  Both now say so explicitly and point at `list_native_relationships`. This one mattered
  most because `list_org_members` is the likely source of the incident's original 9-person
  roster.

**Previously merged for the same incident** (`69d6225`):

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

- ~~Confirm the persistence fix survives a real redeploy~~ — done 2026-08-11, verified by
  an actual restart.
- ~~Reconcile `PROJECT-STATUS.md` with reality~~ — done 2026-08-11.
- ~~`MCP_AUTH_TOKEN` is set in the Railway env but never read by the code — `/mcp` is
  ungated.~~ — fixed and deployed 2026-08-12, then superseded entirely by the per-user
  OAuth session (top of this file): `MCP_AUTH_TOKEN`/`MCP_URL_SECRET` are dead vars now,
  safe to delete from Railway once the per-user branch ships.
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
