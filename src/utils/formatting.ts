/**
 * Response formatting utilities for NationBuilder data
 */

import type {
  JsonApiResource,
  JsonApiResponse,
  SignupAttributes,
  DonationAttributes,
  EventAttributes,
  ContactAttributes,
  TagAttributes,
  ListAttributes,
  EventRsvpAttributes,
  MembershipAttributes,
  MembershipTypeAttributes,
  PathAttributes,
  PathJourneyAttributes,
  NativeRelationshipAttributes,
  SignupProfileAttributes,
  PetitionAttributes,
  PetitionSignatureAttributes,
  MailingAttributes,
  PageAttributes,
  SiteAttributes,
  AutomationAttributes,
  AutomationEnrollmentAttributes,
  ImportAttributes,
  SignupSourceAttributes,
  IdentityMappingAttributes,
} from "../types/index.js";

export function formatSignup(resource: JsonApiResource<SignupAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];

  lines.push(`**${a.full_name || [a.first_name, a.last_name].filter(Boolean).join(" ") || "Unknown"}** (ID: ${resource.id})`);

  if (a.signup_type === 1) lines.push(`  Type: Organization`);

  if (a.email) lines.push(`  Email: ${a.email}`);
  if (a.phone_number) lines.push(`  Phone: ${a.phone_number}`);
  if (a.mobile_number) lines.push(`  Mobile: ${a.mobile_number}`);
  if (a.support_level != null) lines.push(`  Support Level: ${a.support_level}`);
  if (a.is_volunteer) lines.push(`  Volunteer: Yes`);
  if (a.is_donor) lines.push(`  Donor: Yes`);
  if (a.employer) lines.push(`  Employer: ${a.employer}`);
  if (a.occupation) lines.push(`  Occupation: ${a.occupation}`);

  // Only present when the caller requested extra_fields[signups]=registered_address
  // — there is no flat registered_address_city/_state/_zip attribute to read.
  if (a.registered_address) {
    const addressParts = [
      a.registered_address.city,
      a.registered_address.state,
      a.registered_address.zip,
    ].filter(Boolean);
    if (addressParts.length > 0) {
      lines.push(`  Location: ${addressParts.join(", ")}`);
    }
  }

  if (a.note) lines.push(`  Note: ${a.note}`);

  if (a.custom_values && typeof a.custom_values === "object") {
    const entries = Object.entries(a.custom_values).filter(([, v]) => v != null);
    if (entries.length > 0) {
      lines.push(`  Custom: ${entries.map(([k, v]) => `${k}=${String(v)}`).join(", ")}`);
    }
  }

  if (a.created_at) lines.push(`  Created: ${formatDate(a.created_at)}`);

  return lines.join("\n");
}

export function formatDonation(resource: JsonApiResource<DonationAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];

  const amount = a.amount || (a.amount_in_cents ? `$${(a.amount_in_cents / 100).toFixed(2)}` : "Unknown amount");
  lines.push(`**$${amount}** (ID: ${resource.id})`);

  if (a.payment_type) lines.push(`  Payment: ${a.payment_type}`);
  if (a.tracking_code) lines.push(`  Tracking: ${a.tracking_code}`);
  if (a.succeeded_at) lines.push(`  Date: ${formatDate(a.succeeded_at)}`);
  else if (a.created_at) lines.push(`  Created: ${formatDate(a.created_at)}`);
  if (a.note) lines.push(`  Note: ${a.note}`);

  return lines.join("\n");
}

