/**
 * Event tools for NationBuilder
 * - list_events: List events with date filtering
 * - get_event: Get event details
 * - list_event_rsvps: List RSVPs for an event
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { EventAttributes, EventRsvpAttributes, QueryParams } from "../types/index.js";
import { formatEvent, formatRsvp, formatPagination, sanitizeText } from "../utils/formatting.js";

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
          sort: "-starts_at",
        };

        const filter: Record<string, string | Record<string, string>> = {};

        if (params.starts_after) {
          filter.starts_at = { ...(filter.starts_at as Record<string, string> || {}), gte: params.starts_after };
        }
        if (params.starts_before) {
          filter.starts_at = { ...(filter.starts_at as Record<string, string> || {}), lte: params.starts_before };
        }

        if (Object.keys(filter).length > 0) {
          queryParams.filter = filter;
        }

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
        result += formatPagination(response, params.page_number, params.page_size);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing events: ${error instanceof Error ? error.message : String(error)}` }],
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
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error getting event: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "list_event_rsvps",
    "List RSVPs for a specific event in NationBuilder.",
    {
      event_id: z.string().describe("The NationBuilder event ID"),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
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
          include: "signup",
        };

        const response = await client.get<EventRsvpAttributes>(
          `events/${params.event_id}/rsvps`,
          queryParams
        );

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No RSVPs found for event ${params.event_id}.` }],
          };
        }

        let result = `RSVPs for event ${params.event_id}:\n\n`;
        for (const rsvp of response.data) {
          result += formatRsvp(rsvp, response.included) + "\n\n";
        }
        result += formatPagination(response, params.page_number, params.page_size);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing RSVPs: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
