# Session Handoff

## Where we are (2026-08-19)

Per-user NationBuilder OAuth is still live and healthy in production — reverified directly
this session (`connection_status`: good refresh chain, no reauth needed) before touching
anything.

Triaged a fresh 3-error digest (`list_pages failed`, `search_people failed`,
`nationbuilder_client: HTTP 500 after 3 attempts`), all dated 2026-08-18/19 — i.e. *after*
the per-user OAuth deploy, not a repeat of the stale 2026-08-12 digest the previous
session already closed out below. The digest's own suggested diagnosis (NationBuilder
outage, expired credentials) was wrong: `connection_status` was healthy and
`search_people`/`list_sites` returned real data live throughout.

- **`list_pages failed` — real bug, fixed.** `page_type` was advertised as a filter
  parameter but NationBuilder's V2 `pages` resource rejects it outright: `400
  bad_request: "Tried to filter on attribute :page_type, but could not find an attribute
  with that name"` — reproduced live. Removed the parameter (schema, filter construction,
  the dead `Type:` display line, the type definition). Same fix class as the 2026-04-28
  `search_people` filter cleanup; that sweep just never reached `pages.ts`. `status`
  filtering still works.
- **`nationbuilder_client: HTTP 500 after 3 attempts` — real, transient, correctly handled.**
  Pinned to 2026-08-18 ~17:11 UTC in Railway logs: one request, three attempts
  (`1000ms`/`2000ms`/`4000ms` backoff), then gave up. A different user was making
  successful calls six minutes later; token refreshes ran clean throughout. No action
  needed on this occurrence — but see the retry-loop fix below, found while reading this
  exact log line.
- **`search_people failed` — could not be attributed.** Works correctly live right now.
  The raw error text that would settle what actually happened lives in the Error
  Reporter's Postgres (`error_logs` table); reaching it needed either a bulk Railway
  env-var read or `railway ssh` into the Error Reporter's Postgres service, and the
  permission classifier blocked both in this session. Whoever picks this up next: get an
  allowlisted way to read that table, or just wait — the fix below means the next
  occurrence of this exact tool will self-diagnose.

**Also fixed, found by reading the retry code while chasing the 500 above:**

- **Dead sleep on the final retry attempt.** The 5xx and 429 branches in
  `client/nationbuilder.ts` slept the full backoff (up to 4s for 5xx, up to 30s for 429)
  *before* exiting the retry loop on the last attempt — a retry that was never coming.
  Both now skip the sleep when no attempt remains. Verified: an exhausted triple-500 now
  takes ~3.0s of backoff, not ~7.0s.
- **`tool_error` reports had no HTTP status or endpoint** — this is *why* the digest above
  was undiagnosable from the dashboard alone. A `tool_error` said only `"list_pages
  failed"`; the client's own `api_error` had the status but is globally throttled and
  names no tool, so the two couldn't be joined. Fixed by having the client stamp
  `{status, path, method, attempts}` onto the error it throws
  (`attachErrorMeta`/`readErrorMeta`, `Symbol.for`-keyed so it can't leak into
  `JSON.stringify` or a response body); `buildBody` now merges that into every report's
  context automatically. All ~40 existing `reportError` call sites gain the fields with
  zero changes to any of them. Only `safePath()` output is attached, never the query
  string — NationBuilder filter values are member PII.

**Verified** with a 16-check harness against the compiled client (real `dist/`, stubbed
`fetch`) covering: exhausted-5xx timing and error detail, the exact `list_pages` 400 case
end-to-end including that the filter *value* never reaches the report context, exhausted-429
timing, and that the success path is unchanged. Clean `tsc` build. **Not yet committed** —
sitting as working-tree changes on `claude/nationbuilder-mcp-errors-00e1ac` as of this
handoff; commit/push/deploy is the very next step.

## Update (2026-08-12, fourth session) — per-user NationBuilder OAuth, merged, not yet deployed

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

**Merged, not yet deployed.** This branch (`claude/per-user-nationbuilder-oauth`) has been
merged with `origin/main`, which had diverged with two unrelated commits from a concurrent
session (the "five code-quality fixes" and "tool annotations / connector icon /
connection_status / batch tagging" sessions below) while this work was in progress. All
core auth files (`oauth.ts`, `index.ts`, `client/nationbuilder.ts`, `rateLimiter.ts`)
required manual reconciliation; the 17 tool files merged cleanly since they're orthogonal
to auth. See PROJECT-STATUS.md's URGENT To-Do for the full Railway-env +
claude.ai-connector + NationBuilder-callback-URL coordination checklist. As of this
writing, `MCP_TOKEN_SIGNING_SECRET` has been set and verified on Railway, and the dead
`MCP_URL_SECRET`/`MCP_AUTH_TOKEN`/`NATIONBUILDER_ACCESS_TOKEN`/`NATIONBUILDER_REFRESH_TOKEN`
vars have been deleted; the NationBuilder OAuth callback URL has been confirmed unchanged.
Still needed: full rebuild + re-verification of the merged code, then a fresh push-to-main
confirmation (the merge changes what's landing, so the original "then we'll deploy" needs
re-confirming against this combined diff), then every person (team and non-team) adding
their own personal connector once it ships.

## Update (2026-08-12, latest session) — five code-quality fixes, merged on top of the auth fix

A separate same-day review (independent of the "HTTP endpoints authenticated" work below)
found and fixed five issues: `add_tags_to_person` could create near-duplicate tags on a
casing mismatch; concurrent 401s could race two OAuth token refreshes against
NationBuilder's refresh-token rotation; outbound NationBuilder requests had no timeout;
the rate limiter was built fresh per HTTP session instead of shared across the whole
process (so concurrent connector sessions each thought they had the full request budget);
and `.env.example` still described the abandoned `RAILWAY_API_TOKEN` mechanism. Full detail
in `CHANGELOG.md`'s `[2026-08-12] — Five code-quality fixes` entry.

**Branch history note:** this work started on a branch before the "HTTP endpoints
authenticated" fix below landed on `main` from a concurrent session. Reconciled via
`git stash` + fast-forward + `git stash pop`, with two real conflicts (`.env.example`,
`src/index.ts` — both files the auth fix also touched) resolved by hand; `src/oauth.ts`
merged clean since the two fixes touch disjoint functions. Rebuilt and re-verified
(`npm run build`, plus the single-flight-refresh and shared-rate-limiter checks) against
the merged result before pushing — the auth fix's `/mcp`/`/sse` restructuring (secret-path
routes, `handleMcpRequest`/`handleSseConnect`) is what the shared-client hoist now plugs
into. This confirms both fixes coexist correctly; it does not add new coverage beyond
that. **Superseded during the per-user OAuth merge above:** the refresh-race and
rate-limiter fixes were absorbed into that work's more general versions
(`refreshUserToken`'s in-flight dedupe, `getRateLimiter(slug)`); the tag-dedup and
outbound-timeout fixes stand as-is.

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
