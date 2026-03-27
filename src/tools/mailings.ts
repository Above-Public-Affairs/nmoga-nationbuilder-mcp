/**
 * Mailing/Broadcaster tools for NationBuilder
 * - list_mailings: List email blasts/mailings
 * - get_mailing: Get mailing details
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { MailingAttributes, QueryParams } from "../types/index.js";
import { formatMailing, formatPagination, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerMailingTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "list_mailings",
    "List email mailings/blasts in NationBuilder with optional filters.",
    {
      status: z
        .string()
        .optional()
        .describe("Filter by mailing status (e.g. 'draft', 'sent', 'queued')"),
      since: z
        .string()
        .optional()
        .describe("Mailings sent on or after this date (YYYY-MM-DD)"),
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
          sort: "-created_at",
        };

        const filter: Record<string, string | Record<string, string>> = {};

        if (params.status) filter.status = params.status;
        if (params.since) filter.sent_at = { gte: params.since };

        if (Object.keys(filter).length > 0) {
          queryParams.filter = filter;
        }

        const response = await client.get<MailingAttributes>("mailings", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No mailings found matching your criteria." }],
          };
        }

        let result = `Mailings:\n\n`;
        for (const mailing of response.data) {
          result += formatMailing(mailing) + "\n\n";
        }
        result += formatPagination(response, params.page_number, params.page_size);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_mailings failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing mailings: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "get_mailing",
    "Get full details for a specific mailing by its NationBuilder ID.",
    {
      mailing_id: z.string().describe("The NationBuilder mailing ID"),
    },
    async (params) => {
      try {
        const response = await client.getById<MailingAttributes>(
          "mailings",
          params.mailing_id
        );

        const result = formatMailing(response.data);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "get_mailing failed", rawError: error, context: { mailing_id: params.mailing_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error getting mailing: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
