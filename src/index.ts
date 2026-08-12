#!/usr/bin/env node
/**
 * NMOGA NationBuilder API MCP Server
 *
 * A Model Context Protocol server that enables Claude to interact with
 * NationBuilder's API v2 — managing people, tags, contacts, donations,
 * events, and lists.
 *
 * Transport:
 *   - SSE (when PORT env var is set — for Railway deployment)
 *   - stdio (default — for local use with Claude Desktop)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import type { Server } from "node:http";
import express from "express";
import type { Request, Response } from "express";
import { createNationBuilderClient, NO_TOKEN_PREFIX } from "./client/nationbuilder.js";
import type { NationBuilderClientOptions } from "./client/nationbuilder.js";
import { bootstrapToken, createOAuthRouter, isOAuthConfigured, refreshUserToken, sweepUserTokens } from "./oauth.js";
import { getStoreStatus, getUserAccessToken, userTag as storeUserTag } from "./auth/store.js";
import { createNationBuilderOAuthProvider } from "./auth/provider.js";
import { wellKnownAliasRouter, mcpCorsMiddleware } from "./auth/wellKnown.js";
import { publicBaseUrl } from "./auth/tokens.js";
import { mcpAuthRouter, createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { reportError, reportErrorThrottled, reportAndFlush, safeErr } from "./utils/errorReporter.js";
import { registerSignupTools } from "./tools/signups.js";
import { registerTagTools } from "./tools/tags.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerDonationTools } from "./tools/donations.js";
import { registerEventTools } from "./tools/events.js";
import { registerListTools } from "./tools/lists.js";
import { registerRelationshipTools } from "./tools/relationships.js";
import { registerMembershipTools } from "./tools/memberships.js";
import { registerMembershipTypeTools } from "./tools/membershipTypes.js";
import { registerPathTools } from "./tools/paths.js";
import { registerNativeRelationshipTools } from "./tools/nativeRelationships.js";
import { registerSignupProfileTools } from "./tools/signupProfiles.js";
import { registerPetitionTools } from "./tools/petitions.js";
import { registerMailingTools } from "./tools/mailings.js";
import { registerPageTools } from "./tools/pages.js";
import { registerAutomationTools } from "./tools/automations.js";
import { registerImportTools } from "./tools/imports.js";

// CRITICAL: Never use console.log() - it corrupts JSON-RPC on stdout
// Always use console.error() for any logging/debugging

const INSTRUCTIONS = `
# NationBuilder MCP Server — Instructions

## Key Concepts

### People vs Organizations
NationBuilder stores both people and organizations as "signups" in the same endpoint. The distinction is the \`signup_type\` attribute: **0 = person, 1 = organization**. There is no \`is_organization\` attribute — filtering on that name returns a 400 from the V2 API.

When searching, use the search_people tool for both — there is no separate organizations endpoint. To scope by type, pass \`is_organization: true\` (or \`false\`) to \`search_people\`, which maps to \`filter[signup_type]\` for you. In \`advanced_search\`, filter on the raw attribute instead: \`filters={"signup_type":"1"}\`.

### Relationships (IMPORTANT)
There are two completely different systems that can associate people with organizations:

1. **Formal Relationships** (use these): The NationBuilder relationships API stores typed connections between two signups. The two main types are "employee_of" and "primary_contact_of". Use the \`list_native_relationships\` tool to query these. This is the authoritative source for who is formally connected to an organization.

2. **Employer Field** (informational only): Each person signup has an "employer" text field. The \`list_org_members\` and \`list_org_members_batch\` tools match on this employer text field — they do NOT query formal NationBuilder relationships. Treat these results as informational/supplementary, not as confirmed relationships.

When asked about relationships between people and organizations, always use \`list_native_relationships\`. Do not rely on \`list_org_members\` for formal relationship data.

### Custom Fields
NationBuilder supports custom fields on signups. Key custom fields in this nation include:
- \`member_type\` — categorizes organizations (e.g., "Service Company", "Operator")

To search by custom fields, use \`search_people\` with the \`custom_field\` and \`custom_field_value\` parameters, or use \`advanced_search\` for more complex queries.

### Tags
Tags work in both directions. Use \`list_people_with_tag\` to find everyone with a specific tag, \`list_tags\` to see all available tags, and **\`get_person_tags\` to find every tag on one or more people** (batch-capable — pass comma-separated IDs to check a whole roster in one call).

Tags are **not** sideloadable from the \`signups\` endpoint — \`advanced_search\`'s \`include\` parameter cannot fetch a person's tags (NationBuilder rejects \`include=tags\` there with an HTTP 400, "not a supported relationship"). Do not conclude from that error, or from an \`include\` that comes back empty, that tag data is unavailable via the API, or that a missing tool means the underlying data doesn't exist — before concluding NationBuilder "doesn't expose" something, check whether a different tool or resource already covers it. \`get_person_tags\` is that path for tags; it queries \`signup_taggings\` filtered by \`filter[signup_id]\` with \`include=tag\` (the same query \`remove_tags_from_person\` runs internally).

A person with zero tags is reported by \`get_person_tags\` as having none, explicitly. Never infer "no tags" from a person's absence in a filtered list — that absence usually means the query didn't reach them, not that no tag applies.

To enumerate every tag matching a pattern (e.g. all committee/workgroup tags), use \`list_tags\` with a \`query\` filter and page to exhaustion — see the pagination note below before treating any single page as the full set.

### Memberships
Memberships track organizational membership tiers and statuses. Use \`list_membership_types\` to see available tiers, and \`list_memberships\` to query membership records.

### Pagination — a page is not an answer
NationBuilder's V2 API sends no result total on the endpoints this server calls (confirmed live against signups, signup_tags, signup_taggings, and lists). Every paginated tool's response states explicitly whether it is complete or not — read that line before treating a page as the full answer. A full page (the count you asked for in \`page_size\`) almost always means more results exist; call again with the next \`page_number\` rather than stopping. This applies to every list_*/search_* tool, not just tag tools — a wrong conclusion has previously been drawn by stopping at page 1 across dozens of calls.

