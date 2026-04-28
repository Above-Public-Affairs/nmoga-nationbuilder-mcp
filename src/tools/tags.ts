/**
 * Tag tools for NationBuilder
 * - list_tags: List all tags
 * - add_tags_to_person: Add tags to a person
 * - remove_tags_from_person: Remove tags from a person
 * - list_people_with_tag: List people who have a specific tag
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { TagAttributes, SignupAttributes, TaggingAttributes, QueryParams } from "../types/index.js";
import { formatTag, formatSignup, formatPagination, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";
import { resolveTagByName, getTaggingsPageForTagId } from "../utils/tagLookup.js";

export function registerTagTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "list_tags",
    "List all tags in the NationBuilder nation with optional name search.",
    {
      query: z
        .string()
        .optional()
        .describe("Filter tags by name (partial match)"),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .describe("Results per page"),
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

        if (params.query) {
          queryParams.filter = {
            name: { match: params.query },
          };
        }

        const response = await client.get<TagAttributes>("signup_tags", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No tags found." }],
          };
        }

        let result = `Tags:\n\n`;
        for (const tag of response.data) {
          result += formatTag(tag) + "\n";
        }
        result += formatPagination(response, params.page_number, params.page_size);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_tags failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing tags: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "add_tags_to_person",
    "Add one or more tags to a person in NationBuilder. Creates tags if they don't already exist.",
    {
      person_id: z.string().describe("The NationBuilder signup ID"),
      tags: z
        .array(z.string())
        .min(1)
        .describe("Tag names to add"),
    },
    async (params) => {
      try {
        const results: string[] = [];

        for (const tagName of params.tags) {
          try {
            // Look up tag by name to get its numeric ID
            const tagSearch = await client.get<TagAttributes>("signup_tags", {
              filter: { name: tagName },
              page_size: 1,
            });

            let tagId: string;
            if (tagSearch.data.length > 0) {
              tagId = tagSearch.data[0].id;
            } else {
              // Create the tag first
              const newTag = await client.create<TagAttributes>("signup_tags", {
                data: {
                  type: "signup_tags",
                  attributes: { name: tagName },
                },
              });
              tagId = newTag.data.id;
            }

            await client.create<TaggingAttributes>("signup_taggings", {
              data: {
                type: "signup_taggings",
                attributes: {},
                relationships: {
                  signup: { data: { id: params.person_id, type: "signups" } },
                  tag: { data: { id: tagId, type: "signup_tags" } },
                },
              },
            });
            results.push(`+ Added: ${tagName}`);
          } catch (err) {
            results.push(`x Failed to add "${tagName}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        return {
          content: [{ type: "text" as const, text: sanitizeText(`Tag updates for person ${params.person_id}:\n\n${results.join("\n")}`) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "add_tags_to_person failed", rawError: error, context: { person_id: params.person_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error adding tags: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "remove_tags_from_person",
    "Remove one or more tags from a person in NationBuilder.",
    {
      person_id: z.string().describe("The NationBuilder signup ID"),
      tags: z
        .array(z.string())
        .min(1)
        .describe("Tag names to remove"),
    },
    async (params) => {
      try {
        // First, get the person's taggings to find the tagging IDs
        const taggingsResponse = await client.get<TaggingAttributes>(
          "signup_taggings",
          { filter: { signup_id: params.person_id }, include: "tag", page_size: 100 }
        );

        const results: string[] = [];

        for (const tagName of params.tags) {
          // Find the tagging that corresponds to this tag name
          const tagging = taggingsResponse.data.find((t) => {
            if (t.relationships?.tag?.data && !Array.isArray(t.relationships.tag.data)) {
              const tagId = t.relationships.tag.data.id;
              // Check included resources for the tag name
              const tagResource = taggingsResponse.included?.find(
                (inc) => inc.type === "signup_tags" && inc.id === tagId
              );
              return tagResource && (tagResource.attributes as TagAttributes).name === tagName;
            }
            return false;
          });

          if (tagging) {
            try {
              await client.delete("signup_taggings", tagging.id);
              results.push(`- Removed: ${tagName}`);
            } catch (err) {
              results.push(`x Failed to remove "${tagName}": ${err instanceof Error ? err.message : String(err)}`);
            }
          } else {
            results.push(`~ Tag "${tagName}" not found on this person`);
          }
        }

        return {
          content: [{ type: "text" as const, text: sanitizeText(`Tag updates for person ${params.person_id}:\n\n${results.join("\n")}`) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "remove_tags_from_person failed", rawError: error, context: { person_id: params.person_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error removing tags: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "list_people_with_tag",
    "List people who have a specific tag in NationBuilder. Tag-name lookup is case-insensitive (e.g. 'cmte_legislative' matches 'CMTE_Legislative'). The response includes the total number of people on the tag so you don't have to paginate to see the count.",
    {
      tag: z.string().describe("The tag name to search for (case-insensitive)"),
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
    async (params) => {
      try {
        const resolved = await resolveTagByName(client, params.tag);
        if (!resolved) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Tag "${params.tag}" not found. Tag names are looked up case-insensitively, but the tag must exist in the nation. Use list_tags to browse available tags.`,
              },
            ],
          };
        }

        const signupFields =
          "first_name,last_name,full_name,email,phone,mobile,support_level,is_volunteer,is_donor,registered_address_city,registered_address_state,created_at";

        const taggings = await getTaggingsPageForTagId(client, resolved.id, {
          page: params.page_number,
          pageSize: params.page_size,
          includeSignup: true,
          signupFields,
        });

        const totalLine =
          taggings.totalCount !== null
            ? `Tag "${resolved.name}" — ${taggings.totalCount} people total`
            : `Tag "${resolved.name}"`;

        if (taggings.signupIds.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: sanitizeText(
                  `${totalLine}\n\n(No people on page ${params.page_number}.)`
                ),
              },
            ],
          };
        }

        // Build a lookup of sideloaded signups, then iterate in tagging order
        // so pagination ordering matches the tagging response.
        const included = taggings.raw.included ?? [];
        const signupsById = new Map<
          string,
          { id: string; type: string; attributes: SignupAttributes }
        >();
        for (const resource of included) {
          if (resource.type === "signups") {
            signupsById.set(resource.id, {
              id: resource.id,
              type: resource.type,
              attributes: resource.attributes as SignupAttributes,
            });
          }
        }

        let result = `${totalLine}\n\n`;
        for (const signupId of taggings.signupIds) {
          const signup = signupsById.get(signupId);
          if (signup) {
            result += formatSignup(signup) + "\n\n";
          } else {
            result += `(signup ${signupId} — details unavailable)\n\n`;
          }
        }
        result += formatPagination(
          taggings.raw,
          params.page_number,
          params.page_size
        );

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_people_with_tag failed", rawError: error, context: { tag: params.tag } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing people with tag: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
