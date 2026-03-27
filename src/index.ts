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
import express from "express";
import { createNationBuilderClient } from "./client/nationbuilder.js";
import { createOAuthRouter, getOAuthToken, initTokenFromEnv, isOAuthConfigured, refreshTokenIfNeeded } from "./oauth.js";
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
import { registerSignupSourceTools } from "./tools/signupSources.js";
import { registerIdentityMappingTools } from "./tools/identityMappings.js";

// CRITICAL: Never use console.log() - it corrupts JSON-RPC on stdout
// Always use console.error() for any logging/debugging

function validateEnv(): { slug: string; staticToken: string | null } {
  const slug = process.env.NATIONBUILDER_SLUG;
  const staticToken = process.env.NATIONBUILDER_ACCESS_TOKEN || null;

  if (!slug) {
    console.error("Error: NATIONBUILDER_SLUG environment variable is required");
    process.exit(1);
  }

  if (!staticToken && !isOAuthConfigured()) {
    console.error(
      "Warning: No NATIONBUILDER_ACCESS_TOKEN and OAuth not configured. " +
      "Set NATIONBUILDER_ACCESS_TOKEN or configure OAuth (NATIONBUILDER_CLIENT_ID, NATIONBUILDER_CLIENT_SECRET)."
    );
  }

  return { slug, staticToken };
}

function createServer(
  slug: string,
  tokenGetter: string | (() => string)
): McpServer {
  const server = new McpServer({
    name: "nmoga-nationbuilder-mcp",
    version: "1.0.0",
  });

  const client = createNationBuilderClient(slug, tokenGetter);

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
  registerSignupSourceTools(server, client);
  registerIdentityMappingTools(server, client);

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

  // Track active transports by session ID (Streamable HTTP)
  const streamableTransports = new Map<string, StreamableHTTPServerTransport>();
  // Track active SSE transports (legacy)
  const sseTransports = new Map<string, SSEServerTransport>();

  // Mount OAuth routes
  if (isOAuthConfigured()) {
    app.use(createOAuthRouter());
    console.error("OAuth routes enabled: /oauth/authorize, /oauth/callback, /oauth/status");
  }

  // Health check
  app.get("/health", (_req, res) => {
    const oauthToken = getOAuthToken();
    res.json({
      status: "ok",
      name: "nmoga-nationbuilder-mcp",
      auth: oauthToken ? "oauth" : staticToken ? "static_token" : "none",
    });
  });

  // Streamable HTTP endpoint — modern mcp-remote uses this
  app.all("/mcp", async (req, res) => {
    console.error(`Streamable HTTP ${req.method} from ${req.ip}`);

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && streamableTransports.has(sessionId)) {
      // Existing session — route to its transport
      await streamableTransports.get(sessionId)!.handleRequest(req, res);
    } else if (req.method === "POST" && !sessionId) {
      // New session — first POST has no session ID (the initialize request)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      const server = createServer(slug, getToken);
      await server.connect(transport);

      // handleRequest processes the initialize and sets the session ID
      // in the response header automatically
      await transport.handleRequest(req, res);

      // After handleRequest, transport.sessionId is now set
      if (transport.sessionId) {
        console.error(`New Streamable HTTP session: ${transport.sessionId}`);
        streamableTransports.set(transport.sessionId, transport);

        transport.onclose = () => {
          console.error(`Streamable HTTP session closed: ${transport.sessionId}`);
          if (transport.sessionId) {
            streamableTransports.delete(transport.sessionId);
          }
        };
      }
    } else if (req.method === "DELETE" && sessionId) {
      // Session cleanup
      const transport = streamableTransports.get(sessionId);
      if (transport) {
        await transport.handleRequest(req, res);
        streamableTransports.delete(sessionId);
      } else {
        res.status(404).json({ error: "Session not found" });
      }
    } else {
      res.status(400).json({ error: "Invalid or missing session ID" });
    }
  });

  // Legacy SSE endpoint — fallback for older clients
  app.get("/sse", async (req, res) => {
    console.error(`Legacy SSE connection from ${req.ip}`);

    const transport = new SSEServerTransport("/messages", res);
    const sessionId = transport.sessionId;
    sseTransports.set(sessionId, transport);

    const server = createServer(slug, getToken);

    res.on("close", () => {
      console.error(`SSE connection closed: ${sessionId}`);
      sseTransports.delete(sessionId);
    });

    await server.connect(transport);
  });

  // Legacy messages endpoint
  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = sseTransports.get(sessionId);

    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    await transport.handlePostMessage(req, res);
  });

  // Refresh OAuth token periodically (every 30 minutes)
  setInterval(() => {
    refreshTokenIfNeeded().catch((err) =>
      console.error("Token refresh interval error:", err)
    );
  }, 30 * 60 * 1000);

  app.listen(port, () => {
    console.error(`NMOGA NationBuilder MCP server listening on port ${port}`);
    console.error(`Streamable HTTP: http://localhost:${port}/mcp`);
    console.error(`Legacy SSE: http://localhost:${port}/sse`);
    console.error(`Health check: http://localhost:${port}/health`);
    if (isOAuthConfigured()) {
      console.error(`OAuth: http://localhost:${port}/oauth/authorize`);
    }
  });
}

async function startStdioServer(slug: string, staticToken: string | null): Promise<void> {
  if (!staticToken) {
    console.error("Error: NATIONBUILDER_ACCESS_TOKEN is required for stdio mode (OAuth is HTTP-only)");
    process.exit(1);
  }
  const server = createServer(slug, staticToken);
  const transport = new StdioServerTransport();

  console.error("Starting NMOGA NationBuilder MCP server (stdio)...");
  console.error(
    "Available tools: People, Tags, Contacts, Donations, Events, Lists, Memberships, Paths, Relationships, Profiles, Petitions, Mailings, Pages, Automations, Imports"
  );

  await server.connect(transport);
}

async function main(): Promise<void> {
  const { slug, staticToken } = validateEnv();

  // Set up process handlers
  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.error("Received SIGINT, shutting down...");
    process.exit(0);
  });

  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
    process.exit(1);
  });

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
  process.exit(1);
});
