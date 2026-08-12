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
import { readTotal } from "./formatting.js";

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
    /** e.g. "registered_address" — sideloaded signups only get this data if
     *  asked for it via extra_fields[signups], same as any direct signup
     *  fetch; sparse fieldsets alone don't carry it. */
    signupExtraFields?: string;
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
    if (opts.signupExtraFields) {
      params.extra_fields = { signups: opts.signupExtraFields };
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

  // In production this is always null — verified live against
  // signup_taggings, which (like every other V2 endpoint this server calls)
  // sends no `meta.total`/`total_count`. Kept in case that ever changes;
  // never assume it's populated.
  const total = readTotal(response.meta);

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
    // Terminate on the RAW page size, not `signupIds.length`. A tagging
    // whose `signup` relationship is missing is dropped from `signupIds` but
    // still counts as a row NationBuilder sent — checking the filtered
    // length ends the walk one page early whenever that happens. With
    // `totalCount` effectively always null in production, this is the only
    // termination signal that runs, so it has to be exact.
    if (result.raw.data.length < pageSize) break;
    if (totalCount !== null && ids.length >= totalCount) break;
    page += 1;
  }

  return { signupIds: ids, totalCount, truncated };
}

export interface SignupTagging {
  taggingId: string;
  tagId: string;
  tagName: string;
}

/**
 * Get every tag on each of the given signup IDs — the reverse of
 * `getAllSignupIdsForTagId` above, and the query `get_person_tags` and
 * `remove_tags_from_person` both need. Every requested ID is guaranteed a key
 * in the returned map, even with zero tags: callers must render "no tags"
 * explicitly rather than omitting the person, which is the exact inference
 * that caused NationBuilder's tag data to look like it didn't exist.
 *
 * Tries the batched `filter[signup_id][in]=<csv>` form first. That operator
 * is proven only for `filter[id][in]` on `signups` (the client encodes `[in]`
 * generically for any attribute, which is not the same as NationBuilder
 * supporting it on this one) — if NB rejects it, this falls back to one
 * verified-working request per signup, so a batch of 9 costs at most 9
 * requests either way.
 */
export async function getTaggingsForSignupIds(
  client: NationBuilderClient,
  signupIds: string[],
  opts: { pageSize?: number; maxTaggings?: number } = {}
): Promise<{ bySignupId: Map<string, SignupTagging[]>; truncated: boolean }> {
  const pageSize = opts.pageSize ?? 100;
  const cap = opts.maxTaggings ?? 5000;
  const bySignupId = new Map<string, SignupTagging[]>();
  for (const id of signupIds) bySignupId.set(id, []);
  if (signupIds.length === 0) return { bySignupId, truncated: false };

  function ingest(
    data: JsonApiResponse<TaggingAttributes>["data"],
    included: JsonApiResponse<unknown>["included"]
  ): number {
    for (const tagging of data) {
      const signupRel = tagging.relationships?.signup?.data;
      const tagRel = tagging.relationships?.tag?.data;
      if (!signupRel || Array.isArray(signupRel) || !tagRel || Array.isArray(tagRel)) continue;
      const list = bySignupId.get(signupRel.id);
      if (!list) continue; // a signup outside the requested set — ignore
      const tagResource = included?.find((r) => r.type === "signup_tags" && r.id === tagRel.id);
      const name = tagResource ? (tagResource.attributes as TagAttributes).name : null;
      if (name) list.push({ taggingId: tagging.id, tagId: tagRel.id, tagName: name });
    }
    return data.length;
  }

  async function walk(filter: Record<string, string | Record<string, string>>): Promise<{ truncated: boolean }> {
    let page = 1;
    let seen = 0;
    while (true) {
      const response = await client.get<TaggingAttributes>("signup_taggings", {
        filter,
        include: "tag",
        page_size: pageSize,
        page_number: page,
      });
      seen += ingest(response.data, response.included);
      if (seen >= cap) return { truncated: true };
      if (response.data.length < pageSize) return { truncated: false };
      page += 1;
    }
  }

  if (signupIds.length === 1) {
    const result = await walk({ signup_id: signupIds[0] });
    return { bySignupId, truncated: result.truncated };
  }

  try {
    const result = await walk({ signup_id: { in: signupIds.join(",") } });
    return { bySignupId, truncated: result.truncated };
  } catch {
    // Batched [in] filter rejected, or failed partway through a walk that had
    // already ingested some pages — reset and redo from scratch with the
    // verified-working per-signup form so nothing double-counts.
    for (const id of signupIds) bySignupId.set(id, []);
    let truncated = false;
    for (const id of signupIds) {
      const result = await walk({ signup_id: id });
      truncated = truncated || result.truncated;
    }
    return { bySignupId, truncated };
  }
}
