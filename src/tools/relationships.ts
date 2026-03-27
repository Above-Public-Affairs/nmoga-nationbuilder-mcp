/**
 * NationBuilder organization relationship tools
 *
 * Finds people related to organizations by looking up the org name
 * and then searching for signups with a matching employer field.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { SignupAttributes } from "../types/index.js";
import { formatSignup, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

/** Get the display name of an organization signup */
async function getOrgName(
  client: NationBuilderClient,
  orgId: string
): Promise<string | null> {
  try {
    const doc = await client.getById<SignupAttributes>("signups", orgId);
    const attrs = doc.data.attributes;
    return (
      attrs.full_name ||
      [attrs.first_name, attrs.last_name].filter(Boolean).join(" ") ||
      null
    );
  } catch {
    return null;
  }
}

/** Find people whose employer matches a given name */
async function findPeopleByEmployer(
  client: NationBuilderClient,
  employerName: string
): Promise<{ id: string; attrs: SignupAttributes }[]> {
  try {
    const response = await client.get<SignupAttributes>("signups", {
      filter: { employer: employerName },
      page_size: 100,
    });
    return response.data.map((d) => ({ id: d.id, attrs: d.attributes }));
  } catch (err) {
    // If employer filter isn't supported, fall back to parent_id
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("400") || msg.includes("could not find")) {
      return [];
    }
    throw err;
  }
}

export function registerRelationshipTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "list_org_members",
    "List people whose employer field matches an organization's name. NOTE: This matches on the employer text field, NOT formal NationBuilder relationships. For actual relationship records (employee_of, primary_contact_of), use list_native_relationships instead.",
    {
      org_id: z
        .string()
        .describe("The NationBuilder signup ID of the organization"),
    },
    async (params) => {
      try {
        // Step 1: Get the org name
        const orgName = await getOrgName(client, params.org_id);
        if (!orgName) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Could not find organization with ID ${params.org_id}.`,
              },
            ],
          };
        }

        // Step 2: Find people by employer match
        let people = await findPeopleByEmployer(client, orgName);

        // Step 3: Also try parent_id filter
        try {
          const parentResponse = await client.get<SignupAttributes>(
            "signups",
            {
              filter: { parent_id: params.org_id },
              page_size: 100,
            }
          );
          const existingIds = new Set(people.map((p) => p.id));
          for (const person of parentResponse.data) {
            if (!existingIds.has(person.id)) {
              people.push({
                id: person.id,
                attrs: person.attributes,
              });
            }
          }
        } catch {
          // parent_id filter may not work — that's ok
        }

        if (people.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No people found related to organization "${orgName}" (ID: ${params.org_id}).`,
              },
            ],
          };
        }

        let result = `Found ${people.length} people related to **${orgName}** (ID: ${params.org_id}):\n\n`;
        for (const person of people) {
          const name =
            person.attrs.full_name ||
            [person.attrs.first_name, person.attrs.last_name]
              .filter(Boolean)
              .join(" ") ||
            `ID ${person.id}`;
          const email = person.attrs.email ? ` — ${person.attrs.email}` : "";
          const occupation = person.attrs.occupation
            ? `, ${person.attrs.occupation}`
            : "";
          result += `- **${name}**${email}${occupation} [ID: ${person.id}]\n`;
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
    "Find all people whose employer field matches multiple organizations' names. NOTE: This matches on the employer text field, NOT formal NationBuilder relationships. For actual relationship records, use list_native_relationships instead.",
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
        { name: string; email: string; occupation: string; orgName: string }
      > = new Map();
      const errors: string[] = [];

      for (const orgId of ids) {
        try {
          // Get org name
          const orgName = await getOrgName(client, orgId);
          if (!orgName) {
            errors.push(orgId);
            continue;
          }

          // Find people by employer
          const people = await findPeopleByEmployer(client, orgName);
          for (const person of people) {
            const name =
              person.attrs.full_name ||
              [person.attrs.first_name, person.attrs.last_name]
                .filter(Boolean)
                .join(" ") ||
              `ID ${person.id}`;
            allMembers.set(person.id, {
              name,
              email: person.attrs.email || "",
              occupation: person.attrs.occupation || "",
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
          const occupation = info.occupation ? `, ${info.occupation}` : "";
          result += `- **${info.name}**${email}${occupation} (${info.orgName}) [ID: ${id}]\n`;
        }
      }

      if (errors.length > 0) {
        result += `\n---\nCould not query ${errors.length} org(s): ${errors.join(", ")}`;
      }

      return {
        content: [{ type: "text" as const, text: sanitizeText(result) }],
      };
    }
  );
}
