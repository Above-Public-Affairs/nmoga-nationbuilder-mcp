/**
 * NationBuilder organization relationship tools
 *
 * Lists people related to organizations via the NB V2 API.
 * Tries sideloading memberships first, falls back to the
 * dedicated relationships endpoint if available.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { SignupAttributes, JsonApiResource } from "../types/index.js";
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
        // Try fetching the org's relationships via the dedicated endpoint
        const response = await client.get<SignupAttributes>(
          `signups/${params.org_id}/relationships`,
          { page_size: 100 }
        );

        if (response.data.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No relationships found for organization ${params.org_id}.`,
              },
            ],
          };
        }

        let result = `Found ${response.data.length} relationship(s) for org ${params.org_id}:\n\n`;
        for (const rel of response.data) {
          // Relationships may be their own resource type — extract what we can
          const attrs = rel.attributes;
          const name =
            attrs.full_name ||
            [attrs.first_name, attrs.last_name].filter(Boolean).join(" ") ||
            `ID ${rel.id}`;
          const email = attrs.email ? ` — ${attrs.email}` : "";
          const employer = attrs.employer ? ` (${attrs.employer})` : "";
          result += `- **${name}**${email}${employer} [ID: ${rel.id}]\n`;
        }

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        // If the relationships endpoint doesn't exist, try sideloading
        const errMsg =
          error instanceof Error ? error.message : String(error);

        if (errMsg.includes("404") || errMsg.includes("400")) {
          // Fallback: try include=memberships on the signup
          try {
            const doc = await client.getById<SignupAttributes>(
              "signups",
              params.org_id,
              { include: "memberships" }
            );

            const included = (
              doc as unknown as {
                included?: JsonApiResource<SignupAttributes>[];
              }
            ).included;

            if (included && included.length > 0) {
              let result = `Found ${included.length} member(s) for org ${params.org_id}:\n\n`;
              for (const member of included) {
                result += formatSignup(member) + "\n\n";
              }
              return {
                content: [
                  { type: "text" as const, text: sanitizeText(result) },
                ],
              };
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: `No members/relationships found for organization ${params.org_id} via sideloading.\nOriginal error: ${errMsg}`,
                },
              ],
            };
          } catch (fallbackError) {
            // Both approaches failed
            const fallbackMsg =
              fallbackError instanceof Error
                ? fallbackError.message
                : String(fallbackError);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Could not find relationships for org ${params.org_id}.\nEndpoint error: ${errMsg}\nSideload error: ${fallbackMsg}`,
                },
              ],
            };
          }
        }

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
        { name: string; email: string; employer: string; orgId: string }
      > = new Map();
      const errors: string[] = [];

      for (const orgId of ids) {
        try {
          // Try relationships endpoint first
          let found = false;
          try {
            const response = await client.get<SignupAttributes>(
              `signups/${orgId}/relationships`,
              { page_size: 100 }
            );
            for (const rel of response.data) {
              const attrs = rel.attributes;
              const name =
                attrs.full_name ||
                [attrs.first_name, attrs.last_name]
                  .filter(Boolean)
                  .join(" ") ||
                `ID ${rel.id}`;
              allMembers.set(rel.id, {
                name,
                email: attrs.email || "",
                employer: attrs.employer || "",
                orgId,
              });
            }
            found = response.data.length > 0;
          } catch {
            // Endpoint not available — try sideloading
          }

          if (!found) {
            try {
              const doc = await client.getById<SignupAttributes>(
                "signups",
                orgId,
                { include: "memberships" }
              );
              const included = (
                doc as unknown as {
                  included?: JsonApiResource<SignupAttributes>[];
                }
              ).included;
              if (included) {
                for (const member of included) {
                  const attrs = member.attributes;
                  const name =
                    attrs.full_name ||
                    [attrs.first_name, attrs.last_name]
                      .filter(Boolean)
                      .join(" ") ||
                    `ID ${member.id}`;
                  allMembers.set(member.id, {
                    name,
                    email: attrs.email || "",
                    employer: attrs.employer || "",
                    orgId,
                  });
                }
              }
            } catch {
              // Both failed for this org
              errors.push(orgId);
            }
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