## Tool Selection Guide

| Task | Tool to Use |
|------|-------------|
| Find formal relationships for a person or org | \`list_native_relationships\` |
| Find people by employer field (informational) | \`list_org_members\` |
| Search people or orgs by name/email | \`search_people\` |
| Search by custom fields | \`search_people\` with custom_field params, or \`advanced_search\` |
| Find people with a specific tag | \`list_people_with_tag\` |
| Find every tag on one or more people | \`get_person_tags\` |
| Create a formal relationship | \`create_native_relationship\` |
`.trim();

function validateEnv(): { slug: string; staticToken: string | null } {
  const slug = process.env.NATIONBUILDER_SLUG;
  const staticToken = process.env.NATIONBUILDER_ACCESS_TOKEN || null;

  if (!slug) {
    // Thrown, not exited directly: main().catch reports startup_error via the
    // flush-before-exit path and then exits. A bare process.exit(1) here
    // would report nothing — silent in the one place a deploy is most likely
    // to fail.
    throw new Error("missing required environment variable: NATIONBUILDER_SLUG");
  }

  if (process.env.PORT) {
    // HTTP mode. Per-user NationBuilder OAuth (src/auth/provider.ts) is the
    // only supported path to /mcp now — nothing in this codebase reads
    // NATIONBUILDER_ACCESS_TOKEN/REFRESH_TOKEN into a live tool call
    // anymore. Refuse to boot with either set rather than let it sit as an
    // inert credential that LOOKS like a fallback but silently isn't one:
    // that ambiguity is exactly what this migration exists to close, and a
    // loud boot failure is a better place to discover a leftover Railway
    // env var than a quiet log line nobody's watching.
    if (staticToken || process.env.NATIONBUILDER_REFRESH_TOKEN) {
      throw new Error(
        "NATIONBUILDER_ACCESS_TOKEN and NATIONBUILDER_REFRESH_TOKEN must not be set in HTTP mode " +
        "(PORT is set). Per-user NationBuilder OAuth is the only supported path to /mcp — delete both " +
        "vars from this service's environment. (stdio/local Claude Desktop use is unaffected: it never " +
        "sets PORT and still requires NATIONBUILDER_ACCESS_TOKEN.)"
      );
    }
    if (!isOAuthConfigured()) {
      console.error(
        "Warning: OAuth is not configured (NATIONBUILDER_CLIENT_ID/NATIONBUILDER_CLIENT_SECRET/callback " +
        "URL). HTTP mode has no other way to authenticate now — every /mcp request will be rejected " +
        "until this is set."
      );
      // Boots anyway (so /health stays reachable for diagnosis), but every
      // /mcp request will 401 until this is fixed — worth a row, not just a
      // log line nobody's watching.
      reportError({
        category: "auth_error",
        message: "startup: HTTP mode with OAuth not configured — /mcp is unreachable",
        context: {
          has_client_id: !!process.env.NATIONBUILDER_CLIENT_ID,
          has_callback_url: !!(process.env.NATIONBUILDER_OAUTH_CALLBACK_URL || process.env.RAILWAY_PUBLIC_DOMAIN),
        },
      });
    }
  } else if (!staticToken) {
    // stdio mode. startStdioServer() throws on a missing static token too;
    // warn here so it's visible even before that path runs.
    console.error("Warning: No NATIONBUILDER_ACCESS_TOKEN set — required for stdio mode.");
  }

  return { slug, staticToken };
}