export function formatEvent(resource: JsonApiResource<EventAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];

  lines.push(`**${a.name || "Untitled Event"}** (ID: ${resource.id})`);

  if (a.status) lines.push(`  Status: ${a.status}`);
  if (a.starts_at) {
    lines.push(`  Starts: ${formatDate(a.starts_at)}`);
    if (a.ends_at) lines.push(`  Ends: ${formatDate(a.ends_at)}`);
  }

  const venueParts = [a.venue_name, a.venue_city, a.venue_state].filter(Boolean);
  if (venueParts.length > 0) {
    lines.push(`  Venue: ${venueParts.join(", ")}`);
  }

  if (a.rsvp_count != null) {
    let rsvpText = `  RSVPs: ${a.rsvp_count}`;
    if (a.capacity) rsvpText += ` / ${a.capacity}`;
    lines.push(rsvpText);
  }

  if (a.intro) lines.push(`  Description: ${a.intro.substring(0, 200)}${a.intro.length > 200 ? "..." : ""}`);

  return lines.join("\n");
}

export function formatContact(resource: JsonApiResource<ContactAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];

  lines.push(`**${a.type_id || "Contact"}** (ID: ${resource.id})`);

  if (a.method) lines.push(`  Method: ${a.method}`);
  if (a.status) lines.push(`  Status: ${a.status}`);
  if (a.note) lines.push(`  Note: ${a.note.substring(0, 300)}${a.note.length > 300 ? "..." : ""}`);
  if (a.created_at) lines.push(`  Date: ${formatDate(a.created_at)}`);

  return lines.join("\n");
}

export function formatTag(resource: JsonApiResource<TagAttributes>): string {
  return `- **${resource.attributes.name}** (ID: ${resource.id})`;
}

export interface PersonTagEntry {
  name: string;
  id: string;
}

/**
 * Render a person's tag list. Zero tags renders as an explicit "No tags" —
 * never as an omitted entry. A prior incident inferred "this person has no
 * committee tags" from a person simply being absent from a filtered result
 * set; that inference must not be possible to reach from this tool's output.
 */
export function formatPersonTags(personLabel: string, tags: PersonTagEntry[]): string {
  const lines: string[] = [`**${personLabel}**`];
  if (tags.length === 0) {
    lines.push(`  No tags.`);
  } else {
    for (const tag of tags) {
      lines.push(`  - ${tag.name} (ID: ${tag.id})`);
    }
  }
  return lines.join("\n");
}

export function formatList(resource: JsonApiResource<ListAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];

  lines.push(`**${a.name || "Untitled List"}** (ID: ${resource.id})`);
  if (a.slug) lines.push(`  Slug: ${a.slug}`);
  if (a.count != null) lines.push(`  Count: ${a.count}`);
  if (a.created_at) lines.push(`  Created: ${formatDate(a.created_at)}`);

  return lines.join("\n");
}

export function formatRsvp(
  resource: JsonApiResource<EventRsvpAttributes>,
  included?: JsonApiResource<unknown>[]
): string {
  const a = resource.attributes;
  const lines: string[] = [];

  // Try to find the associated signup from included resources
  let personName = `RSVP ID: ${resource.id}`;
  if (resource.relationships?.signup?.data && included) {
    const rel = resource.relationships.signup.data;
    if (!Array.isArray(rel)) {
      const signup = included.find(
        (r) => r.type === "signups" && r.id === rel.id
      ) as JsonApiResource<SignupAttributes> | undefined;
      if (signup) {
        personName = signup.attributes.full_name ||
          [signup.attributes.first_name, signup.attributes.last_name].filter(Boolean).join(" ") ||
          `Signup ${rel.id}`;
      }
    }
  }

  lines.push(`**${personName}**`);
  if (a.guests_count != null && a.guests_count > 0) lines.push(`  Guests: ${a.guests_count}`);
  if (a.attended) lines.push(`  Attended: Yes`);
  if (a.canceled) lines.push(`  Canceled: Yes`);
  if (a.created_at) lines.push(`  RSVP Date: ${formatDate(a.created_at)}`);

  return lines.join("\n");
}

