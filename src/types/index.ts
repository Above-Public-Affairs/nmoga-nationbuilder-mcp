/**
 * NationBuilder API v2 type definitions
 * Follows JSON:API specification
 */

// --- JSON:API Generic Types ---

export interface JsonApiResource<T> {
  id: string;
  type: string;
  attributes: T;
  relationships?: Record<string, JsonApiRelationship>;
  links?: Record<string, string>;
}

export interface JsonApiResponse<T> {
  data: JsonApiResource<T>[];
  included?: JsonApiResource<unknown>[];
  meta?: { total?: number; page_count?: number; total_pages?: number };
  links?: { self?: string; next?: string; prev?: string; first?: string; last?: string };
}

export interface JsonApiDocument<T> {
  data: JsonApiResource<T>;
  included?: JsonApiResource<unknown>[];
}

export interface JsonApiRelationship {
  data: { id: string; type: string } | { id: string; type: string }[] | null;
  links?: { self?: string; related?: string };
}

export interface JsonApiCreatePayload<T> {
  data: {
    type: string;
    attributes: Partial<T>;
    relationships?: Record<string, { data: { id: string; type: string } | { id: string; type: string }[] }>;
  };
}

export interface JsonApiUpdatePayload<T> {
  data: {
    id: string;
    type: string;
    attributes: Partial<T>;
  };
}

export interface JsonApiErrorResponse {
  errors: JsonApiError[];
}

export interface JsonApiError {
  status?: string;
  title?: string;
  detail?: string;
  code?: string;
  source?: { pointer?: string; parameter?: string };
}

// --- Query Parameters ---

export interface QueryParams {
  filter?: Record<string, string | Record<string, string>>;
  sort?: string;
  page_size?: number;
  page_number?: number;
  fields?: Record<string, string>;
  include?: string;
}

// --- NationBuilder Resource Attributes ---

export interface SignupAttributes {
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
  email_opt_in: boolean | null;
  phone: string | null;
  mobile: string | null;
  support_level: number | null;
  /** 0 = person, 1 = organization. NB V2 has no `is_organization` attribute. */
  signup_type: number | null;
  is_volunteer: boolean | null;
  is_donor: boolean | null;
  registered_address_address1: string | null;
  registered_address_city: string | null;
  registered_address_state: string | null;
  registered_address_zip: string | null;
  employer: string | null;
  occupation: string | null;
  note: string | null;
  created_at: string | null;
  updated_at: string | null;
  custom_values: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface DonationAttributes {
  amount: string | null;
  amount_in_cents: number | null;
  payment_type: string | null;
  tracking_code: string | null;
  note: string | null;
  succeeded_at: string | null;
  failed_at: string | null;
  canceled_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface EventAttributes {
  name: string | null;
  slug: string | null;
  status: string | null;
  starts_at: string | null;
  ends_at: string | null;
  intro: string | null;
  venue_name: string | null;
  venue_address: string | null;
  venue_city: string | null;
  venue_state: string | null;
  rsvp_count: number | null;
  capacity: number | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface ContactAttributes {
  type_id: string | null;
  method: string | null;
  note: string | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface TagAttributes {
  name: string;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface TaggingAttributes {
  created_at: string | null;
  [key: string]: unknown;
}

export interface ListAttributes {
  name: string | null;
  slug: string | null;
  author_id: number | null;
  count: number | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface EventRsvpAttributes {
  guests_count: number | null;
  canceled: boolean | null;
  attended: boolean | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface MembershipAttributes {
  name: string | null;
  status: string | null;
  started_at: string | null;
  expires_on: string | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface MembershipTypeAttributes {
  name: string | null;
  description: string | null;
  amount_in_cents: number | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface PathAttributes {
  name: string | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface PathJourneyAttributes {
  status: string | null;
  current_step_name: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface NativeRelationshipAttributes {
  relationship_type: string | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface SignupProfileAttributes {
  bio: string | null;
  headline: string | null;
  website: string | null;
  facebook_url: string | null;
  twitter_url: string | null;
  linkedin_url: string | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface PetitionAttributes {
  name: string | null;
  description: string | null;
  slug: string | null;
  signatures_count: number | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface PetitionSignatureAttributes {
  comment: string | null;
  is_private: boolean | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface MailingAttributes {
  name: string | null;
  subject: string | null;
  status: string | null;
  sent_at: string | null;
  recipients_count: number | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface PageAttributes {
  name: string | null;
  slug: string | null;
  page_type: string | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface SiteAttributes {
  name: string | null;
  domain: string | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface AutomationAttributes {
  name: string | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface AutomationEnrollmentAttributes {
  status: string | null;
  enrolled_at: string | null;
  completed_at: string | null;
  created_at: string | null;
  [key: string]: unknown;
}

export interface SignupSourceAttributes {
  source: string | null;
  source_type: string | null;
  created_at: string | null;
  [key: string]: unknown;
}

export interface IdentityMappingAttributes {
  external_id: string | null;
  provider: string | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface ImportAttributes {
  status: string | null;
  import_type: string | null;
  created_count: number | null;
  updated_count: number | null;
  error_count: number | null;
  created_at: string | null;
  [key: string]: unknown;
}
