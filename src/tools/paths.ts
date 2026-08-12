/**
 * Path and Path Journey tools for NationBuilder
 * - list_paths: List all paths/workflows
 * - get_path: Get path details with steps
 * - list_path_journeys: List journeys with filters
 * - get_path_journey: Get journey details
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { PathAttributes, PathJourneyAttributes, QueryParams } from "../types/index.js";
import { formatPath, formatPathJourney, paginatedResult, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerPathTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "list_paths",
    "List all paths (workflows/pipelines) in NationBuilder.",
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

        const response = await client.get<PathAttributes>("paths", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No paths found." }],
          };
        }

        let result = `Paths:\n\n`;
        for (const path of response.data) {
          result += formatPath(path) + "\n\n";
        }
        return {
          content: [{ type: "text" as const, text: sanitizeText(paginatedResult(result, response, params.page_number, params.page_size)) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_paths failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing paths: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "get_path",
    "Get full details for a specific path by its NationBuilder ID, including steps.",
    {
      path_id: z.string().describe("The NationBuilder path ID"),
    },
    async (params) => {
      try {
        const response = await client.getById<PathAttributes>(
          "paths",
          params.path_id,
          { include: "path_steps" }
        );

        let result = formatPath(response.data);

        // Show steps from included resources
        if (response.included && response.included.length > 0) {
          const steps = response.included.filter((r) => r.type === "path_steps");
          if (steps.length > 0) {
            result += "\n\n**Steps:**\n";
            for (const step of steps) {
              const attrs = step.attributes as Record<string, unknown>;
              const name = attrs.name || `Step ${step.id}`;
              result += `  ${step.id}. ${name}\n`;
            }
          }
        }

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "get_path failed", rawError: error, context: { path_id: params.path_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error getting path: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "list_path_journeys",
    "List path journeys (people progressing through workflows) with optional filters.",
    {
      path_id: z
        .string()
        .optional()
        .describe("Filter by path ID"),
      signup_id: z
        .string()
        .optional()
        .describe("Filter by person's signup ID"),
      status: z
        .string()
        .optional()
        .describe("Filter by journey status"),
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
          include: "signup,path",
        };

        const filter: Record<string, string | Record<string, string>> = {};

        if (params.path_id) filter.path_id = params.path_id;
        if (params.signup_id) filter.signup_id = params.signup_id;
        if (params.status) filter.status = params.status;

        if (Object.keys(filter).length > 0) {
          queryParams.filter = filter;
        }

        const response = await client.get<PathJourneyAttributes>("path_journeys", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No path journeys found matching your criteria." }],
          };
        }

        let result = `Path Journeys:\n\n`;
        for (const journey of response.data) {
          result += formatPathJourney(journey, response.included) + "\n\n";
        }
        return {
          content: [{ type: "text" as const, text: sanitizeText(paginatedResult(result, response, params.page_number, params.page_size)) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_path_journeys failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing path journeys: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "get_path_journey",
    "Get full details for a specific path journey by its NationBuilder ID.",
    {
      journey_id: z.string().describe("The NationBuilder path journey ID"),
    },
    async (params) => {
      try {
        const response = await client.getById<PathJourneyAttributes>(
          "path_journeys",
          params.journey_id,
          { include: "signup,path,current_step" }
        );

        const result = formatPathJourney(response.data, response.included);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "get_path_journey failed", rawError: error, context: { journey_id: params.journey_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error getting path journey: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