export function formatMembership(
  resource: JsonApiResource<MembershipAttributes>,
  included?: JsonApiResource<unknown>[]
): string {
  const a = resource.attributes;
  const lines: string[] = [];

  // Memberships carry no useful info on their own — they're a status/date
  // record hung off a signup and a membership type. Without sideloading
  // those (via include=signup,membership_type, which list_memberships and
  // get_membership both request), every row rendered identically regardless
  // of whose membership it was.
  let personName = "";
  let membershipTypeName = "";
  if (included) {
    const signupRel = resource.relationships?.signup?.data;
    if (signupRel && !Array.isArray(signupRel)) {
      const signup = included.find(
        (r) => r.type === "signups" && r.id === signupRel.id
      ) as JsonApiResource<SignupAttributes> | undefined;
      if (signup) {
        personName =
          signup.attributes.full_name ||
          [signup.attributes.first_name, signup.attributes.last_name].filter(Boolean).join(" ") ||
          "";
      }
    }
    const typeRel = resource.relationships?.membership_type?.data;
    if (typeRel && !Array.isArray(typeRel)) {
      const membershipType = included.find(
        (r) => r.type === "membership_types" && r.id === typeRel.id
      ) as JsonApiResource<MembershipTypeAttributes> | undefined;
      if (membershipType) {
        membershipTypeName = membershipType.attributes.name || "";
      }
    }
  }

  const title = a.name || membershipTypeName || "Membership";
  lines.push(`**${title}**${personName ? ` — ${personName}` : ""} (ID: ${resource.id})`);
  if (membershipTypeName && membershipTypeName !== title) lines.push(`  Type: ${membershipTypeName}`);
  if (a.status) lines.push(`  Status: ${a.status}`);
  if (a.started_at) lines.push(`  Started: ${formatDate(a.started_at)}`);
  if (a.expires_on) lines.push(`  Expires: ${formatDate(a.expires_on)}`);
  if (a.created_at) lines.push(`  Created: ${formatDate(a.created_at)}`);
  return lines.join("\n");
}

export function formatMembershipType(resource: JsonApiResource<MembershipTypeAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];
  lines.push(`**${a.name || "Membership Type"}** (ID: ${resource.id})`);
  if (a.description) lines.push(`  Description: ${a.description.substring(0, 200)}${a.description.length > 200 ? "..." : ""}`);
  if (a.amount_in_cents != null) lines.push(`  Amount: $${(a.amount_in_cents / 100).toFixed(2)}`);
  if (a.created_at) lines.push(`  Created: ${formatDate(a.created_at)}`);
  return lines.join("\n");
}

export function formatPath(resource: JsonApiResource<PathAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];
  lines.push(`**${a.name || "Path"}** (ID: ${resource.id})`);
  if (a.created_at) lines.push(`  Created: ${formatDate(a.created_at)}`);
  return lines.join("\n");
}

export function formatPathJourney(
  resource: JsonApiResource<PathJourneyAttributes>,
  included?: JsonApiResource<unknown>[]
): string {
  const a = resource.attributes;
  const lines: string[] = [];

  let personName = "";
  if (resource.relationships?.signup?.data && included) {
    const rel = resource.relationships.signup.data;
    if (!Array.isArray(rel)) {
      const signup = included.find((r) => r.type === "signups" && r.id === rel.id) as JsonApiResource<SignupAttributes> | undefined;
      if (signup) {
        personName = signup.attributes.full_name || [signup.attributes.first_name, signup.attributes.last_name].filter(Boolean).join(" ") || "";
      }
    }
  }

  lines.push(`**Journey ${resource.id}**${personName ? ` — ${personName}` : ""}`);
  if (a.status) lines.push(`  Status: ${a.status}`);
  if (a.current_step_name) lines.push(`  Current Step: ${a.current_step_name}`);
  if (a.started_at) lines.push(`  Started: ${formatDate(a.started_at)}`);
  if (a.completed_at) lines.push(`  Completed: ${formatDate(a.completed_at)}`);
  return lines.join("\n");
}

