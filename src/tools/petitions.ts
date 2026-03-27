/**
 * Petition tools for NationBuilder
 * - list_petitions: List all petitions
 * - get_petition: Get petition details
 * - list_petition_signatures: List signatures with filters
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { PetitionAttributes, PetitionSignatureAttributes, QueryParams } from "../types/index.js";
import { formatPetition, formatPetitionSignature, formatPagination, sanitizeText } from "../utils/formatting.js";
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

  server.tool(
    "list_petition_signatures",
    "List petition signatures in NationBuilder, optionally filtered by petition or person.",
    {
      petition_id: z
        .string()
        .optional()
        .describe("Filter by petition ID"),
      signup_id: z
        .string()
        .optional()
        .describe("Filter by signer's signup ID"),
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
          include: "signup",
        };

        const filter: Record<string, string | Record<string, string>> = {};

        if (params.petition_id) filter.petition_page_id = params.petition_id;
        if (params.signup_id) filter.signup_id = params.signup_id;

        if (Object.keys(filter).length > 0) {
          queryParams.filter = filter;
        }

        const response = await client.get<PetitionSignatureAttributes>("petition_signatures", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No petition signatures found matching your criteria." }],
          };
        }

        let result = `Petition Signatures:\n\n`;
        for (const sig of response.data) {
          result += formatPetitionSignature(sig, response.included) + "\n\n";
        }
        result += formatPagination(response, params.page_number, params.page_size);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_petition_signatures failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing petition signatures: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
