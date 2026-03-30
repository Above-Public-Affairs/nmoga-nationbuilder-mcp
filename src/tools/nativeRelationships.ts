/**
 * Native Relationship tools for NationBuilder
 * Uses NB's built-in relationship system (spouse, parent, board member, etc.)
 * - list_native_relationships: List relationships for a person
 * - create_native_relationship: Create a relationship between two people (with safety warning)
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { NativeRelationshipAttributes, QueryParams } from "../types/index.js";
import { formatNativeRelationship, formatPagination, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerNativeRelationshipTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "list_native_relationships",
    "List NationBuilder relationships for a person (spouse, parent, board member, employer, etc.). Returns the relationship type and both connected people.",
    {
      signup_id: z.string().describe("The NationBuilder signup ID to find relationships for"),
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
        // Relationships are directional: query both sides to find all relationships
        // where this signup appears as either the first or second party
        const baseParams = {
          page_size: params.page_size,
          page_number: params.page_number,
          include: "first_signup,second_signup",
        };

        const [firstResponse, secondResponse] = await Promise.all([
          client.get<NativeRelationshipAttributes>("relationships", {
            ...baseParams,
            filter: { first_signup_id: params.signup_id },
          }),
          client.get<NativeRelationshipAttributes>("relationships", {
            ...baseParams,
            filter: { second_signup_id: params.signup_id },
          }),
        ]);

        // Merge and deduplicate by relationship ID
        const seenIds = new Set<string>();
        const allRelationships: typeof firstResponse.data = [];
        const allIncluded: typeof firstResponse.included = [];

        for (const rel of [...firstResponse.data, ...secondResponse.data]) {
          if (!seenIds.has(rel.id)) {
            seenIds.add(rel.id);
            allRelationships.push(rel);
          }
        }

        // Merge included sideloads (first_signup, second_signup records)
        const seenIncludedIds = new Set<string>();
        for (const inc of [...(firstResponse.included || []), ...(secondResponse.included || [])]) {
          const key = `${inc.type}:${inc.id}`;
          if (!seenIncludedIds.has(key)) {
            seenIncludedIds.add(key);
            allIncluded.push(inc);
          }
        }

        if (allRelationships.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No relationships found for person ${params.signup_id}.` }],
          };
        }

        let result = `Relationships for person ${params.signup_id}:\n\n`;
        for (const rel of allRelationships) {
          result += formatNativeRelationship(rel, allIncluded) + "\n\n";
        }

        const totalResults = allRelationships.length;
        result += `Showing ${totalResults} relationship${totalResults === 1 ? "" : "s"}.`;

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_native_relationships failed", rawError: error, context: { signup_id: params.signup_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing relationships: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "create_native_relationship",
    "WARNING: Creates a relationship between two people in NationBuilder. This MAY OVERWRITE an existing relationship of the same type between these two signups. Double-check both signup IDs and the relationship type before proceeding.",
    {
      first_signup_id: z.string().describe("The first person's signup ID"),
      second_signup_id: z.string().describe("The second person's signup ID"),
      relationship_type: z
        .string()
        .describe("Relationship type (e.g. 'spouse', 'parent', 'child', 'sibling', 'employer', 'employee', 'board_member')"),
    },
    async (params) => {
      try {
        const response = await client.create<NativeRelationshipAttributes>("relationships", {
          data: {
            type: "relationships",
            attributes: {
              relationship_type: params.relationship_type,
            },
            relationships: {
              first_signup: { data: { id: params.first_signup_id, type: "signups" } },
              second_signup: { data: { id: params.second_signup_id, type: "signups" } },
            },
          },
        });

        const result = `Relationship created successfully:\n\n${formatNativeRelationship(response.data, response.included)}`;

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "create_native_relationship failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error creating relationship: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
