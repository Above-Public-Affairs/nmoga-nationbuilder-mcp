/**
 * Identity Mapping tools for NationBuilder
 * - list_identity_mappings: List cross-system ID mappings for a person
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { IdentityMappingAttributes, QueryParams } from "../types/index.js";
import { formatIdentityMapping, formatPagination, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerIdentityMappingTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "list_identity_mappings",
    "List identity mappings (cross-system ID links) for a person in NationBuilder. Shows external IDs from other systems linked to this signup.",
    {
      signup_id: z.string().describe("The NationBuilder signup ID"),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Results per page (max 100)"),
      page_number: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Page number"),
    },
    async (params) => {
      try {
        const queryParams: QueryParams = {
          page_size: params.page_size,
          page_number: params.page_number,
          filter: { signup_id: params.signup_id },
        };

        const response = await client.get<IdentityMappingAttributes>(
          "identity_mappings",
          queryParams
        );

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No identity mappings found for person ${params.signup_id}.` }],
          };
        }

        let result = `Identity mappings for person ${params.signup_id}:\n\n`;
        for (const mapping of response.data) {
          result += formatIdentityMapping(mapping) + "\n\n";
        }
        result += formatPagination(response, params.page_number, params.page_size);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_identity_mappings failed", rawError: error, context: { signup_id: params.signup_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing identity mappings: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
