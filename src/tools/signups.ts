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
import { formatSignup, formatIncludedSection, paginatedResult, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";
import { resolveTagByName, getAllSignupIdsForTagId } from "../utils/tagLookup.js";

export function registerSignupTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.registerTool(
    "search_people",
    {
      title: "Search People",
      description: "Search for people/supporters in NationBuilder by name, email, or other filters. Returns matching contacts with their key details. Does not support filtering by address (state/city) or by whether email/phone is present — NationBuilder's V2 filter API has no operator for presence checks, and registered address is not a filterable attribute at all (confirmed against the nation's own OpenAPI spec); those parameters previously 400'd or failed outright and have been removed rather than shipped broken.",
      inputSchema: {
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
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const queryParams: QueryParams = {
          page_size: params.page_size,
          page_number: params.page_number,
          fields: {
            // `phone_number`/`mobile_number`, not `phone`/`mobile` — those
            // names don't exist on the V2 signup resource (confirmed against
            // the nation's OpenAPI spec) and were silently dropped by
            // NationBuilder on every request this server has ever made.
            signups:
              "first_name,last_name,full_name,email,phone_number,mobile_number,support_level,signup_type,is_volunteer,is_donor,employer,occupation,note,custom_values,created_at,updated_at",
          },
          // registered_address is not a sparse-fieldset attribute at all — it's
          // an opt-in extra_field, omitted entirely unless requested here.
          extra_fields: { signups: "registered_address" },
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

        // state/city/has_email/has_phone filter params were removed here —
        // see the tool description. Address isn't a filterable attribute at
        // all in V2, and there is no documented presence/absence filter
        // operator; the old `filter[x]=null`/`filter[x][not_eq]=null`
        // sentinel-value approach reproducibly failed live (opaque
        // "Request failed after retries", all 3 attempts exhausted) rather
        // than actually filtering on presence.

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

        // "on this page" — never fabricate a total from `data.length`. NB
        // sends no total on this endpoint (verified live); paginatedResult
        // below carries the real completeness signal.
        let result = `Found ${response.data.length} people on this page:\n\n`;
        for (const person of response.data) {
          result += formatSignup(person) + "\n\n";
        }
        return {
          content: [{ type: "text" as const, text: sanitizeText(paginatedResult(result, response, params.page_number, params.page_size)) }],
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

  server.registerTool(
    "get_person",
    {
      title: "Get Person",
      description: "Get details for a specific person by their NationBuilder ID: contact info, address, support level, and custom values. Does NOT include tags — tags are a separate relationship not carried on the signup record; use get_person_tags for those. Does not include donations, memberships, events, or path progress either — use the dedicated list_* tools for those.",
      inputSchema: {
        person_id: z.string().describe("The NationBuilder signup ID"),
      },
      annotations: { readOnlyHint: true },
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

  server.registerTool(
    "create_person",
    {
      title: "Create Person",
      description: "Create a new person/supporter in NationBuilder with their contact details.",
      inputSchema: {
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
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (params) => {
      try {
        const { registered_address_city, registered_address_state, registered_address_zip, ...fields } = params;

        const attributes: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(fields)) {
          if (value != null) {
            attributes[key] = value;
          }
        }

        // NationBuilder has no flat registered_address_city/_state/_zip
        // attribute to write to (confirmed against the nation's OpenAPI
        // spec) — the only writable path is the nested
        // registered_address_attributes object. The old code sent these
        // three as flat keys, which NationBuilder's write schema doesn't
        // recognize; that data was likely silently discarded on every
        // create_person call that included an address.
        if (registered_address_city != null || registered_address_state != null || registered_address_zip != null) {
          attributes.registered_address_attributes = {
            ...(registered_address_city != null ? { city: registered_address_city } : {}),
            ...(registered_address_state != null ? { state: registered_address_state } : {}),
            ...(registered_address_zip != null ? { zip: registered_address_zip } : {}),
          };
        }

        const response = await client.create<SignupAttributes>("signups", {
          data: {
            type: "signups",
            attributes,
          },
        });

        // Address isn't in the default sparse fieldset — request it
        // explicitly so a person created with one actually shows it back,
        // confirming the write landed rather than silently vanishing again.
        const created = registered_address_city != null || registered_address_state != null || registered_address_zip != null
          ? await client.getById<SignupAttributes>("signups", response.data.id, { extra_fields: { signups: "registered_address" } })
          : response;

        const result = `Person created successfully:\n\n${formatSignup(created.data)}`;

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

  server.registerTool(
    "update_person",
    {
      title: "Update Person",
      description: "Update an existing person's details in NationBuilder. Only provided fields will be changed.",
      inputSchema: {
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
      annotations: { readOnlyHint: false, destructiveHint: false },
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

  server.registerTool(
    "advanced_search",
    {
      title: "Advanced Search",
      description: "Power-user search with full NationBuilder V2 filter syntax. Pass filters as key-value pairs where values can be strings (exact match) or objects with operators (match, gte, lte, gt, lt, not_eq, prefix, suffix). Example: filters={\"support_level\":{\"gte\":\"1\",\"lte\":\"3\"}, \"note\":{\"match\":\"volunteer\"}}. Use the top-level `tag` parameter for tag filtering — the V2 signups endpoint has no tag attribute, so passing `tags` / `tag_list` / etc. inside `filters` will either error or be silently ignored. To filter people vs organizations use `signup_type` (0 = person, 1 = organization); there is no `is_organization` attribute.",
      inputSchema: {
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
        .describe(
          "Comma-separated relationships to sideload on the signups endpoint, rendered in an 'Included' section below the results (e.g. 'memberships,petition_signatures'). Do NOT use 'tags' here — NationBuilder's signups endpoint rejects it outright (HTTP 400: \"not a supported relationship\"), confirmed live; it is not a real option despite looking like one. For a person's tags, use list_people_with_tag or the top-level `tag` parameter above instead."
        ),
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
      annotations: { readOnlyHint: true },
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
          // phone_number/mobile_number, not phone/mobile — those names don't
          // exist on the V2 signup resource (confirmed against the nation's
          // OpenAPI spec). registered_address isn't a sparse-fieldset
          // attribute at all; it's requested separately below.
          queryParams.fields = {
            signups:
              "first_name,last_name,full_name,email,phone_number,mobile_number,support_level,signup_type,is_volunteer,is_donor,employer,occupation,note,custom_values,created_at,updated_at",
          };
        }
        queryParams.extra_fields = { signups: "registered_address" };

        const response = await client.get<SignupAttributes>("signups", queryParams);

        if (response.data.length === 0) {
          const noResultsHeader = tagHeader ? `${tagHeader}\n\n` : "";
          return {
            content: [{ type: "text" as const, text: sanitizeText(`${noResultsHeader}No people found matching your search criteria.`) }],
          };
        }

        let result = "";
        if (tagHeader) result += `${tagHeader}\n`;
        // Never `response.meta?.total ?? response.data.length` — NB sends no
        // total on this endpoint (verified live), so that fallback silently
        // prints a page size as if it were a total. "on this page" makes the
        // distinction explicit; paginatedResult's header/footer below carry
        // the actual completeness signal.
        result += `Found ${response.data.length} people on this page:\n\n`;
        for (const person of response.data) {
          result += formatSignup(person) + "\n\n";
        }
        // `include` sideloads land in response.included and were previously
        // dropped on the floor here — the call paid the round-trip and the
        // caller never saw the data. See CHANGELOG.
        result += formatIncludedSection(response.included);

        return {
          content: [{ type: "text" as const, text: sanitizeText(paginatedResult(result, response, params.page_number, params.page_size)) }],
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
