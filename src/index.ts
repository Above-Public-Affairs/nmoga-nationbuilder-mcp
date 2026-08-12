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
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import type { Server } from "node:http";
import express from "express";
import type { Request, Response } from "express";
import { createNationBuilderClient, type NationBuilderClient } from "./client/nationbuilder.js";
import { bootstrapToken, createOAuthRouter, getOAuthToken, getTokenStoreStatus, initTokenFromEnv, isOAuthConfigured, refreshTokenIfNeeded } from "./oauth.js";
import { reportError, reportErrorThrottled, reportAndFlush, safeErr } from "./utils/errorReporter.js";
import { getMcpUrlSecret, isAuthorized } from "./utils/httpAuth.js";
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

  if (!staticToken && !isOAuthConfigured()) {
    console.error(
      "Warning: No NATIONBUILDER_ACCESS_TOKEN and OAuth not configured. " +
      "Set NATIONBUILDER_ACCESS_TOKEN or configure OAuth (NATIONBUILDER_CLIENT_ID, NATIONBUILDER_CLIENT_SECRET)."
    );
    // Boots anyway, but every tool call will fail until someone sets a
    // credential — worth a row, not just a log line nobody's watching.
    reportError({
      category: "auth_error",
      message: "startup: no NATIONBUILDER_ACCESS_TOKEN and OAuth is not configured",
      context: {
        has_client_id: !!process.env.NATIONBUILDER_CLIENT_ID,
        has_callback_url: !!(process.env.NATIONBUILDER_OAUTH_CALLBACK_URL || process.env.RAILWAY_PUBLIC_DOMAIN),
      },
    });
  }

  return { slug, staticToken };
}