export function formatNativeRelationship(
  resource: JsonApiResource<NativeRelationshipAttributes>,
  included?: JsonApiResource<unknown>[]
): string {
  const a = resource.attributes;
  const lines: string[] = [];

  let firstName = "";
  let secondName = "";
  if (included) {
    if (resource.relationships?.first_signup?.data) {
      const rel = resource.relationships.first_signup.data;
      if (!Array.isArray(rel)) {
        const signup = included.find((r) => r.type === "signups" && r.id === rel.id) as JsonApiResource<SignupAttributes> | undefined;
        if (signup) firstName = signup.attributes.full_name || [signup.attributes.first_name, signup.attributes.last_name].filter(Boolean).join(" ") || `ID ${rel.id}`;
      }
    }
    if (resource.relationships?.second_signup?.data) {
      const rel = resource.relationships.second_signup.data;
      if (!Array.isArray(rel)) {
        const signup = included.find((r) => r.type === "signups" && r.id === rel.id) as JsonApiResource<SignupAttributes> | undefined;
        if (signup) secondName = signup.attributes.full_name || [signup.attributes.first_name, signup.attributes.last_name].filter(Boolean).join(" ") || `ID ${rel.id}`;
      }
    }
  }

  lines.push(`**${a.relationship_type || "Relationship"}** (ID: ${resource.id})`);
  if (firstName) lines.push(`  Person 1: ${firstName}`);
  if (secondName) lines.push(`  Person 2: ${secondName}`);
  if (a.created_at) lines.push(`  Created: ${formatDate(a.created_at)}`);
  return lines.join("\n");
}

export function formatSignupProfile(resource: JsonApiResource<SignupProfileAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];
  lines.push(`**Profile** (ID: ${resource.id})`);
  if (a.headline) lines.push(`  Headline: ${a.headline}`);
  if (a.bio) lines.push(`  Bio: ${a.bio.substring(0, 300)}${a.bio.length > 300 ? "..." : ""}`);
  if (a.website) lines.push(`  Website: ${a.website}`);
  if (a.facebook_url) lines.push(`  Facebook: ${a.facebook_url}`);
  if (a.twitter_url) lines.push(`  Twitter: ${a.twitter_url}`);
  if (a.linkedin_url) lines.push(`  LinkedIn: ${a.linkedin_url}`);
  return lines.join("\n");
}

export function formatPetition(resource: JsonApiResource<PetitionAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];
  lines.push(`**${a.name || "Petition"}** (ID: ${resource.id})`);
  if (a.slug) lines.push(`  Slug: ${a.slug}`);
  if (a.signatures_count != null) lines.push(`  Signatures: ${a.signatures_count}`);
  if (a.description) lines.push(`  Description: ${a.description.substring(0, 200)}${a.description.length > 200 ? "..." : ""}`);
  if (a.created_at) lines.push(`  Created: ${formatDate(a.created_at)}`);
  return lines.join("\n");
}

export function formatPetitionSignature(
  resource: JsonApiResource<PetitionSignatureAttributes>,
  included?: JsonApiResource<unknown>[]
): string {
  const a = resource.attributes;
  const lines: string[] = [];

  let personName = `Signature ${resource.id}`;
  if (resource.relationships?.signup?.data && included) {
    const rel = resource.relationships.signup.data;
    if (!Array.isArray(rel)) {
      const signup = included.find((r) => r.type === "signups" && r.id === rel.id) as JsonApiResource<SignupAttributes> | undefined;
      if (signup) {
        personName = signup.attributes.full_name || [signup.attributes.first_name, signup.attributes.last_name].filter(Boolean).join(" ") || `Signup ${rel.id}`;
      }
    }
  }

  lines.push(`**${personName}** (ID: ${resource.id})`);
  if (a.comment) lines.push(`  Comment: ${a.comment.substring(0, 300)}${a.comment.length > 300 ? "..." : ""}`);
  if (a.is_private) lines.push(`  Private: Yes`);
  if (a.created_at) lines.push(`  Signed: ${formatDate(a.created_at)}`);
  return lines.join("\n");
}

