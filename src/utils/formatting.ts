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
