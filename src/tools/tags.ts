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
import { formatTag, formatSignup, formatPersonTags, formatTruncationNotice, paginatedResult, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";
import { resolveTagByName, getTaggingsPageForTagId, getTaggingsForSignupIds, getAllSignupIdsForTagId } from "../utils/tagLookup.js";

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
        // Default to the max: NationBuilder V2 sends no result total on this
        // endpoint (verified live), so a smaller default risks silently
        // truncating the tag universe before any per-tag paging even starts.
        .default(100)
        .describe("Results per page (defaults to the max — this endpoint reports no total, so a full page is the only warning that more tags exist)"),
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

        return {
          content: [{ type: "text" as const, text: sanitizeText(paginatedResult(result, response, params.page_number, params.page_size)) }],
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
            // Case-insensitive resolve (shared with list_people_with_tag /
            // remove_tags_from_person) — an exact-case-only lookup here used
            // to create a near-duplicate tag whenever the caller's casing
            // didn't match an existing tag verbatim (e.g. "cmte_legislative"
            // vs. "CMTE_Legislative").
            const resolved = await resolveTagByName(client, tagName);

            let tagId: string;
            if (resolved) {
              tagId = resolved.id;
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
        // Shared with get_person_tags: pages to exhaustion (capped) rather
        // than the single 100-row page this used to fetch, and matches tag
        // names case-insensitively — NB tag names carry mixed casing
        // (CMTE_Legislative, WG_Seismicity), and an exact-match lookup here
        // silently failed to remove a tag whose case didn't match verbatim.
        const { bySignupId, truncated } = await getTaggingsForSignupIds(client, [params.person_id]);
        const taggings = bySignupId.get(params.person_id) ?? [];

        const results: string[] = [];

        for (const tagName of params.tags) {
          const lower = tagName.toLowerCase();
          const tagging = taggings.find((t) => t.tagName.toLowerCase() === lower);

          if (tagging) {
            try {
              await client.delete("signup_taggings", tagging.taggingId);
              results.push(`- Removed: ${tagName}`);
            } catch (err) {
              results.push(`x Failed to remove "${tagName}": ${err instanceof Error ? err.message : String(err)}`);
            }
          } else {
            results.push(`~ Tag "${tagName}" not found on this person${truncated ? " (tag list was truncated — this person has an unusually large number of tags; the tag may exist beyond the cap)" : ""}`);
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
    "get_person_tags",
    "Get every tag on one or more people in NationBuilder. This is the reverse of list_people_with_tag: given person IDs, returns each person's tags. Batch-capable — pass multiple comma-separated IDs to check a whole roster in one call. People with zero tags are explicitly reported as having none — they are never silently omitted.",
    {
      person_ids: z
        .string()
        .describe("Comma-separated NationBuilder signup IDs (e.g. '498900,498903,498967')"),
    },
    async (params) => {
      const ids = params.person_ids
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

      if (ids.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No person IDs provided." }],
        };
      }

      try {
        // Display names are a nicety, not the point of this tool — resolve
        // in one batched call (the same filter[id][in] form advanced_search
        // already uses to intersect tag membership) and fall back to bare
        // IDs for anyone this doesn't resolve, rather than failing the tool.
        const namesById = new Map<string, string>();
        try {
          const signupsResponse = await client.get<SignupAttributes>("signups", {
            filter: { id: { in: ids.join(",") } },
            fields: { signups: "first_name,last_name,full_name" },
            page_size: Math.min(Math.max(ids.length, 1), 100),
          });
          for (const s of signupsResponse.data) {
            const name =
              s.attributes.full_name ||
              [s.attributes.first_name, s.attributes.last_name].filter(Boolean).join(" ") ||
              null;
            if (name) namesById.set(s.id, name);
          }
        } catch {
          // Name lookup failing is not fatal — tags still render against bare IDs.
        }

        const { bySignupId, truncated } = await getTaggingsForSignupIds(client, ids);

        let result = `Tags for ${ids.length} ${ids.length === 1 ? "person" : "people"}:\n\n`;
        for (const id of ids) {
          const name = namesById.get(id);
          const label = name ? `${name} (ID: ${id})` : `Signup ${id}`;
          const taggings = bySignupId.get(id) ?? [];
          const tags = taggings.map((t) => ({ id: t.tagId, name: t.tagName }));
          result += formatPersonTags(label, tags) + "\n\n";
        }

        if (truncated) {
          result += `\n${formatTruncationNotice("taggings walked per signup", 5000, 5000)}`;
        }

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({
          category: "tool_error",
          message: "get_person_tags failed",
          rawError: error,
          context: { person_id_count: ids.length },
        });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error getting tags: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "list_people_with_tag",
    "List people who have a specific tag in NationBuilder. Tag-name lookup is case-insensitive (e.g. 'cmte_legislative' matches 'CMTE_Legislative'). NationBuilder does not report a total count on this endpoint, so by default the response tells you only whether more pages exist — pass count_all: true to walk every page and get an exact count when you need a reliable denominator (e.g. answering \"how many people have this tag\").",
    {
      tag: z.string().describe("The tag name to search for (case-insensitive)"),
      count_all: z
        .boolean()
        .optional()
        .default(false)
        .describe("Walk every page of this tag first to compute an exact total before returning results. Costs one request per ~100 people on the tag. Use when the count itself is the answer, not just this page's contents."),
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

        // phone_number/mobile_number, not phone/mobile — confirmed against
        // the nation's OpenAPI spec; the old names don't exist on the V2
        // signup resource and were silently dropped on every request.
        const signupFields =
          "first_name,last_name,full_name,email,phone_number,mobile_number,support_level,is_volunteer,is_donor,created_at";

        const taggings = await getTaggingsPageForTagId(client, resolved.id, {
          page: params.page_number,
          pageSize: params.page_size,
          includeSignup: true,
          signupFields,
          // registered_address isn't a sparse-fieldset attribute — it's an
          // opt-in extra_field, requested separately here.
          signupExtraFields: "registered_address",
        });

        let exactCount: { total: number; truncated: boolean } | null = null;
        if (params.count_all) {
          const all = await getAllSignupIdsForTagId(client, resolved.id);
          exactCount = { total: all.signupIds.length, truncated: all.truncated };
        }

        const totalLine = exactCount
          ? `Tag "${resolved.name}" — ${exactCount.total}${exactCount.truncated ? "+ (capped walk)" : ""} people total (exact, via count_all)`
          : taggings.totalCount !== null
            ? `Tag "${resolved.name}" — ${taggings.totalCount} people total`
            : `Tag "${resolved.name}" — NationBuilder does not report a total here; pass count_all: true for an exact count`;

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

        return {
          content: [{
            type: "text" as const,
            text: sanitizeText(paginatedResult(result, taggings.raw, params.page_number, params.page_size)),
          }],
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
