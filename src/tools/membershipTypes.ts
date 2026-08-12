/**
 * Membership Type tools for NationBuilder
 * - list_membership_types: List all membership types
 * - get_membership_type: Get type details
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { MembershipTypeAttributes, QueryParams } from "../types/index.js";
import { formatMembershipType, paginatedResult, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerMembershipTypeTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.registerTool(
    "list_membership_types",
    {
      title: "List Membership Types",
      description: "List all membership types/tiers in NationBuilder.",
      inputSchema: {
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
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const queryParams: QueryParams = {
          page_size: params.page_size,
          page_number: params.page_number,
        };

        const response = await client.get<MembershipTypeAttributes>("membership_types", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No membership types found." }],
          };
        }

        let result = `Membership Types:\n\n`;
        for (const mt of response.data) {
          result += formatMembershipType(mt) + "\n\n";
        }
        return {
          content: [{ type: "text" as const, text: sanitizeText(paginatedResult(result, response, params.page_number, params.page_size)) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_membership_types failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing membership types: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.registerTool(
    "get_membership_type",
    {
      title: "Get Membership Type",
      description: "Get full details for a specific membership type by its NationBuilder ID.",
      inputSchema: {
        membership_type_id: z.string().describe("The NationBuilder membership type ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const response = await client.getById<MembershipTypeAttributes>(
          "membership_types",
          params.membership_type_id
        );

        const result = formatMembershipType(response.data);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "get_membership_type failed", rawError: error, context: { membership_type_id: params.membership_type_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error getting membership type: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
