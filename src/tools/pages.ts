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
  server.tool(
    "list_pages",
    "List website and landing pages in NationBuilder with optional filters.",
    {
      page_type: z
        .string()
        .optional()
        .describe("Filter by page type (e.g. 'basic', 'event', 'petition', 'donation', 'survey')"),
      status: z
        .string()
        .optional()
        .describe("Filter by page status"),
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

        const filter: Record<string, string | Record<string, string>> = {};

        if (params.page_type) filter.page_type = params.page_type;
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

  server.tool(
    "get_page",
    "Get full details for a specific page by its NationBuilder ID.",
    {
      page_id: z.string().describe("The NationBuilder page ID"),
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

  server.tool(
    "list_sites",
    "List all sites in NationBuilder.",
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