function createServer(
  slug: string,
  tokenGetter: string | (() => string),
  clientOpts: NationBuilderClientOptions = {}
): McpServer {
  const server = new McpServer(
    {
      name: "nmoga-nationbuilder-mcp",
      version: "1.0.0",
    },
    {
      instructions: INSTRUCTIONS,
    }
  );

  const client = createNationBuilderClient(slug, tokenGetter, clientOpts);

  // Register all tools
  registerSignupTools(server, client);
  registerTagTools(server, client);
  registerContactTools(server, client);
  registerDonationTools(server, client);
  registerEventTools(server, client);
  registerListTools(server, client);
  registerRelationshipTools(server, client);
  registerMembershipTools(server, client);
  registerMembershipTypeTools(server, client);
  registerPathTools(server, client);
  registerNativeRelationshipTools(server, client);
  registerSignupProfileTools(server, client);
  registerPetitionTools(server, client);
  registerMailingTools(server, client);
  registerPageTools(server, client);
  registerAutomationTools(server, client);
  registerImportTools(server, client);

  return server;
}

async function startSseServer(slug: string): Promise<void> {
  const port = parseInt(process.env.PORT || "3000", 10);
  const app = express();
  // Trust exactly one hop (Railway's own proxy) so req.ip/req.protocol reflect
  // the real client instead of the proxy. A specific hop count, not `true` —
  // `true` trusts every hop in X-Forwarded-For, which lets any caller spoof
  // their own IP and defeats per-IP rate limiting outright.
  app.set("trust proxy", 1);

  // The Authorization Server this MCP server presents to claude.ai, backed
  // by each connecting person's own real NationBuilder login (see
  // src/auth/provider.ts). Mounted unconditionally and at the app root, per
  // the SDK's own requirement for mcpAuthRouter — /authorize will itself
  // redirect with an error if NationBuilder OAuth isn't configured, rather
  // than this needing a conditional mount.
  //
  // This IS what gates /mcp below (via requireBearerAuth) — the
  // MCP_URL_SECRET/MCP_AUTH_TOKEN shared-secret gate and the legacy SSE
  // transport are gone; every caller now completes a real NationBuilder
  // login through this Authorization Server.
  app.use(mcpCorsMiddleware);
  const nbOAuthProvider = createNationBuilderOAuthProvider();
  const issuerUrl = new URL(publicBaseUrl());
  const resourceServerUrl = new URL(`${publicBaseUrl()}/mcp`);
  const oauthMetadata = createOAuthMetadata({
    provider: nbOAuthProvider,
    issuerUrl,
    scopesSupported: ["nationbuilder"],
  });
  app.use(
    mcpAuthRouter({
      provider: nbOAuthProvider,
      issuerUrl,
      resourceServerUrl,
      scopesSupported: ["nationbuilder"],
      resourceName: "NMOGA NationBuilder",
    })
  );
  app.use(
    wellKnownAliasRouter({
      oauthMetadata,
      resourceServerUrl,
      scopesSupported: ["nationbuilder"],
      resourceName: "NMOGA NationBuilder",
    })
  );
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

  // Track active transports by session ID (Streamable HTTP)
  const streamableTransports = new Map<string, StreamableHTTPServerTransport>();
  // Last time each session was used, so idle sessions can be reaped
  const sessionLastSeen = new Map<string, number>();
  // Which userKey each live session belongs to — the session's McpServer
  // (and the NationBuilder client inside it) was built once, at session
  // creation, bound to one person's tokenGetter. Every later request on
  // that session id is re-checked against this map (see handleMcpRequest)
  // so a second, differently-authenticated caller who somehow obtains the
  // session id can't ride it to act as its original owner.
  const sessionUser = new Map<string, string>();

  // Reject new Streamable HTTP sessions beyond this — cheap insurance
  // against unbounded memory growth even with auth in front of it. Each
  // session holds a full McpServer + transport in memory for up to
  // SESSION_IDLE_MS.
  const MAX_CONCURRENT_SESSIONS = 100;
  // Per-person cap on top of the global one, so a single runaway or buggy
  // client can't consume the whole pool and 503 everyone else.
  const MAX_SESSIONS_PER_USER = 10;

  // Sessions live in memory only. Clients rarely send DELETE (Claude's connector
  // never does), so onclose alone leaves entries — and their McpServer instances —
  // behind forever. Reap anything idle past this window.
  const SESSION_IDLE_MS = 30 * 60 * 1000;

  function dropSession(sessionId: string, reason: string): void {
    const transport = streamableTransports.get(sessionId);
    streamableTransports.delete(sessionId);
    sessionLastSeen.delete(sessionId);
    sessionUser.delete(sessionId);
    if (transport) {
      console.error(`Dropping session ${sessionId} (${reason})`);
      void Promise.resolve(transport.close()).catch(() => {});
    }
  }

  setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [sessionId, lastSeen] of sessionLastSeen) {
      if (lastSeen < cutoff) dropSession(sessionId, "idle timeout");
    }
  }, 5 * 60 * 1000);

  // Mount OAuth routes. /oauth/callback is deliberately unauthenticated and
  // at its existing path: it's the redirect target NationBuilder itself
  // calls, protected instead by the CSRF state check, and moving it would
  // require updating the callback URL registered with NationBuilder.
  // /oauth/status is public but tiered — see oauth.ts.
  if (isOAuthConfigured()) {
    app.use(createOAuthRouter());
    console.error("OAuth routes enabled: /oauth/callback (unauthenticated), /oauth/status (tiered)");
  }

  // Health check — deliberately the one route left unauthenticated, so
  // Railway's health probe (which sends no credentials) keeps working.
  // Deliberately minimal: liveness only. "Who's connected and are they
  // healthy" is /oauth/status's job, not this one's.
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      name: "nmoga-nationbuilder-mcp",
      oauthConfigured: isOAuthConfigured(),
    });
  });

  /** Per-session tokenGetter: resolves this specific person's NationBuilder
   *  access token fresh on every call (never captures a token value), so a
   *  revoked/deleted user record takes effect on that person's very next
   *  request with no per-tool changes needed — every tool only ever goes
   *  through the shared NationBuilderClient, which already re-invokes this
   *  closure per request and per retry. */
  function makeUserTokenGetter(userKey: string): () => string {
    return () => {
      const token = getUserAccessToken(userKey);
      if (!token) {
        // NO_TOKEN_PREFIX is a load-bearing contract with the API client's
        // retry loop (src/client/nationbuilder.ts) — it fast-fails on this
        // exact prefix instead of burning 3 retries on a condition that
        // can't self-resolve. Never reword the opening words.
        throw new Error(
          `${NO_TOKEN_PREFIX} for this connector. Reconnect it in claude.ai: Settings → ` +
          `Connectors → remove and re-add this connector, then complete the NationBuilder login.`
        );
      }
      return token;
    };
  }

  // Streamable HTTP endpoint. requireBearerAuth validates the MCP access
  // token (src/auth/provider.ts's verifyAccessToken) and populates
  // req.auth.extra.userKey — everything downstream is scoped to that one
  // person's NationBuilder identity.
  app.all(
    "/mcp",
    requireBearerAuth({ verifier: nbOAuthProvider, requiredScopes: [], resourceMetadataUrl }),
    async (req, res) => {
      const userKey = req.auth?.extra?.userKey as string | undefined;
      if (!userKey) {
        // Should be unreachable: requireBearerAuth only calls next() after
        // verifyAccessToken() resolves, which always sets extra.userKey.
        console.error("/mcp: requireBearerAuth passed a request with no userKey — this is a bug");
        res.status(500).json({ error: "server_error" });
        return;
      }

      console.error(`Streamable HTTP ${req.method} from ${req.ip} (user ${storeUserTag(userKey)})`);

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      try {
        if (sessionId && streamableTransports.has(sessionId)) {
          // Re-verify session ownership on every request, not only at
          // creation — see the sessionUser comment above for why.
          const owner = sessionUser.get(sessionId);
          if (owner !== userKey) {
            console.error(`Session owner mismatch for ${sessionId} — rejecting`);
            reportError({
              category: "auth_error",
              message: "mcp: session owner mismatch",
              context: {
                session_owner_tag: owner ? storeUserTag(owner) : null,
                caller_tag: storeUserTag(userKey),
              },
            });
            res.status(403).json({ error: "invalid_session_owner" });
            return;
          }

          sessionLastSeen.set(sessionId, Date.now());
          // Passing req.body explicitly (undefined today, since nothing
          // here mounts a body parser on /mcp) is defence-in-depth: the SDK
          // reads the raw request stream itself only when the third arg is
          // omitted, so once any route ever adds a body parser upstream of
          // this one, an omitted third arg here would hang waiting on a
          // stream that parser already drained.
          await streamableTransports.get(sessionId)!.handleRequest(req, res, req.body);
        } else if (sessionId) {
          // Session ID we don't recognise — the server restarted, or we reaped it.
          //
          // This MUST be 404, not 400. The Streamable HTTP spec says a client that
          // gets 404 for its session ID starts a fresh session with a new
          // initialize; a 400 is instead read as a fatal protocol error, so the
          // client gives up and the connector goes dark with zero tools loaded
          // until someone reconnects it by hand. That was the "connection dropped
          // unexpectedly / no NationBuilder tools" report.
          console.error(`Unknown session ${sessionId} — telling client to re-initialize`);
          res.status(404).json({
            jsonrpc: "2.0",
            error: {
              code: -32001,
              message: "Session not found or expired. Start a new session with an initialize request.",
            },
            id: null,
          });
        } else if (req.method === "POST") {
          // Reject before spending a McpServer + transport on it — cheap
          // insurance against unbounded memory growth even with auth in front.
          if (streamableTransports.size >= MAX_CONCURRENT_SESSIONS) {
            console.error(
              `Rejecting new session — at capacity (${streamableTransports.size}/${MAX_CONCURRENT_SESSIONS})`
            );
            res.status(503).json({
              error: "server_busy",
              message: `Server is at its concurrent session limit (${MAX_CONCURRENT_SESSIONS}). Try again shortly.`,
            });
            return;
          }

          let sessionsForThisUser = 0;
          for (const owner of sessionUser.values()) {
            if (owner === userKey) sessionsForThisUser++;
          }
          if (sessionsForThisUser >= MAX_SESSIONS_PER_USER) {
            console.error(
              `Rejecting new session for ${storeUserTag(userKey)} — at per-user limit (${sessionsForThisUser}/${MAX_SESSIONS_PER_USER})`
            );
            res.status(503).json({
              error: "server_busy",
              message: `You have reached the concurrent session limit (${MAX_SESSIONS_PER_USER}) for this connector. Close another session and try again.`,
            });
            return;
          }

          // New session — first POST has no session ID (the initialize request)
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
          });

          // Set before handleRequest, not after: if the client aborts during
          // the initialize round-trip, onclose can fire while handleRequest is
          // still pending. Setting it only after handleRequest resolves would
          // leave a dead transport registered forever with nothing to clean it
          // up, since onclose already fired without a listener attached.
          transport.onclose = () => {
            console.error(`Streamable HTTP session closed: ${transport.sessionId}`);
            if (transport.sessionId) {
              streamableTransports.delete(transport.sessionId);
              sessionLastSeen.delete(transport.sessionId);
              sessionUser.delete(transport.sessionId);
            }
          };

          const server = createServer(slug, makeUserTokenGetter(userKey), {
            onUnauthorized: () => refreshUserToken(userKey),
            userTag: storeUserTag(userKey),
          });
          await server.connect(transport);

          // handleRequest processes the initialize and sets the session ID
          // in the response header automatically
          await transport.handleRequest(req, res, req.body);

          // After handleRequest, transport.sessionId is now set
          if (transport.sessionId) {
            console.error(`New Streamable HTTP session: ${transport.sessionId} (user ${storeUserTag(userKey)})`);
            streamableTransports.set(transport.sessionId, transport);
            sessionLastSeen.set(transport.sessionId, Date.now());
            sessionUser.set(transport.sessionId, userKey);
          }
        } else {
          // GET or DELETE with no session ID at all — nothing to attach to.
          // (DELETE for a live session is handled by the transport above, which
          // terminates it and fires onclose.)
          res.status(400).json({ error: "Missing Mcp-Session-Id header" });
        }
      } catch (err) {
        // Express 4 does not catch async rejections: without this, one
        // rejected await here reaches unhandledRejection and takes the whole
        // server down for every user, not just this request.
        const message = err instanceof Error ? err.message : String(err);
        console.error("/mcp handler error:", safeErr(err));
        reportError({
          category: "tool_error",
          message: `mcp_endpoint: ${message}`,
          rawError: err,
          context: {
            http_method: req.method,
            has_session_id: !!sessionId,
            sessions_open: streamableTransports.size,
            user_tag: storeUserTag(userKey),
          },
        });
        if (!res.headersSent) res.status(500).json({ error: "server_error" });
        else if (!res.writableEnded) res.end();
      }
    }
  );

  // Sweep every connected user's NationBuilder token periodically (every 15
  // minutes — was 30, halved since this now walks a whole user list
  // sequentially with a small gap between each, rather than refreshing one
  // shared token). sweepUserTokens() owns failure reporting per-user — it
  // knows *why* each refresh failed and holds its own per-user throttle
  // state. This catch only covers an unexpected throw from the sweep itself.
  setInterval(() => {
    sweepUserTokens().catch((err) => {
      console.error("Token sweep interval error:", safeErr(err));
      reportErrorThrottled({
        category: "auth_error",
        message: "token_sweep_interval: threw unexpectedly",
        rawError: err,
        throttleKey: "sweep_interval_threw",
      });
    });
  }, 15 * 60 * 1000);

  httpServer = app.listen(port, () => {
    console.error(`NMOGA NationBuilder MCP server listening on port ${port}`);
    console.error(`Streamable HTTP: http://localhost:${port}/mcp (requires a per-user NationBuilder OAuth token)`);
    console.error(`Health check: http://localhost:${port}/health`);
    if (isOAuthConfigured()) {
      const issuerBase = issuerUrl.href.replace(/\/+$/, "");
      console.error(
        `Authorization Server: ${issuerBase}/authorize, ${issuerBase}/token, ` +
        `${issuerBase}/.well-known/oauth-authorization-server (this is what gates /mcp — ` +
        `point the claude.ai connector at the bare /mcp URL; it drives the OAuth flow itself)`
      );
      console.error(`OAuth status: http://localhost:${port}/oauth/status`);
    }

    // State the persistence situation at boot. A missing volume otherwise only
    // shows up as a failed write during authorize — after someone has already
    // re-authorized and is about to lose it on the next restart.
    if (isOAuthConfigured()) {
      const store = getStoreStatus();
      if (store.writable) {
        console.error(`Token store: ${store.path} (writable — tokens will survive restarts)`);
      } else {
        console.error(
          `CRITICAL: token store not writable (${store.reason}). Every connected person's ` +
          `NationBuilder credential is in memory only — a restart will force everyone to ` +
          `reconnect their connector in claude.ai and log into NationBuilder again.`
        );
      }
    }

    // Verify our stored credentials right away rather than letting the first
    // user discover they're dead. Deliberately not awaited — the server should
    // come up and answer health checks even if NationBuilder is slow.
    if (isOAuthConfigured()) {
      bootstrapToken().catch((err) => {
        console.error("Startup token bootstrap error:", safeErr(err));
        reportErrorThrottled({
          category: "auth_error",
          message: "startup_bootstrap: threw unexpectedly",
          rawError: err,
          throttleKey: "bootstrap_threw",
        });
      });
    }
  });
}

