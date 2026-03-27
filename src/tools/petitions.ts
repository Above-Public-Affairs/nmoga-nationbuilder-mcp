/**
 * Petition tools for NationBuilder
 * - list_petitions: List all petitions
 * - get_petition: Get petition details
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { PetitionAttributes, QueryParams } from "../types/index.js";
import { formatPetition, formatPagination, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerPetitionTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "list_petitions",
    "List all petitions in NationBuilder.",
    {
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
        };

        const response = await client.get<PetitionAttributes>("petitions", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No petitions found." }],
          };
        }

        let result = `Petitions:\n\n`;
        for (const petition of response.data) {
          result += formatPetition(petition) + "\n\n";
        }
        result += formatPagination(response, params.page_number, params.page_size);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_petitions failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing petitions: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "get_petition",
    "Get full details for a specific petition by its NationBuilder ID.",
    {
      petition_id: z.string().describe("The NationBuilder petition ID"),
    },
    async (params) => {
      try {
        const response = await client.getById<PetitionAttributes>(
          "petitions",
          params.petition_id
        );

        const result = formatPetition(response.data);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "get_petition failed", rawError: error, context: { petition_id: params.petition_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error getting petition: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

}