export function formatMailing(resource: JsonApiResource<MailingAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];
  lines.push(`**${a.name || "Mailing"}** (ID: ${resource.id})`);
  if (a.subject) lines.push(`  Subject: ${a.subject}`);
  if (a.status) lines.push(`  Status: ${a.status}`);
  if (a.recipients_count != null) lines.push(`  Recipients: ${a.recipients_count}`);
  if (a.sent_at) lines.push(`  Sent: ${formatDate(a.sent_at)}`);
  else if (a.created_at) lines.push(`  Created: ${formatDate(a.created_at)}`);
  return lines.join("\n");
}

export function formatPage(resource: JsonApiResource<PageAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];
  lines.push(`**${a.name || "Page"}** (ID: ${resource.id})`);
  if (a.slug) lines.push(`  Slug: ${a.slug}`);
  if (a.status) lines.push(`  Status: ${a.status}`);
  if (a.created_at) lines.push(`  Created: ${formatDate(a.created_at)}`);
  return lines.join("\n");
}

export function formatSite(resource: JsonApiResource<SiteAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];
  lines.push(`**${a.name || "Site"}** (ID: ${resource.id})`);
  if (a.domain) lines.push(`  Domain: ${a.domain}`);
  if (a.created_at) lines.push(`  Created: ${formatDate(a.created_at)}`);
  return lines.join("\n");
}

export function formatAutomation(resource: JsonApiResource<AutomationAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];
  lines.push(`**${a.name || "Automation"}** (ID: ${resource.id})`);
  if (a.status) lines.push(`  Status: ${a.status}`);
  if (a.created_at) lines.push(`  Created: ${formatDate(a.created_at)}`);
  return lines.join("\n");
}

export function formatAutomationEnrollment(
  resource: JsonApiResource<AutomationEnrollmentAttributes>,
  included?: JsonApiResource<unknown>[]
): string {
  const a = resource.attributes;
  const lines: string[] = [];

  let personName = "";
  if (resource.relationships?.signup?.data && included) {
    const rel = resource.relationships.signup.data;
    if (!Array.isArray(rel)) {
      const signup = included.find((r) => r.type === "signups" && r.id === rel.id) as JsonApiResource<SignupAttributes> | undefined;
      if (signup) {
        personName = signup.attributes.full_name || [signup.attributes.first_name, signup.attributes.last_name].filter(Boolean).join(" ") || "";
      }
    }
  }

  lines.push(`**Enrollment ${resource.id}**${personName ? ` — ${personName}` : ""}`);
  if (a.status) lines.push(`  Status: ${a.status}`);
  if (a.enrolled_at) lines.push(`  Enrolled: ${formatDate(a.enrolled_at)}`);
  if (a.completed_at) lines.push(`  Completed: ${formatDate(a.completed_at)}`);
  return lines.join("\n");
}

export function formatImport(resource: JsonApiResource<ImportAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];
  lines.push(`**${a.import_type || "Import"}** (ID: ${resource.id})`);
  if (a.status) lines.push(`  Status: ${a.status}`);
  if (a.created_count != null) lines.push(`  Created: ${a.created_count}`);
  if (a.updated_count != null) lines.push(`  Updated: ${a.updated_count}`);
  if (a.error_count != null) lines.push(`  Errors: ${a.error_count}`);
  if (a.created_at) lines.push(`  Date: ${formatDate(a.created_at)}`);
  return lines.join("\n");
}

export function formatSignupSource(resource: JsonApiResource<SignupSourceAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];
  lines.push(`**${a.source || "Unknown Source"}** (ID: ${resource.id})`);
  if (a.source_type) lines.push(`  Type: ${a.source_type}`);
  if (a.created_at) lines.push(`  Date: ${formatDate(a.created_at)}`);
  return lines.join("\n");
}

export function formatIdentityMapping(resource: JsonApiResource<IdentityMappingAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];
  lines.push(`**${a.provider || "Mapping"}** (ID: ${resource.id})`);
  if (a.external_id) lines.push(`  External ID: ${a.external_id}`);
  if (a.created_at) lines.push(`  Created: ${formatDate(a.created_at)}`);
  return lines.join("\n");
}