async function startStdioServer(slug: string, staticToken: string | null): Promise<void> {
  if (!staticToken) {
    // Thrown, not exited directly — see the matching comment in validateEnv().
    throw new Error("NATIONBUILDER_ACCESS_TOKEN is required for stdio mode (OAuth is HTTP-only)");
  }
  const server = createServer(slug, staticToken);
  const transport = new StdioServerTransport();

  console.error("Starting NMOGA NationBuilder MCP server (stdio)...");
  console.error(
    "Available tools: People, Tags, Contacts, Donations, Events, Lists, Memberships, Paths, Relationships, Profiles, Petitions, Mailings, Pages, Automations, Imports"
  );

  await server.connect(transport);
}

// Set once startSseServer's app.listen() resolves, so a fatal error can stop
// accepting new HTTP work before flushing a report and exiting. Stays
// undefined in stdio mode — reportAndExit's close is then a no-op.
let httpServer: Server | undefined;

/** Upper bound on how long a fatal-path report may delay process exit. */
const REPORT_FLUSH_TIMEOUT_MS = 1500;
let exiting = false;

/**
 * Await a fatal-path report against a hard deadline, then exit. Never hangs
 * and never re-enters if a second fatal event lands mid-flush.
 *
 * Deliberately NOT `Promise.race([reportAndFlush(...), timeout])`: if that
 * timeout promise rejects, the await throws, and because this function is
 * async that becomes a rejected promise — Node doesn't await
 * uncaughtException listeners, so it lands in unhandledRejection, which
 * calls reportAndExit again, which arms another timer, forever.
 * process.exit() is never reached and the process limps on serving requests
 * instead of dying in microseconds like it does today. A `setTimeout` used
 * purely as a deadline can't reject, so that trap doesn't exist here. The
 * `exiting` guard exists because Node won't self-exit while an
 * uncaughtException listener is installed — without it, a hot error source
 * inside the window emits unbounded reports before either timer fires.
 *
 * Closes the HTTP listener before flushing so a destructive tool call that
 * hasn't started yet can't begin during the flush window — this server does
 * delete-in-a-loop tool calls, and widening the crash window from
 * microseconds to ~1.5s should shrink the blast radius, not grow it.
 */
