/**
 * Import tools for NationBuilder
 * - list_imports: List data imports
 * - get_import: Get import details
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { ImportAttributes, QueryParams } from "../types/index.js";
import { formatImport, formatPagination, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerImportTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "list_imports",
    "List data imports in NationBuilder with optional status filter.",
    {
      status: z
        .string()
        .optional()
        .describe("Filter by import status"),
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

        if (params.status) {
          queryParams.filter = { status: params.status };
        }

        const response = await client.get<ImportAttributes>("imports", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No imports found." }],
          };
        }

        let result = `Imports:\n\n`;
        for (const imp of response.data) {
          result += formatImport(imp) + "\n\n";
        }
        result += formatPagination(response, params.page_number, params.page_size);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_imports failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing imports: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "get_import",
    "Get full details for a specific data import by its NationBuilder ID.",
    {
      import_id: z.string().describe("The NationBuilder import ID"),
    },
    async (params) => {
      try {
        const response = await client.getById<ImportAttributes>(
          "imports",
          params.import_id
        );

        const result = formatImport(response.data);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "get_import failed", rawError: error, context: { import_id: params.import_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error getting import: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
