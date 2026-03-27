/**
 * Contact/Interaction logging tools for NationBuilder
 * - log_contact: Log a call, email, meeting, etc.
 * - list_contacts: List interaction history for a person
 * - update_contact: Update an existing contact record (with overwrite warning)
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
          filter: { signup_id: params.person_id },
          sort: "-created_at",
        };

        const response = await client.get<ContactAttributes>("contacts", queryParams);

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

  server.tool(
    "update_contact",
    "WARNING: OVERWRITES existing fields on a contact/interaction record. Any field you provide will REPLACE the current value. Fields you omit are left unchanged. Verify the contact ID and changes before proceeding.",
    {
      contact_id: z.string().describe("The NationBuilder contact ID to update"),
      type_id: z
        .string()
        .optional()
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
        const { contact_id, ...fields } = params;
        const attributes: Partial<ContactAttributes> = {};
        for (const [key, value] of Object.entries(fields)) {
          if (value !== undefined) {
            (attributes as Record<string, unknown>)[key] = value;
          }
        }

        if (Object.keys(attributes).length === 0) {
          return {
            content: [{ type: "text" as const, text: "No fields to update. Provide at least one field to change." }],
          };
        }

        const response = await client.update<ContactAttributes>(
          "contacts",
          contact_id,
          {
            data: {
              id: contact_id,
              type: "contacts",
              attributes,
            },
          }
        );

        const result = `Contact updated successfully:\n\n${formatContact(response.data)}`;

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "update_contact failed", rawError: error, context: { contact_id: params.contact_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error updating contact: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
