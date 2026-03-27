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
} from "../types/index.js";

export function formatSignup(resource: JsonApiResource<SignupAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];

  lines.push(`**${a.full_name || [a.first_name, a.last_name].filter(Boolean).join(" ") || "Unknown"}** (ID: ${resource.id})`);

  if (a.email) lines.push(`  Email: ${a.email}`);
  if (a.phone) lines.push(`  Phone: ${a.phone}`);
  if (a.mobile) lines.push(`  Mobile: ${a.mobile}`);
  if (a.support_level != null) lines.push(`  Support Level: ${a.support_level}`);
  if (a.is_volunteer) lines.push(`  Volunteer: Yes`);
  if (a.is_donor) lines.push(`  Donor: Yes`);
  if (a.employer) lines.push(`  Employer: ${a.employer}`);
  if (a.occupation) lines.push(`  Occupation: ${a.occupation}`);

  const addressParts = [
    a.registered_address_city,
    a.registered_address_state,
    a.registered_address_zip,
  ].filter(Boolean);
  if (addressParts.length > 0) {
    lines.push(`  Location: ${addressParts.join(", ")}`);
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

export function formatMembership(resource: JsonApiResource<MembershipAttributes>): string {
  const a = resource.attributes;
  const lines: string[] = [];
  lines.push(`**${a.name || "Membership"}** (ID: ${resource.id})`);
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
  if (a.page_type) lines.push(`  Type: ${a.page_type}`);
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

export function formatPagination<T>(response: JsonApiResponse<T>, pageNumber: number, pageSize: number): string {
  const total = response.meta?.total;
  const totalPages = response.meta?.total_pages || response.meta?.page_count;

  const parts: string[] = [];
  parts.push(`Page ${pageNumber}`);
  if (totalPages) parts.push(`of ${totalPages}`);
  if (total != null) parts.push(`(${total} total)`);

  return `\n---\n${parts.join(" ")}`;
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
