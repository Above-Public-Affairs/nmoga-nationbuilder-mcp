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
import { formatSignup, formatTruncationNotice, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

/** Cap on how many employer/parent_id matches these tools will page through
 *  before giving up and reporting truncation. Neither tool takes a
 *  page_number param, so silently stopping at the first page (as this code
 *  used to) reported a false "Found N people" as if it were complete —
 *  the same defect class as the incident that prompted this file's fixes. */
const MAX_RELATED_PEOPLE = 1000;
const PAGE_SIZE = 100;

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

interface EmployerSearchResult {
  people: { id: string; attrs: SignupAttributes }[];
  /** Hit the MAX_RELATED_PEOPLE cap — more matches exist. */
  truncated: boolean;
  /** NationBuilder refused the employer filter itself. Distinct from "no
   *  matches": an empty `people` here means the search never ran, not that
   *  the organization has nobody. */
  filterRejected: boolean;
}

/**
 * Find people whose employer matches a given name. Pages to exhaustion (or
 * the cap) rather than returning just the first page — this filter has no
 * total from NationBuilder to check completeness against, so a full first
 * page with no further paging would silently under-report.
 */
async function findPeopleByEmployer(
  client: NationBuilderClient,
  employerName: string
): Promise<EmployerSearchResult> {
  const people: { id: string; attrs: SignupAttributes }[] = [];
  let page = 1;
  let truncated = false;

  try {
    while (true) {
      const response = await client.get<SignupAttributes>("signups", {
        filter: { employer: employerName },
        page_size: PAGE_SIZE,
        page_number: page,
      });
      people.push(...response.data.map((d) => ({ id: d.id, attrs: d.attributes })));

      if (people.length >= MAX_RELATED_PEOPLE) {
        truncated = true;
        people.length = MAX_RELATED_PEOPLE;
        break;
      }
      if (response.data.length < PAGE_SIZE) break;
      page += 1;
    }
    return { people, truncated, filterRejected: false };
  } catch (err) {
    // NationBuilder 400s when it won't accept the employer filter at all,
    // rather than returning zero rows. Those two cases must not look alike:
    // reporting a rejected filter as "no people found" is indistinguishable
    // from a genuinely empty organization, and a roster built on that
    // silence reads as complete when nothing was ever actually searched.
    // Callers surface `filterRejected` instead of treating [] as an answer.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("400") || msg.includes("could not find")) {
      // Keep whatever earlier pages returned — a mid-walk rejection still
      // leaves real, if partial, results worth reporting.
      return { people, truncated, filterRejected: true };
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
        const {
          people,
          truncated: employerTruncated,
          filterRejected: employerFilterRejected,
        } = await findPeopleByEmployer(client, orgName);

        // Step 3: Also try parent_id filter (single page — parent_id is a
        // secondary, best-effort lookup; if it silently 400s that's fine)
        let parentTruncated = false;
        try {
          const parentResponse = await client.get<SignupAttributes>(
            "signups",
            {
              filter: { parent_id: params.org_id },
              page_size: PAGE_SIZE,
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
          parentTruncated = parentResponse.data.length >= PAGE_SIZE;
        } catch {
          // parent_id filter may not work — that's ok
        }

        if (people.length === 0) {
          const text = employerFilterRejected
            ? `INCONCLUSIVE — no people found for organization "${orgName}" (ID: ${params.org_id}), but NationBuilder rejected the employer-field filter, so the employer search never actually ran. This is NOT evidence the organization has no members. Use list_native_relationships for formal relationship records instead.`
            : `No people found related to organization "${orgName}" (ID: ${params.org_id}).`;
          return {
            content: [{ type: "text" as const, text }],
          };
        }

        let result = `Found ${people.length} people related to **${orgName}** (ID: ${params.org_id}):\n\n`;
        if (employerFilterRejected) {
          result += `INCOMPLETE — NationBuilder rejected the employer-field filter partway through, so this list is missing any employer matches beyond what is shown. Do not treat it as the organization's full membership.\n\n`;
        }
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

        if (employerTruncated) {
          result += `\n${formatTruncationNotice("employer-matched people", MAX_RELATED_PEOPLE, MAX_RELATED_PEOPLE)}`;
        }
        if (parentTruncated) {
          result += `\n(parent_id lookup returned a full page of ${PAGE_SIZE} — more may exist; this secondary lookup is not paged further)`;
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
      const truncatedOrgs: string[] = [];
      const rejectedFilterOrgs: string[] = [];

      for (const orgId of ids) {
        try {
          // Get org name
          const orgName = await getOrgName(client, orgId);
          if (!orgName) {
            errors.push(orgId);
            continue;
          }

          // Find people by employer
          const { people, truncated, filterRejected } = await findPeopleByEmployer(client, orgName);
          if (truncated) truncatedOrgs.push(orgId);
          // A rejected filter returns rather than throws, so it never reaches
          // the catch below — without this it would silently read as "searched
          // that org, found nobody."
          if (filterRejected) rejectedFilterOrgs.push(orgId);
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

      if (truncatedOrgs.length > 0) {
        result += `\n---\nTRUNCATED — hit the ${MAX_RELATED_PEOPLE}-person cap for org(s) ${truncatedOrgs.join(", ")}. More employer matches likely exist for these; this is not their complete membership.`;
      }

      if (rejectedFilterOrgs.length > 0) {
        result += `\n---\nINCONCLUSIVE — NationBuilder rejected the employer-field filter for org(s) ${rejectedFilterOrgs.join(", ")}. The search did not run for them, so a zero or low count above is NOT evidence they have no members. Use list_native_relationships for formal relationship records.`;
      }

      return {
        content: [{ type: "text" as const, text: sanitizeText(result) }],
      };
    }
  );
}