// --- Generic renderer for `response.included` (sideloaded resources) -------
//
// Any tool that requests `include=...` gets JSON:API `included` records back
// alongside `data`. Historically several call sites fetched them and never
// rendered them (see CHANGELOG — advanced_search's `include` param paid the
// round-trip and silently dropped whatever came back). These two functions
// are the one shared place that turns `included` into text, dispatching to
// the existing per-type formatter above where one exists.

type IncludedFormatter = (
  resource: JsonApiResource<any>,
  included?: JsonApiResource<unknown>[]
) => string;

/**
 * JSON:API `type` string -> the existing formatter for it. Keys are the
 * plural snake_case resource-path names NationBuilder actually returns
 * (confirmed against live responses and the create/update payloads already
 * in this codebase — e.g. "signups", "signup_tags", "membership_types",
 * "path_steps"). Deliberately not exhaustive: an unmapped type falls through
 * to formatGenericIncluded below rather than needing a new entry here every
 * time NationBuilder adds a relationship.
 */
const INCLUDED_FORMATTERS: Record<string, IncludedFormatter> = {
  signups: (r) => formatSignup(r as JsonApiResource<SignupAttributes>),
  signup_tags: (r) => formatTag(r as JsonApiResource<TagAttributes>),
  memberships: (r, inc) => formatMembership(r as JsonApiResource<MembershipAttributes>, inc),
  membership_types: (r) => formatMembershipType(r as JsonApiResource<MembershipTypeAttributes>),
  donations: (r) => formatDonation(r as JsonApiResource<DonationAttributes>),
  events: (r) => formatEvent(r as JsonApiResource<EventAttributes>),
  contacts: (r) => formatContact(r as JsonApiResource<ContactAttributes>),
  lists: (r) => formatList(r as JsonApiResource<ListAttributes>),
  event_rsvps: (r, inc) => formatRsvp(r as JsonApiResource<EventRsvpAttributes>, inc),
  paths: (r) => formatPath(r as JsonApiResource<PathAttributes>),
  path_journeys: (r, inc) => formatPathJourney(r as JsonApiResource<PathJourneyAttributes>, inc),
  relationships: (r, inc) => formatNativeRelationship(r as JsonApiResource<NativeRelationshipAttributes>, inc),
  signup_profiles: (r) => formatSignupProfile(r as JsonApiResource<SignupProfileAttributes>),
  petitions: (r) => formatPetition(r as JsonApiResource<PetitionAttributes>),
  petition_signatures: (r, inc) => formatPetitionSignature(r as JsonApiResource<PetitionSignatureAttributes>, inc),
  mailings: (r) => formatMailing(r as JsonApiResource<MailingAttributes>),
  pages: (r) => formatPage(r as JsonApiResource<PageAttributes>),
  sites: (r) => formatSite(r as JsonApiResource<SiteAttributes>),
  automations: (r) => formatAutomation(r as JsonApiResource<AutomationAttributes>),
  automation_enrollments: (r, inc) => formatAutomationEnrollment(r as JsonApiResource<AutomationEnrollmentAttributes>, inc),
  imports: (r) => formatImport(r as JsonApiResource<ImportAttributes>),
  signup_sources: (r) => formatSignupSource(r as JsonApiResource<SignupSourceAttributes>),
  identity_mappings: (r) => formatIdentityMapping(r as JsonApiResource<IdentityMappingAttributes>),
};

const GENERIC_VALUE_MAX_LEN = 120;

/**
 * Fallback for a sideloaded resource type with no formatter above (a
 * relationship NationBuilder added, or one we haven't wired up yet). Never
 * drops the record — renders id, type, and scalar attributes. Nested
 * objects/arrays are skipped rather than guessed at, since there's no
 * type-specific knowledge of what they mean here.
 */
