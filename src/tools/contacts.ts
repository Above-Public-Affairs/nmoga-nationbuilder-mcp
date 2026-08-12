/**
 * Contact/Interaction logging tools for NationBuilder
 * - list_contacts: List interaction history for a person
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { ContactAttributes, QueryParams } from "../types/index.js";
import { formatContact, paginatedResult, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerContactTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.registerTool(
    "list_contacts",
    {
      title: "List Contacts",
      description: "List interaction history (calls, emails, meetings, etc.) for a person in NationBuilder.",
      inputSchema: {
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
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const queryParams: QueryParams = {
          page_size: params.page_size,
          page_number: params.page_number,
          filter: { signup_id: params.person_id },
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
        return {
          content: [{ type: "text" as const, text: sanitizeText(paginatedResult(result, response, params.page_number, params.page_size)) }],
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