function createServer(client: NationBuilderClient): McpServer {
  const server = new McpServer(
    {
      name: "nmoga-nationbuilder-mcp",
      version: "1.0.0",
    },
    {
      instructions: INSTRUCTIONS,
    }
  );

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

async function startSseServer(slug: string, staticToken: string | null): Promise<void> {
  const port = parseInt(process.env.PORT || "3000", 10);
  const app = express();

  // Token getter: prefer OAuth token, fall back to static token
  const getToken = (): string => {
    const oauthToken = getOAuthToken();
    if (oauthToken) return oauthToken;
    if (staticToken) return staticToken;
    throw new Error("No access token available. Complete OAuth flow at /oauth/authorize or set NATIONBUILDER_ACCESS_TOKEN.");
  };

  // Every HTTP entry point (/mcp, /sse, /oauth/authorize, /oauth/status) is
  // gated by isAuthorized() — MCP_URL_SECRET as a URL path segment (for
  // claude.ai org connectors, which can't send custom headers) or an
  // MCP_AUTH_TOKEN Bearer header (for mcp-remote/curl/local dev). With
  // neither set, this server is unreachable by anyone — say so loudly at
  // boot rather than let it surface as a silent connector outage.
  if (!getMcpUrlSecret() && !process.env.MCP_AUTH_TOKEN) {
    console.error(
      "CRITICAL: neither MCP_URL_SECRET nor MCP_AUTH_TOKEN is set. /mcp, /sse, and " +
      "/oauth/authorize|status will reject every request. Set MCP_URL_SECRET (a long " +
      "random path segment) and point the claude.ai org connector at /mcp/<that value>."
    );
    reportError({
      category: "auth_error",
      message: "startup: no MCP_URL_SECRET and no MCP_AUTH_TOKEN — HTTP endpoints are unreachable",
    });
  } else if (!getMcpUrlSecret()) {
    console.error(
      "WARNING: MCP_URL_SECRET is not set — the secret-path routes (/mcp/<secret>, " +
      "/sse/<secret>) are disabled. Only Bearer-authenticated requests to the bare " +
      "routes will work. The claude.ai org connector cannot send a Bearer header, so " +
      "it needs MCP_URL_SECRET set and its connector URL pointed at /mcp/<that value>."
    );
  } else if (getMcpUrlSecret()!.length < 16) {
    console.error(
      "WARNING: MCP_URL_SECRET is shorter than 16 characters — use a longer random " +
      "value; a short one is guessable and defeats the point of a secret path."
    );
  }

  // One client (and therefore one RateLimiter) shared by every session in
  // this process — NationBuilder's 250-req/10s limit is per IP, not per
  // session, so building a fresh client per connection let concurrent
  // sessions each believe they had the full budget.
  const client = createNationBuilderClient(slug, getToken);

  // Track active transports by session ID (Streamable HTTP)
  const streamableTransports = new Map<string, StreamableHTTPServerTransport>();
  // Last time each session was used, so idle sessions can be reaped
  const sessionLastSeen = new Map<string, number>();
  // Track active SSE transports (legacy)
  const sseTransports = new Map<string, SSEServerTransport>();

  // Reject new Streamable HTTP sessions beyond this — cheap insurance
  // against unbounded memory growth even with auth in front of it. Each
  // session holds a full McpServer + transport in memory for up to
  // SESSION_IDLE_MS.
  const MAX_CONCURRENT_SESSIONS = 100;

  // Sessions live in memory only. Clients rarely send DELETE (Claude's connector
  // never does), so onclose alone leaves entries — and their McpServer instances —
  // behind forever. Reap anything idle past this window.
  const SESSION_IDLE_MS = 30 * 60 * 1000;

  function dropSession(sessionId: string, reason: string): void {
    const transport = streamableTransports.get(sessionId);
    streamableTransports.delete(sessionId);
    sessionLastSeen.delete(sessionId);
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

  // Mount OAuth routes. /oauth/authorize and /oauth/status are gated (see
  // requireOauthAuth in oauth.ts) — same MCP_URL_SECRET-path-or-Bearer model
  // as /mcp below. /oauth/callback is deliberately left unauthenticated and
  // at its existing path: it's the redirect target NationBuilder itself
  // calls, protected instead by the CSRF state check, and moving it would
  // require updating the callback URL registered with NationBuilder.
  if (isOAuthConfigured()) {
    app.use(createOAuthRouter());
    console.error(
      "OAuth routes enabled: /oauth/<secret>/authorize, /oauth/callback (unauthenticated), " +
      "/oauth/<secret>/status — secret is MCP_URL_SECRET, or use a Bearer MCP_AUTH_TOKEN"
    );
  }

  // Health check — deliberately the one route left unauthenticated, so
  // Railway's health probe (which sends no credentials) keeps working.
  app.get("/health", (_req, res) => {
    const oauthToken = getOAuthToken();
    res.json({
      status: "ok",
      name: "nmoga-nationbuilder-mcp",
      auth: oauthToken ? "oauth" : staticToken ? "static_token" : "none",
    });
  });

  // Shared handler for both the secret-path and bare Streamable HTTP
  // routes below — auth has already been checked by the caller.
  async function handleMcpRequest(req: Request, res: Response): Promise<void> {
    console.error(`Streamable HTTP ${req.method} from ${req.ip}`);

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      if (sessionId && streamableTransports.has(sessionId)) {
        // Existing session — route to its transport
        sessionLastSeen.set(sessionId, Date.now());
        await streamableTransports.get(sessionId)!.handleRequest(req, res);
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
          }
        };

        const server = createServer(client);
        await server.connect(transport);

        // handleRequest processes the initialize and sets the session ID
        // in the response header automatically
        await transport.handleRequest(req, res);

        // After handleRequest, transport.sessionId is now set
        if (transport.sessionId) {
          console.error(`New Streamable HTTP session: ${transport.sessionId}`);
          streamableTransports.set(transport.sessionId, transport);
          sessionLastSeen.set(transport.sessionId, Date.now());
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
        },
      });
      if (!res.headersSent) res.status(500).json({ error: "server_error" });
      else if (!res.writableEnded) res.end();
    }
  }

  // Streamable HTTP, secret-path route — the URL itself is the credential.
  // This is what the claude.ai org connector must be configured to use,
  // since it cannot send custom headers. Wrong secret -> 404, not 401: it
  // shouldn't confirm that a gated route exists at all.
  app.all("/mcp/:mcpSecret", async (req, res) => {
    if (!isAuthorized(req, req.params.mcpSecret)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await handleMcpRequest(req, res);
  });

  // Streamable HTTP, bare route — for callers that can send headers
  // (mcp-remote, curl, local dev). Requires a Bearer MCP_AUTH_TOKEN; never
  // establishes a session without one.
  app.all("/mcp", async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).json({
        error: "unauthorized",
        message: "Provide Authorization: Bearer <MCP_AUTH_TOKEN>, or use the secret-path URL.",
      });
      return;
    }
    await handleMcpRequest(req, res);
  });

  // Shared handler for the legacy SSE connect — both the secret-path and
  // bare routes below construct the transport with the messages endpoint
  // that matches how they were reached, so the client's follow-up POSTs
  // land on an equally-gated path.
  async function handleSseConnect(req: Request, res: Response, messagesPath: string): Promise<void> {
    console.error(`Legacy SSE connection from ${req.ip}`);

    const transport = new SSEServerTransport(messagesPath, res);
    const sessionId = transport.sessionId;
    sseTransports.set(sessionId, transport);

    res.on("close", () => {
      console.error(`SSE connection closed: ${sessionId}`);
      sseTransports.delete(sessionId);
    });

    try {
      const server = createServer(client);
      await server.connect(transport);
    } catch (err) {
      // server.connect() writes the SSE response head as part of
      // establishing the stream, so by the time this can throw, headers are
      // almost always already sent — never attempt a JSON 500 here.
      console.error("/sse handler error:", safeErr(err));
      reportError({
        category: "tool_error",
        message: `sse_endpoint: ${err instanceof Error ? err.message : String(err)}`,
        rawError: err,
      });
      // connect() failed, so this entry never got a live stream behind it —
      // don't wait on res's "close" event to clean it up.
      sseTransports.delete(sessionId);
      if (!res.headersSent) res.status(500).json({ error: "server_error" });
      else if (!res.writableEnded) res.end();
    }
  }

  // Shared handler for the legacy /messages POST — auth has already been
  // checked by the caller.
  async function handleSseMessage(req: Request, res: Response): Promise<void> {
    const sessionId = req.query.sessionId as string;
    const transport = sseTransports.get(sessionId);

    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    try {
      await transport.handlePostMessage(req, res);
    } catch (err) {
      // The SDK writes a 500 and ends the response before throwing here (its
      // SSE stream is already gone) — headers are always sent by this point,
      // so a second res.status(500).json(...) would throw
      // ERR_HTTP_HEADERS_SENT and crash the server a second time from
      // inside this very catch.
      console.error("/messages handler error:", safeErr(err));
      reportError({
        category: "tool_error",
        message: `messages_endpoint: ${err instanceof Error ? err.message : String(err)}`,
        rawError: err,
      });
      // The throw means the transport's stream is gone — drop the now-stale
      // entry so a retried POST to this session doesn't hit the same dead end.
      sseTransports.delete(sessionId);
      if (!res.headersSent) res.status(500).json({ error: "server_error" });
      else if (!res.writableEnded) res.end();
    }
  }

  // Legacy SSE, secret-path routes — same URL-is-the-credential model as /mcp.
  app.get("/sse/:sseSecret", async (req, res) => {
    if (!isAuthorized(req, req.params.sseSecret)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await handleSseConnect(req, res, `/sse/${req.params.sseSecret}/messages`);
  });

  app.post("/sse/:sseSecret/messages", async (req, res) => {
    if (!isAuthorized(req, req.params.sseSecret)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await handleSseMessage(req, res);
  });

  // Legacy SSE, bare routes — for header-capable callers (mcp-remote, curl,
  // local dev). Requires a Bearer MCP_AUTH_TOKEN.
  app.get("/sse", async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).json({
        error: "unauthorized",
        message: "Provide Authorization: Bearer <MCP_AUTH_TOKEN>, or use the secret-path URL.",
      });
      return;
    }
    await handleSseConnect(req, res, "/messages");
  });

  app.post("/messages", async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    await handleSseMessage(req, res);
  });

  // Refresh OAuth token periodically (every 30 minutes)
  setInterval(() => {
    // doRefresh() (called via refreshTokenIfNeeded) owns failure reporting —
    // it knows *why* refresh failed and holds its own throttle state. This
    // catch only covers an unexpected throw from the interval itself.
    refreshTokenIfNeeded().catch((err) => {
      console.error("Token refresh interval error:", safeErr(err));
      reportErrorThrottled({
        category: "auth_error",
        message: "token_refresh_interval: threw unexpectedly",
        rawError: err,
        throttleKey: "refresh_interval_threw",
      });
    });
  }, 30 * 60 * 1000);

  httpServer = app.listen(port, () => {
    console.error(`NMOGA NationBuilder MCP server listening on port ${port}`);
    // Never print MCP_URL_SECRET's value — these lines say where the gated
    // routes live, not what unlocks them. See the MCP_URL_SECRET/
    // MCP_AUTH_TOKEN warnings logged above for whether anything can reach them.
    console.error(`Streamable HTTP (secret path): http://localhost:${port}/mcp/<MCP_URL_SECRET>`);
    console.error(`Streamable HTTP (bare, Bearer-gated): http://localhost:${port}/mcp`);
    console.error(`Legacy SSE (secret path): http://localhost:${port}/sse/<MCP_URL_SECRET>`);
    console.error(`Legacy SSE (bare, Bearer-gated): http://localhost:${port}/sse`);
    console.error(`Health check: http://localhost:${port}/health`);
    if (isOAuthConfigured()) {
      console.error(`OAuth (gated): http://localhost:${port}/oauth/<MCP_URL_SECRET>/authorize`);
    }

    // State the persistence situation at boot. A missing volume otherwise only
    // shows up as a failed write during authorize — after someone has already
    // re-authorized and is about to lose it on the next restart.
    if (isOAuthConfigured()) {
      const store = getTokenStoreStatus();
      if (store.writable) {
        console.error(`Token store: ${store.path} (writable — tokens will survive restarts)`);
      } else {
        console.error(
          `CRITICAL: token store not writable (${store.reason}). Tokens will be ` +
          `in memory only and every restart will require re-running /oauth/authorize.`
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
  const client = createNationBuilderClient(slug, staticToken);
  const server = createServer(client);
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

  // Hydrate OAuth token from env vars (if persisted from prior session)
  if (isOAuthConfigured()) {
    initTokenFromEnv();
  }

  // If PORT is set, use SSE transport (Railway deployment)
  // Otherwise, use stdio transport (local Claude Desktop)
  if (process.env.PORT) {
    await startSseServer(slug, staticToken);
  } else {
    await startStdioServer(slug, staticToken);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  void reportAndExit(1, "startup_error", `fatal: ${error instanceof Error ? error.message : String(error)}`, error);
});
