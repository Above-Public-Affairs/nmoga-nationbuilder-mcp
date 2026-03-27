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
import { registerSignupTools } from "./tools/signups.js";
import { registerTagTools } from "./tools/tags.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerDonationTools } from "./tools/donations.js";
import { registerEventTools } from "./tools/events.js";
import { registerListTools } from "./tools/lists.js";

// CRITICAL: Never use console.log() - it corrupts JSON-RPC on stdout
// Always use console.error() for any logging/debugging

function validateEnv(): { slug: string; token: string } {
  const slug = process.env.NATIONBUILDER_SLUG;
  const token = process.env.NATIONBUILDER_ACCESS_TOKEN;

  if (!slug) {
    console.error("Error: NATIONBUILDER_SLUG environment variable is required");
    process.exit(1);
  }

  if (!token) {
    console.error(
      "Error: NATIONBUILDER_ACCESS_TOKEN environment variable is required"
    );
    process.exit(1);
  }

  return { slug, token };
}

function createServer(
  slug: string,
  token: string
): McpServer {
  const server = new McpServer({
    name: "nmoga-nationbuilder-mcp",
    version: "1.0.0",
  });

  const client = createNationBuilderClient(slug, token);

  // Register all tools
  registerSignupTools(server, client);
  registerTagTools(server, client);
  registerContactTools(server, client);
  registerDonationTools(server, client);
  registerEventTools(server, client);
  registerListTools(server, client);

  return server;
}

async function startSseServer(slug: string, token: string): Promise<void> {
  const port = parseInt(process.env.PORT || "3000", 10);
  const app = express();
  app.use(express.json());

  // Track active transports by session ID (Streamable HTTP)
  const streamableTransports = new Map<string, StreamableHTTPServerTransport>();
  // Track active SSE transports (legacy)
  const sseTransports = new Map<string, SSEServerTransport>();

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", name: "nmoga-nationbuilder-mcp" });
  });

  // Streamable HTTP endpoint — modern mcp-remote uses this
  app.all("/mcp", async (req, res) => {
    console.error(`Streamable HTTP ${req.method} from ${req.ip}`);

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST" && !sessionId) {
      // New session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const id = transport.sessionId ?? randomUUID();
      streamableTransports.set(id, transport);

      const server = createServer(slug, token);
      await server.connect(transport);

      res.setHeader("mcp-session-id", id);
      await transport.handleRequest(req, res);

      res.on("close", () => {
        console.error(`Streamable HTTP session closed: ${id}`);
        streamableTransports.delete(id);
      });
    } else if (sessionId && streamableTransports.has(sessionId)) {
      await streamableTransports.get(sessionId)!.handleRequest(req, res);
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

    const server = createServer(slug, token);

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

  app.listen(port, () => {
    console.error(`NMOGA NationBuilder MCP server listening on port ${port}`);
    console.error(`Streamable HTTP: http://localhost:${port}/mcp`);
    console.error(`Legacy SSE: http://localhost:${port}/sse`);
    console.error(`Health check: http://localhost:${port}/health`);
  });
}

async function startStdioServer(slug: string, token: string): Promise<void> {
  const server = createServer(slug, token);
  const transport = new StdioServerTransport();

  console.error("Starting NMOGA NationBuilder MCP server (stdio)...");
  console.error(
    "Available tools: People, Tags, Contacts, Donations, Events, Lists"
  );

  await server.connect(transport);
}

async function main(): Promise<void> {
  const { slug, token } = validateEnv();

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

  // If PORT is set, use SSE transport (Railway deployment)
  // Otherwise, use stdio transport (local Claude Desktop)
  if (process.env.PORT) {
    await startSseServer(slug, token);
  } else {
    await startStdioServer(slug, token);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
