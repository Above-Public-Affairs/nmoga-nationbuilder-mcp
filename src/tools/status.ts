/**
 * Connection/auth status introspection for NationBuilder
 * - connection_status: Report the MCP server's own auth state (not a NationBuilder resource)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAuthStatus } from "../oauth.js";

export function registerStatusTools(server: McpServer): void {
  server.registerTool(
    "connection_status",
    {
      title: "Check NationBuilder Connection Status",
      description:
        "Report the MCP server's current NationBuilder auth state: which auth method is active (OAuth vs. a static token), OAuth token expiry and whether a refresh token is present, and whether the token store is writable. Use this first when NationBuilder tool calls start failing to see whether the problem is auth-related.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const status = getAuthStatus();

      const lines: string[] = [];
      lines.push(`Active auth method: ${status.activeMethod}`);
      lines.push(`OAuth configured: ${status.oauthConfigured ? "yes" : "no"}`);
      lines.push(`Has OAuth token: ${status.hasOAuthToken ? "yes" : "no"}`);
      lines.push(`Has static token (NATIONBUILDER_ACCESS_TOKEN): ${status.hasStaticToken ? "yes" : "no"}`);
      lines.push(
        `Token expiry: ${status.tokenExpiry ?? (status.hasOAuthToken ? "never expires" : "n/a")}`
      );
      lines.push(`Has refresh token: ${status.hasRefreshToken ? "yes" : "no"}`);
      lines.push("");
      lines.push("Token store:");
      lines.push(`  Path: ${status.tokenStore.path ?? "(none configured)"}`);
      lines.push(`  Writable: ${status.tokenStore.writable ? "yes" : "no"}`);
      if (status.tokenStore.reason) {
        lines.push(`  Reason: ${status.tokenStore.reason}`);
      }

      if (!status.hasOAuthToken && !status.hasStaticToken) {
        lines.push("");
        lines.push("No token of any kind is active — NationBuilder tool calls will fail. Visit /oauth/authorize to authorize, or set NATIONBUILDER_ACCESS_TOKEN.");
      } else if (status.hasOAuthToken && !status.hasRefreshToken) {
        lines.push("");
        lines.push("Warning: an OAuth token is active but there's no refresh token — it can't auto-renew once it expires.");
      } else if (!status.tokenStore.writable) {
        lines.push("");
        lines.push("Warning: the token store isn't writable — a freshly obtained or refreshed token won't survive the next restart.");
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );
}
