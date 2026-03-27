/**
 * NationBuilder organization relationship tools
 *
 * Finds people related to organizations by querying signups
 * whose parent_id matches the organization's signup ID.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { SignupAttributes } from "../types/index.js";
import { formatSignup, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerRelationshipTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "list_org_members",
    "List people related to an organization in NationBuilder. Returns people linked via NB's relationship system (Employee of, Board member of, etc.).",
    {
      org_id: z
        .string()
        .describe("The NationBuilder signup ID of the organization"),
    },
    async (params) => {
      try {
        // Find signups whose parent is this organization
        const response = await client.get<SignupAttributes>("signups", {
          filter: { parent_id: params.org_id },
          page_size: 100,
        });

        if (response.data.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No people found related to organization ${params.org_id}.`,
              },
            ],
          };
        }

        let result = `Found ${response.data.length} people related to org ${params.org_id}:\n\n`;
        for (const person of response.data) {
          result += formatSignup(person) + "\n\n";
        }

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        const errMsg =
          error instanceof Error ? error.message : String(error);

        reportError({
          category: "tool_error",
          message: "list_org_members failed",
          rawError: error,
          context: { org_id: params.org_id },
        });
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error listing org members: ${errMsg}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "list_org_members_batch",
    "Find all people related to multiple organizations. Takes a comma-separated list of org IDs and returns all related people across those organizations.",
    {
      org_ids: z
        .string()
        .describe(
          "Comma-separated list of NationBuilder org signup IDs (e.g. '498900,498903,498967')"
        ),
    },
    async (params) => {
      const ids = params.org_ids
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

      if (ids.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No org IDs provided." },
          ],
        };
      }

      const allMembers: Map<
        string,
        { name: string; email: string; employer: string; orgName: string }
      > = new Map();
      const orgNames: Map<string, string> = new Map();
      const errors: string[] = [];

      for (const orgId of ids) {
        try {
          const response = await client.get<SignupAttributes>("signups", {
            filter: { parent_id: orgId },
            page_size: 100,
          });

          for (const person of response.data) {
            const attrs = person.attributes;
            const name =
              attrs.full_name ||
              [attrs.first_name, attrs.last_name]
                .filter(Boolean)
                .join(" ") ||
              `ID ${person.id}`;
            const orgName = orgNames.get(orgId) || orgId;
            allMembers.set(person.id, {
              name,
              email: attrs.email || "",
              employer: attrs.employer || "",
              orgName,
            });
          }
        } catch {
          errors.push(orgId);
        }
      }

      let result = `Searched ${ids.length} organizations.\n`;
      result += `Found ${allMembers.size} unique related people.\n\n`;

      if (allMembers.size > 0) {
        for (const [id, info] of allMembers) {
          const email = info.email ? ` — ${info.email}` : "";
          const employer = info.employer ? ` (${info.employer})` : "";
          result += `- **${info.name}**${email}${employer} [ID: ${id}]\n`;
        }
      }

      if (errors.length > 0) {
        result += `\n---\nCould not query relationships for ${errors.length} org(s): ${errors.join(", ")}`;
      }

      return {
        content: [{ type: "text" as const, text: sanitizeText(result) }],
      };
    }
  );
}