function formatGenericIncluded(resource: JsonApiResource<unknown>): string {
  const lines: string[] = [`**${resource.type}** (ID: ${resource.id})`];
  const attrs = resource.attributes;
  if (attrs && typeof attrs === "object") {
    for (const [key, value] of Object.entries(attrs as Record<string, unknown>)) {
      if (value == null || typeof value === "object") continue;
      const str = String(value);
      lines.push(`  ${key}: ${str.length > GENERIC_VALUE_MAX_LEN ? `${str.slice(0, GENERIC_VALUE_MAX_LEN)}...` : str}`);
    }
  }
  return lines.join("\n");
}

/** Render one sideloaded resource, dispatching on its JSON:API `type`. */
export function formatIncludedResource(
  resource: JsonApiResource<unknown>,
  included?: JsonApiResource<unknown>[]
): string {
  const formatter = INCLUDED_FORMATTERS[resource.type];
  if (!formatter) return formatGenericIncluded(resource);
  try {
    return formatter(resource, included);
  } catch {
    // A formatter assumes its type's attribute shape; if a real response
    // doesn't match that assumption, fall back rather than let one bad
    // record blank out the whole section.
    return formatGenericIncluded(resource);
  }
}

/** Cap per type so a page of sideloads with hundreds of records in one
 *  relationship can't blow up the response — the cap is stated explicitly
 *  rather than silently truncating, since silent drops are the exact defect
 *  this exists to fix. */
const MAX_INCLUDED_PER_TYPE = 25;

/**
 * Render every sideloaded resource from a JSON:API `included` array, grouped
 * by type. Returns "" if there's nothing to show (no `include` was
 * requested, or NationBuilder returned none) — callers can append the result
 * unconditionally without an extra empty-check.
 */
export function formatIncludedSection(included?: JsonApiResource<unknown>[]): string {
  if (!included || included.length === 0) return "";

  const byType = new Map<string, JsonApiResource<unknown>[]>();
  for (const resource of included) {
    const bucket = byType.get(resource.type);
    if (bucket) bucket.push(resource);
    else byType.set(resource.type, [resource]);
  }

  const sections: string[] = [];
  for (const type of Array.from(byType.keys()).sort()) {
    const resources = byType.get(type)!;
    const shown = resources.slice(0, MAX_INCLUDED_PER_TYPE);
    let section = `### ${type} (${resources.length})\n\n${shown
      .map((r) => formatIncludedResource(r, included))
      .join("\n\n")}`;
    if (resources.length > shown.length) {
      section += `\n\n(+${resources.length - shown.length} more ${type} not shown)`;
    }
    sections.push(section);
  }

  return `\n---\n**Included:**\n\n${sections.join("\n\n")}`;
}

export interface PaginationInfo {
  /** True only when we have positive evidence there is nothing more to fetch. */
  complete: boolean;
  /** A real total NationBuilder reported, if any. NB V2 has not been observed
   *  to send one on any endpoint this server calls (signups, signup_tags,
   *  signup_taggings, lists all confirmed empty live) — never fabricate this
   *  from `response.data.length`, which is a page size, not a count. */
  total: number | null;
  /** Page number to request next, or null if `complete` is true. */
  nextPage: number | null;
}

/**
 * The one place that reads a total off `meta`. NB has been seen to use both
 * `total` and, on some endpoints historically, `total_count` — shared here so
 * every caller (this file, `tagLookup.ts`) agrees on precedence instead of
 * duplicating the fallback.
 */
export function readTotal(meta: JsonApiResponse<unknown>["meta"]): number | null {
  if (!meta) return null;
  if (typeof meta.total === "number") return meta.total;
  if (typeof meta.total_count === "number") return meta.total_count;
  return null;
}

/**
 * Decide whether a page is the whole answer using only evidence NationBuilder
 * actually provides, strongest signal first. In production none of the
 * `meta`/`links` branches have ever fired for this server's endpoints — the
 * `data.length >= pageSize` fallback is the one path that runs today. That
 * makes it the load-bearing check, not a rare edge case, so it must never be
 * silently skipped or degrade to "assume complete."
 */