async function reportAndExit(code: number, category: string, message: string, rawError?: unknown): Promise<void> {
  if (exiting) return;
  exiting = true;

  try {
    httpServer?.close();
  } catch {
    /* already closing/closed */
  }

  const deadline = setTimeout(() => process.exit(code), REPORT_FLUSH_TIMEOUT_MS);
  deadline.unref();

  await reportAndFlush({ category, message, rawError });
  clearTimeout(deadline);
  process.exit(code);
}

async function main(): Promise<void> {
  // Set up process handlers first, so a throw from validateEnv() below is
  // still caught by main().catch (registered at module load, below) even
  // though these listeners aren't strictly needed for that particular path.
  process.on("SIGTERM", () => {
    // Railway sends this on every redeploy — normal shutdown, not an error.
    // Do not report it; that would put one row per deploy into the digest.
    console.error("Received SIGTERM, shutting down...");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.error("Received SIGINT, shutting down...");
    process.exit(0);
  });

  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    void reportAndExit(1, "uncaught_exception", error instanceof Error ? error.message : String(error), error);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
    void reportAndExit(1, "unhandled_rejection", reason instanceof Error ? reason.message : String(reason), reason);
  });

  const { slug, staticToken } = validateEnv();

  // If PORT is set, use Streamable HTTP (Railway deployment) — per-user
  // NationBuilder OAuth only; validateEnv() already refused to boot if a
  // static/env token is set alongside it. Otherwise, use stdio transport
  // (local Claude Desktop), which still needs the static token directly.
  if (process.env.PORT) {
    await startSseServer(slug);
  } else {
    await startStdioServer(slug, staticToken);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  void reportAndExit(1, "startup_error", `fatal: ${error instanceof Error ? error.message : String(error)}`, error);
});
