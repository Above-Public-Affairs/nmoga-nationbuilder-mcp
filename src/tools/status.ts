/**
 * Connection/auth status introspection for NationBuilder
 * - connection_status: Report the CALLER'S OWN NationBuilder auth state
 *   (not a NationBuilder resource, and not server-wide — there is no single
 *   server-wide auth state anymore now that each person authenticates
 *   independently; see src/auth/store.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getUser } from "../auth/store.js";

/**
 * `userKey` is bound at session-creation time (see createServer() in
 * index.ts) to whichever person's bearer token authenticated this specific
 * MCP session — the same identity every tool call in this session already
 * runs under. This tool exists so that identity is checkable from inside a
 * chat, not just via the unauthenticated-baseline `/oauth/status` HTTP route.
 */
export function registerStatusTools(server: McpServer, userKey: string): void {
  server.registerTool(
    "connection_status",
    {
      title: "Check Your NationBuilder Connection Status",
      description:
        "Report YOUR OWN NationBuilder connection state for this session: your display label (if known), token expiry, whether your refresh chain is healthy, and whether you need to reconnect. Use this first when your NationBuilder tool calls start failing to see whether the problem is auth-related. This reports only your own connection — every person connects independently now, there is no shared server-wide token.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const user = getUser(userKey);
      const lines: string[] = [];

      if (!user || user.revoked) {
        lines.push("No active NationBuilder connection for this session.");
        lines.push(
          "Reconnect in claude.ai: Settings → Connectors → remove and re-add this connector, " +
          "then complete the NationBuilder login."
        );
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      lines.push(`Label: ${user.label ?? "(unknown — the identity probe didn't resolve a name)"}`);
      lines.push(`Token expiry: ${user.expiresAt ? new Date(user.expiresAt).toISOString() : "unknown"}`);
      lines.push(`Has refresh token: ${user.refreshToken ? "yes" : "no"}`);
      lines.push(`Refresh healthy: ${user.refreshHealthy ? "yes" : "no"}`);
      lines.push(`Needs re-authorization: ${user.needsReauth ? "yes" : "no"}`);

      if (!user.refreshToken) {
        lines.push("");
        lines.push("Warning: no refresh token — your connection can't auto-renew once the current token expires.");
      } else if (user.needsReauth || !user.refreshHealthy) {
        lines.push("");
        lines.push(
          "Warning: your NationBuilder connection needs attention. Reconnect in claude.ai: " +
          "Settings → Connectors → remove and re-add this connector, then complete the NationBuilder login."
        );
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );
}
