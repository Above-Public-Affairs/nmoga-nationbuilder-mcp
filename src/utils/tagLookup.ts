/**
 * Shared helpers for filtering signups by tag.
 *
 * The V2 `signups` resource does not expose a tag filter attribute, so any
 * `filter[tag]=...` / `filter[tags]=...` query is either silently ignored or
 * 400s. Tag-scoped queries must go through `signup_taggings` (which supports
 * `filter[tag_id]`) after resolving the tag name → ID via `signup_tags`.
 */

import type { NationBuilderClient } from "../client/nationbuilder.js";
import type {
  TagAttributes,
  TaggingAttributes,
  JsonApiResponse,
} from "../types/index.js";

export interface ResolvedTag {
  id: string;
  name: string;
}

/**
 * Resolve a tag name to its NationBuilder ID. Case-insensitive: NB stores
 * names with mixed casing (e.g. `CMTE_Legislative`, `WG_Seismicity`) and an
 * exact-match query against the wrong casing returns nothing.
 */
export async function resolveTagByName(
  client: NationBuilderClient,
  name: string
): Promise<ResolvedTag | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  // Fast path: exact match.
  const exact = await client.get<TagAttributes>("signup_tags", {
    filter: { name: trimmed },
    page_size: 1,
  });
  if (exact.data.length > 0) {
    return { id: exact.data[0].id, name: exact.data[0].attributes.name };
  }

  // Fallback: case-insensitive match via prefix search. We search by the
  // longest unambiguous prefix (the whole name, lowercased + as-is) and pick
  // the entry whose name matches case-insensitively. NB's `match` operator is
  // a partial substring match, which is what we want here.
  const fuzzy = await client.get<TagAttributes>("signup_tags", {
    filter: { name: { match: trimmed } },
    page_size: 100,
  });
  const lower = trimmed.toLowerCase();
  const hit = fuzzy.data.find(
    (t) => (t.attributes.name ?? "").toLowerCase() === lower
  );
  return hit ? { id: hit.id, name: hit.attributes.name } : null;
}

export interface TaggingsPage {
  signupIds: string[];
  totalCount: number | null;
  raw: JsonApiResponse<TaggingAttributes>;
}

/**
 * Fetch one page of `signup_taggings` filtered by tag ID, optionally
 * sideloading the related signup records via `include=signup`. Returns the
 * signup IDs in page order plus the total count from `meta.total` so callers
 * can show "X people total" without paging through everything.
 */
export async function getTaggingsPageForTagId(
  client: NationBuilderClient,
  tagId: string,
  opts: {
    page?: number;
    pageSize?: number;
    includeSignup?: boolean;
    signupFields?: string;
  } = {}
): Promise<TaggingsPage> {
  const params: Parameters<NationBuilderClient["get"]>[1] = {
    filter: { tag_id: tagId },
    page_size: opts.pageSize ?? 20,
    page_number: opts.page ?? 1,
  };
  if (opts.includeSignup) {
    params.include = "signup";
    if (opts.signupFields) {
      params.fields = { signups: opts.signupFields };
    }
  }

  const response = await client.get<TaggingAttributes>(
    "signup_taggings",
    params
  );

  const signupIds: string[] = [];
  for (const tagging of response.data) {
    const rel = tagging.relationships?.signup?.data;
    if (rel && !Array.isArray(rel)) {
      signupIds.push(rel.id);
    }
  }

  // NB returns `meta.total` (typed) on paged responses. Some endpoints use
  // `total_count` historically; fall back to that just in case.
  const meta = (response.meta ?? {}) as Record<string, unknown>;
  const total =
    typeof meta.total === "number"
      ? meta.total
      : typeof meta.total_count === "number"
      ? (meta.total_count as number)
      : null;

  return { signupIds, totalCount: total, raw: response };
}

/**
 * Fetch every signup ID for a tag by paging through all `signup_taggings`.
 * Used by `advanced_search` to intersect tag membership with other filters.
 * Capped to avoid runaway requests on a misconfigured giant tag.
 */
export async function getAllSignupIdsForTagId(
  client: NationBuilderClient,
  tagId: string,
  opts: { maxIds?: number; pageSize?: number } = {}
): Promise<{ signupIds: string[]; totalCount: number | null; truncated: boolean }> {
  const cap = opts.maxIds ?? 5000;
  const pageSize = opts.pageSize ?? 100;
  const ids: string[] = [];
  let page = 1;
  let totalCount: number | null = null;
  let truncated = false;

  while (true) {
    const result = await getTaggingsPageForTagId(client, tagId, {
      page,
      pageSize,
    });
    if (totalCount === null) totalCount = result.totalCount;
    ids.push(...result.signupIds);

    if (ids.length >= cap) {
      truncated = true;
      ids.length = cap;
      break;
    }
    if (result.signupIds.length < pageSize) break;
    if (totalCount !== null && ids.length >= totalCount) break;
    page += 1;
  }

  return { signupIds: ids, totalCount, truncated };
}
