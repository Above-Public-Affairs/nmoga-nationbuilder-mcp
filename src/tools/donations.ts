/**
 * Donation tools for NationBuilder
 * - list_donations: List/filter donations
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { DonationAttributes, QueryParams } from "../types/index.js";
import { formatDonation, paginatedResult, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerDonationTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "list_donations",
    "List donations in NationBuilder with optional filtering by date or amount.",
    {
      since: z
        .string()
        .optional()
        .describe("Donations after this date (YYYY-MM-DD)"),
      until: z
        .string()
        .optional()
        .describe("Donations before this date (YYYY-MM-DD)"),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Results per page"),
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
          sort: "-succeeded_at",
          include: "signup",
        };

        const filter: Record<string, string | Record<string, string>> = {};

        if (params.since) {
          filter.succeeded_at = { ...(filter.succeeded_at as Record<string, string> || {}), gte: params.since };
        }
        if (params.until) {
          filter.succeeded_at = { ...(filter.succeeded_at as Record<string, string> || {}), lte: params.until };
        }

        if (Object.keys(filter).length > 0) {
          queryParams.filter = filter;
        }

        const response = await client.get<DonationAttributes>("donations", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No donations found matching your criteria." }],
          };
        }

        let result = `Donations:\n\n`;
        for (const donation of response.data) {
          // Try to find donor name from included signups
          let donorInfo = "";
          if (donation.relationships?.signup?.data && response.included) {
            const rel = donation.relationships.signup.data;
            if (!Array.isArray(rel)) {
              const signup = response.included.find(
                (r) => r.type === "signups" && r.id === rel.id
              );
              if (signup) {
                const attrs = signup.attributes as Record<string, unknown>;
                const name = attrs.full_name || [attrs.first_name, attrs.last_name].filter(Boolean).join(" ");
                if (name) donorInfo = `  Donor: ${name} (ID: ${rel.id})\n`;
              }
            }
          }
          result += formatDonation(donation) + "\n";
          if (donorInfo) result += donorInfo;
          result += "\n";
        }
        return {
          content: [{ type: "text" as const, text: sanitizeText(paginatedResult(result, response, params.page_number, params.page_size)) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_donations failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing donations: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

}
