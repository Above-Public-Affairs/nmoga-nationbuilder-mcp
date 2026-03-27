/**
 * Signup Source tools for NationBuilder
 * - list_signup_sources: List sources for a person (where they came from)
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { SignupSourceAttributes, QueryParams } from "../types/index.js";
import { formatSignupSource, formatPagination, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerSignupSourceTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "list_signup_sources",
    "List signup sources for a person in NationBuilder — shows where/how they were added to the database.",
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
          sort: "-created_at",
        };

        const response = await client.get<SignupSourceAttributes>(
          "signup_sources",
          queryParams
        );

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No signup sources found for person ${params.signup_id}.` }],
          };
        }

        let result = `Signup sources for person ${params.signup_id}:\n\n`;
        for (const source of response.data) {
          result += formatSignupSource(source) + "\n\n";
        }
        result += formatPagination(response, params.page_number, params.page_size);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_signup_sources failed", rawError: error, context: { signup_id: params.signup_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing signup sources: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
