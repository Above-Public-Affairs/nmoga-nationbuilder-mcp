/**
 * Page and Site tools for NationBuilder
 * - list_pages: List website/landing pages
 * - get_page: Get page details
 * - list_sites: List sites
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { PageAttributes, SiteAttributes, QueryParams } from "../types/index.js";
import { formatPage, formatSite, paginatedResult, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerPageTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.registerTool(
    "list_pages",
    {
      title: "List Pages",
      description:
        "List website and landing pages in NationBuilder. Filterable by status only. " +
        "Does not support filtering by page type — `page_type` is not a filterable " +
        "attribute on NationBuilder's V2 `pages` resource (it 400s: \"Tried to filter on " +
        "attribute :page_type, but could not find an attribute with that name\"), and V2 " +
        "does not return it on the record either, so it has been removed rather than " +
        "shipped broken.",
      inputSchema: {
        status: z
          .string()
          .optional()
          .describe("Filter by page status (e.g. 'published', 'unlisted')"),
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

        const filter: Record<string, string | Record<string, string>> = {};

        // Only `status` here. A `page_type` filter was removed: NationBuilder's
        // V2 PageResource rejects it outright with a 400 rather than ignoring
        // it, so every call that passed it was a hard failure. Same class of
        // bug as the state/city/has_email/has_phone params removed from
        // search_people — see the note in tools/signups.ts.
        if (params.status) filter.status = params.status;

        if (Object.keys(filter).length > 0) {
          queryParams.filter = filter;
        }

        const response = await client.get<PageAttributes>("pages", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No pages found matching your criteria." }],
          };
        }

        let result = `Pages:\n\n`;
        for (const page of response.data) {
          result += formatPage(page) + "\n\n";
        }
        return {
          content: [{ type: "text" as const, text: sanitizeText(paginatedResult(result, response, params.page_number, params.page_size)) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_pages failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing pages: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.registerTool(
    "get_page",
    {
      title: "Get Page",
      description: "Get full details for a specific page by its NationBuilder ID.",
      inputSchema: {
        page_id: z.string().describe("The NationBuilder page ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const response = await client.getById<PageAttributes>(
          "pages",
          params.page_id
        );

        const result = formatPage(response.data);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "get_page failed", rawError: error, context: { page_id: params.page_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error getting page: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.registerTool(
    "list_sites",
    {
      title: "List Sites",
      description: "List all sites in NationBuilder.",
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

        const response = await client.get<SiteAttributes>("sites", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No sites found." }],
          };
        }

        let result = `Sites:\n\n`;
        for (const site of response.data) {
          result += formatSite(site) + "\n\n";
        }
        return {
          content: [{ type: "text" as const, text: sanitizeText(paginatedResult(result, response, params.page_number, params.page_size)) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_sites failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing sites: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
