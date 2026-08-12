/**
 * Event tools for NationBuilder
 * - list_events: List events
 * - get_event: Get event details
 * - list_event_rsvps: List RSVPs for an event
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { EventAttributes, EventRsvpAttributes, QueryParams } from "../types/index.js";
import { formatEvent, formatRsvp, paginatedResult, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerEventTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "list_events",
    "List events in NationBuilder with optional date filtering.",
    {
      starts_after: z
        .string()
        .optional()
        .describe("Events starting after this date (YYYY-MM-DD)"),
      starts_before: z
        .string()
        .optional()
        .describe("Events starting before this date (YYYY-MM-DD)"),
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
        };

        const response = await client.get<EventAttributes>("events", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No events found matching your criteria." }],
          };
        }

        let result = `Events:\n\n`;
        for (const event of response.data) {
          result += formatEvent(event) + "\n\n";
        }
        return {
          content: [{ type: "text" as const, text: sanitizeText(paginatedResult(result, response, params.page_number, params.page_size)) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_events failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing events: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "list_event_rsvps",
    "List RSVPs for a specific event in NationBuilder.",
    {
      event_id: z.string().describe("The NationBuilder event ID"),
      page_size: z.number().int().min(1).max(100).default(50).describe("Results per page"),
      page_number: z.number().int().min(1).default(1).describe("Page number"),
    },
    async (params) => {
      try {
        const queryParams: QueryParams = {
          page_size: params.page_size,
          page_number: params.page_number,
          filter: { event_id: params.event_id },
          include: "signup",
        };

        const response = await client.get<EventRsvpAttributes>("event_rsvps", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No RSVPs found for event ${params.event_id}.` }],
          };
        }

        let result = `RSVPs for event ${params.event_id}:\n\n`;
        for (const rsvp of response.data) {
          result += formatRsvp(rsvp, response.included) + "\n\n";
        }
        return {
          content: [{ type: "text" as const, text: sanitizeText(paginatedResult(result, response, params.page_number, params.page_size)) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_event_rsvps failed", rawError: error, context: { event_id: params.event_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing RSVPs: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "get_event",
    "Get full details for a specific event by its NationBuilder ID.",
    {
      event_id: z.string().describe("The NationBuilder event ID"),
    },
    async (params) => {
      try {
        const response = await client.getById<EventAttributes>(
          "events",
          params.event_id
        );

        const result = formatEvent(response.data);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "get_event failed", rawError: error, context: { event_id: params.event_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error getting event: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

}
