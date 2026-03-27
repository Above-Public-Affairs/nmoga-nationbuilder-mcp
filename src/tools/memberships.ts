/**
 * Membership tools for NationBuilder
 * - list_memberships: List memberships with filters
 * - get_membership: Get membership details
 * - create_membership: Create a new membership
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { MembershipAttributes, QueryParams } from "../types/index.js";
import { formatMembership, formatPagination, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerMembershipTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "list_memberships",
    "List memberships in NationBuilder with optional filtering by person, status, or date.",
    {
      signup_id: z
        .string()
        .optional()
        .describe("Filter by person's signup ID"),
      status: z
        .string()
        .optional()
        .describe("Filter by membership status (e.g. 'active', 'expired', 'grace_period')"),
      since: z
        .string()
        .optional()
        .describe("Memberships started on or after this date (YYYY-MM-DD)"),
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
          sort: "-created_at",
          include: "signup,membership_type",
        };

        const filter: Record<string, string | Record<string, string>> = {};

        if (params.signup_id) {
          filter.signup_id = params.signup_id;
        }
        if (params.status) {
          filter.status = params.status;
        }
        if (params.since) {
          filter.started_at = { gte: params.since };
        }

        if (Object.keys(filter).length > 0) {
          queryParams.filter = filter;
        }

        const response = await client.get<MembershipAttributes>("memberships", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No memberships found matching your criteria." }],
          };
        }

        let result = `Memberships:\n\n`;
        for (const membership of response.data) {
          result += formatMembership(membership) + "\n\n";
        }
        result += formatPagination(response, params.page_number, params.page_size);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_memberships failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing memberships: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "get_membership",
    "Get full details for a specific membership by its NationBuilder ID.",
    {
      membership_id: z.string().describe("The NationBuilder membership ID"),
    },
    async (params) => {
      try {
        const response = await client.getById<MembershipAttributes>(
          "memberships",
          params.membership_id,
          { include: "signup,membership_type" }
        );

        const result = formatMembership(response.data);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "get_membership failed", rawError: error, context: { membership_id: params.membership_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error getting membership: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "create_membership",
    "Creates a NEW membership record for a person. This does NOT overwrite or modify existing memberships — it adds a new one.",
    {
      signup_id: z.string().describe("The signup ID of the person to create a membership for"),
      membership_type_id: z.string().describe("The membership type ID"),
      status: z
        .string()
        .default("active")
        .describe("Membership status: 'active', 'grace period', 'expired', or 'canceled' (default: active)"),
      started_at: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      expires_on: z.string().optional().describe("Expiration date (YYYY-MM-DD) — must be today or in the past"),
    },
    async (params) => {
      try {
        const attributes: Partial<MembershipAttributes> = {
          status: params.status,
        };
        if (params.started_at) attributes.started_at = params.started_at;
        if (params.expires_on) attributes.expires_on = params.expires_on;

        const response = await client.create<MembershipAttributes>("memberships", {
          data: {
            type: "memberships",
            attributes,
            relationships: {
              signup: { data: { id: params.signup_id, type: "signups" } },
              membership_type: { data: { id: params.membership_type_id, type: "membership_types" } },
            },
          },
        });

        const result = `Membership created successfully:\n\n${formatMembership(response.data)}`;

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "create_membership failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error creating membership: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
