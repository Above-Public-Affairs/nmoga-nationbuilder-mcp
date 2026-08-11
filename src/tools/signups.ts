/**
 * Signup (People) tools for NationBuilder
 * - search_people: Search by name, email, tag, support level
 * - get_person: Get full details by ID
 * - create_person: Create a new person
 * - update_person: Update existing person
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { SignupAttributes, QueryParams } from "../types/index.js";
import { formatSignup, formatPagination, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";
import { resolveTagByName, getAllSignupIdsForTagId } from "../utils/tagLookup.js";

export function registerSignupTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "search_people",
    "Search for people/supporters in NationBuilder by name, email, or other filters. Returns matching contacts with their key details.",
    {
      query: z
        .string()
        .optional()
        .describe("Search term — searches name, email fields"),
      support_level: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Filter by support level (1-5)"),
      created_since: z
        .string()
        .optional()
        .describe("Filter by creation date (YYYY-MM-DD) — returns people created on or after this date"),
      updated_since: z
        .string()
        .optional()
        .describe("Filter by last update date (YYYY-MM-DD)"),
      custom_field: z
        .string()
        .optional()
        .describe("Custom field slug to filter by (e.g. 'member_type')"),
      custom_field_value: z
        .string()
        .optional()
        .describe("Value to match for the custom field (e.g. 'service company')"),
      is_organization: z
        .boolean()
        .optional()
        .describe("Filter to organizations only (true) or people only (false). Maps to NationBuilder's `signup_type` attribute (0 = person, 1 = organization)."),
      note_contains: z
        .string()
        .optional()
        .describe("Filter by note content (partial match)"),
      donations_min_cents: z
        .number()
        .int()
        .optional()
        .describe("Minimum lifetime donation amount in cents (e.g. 10000 = $100)"),
      donations_max_cents: z
        .number()
        .int()
        .optional()
        .describe("Maximum lifetime donation amount in cents"),
      state: z
        .string()
        .optional()
        .describe("Filter by registered address state (e.g. 'NM', 'TX')"),
      city: z
        .string()
        .optional()
        .describe("Filter by registered address city"),
      has_email: z
        .boolean()
        .optional()
        .describe("Filter for people with email (true) or without email (false)"),
      has_phone: z
        .boolean()
        .optional()
        .describe("Filter for people with phone (true) or without phone (false)"),
      sort_by: z
        .enum(["first_name", "last_name", "created_at", "updated_at", "support_level"])
        .optional()
        .describe("Field to sort results by"),
      sort_order: z
        .enum(["asc", "desc"])
        .optional()
        .default("asc")
        .describe("Sort direction (default: asc)"),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Results per page (max 100)"),
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
            signups:
              "first_name,last_name,full_name,email,phone,mobile,support_level,signup_type,is_volunteer,is_donor,employer,occupation,registered_address_city,registered_address_state,registered_address_zip,note,custom_values,created_at,updated_at",
          },
        };

        const filter: Record<string, string | Record<string, string>> = {};

        if (params.query) {
          // NB v2 uses filter[name][match] for partial name search
          // or filter[email] for email lookup
          if (params.query.includes("@")) {
            filter.email = params.query;
          } else {
            filter.full_name = { match: params.query };
          }
        }

        if (params.support_level != null) {
          filter.support_level = String(params.support_level);
        }

        if (params.created_since) {
          filter.created_at = { gte: params.created_since };
        }

        if (params.updated_since) {
          filter.updated_at = { gte: params.updated_since };
        }

        if (params.custom_field && params.custom_field_value) {
          filter.custom_values = { [params.custom_field]: params.custom_field_value };
        }

        if (params.is_organization != null) {
          // NB V2 has no `is_organization` attribute — the person/organization
          // distinction lives on `signup_type` (0 = person, 1 = organization).
          filter.signup_type = params.is_organization ? "1" : "0";
        }

        if (params.note_contains) {
          filter.note = { match: params.note_contains };
        }

        if (params.donations_min_cents != null) {
          filter.donations_amount_in_cents = {
            ...(filter.donations_amount_in_cents as Record<string, string> || {}),
            gte: String(params.donations_min_cents),
          };
        }

        if (params.donations_max_cents != null) {
          filter.donations_amount_in_cents = {
            ...(filter.donations_amount_in_cents as Record<string, string> || {}),
            lte: String(params.donations_max_cents),
          };
        }

        if (params.state) {
          filter.registered_address_state = params.state;
        }

        if (params.city) {
          filter.registered_address_city = params.city;
        }

        if (params.has_email === true) {
          filter.email = { not_eq: "null" };
        } else if (params.has_email === false) {
          filter.email = "null";
        }

        if (params.has_phone === true) {
          filter.phone = { not_eq: "null" };
        } else if (params.has_phone === false) {
          filter.phone = "null";
        }

        if (params.sort_by) {
          queryParams.sort = params.sort_order === "desc" ? `-${params.sort_by}` : params.sort_by;
        }

        if (Object.keys(filter).length > 0) {
          queryParams.filter = filter;
        }

        const response = await client.get<SignupAttributes>("signups", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No people found matching your search criteria." }],
          };
        }

        let result = `Found ${response.meta?.total ?? response.data.length} people:\n\n`;
        for (const person of response.data) {
          result += formatSignup(person) + "\n\n";
        }
        result += formatPagination(response, params.page_number, params.page_size);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        // context carries which filters were set, never their values — params
        // routinely contains an operator-typed email/name/note (see `query`,
        // `note_contains`), which must not leave the process in a report.
        reportError({
          category: "tool_error",
          message: "search_people failed",
          rawError: error,
          context: {
            param_keys: Object.entries(params)
              .filter(([, v]) => v !== undefined)
              .map(([k]) => k)
              .sort(),
            page_size: params.page_size,
            page_number: params.page_number,
          },
        });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error searching people: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "get_person",
    "Get full details for a specific person by their NationBuilder ID. Returns all available fields including contact info, address, support level, and custom values.",
    {
      person_id: z.string().describe("The NationBuilder signup ID"),
    },
    async (params) => {
      try {
        const response = await client.getById<SignupAttributes>(
          "signups",
          params.person_id
        );

        const result = formatSignup(response.data);

        // Also show custom values if present
        const customValues = response.data.attributes.custom_values;
        let extra = "";
        if (customValues && Object.keys(customValues).length > 0) {
          extra += "\n\n**Custom Values:**\n";
          for (const [key, value] of Object.entries(customValues)) {
            if (value != null) {
              extra += `  ${key}: ${String(value)}\n`;
            }
          }
        }

        return {
          content: [{ type: "text" as const, text: sanitizeText(result + extra) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "get_person failed", rawError: error, context: { person_id: params.person_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error getting person: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "create_person",
    "Create a new person/supporter in NationBuilder with their contact details.",
    {
      first_name: z.string().describe("First name"),
      last_name: z.string().describe("Last name"),
      email: z.string().optional().describe("Email address"),
      phone_number: z.string().optional().describe("Phone number"),
      mobile_number: z.string().optional().describe("Mobile phone number"),
      support_level: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Support level (1=Supporter, 2=Leaning, 3=Undecided, 4=Leaning against, 5=Opposed)"),
      employer: z.string().optional().describe("Employer name"),
      occupation: z.string().optional().describe("Occupation"),
      registered_address_city: z.string().optional().describe("City"),
      registered_address_state: z.string().optional().describe("State abbreviation"),
      registered_address_zip: z.string().optional().describe("ZIP code"),
      note: z.string().optional().describe("Internal note about this person"),
    },
    async (params) => {
      try {
        const attributes: Partial<SignupAttributes> = {};
        for (const [key, value] of Object.entries(params)) {
          if (value != null) {
            (attributes as Record<string, unknown>)[key] = value;
          }
        }

        const response = await client.create<SignupAttributes>("signups", {
          data: {
            type: "signups",
            attributes,
          },
        });

        const result = `Person created successfully:\n\n${formatSignup(response.data)}`;

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "create_person failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error creating person: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "update_person",
    "Update an existing person's details in NationBuilder. Only provided fields will be changed.",
    {
      person_id: z.string().describe("The NationBuilder signup ID to update"),
      first_name: z.string().optional().describe("First name"),
      last_name: z.string().optional().describe("Last name"),
      email: z.string().optional().describe("Email address"),
      phone_number: z.string().optional().describe("Phone number"),
      mobile_number: z.string().optional().describe("Mobile phone number"),
      support_level: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Support level (1-5)"),
      employer: z.string().optional().describe("Employer name"),
      occupation: z.string().optional().describe("Occupation"),
      note: z.string().optional().describe("Internal note"),
    },
    async (params) => {
      try {
        const { person_id, ...fields } = params;
        const attributes: Partial<SignupAttributes> = {};
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

        const response = await client.update<SignupAttributes>(
          "signups",
          person_id,
          {
            data: {
              id: person_id,
              type: "signups",
              attributes,
            },
          }
        );

        const result = `Person updated successfully:\n\n${formatSignup(response.data)}`;

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "update_person failed", rawError: error, context: { person_id: params.person_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error updating person: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "advanced_search",
    "Power-user search with full NationBuilder V2 filter syntax. Pass filters as key-value pairs where values can be strings (exact match) or objects with operators (match, gte, lte, gt, lt, not_eq, prefix, suffix). Example: filters={\"support_level\":{\"gte\":\"1\",\"lte\":\"3\"}, \"note\":{\"match\":\"volunteer\"}}. Use the top-level `tag` parameter for tag filtering — the V2 signups endpoint has no tag attribute, so passing `tags` / `tag_list` / etc. inside `filters` will either error or be silently ignored. To filter people vs organizations use `signup_type` (0 = person, 1 = organization); there is no `is_organization` attribute.",
    {
      filters: z
        .record(z.string(), z.union([z.string(), z.record(z.string(), z.string())]))
        .optional()
        .describe("Filter object — keys are field names, values are strings or {operator: value} objects. Do NOT put tag filters here; use the `tag` parameter."),
      tag: z
        .string()
        .optional()
        .describe("Tag name to filter by (case-insensitive). Resolved to the tag's ID and intersected with `filters` so e.g. tag='cmte_legislative' + filters={state:'NM'} returns committee members in NM."),
      sort: z
        .string()
        .optional()
        .describe("Sort field. Prefix with - for descending (e.g. '-created_at')"),
      include: z
        .string()
        .optional()
        .describe("Comma-separated relationships to sideload (e.g. 'tags,memberships,petition_signatures')"),
      fields: z
        .string()
        .optional()
        .describe("Comma-separated sparse field list (e.g. 'first_name,last_name,email,support_level')"),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Results per page (max 100)"),
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

        const filter: Record<string, string | Record<string, string>> = {
          ...(params.filters ?? {}),
        };

        let tagHeader: string | null = null;
        let tagTruncated = false;
        if (params.tag) {
          const resolved = await resolveTagByName(client, params.tag);
          if (!resolved) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Tag "${params.tag}" not found. Tag names are looked up case-insensitively, but the tag must exist in the nation.`,
                },
              ],
            };
          }
          const tagged = await getAllSignupIdsForTagId(client, resolved.id);
          tagTruncated = tagged.truncated;
          if (tagged.signupIds.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Tag "${resolved.name}" exists but has no people on it (total: ${tagged.totalCount ?? 0}).`,
                },
              ],
            };
          }
          // Intersect tag membership with the rest of the filter set via
          // filter[id][in]=<csv>. The JSON:API client encodes the operator
          // form for free.
          filter.id = { in: tagged.signupIds.join(",") };
          tagHeader = `Tag "${resolved.name}" — ${tagged.totalCount ?? tagged.signupIds.length} people on tag${
            tagTruncated ? " (truncated to 5000 for intersection)" : ""
          }`;
        }

        if (Object.keys(filter).length > 0) {
          queryParams.filter = filter;
        }

        if (params.sort) {
          queryParams.sort = params.sort;
        }

        if (params.include) {
          queryParams.include = params.include;
        }

        if (params.fields) {
          queryParams.fields = { signups: params.fields };
        } else {
          queryParams.fields = {
            signups:
              "first_name,last_name,full_name,email,phone,mobile,support_level,signup_type,is_volunteer,is_donor,employer,occupation,registered_address_city,registered_address_state,registered_address_zip,note,custom_values,created_at,updated_at",
          };
        }

        const response = await client.get<SignupAttributes>("signups", queryParams);

        if (response.data.length === 0) {
          const noResultsHeader = tagHeader ? `${tagHeader}\n\n` : "";
          return {
            content: [{ type: "text" as const, text: sanitizeText(`${noResultsHeader}No people found matching your search criteria.`) }],
          };
        }

        let result = "";
        if (tagHeader) result += `${tagHeader}\n`;
        result += `Found ${response.meta?.total ?? response.data.length} people:\n\n`;
        for (const person of response.data) {
          result += formatSignup(person) + "\n\n";
        }
        result += formatPagination(response, params.page_number, params.page_size);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        // filter_keys/has_tag only — filters is an arbitrary caller-supplied
        // object that can carry member PII (email, name, note text).
        reportError({
          category: "tool_error",
          message: "advanced_search failed",
          rawError: error,
          context: {
            filter_keys: Object.keys(params.filters ?? {}),
            has_tag: !!params.tag,
            page_size: params.page_size,
            page_number: params.page_number,
          },
        });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error in advanced search: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
