/**
 * List/Segment tools for NationBuilder
 * - list_lists: List all saved lists/segments
 * - get_list_people: Get people in a specific list
 * - create_list: Create a new list/segment
 * - add_person_to_list: Add a person/signup to a list
 * - remove_person_from_list: Remove a person/signup from a list
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { ListAttributes, SignupAttributes, QueryParams } from "../types/index.js";
import { formatList, formatSignup, paginatedResult, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerListTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "list_lists",
    "List all saved lists/segments in NationBuilder.",
    {
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
          sort: "-created_at",
        };

        const response = await client.get<ListAttributes>("lists", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No lists found." }],
          };
        }

        let result = `Lists:\n\n`;
        for (const list of response.data) {
          result += formatList(list) + "\n\n";
        }
        return {
          content: [{ type: "text" as const, text: sanitizeText(paginatedResult(result, response, params.page_number, params.page_size)) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_lists failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing lists: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "get_list_people",
    "Get the people in a specific saved list/segment in NationBuilder.",
    {
      list_id: z.string().describe("The NationBuilder list ID"),
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
          fields: {
            // phone_number/mobile_number, not phone/mobile — confirmed
            // against the nation's OpenAPI spec; the old names don't exist
            // on the V2 signup resource and were silently dropped.
            signups:
              "first_name,last_name,full_name,email,phone_number,mobile_number,support_level,is_volunteer,is_donor,created_at",
          },
          // registered_address isn't a sparse-fieldset attribute — it's an
          // opt-in extra_field, requested separately here.
          extra_fields: { signups: "registered_address" },
        };

        const response = await client.get<SignupAttributes>(
          `lists/${params.list_id}/signups`,
          queryParams
        );

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No people found in list ${params.list_id}.` }],
          };
        }

        let result = `People in list ${params.list_id}:\n\n`;
        for (const person of response.data) {
          result += formatSignup(person) + "\n\n";
        }
        return {
          content: [{ type: "text" as const, text: sanitizeText(paginatedResult(result, response, params.page_number, params.page_size)) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "get_list_people failed", rawError: error, context: { list_id: params.list_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error getting list people: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "create_list",
    "Creates a NEW saved list/segment in NationBuilder. This does NOT overwrite existing lists.",
    {
      name: z.string().describe("Name for the new list"),
      slug: z.string().optional().describe("URL-friendly slug (auto-generated from name if omitted)"),
      author_id: z.string().describe("The signup ID of the list author/owner"),
    },
    async (params) => {
      try {
        const autoSlug = params.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        const attributes: Partial<ListAttributes> = {
          name: params.name,
          slug: params.slug || autoSlug,
        };

        const response = await client.create<ListAttributes>("lists", {
          data: {
            type: "lists",
            attributes,
            relationships: {
              author: { data: { id: params.author_id, type: "signups" } },
            },
          },
        });

        const result = `List created successfully:\n\n${formatList(response.data)}`;

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "create_list failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error creating list: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "add_person_to_list",
    "Add a person (signup) to a saved list in NationBuilder.",
    {
      list_id: z.string().describe("The NationBuilder list ID"),
      person_id: z.string().describe("The signup ID of the person to add"),
    },
    async (params) => {
      try {
        await client.v1Request("POST", `/lists/${params.list_id}/people`, {
          people_ids: [parseInt(params.person_id, 10)],
        });

        return {
          content: [{ type: "text" as const, text: sanitizeText(`Person ${params.person_id} added to list ${params.list_id} successfully.`) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "add_person_to_list failed", rawError: error, context: { list_id: params.list_id, person_id: params.person_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error adding person to list: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "remove_person_from_list",
    "Remove a person (signup) from a saved list in NationBuilder.",
    {
      list_id: z.string().describe("The NationBuilder list ID"),
      person_id: z.string().describe("The signup ID of the person to remove"),
    },
    async (params) => {
      try {
        await client.v1Request("DELETE", `/lists/${params.list_id}/people`, {
          people_ids: [parseInt(params.person_id, 10)],
        });

        return {
          content: [{ type: "text" as const, text: sanitizeText(`Person ${params.person_id} removed from list ${params.list_id} successfully.`) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "remove_person_from_list failed", rawError: error, context: { list_id: params.list_id, person_id: params.person_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error removing person from list: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