export function resolvePagination<T>(
  response: JsonApiResponse<T>,
  pageNumber: number,
  pageSize: number
): PaginationInfo {
  const total = readTotal(response.meta);
  const totalPages = response.meta?.total_pages || response.meta?.page_count || null;

  if (response.links?.next) {
    return { complete: false, total, nextPage: pageNumber + 1 };
  }

  if (totalPages != null) {
    const complete = pageNumber >= totalPages;
    return { complete, total, nextPage: complete ? null : pageNumber + 1 };
  }

  if (total != null) {
    const complete = pageNumber * pageSize >= total;
    return { complete, total, nextPage: complete ? null : pageNumber + 1 };
  }

  // No total, no page count, no next link — the only remaining evidence is
  // whether this page was full. A full page means more almost certainly
  // exist; NEVER treat "no signal" as "complete."
  const full = response.data.length >= pageSize;
  return { complete: !full, total: null, nextPage: full ? pageNumber + 1 : null };
}

/**
 * Footer for a paginated result. Always resolves to an explicit complete-or-
 * incomplete statement — never a bare "Page N" that could be mistaken for
 * "that's everything." Terse when complete (this is the common case and runs
 * on every paginated tool call); an explicit instruction, including the exact
 * next call, when not.
 */
export function formatPagination<T>(response: JsonApiResponse<T>, pageNumber: number, pageSize: number): string {
  const info = resolvePagination(response, pageNumber, pageSize);

  if (info.complete) {
    const totalPart = info.total != null ? ` (${info.total} total)` : "";
    return `\n---\nPage ${pageNumber}${totalPart} — complete, no more results.`;
  }

  const shown = response.data.length;
  const totalPart = info.total != null ? ` of ${info.total} total` : "";
  return (
    `\n---\nINCOMPLETE — page ${pageNumber} returned ${shown} result${shown === 1 ? "" : "s"}${totalPart}. ` +
    `More results likely exist. Call again with page_number: ${info.nextPage} before treating this as the full answer.`
  );
}

/**
 * One line to place ABOVE the results, not just in the footer. A footer-only
 * warning is read after a conclusion has already formed from the data above
 * it — which is exactly how a prior session read 34 page-1 tag scans as
 * complete. Returns "" when the page is complete, so callers can
 * unconditionally prepend it with no branching at the call site.
 */
export function formatIncompleteHeader<T>(response: JsonApiResponse<T>, pageNumber: number, pageSize: number): string {
  const info = resolvePagination(response, pageNumber, pageSize);
  if (info.complete) return "";
  return `[INCOMPLETE RESULTS — more likely exist beyond page ${pageNumber}; see note at the end]\n\n`;
}

/**
 * Wrap a fully-built result body with both the pre-data warning and the
 * footer, so tool handlers need one call instead of two independent ones that
 * could drift out of sync with each other.
 */
export function paginatedResult<T>(
  body: string,
  response: JsonApiResponse<T>,
  pageNumber: number,
  pageSize: number
): string {
  return (
    formatIncompleteHeader(response, pageNumber, pageSize) +
    body +
    formatPagination(response, pageNumber, pageSize)
  );
}

/**
 * Shared wording for "we stopped fetching before exhausting the result set,"
 * used by capped walks (tag-membership intersection, person-tag lookups)
 * that are a different shape from single-page pagination above — there is no
 * `page_number` to hand back, just a hard cap that was hit.
 */
export function formatTruncationNotice(itemLabel: string, shown: number, cap: number): string {
  return `TRUNCATED — stopped after ${shown} ${itemLabel} (cap: ${cap}). More may exist; this is not the complete set.`;
}

export function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

export function sanitizeText(text: string): string {
  // Remove unpaired surrogates that can cause JSON serialization issues
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
