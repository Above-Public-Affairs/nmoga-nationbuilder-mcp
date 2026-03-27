/**
 * Contact/Interaction logging tools for NationBuilder
 * - log_contact: Log a call, email, meeting, etc.
 * - list_contacts: List interaction history for a person
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { ContactAttributes, QueryParams } from "../types/index.js";
import { formatContact, formatPagination, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerContactTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "log_contact",
    "Log an interaction (call, email, meeting, door knock, etc.) with a person in NationBuilder.",
    {
      person_id: z.string().describe("The NationBuilder signup ID of the person"),
      type_id: z
        .string()
        .describe("Contact type (e.g., 'call', 'email', 'meeting', 'door_knock', 'other')"),
      method: z
        .string()
        .optional()
        .describe("How the contact was made (e.g., 'phone', 'in_person', 'online')"),
      note: z
        .string()
        .optional()
        .describe("Notes about the interaction"),
      status: z
        .string()
        .optional()
        .describe("Outcome status (e.g., 'answered', 'left_voicemail', 'no_answer')"),
    },
    async (params) => {
      try {
        const attributes: Partial<ContactAttributes> = {
          type_id: params.type_id,
        };
        if (params.method) attributes.method = params.method;
        if (params.note) attributes.note = params.note;
        if (params.status) attributes.status = params.status;

        const response = await client.create<ContactAttributes>("contacts", {
          data: {
            type: "contacts",
            attributes,
            relationships: {
              signup: { data: { id: params.person_id, type: "signups" } },
            },
          },
        });

        const result = `Contact logged successfully:\n\n${formatContact(response.data)}`;

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "log_contact failed", rawError: error, context: { person_id: params.person_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error logging contact: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "list_contacts",
    "List interaction history (calls, emails, meetings, etc.) for a person in NationBuilder.",
    {
      person_id: z.string().describe("The NationBuilder signup ID"),
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

        const response = await client.get<ContactAttributes>(
          `signups/${params.person_id}/contacts`,
          queryParams
        );

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No contacts/interactions found for person ${params.person_id}.` }],
          };
        }

        let result = `Interaction history for person ${params.person_id}:\n\n`;
        for (const contact of response.data) {
          result += formatContact(contact) + "\n\n";
        }
        result += formatPagination(response, params.page_number, params.page_size);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_contacts failed", rawError: error, context: { person_id: params.person_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing contacts: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
