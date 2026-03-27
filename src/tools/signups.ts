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
              "first_name,last_name,full_name,email,phone,mobile,support_level,is_volunteer,is_donor,employer,occupation,registered_address_city,registered_address_state,registered_address_zip,note,created_at,updated_at",
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
        reportError({ category: "tool_error", message: "search_people failed", rawError: error, context: { params } });
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
      phone: z.string().optional().describe("Phone number"),
      mobile: z.string().optional().describe("Mobile phone number"),
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
      phone: z.string().optional().describe("Phone number"),
      mobile: z.string().optional().describe("Mobile phone number"),
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
}
