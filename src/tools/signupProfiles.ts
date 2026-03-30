/**
 * Signup Profile tools for NationBuilder
 * - get_signup_profile: Get profile for a person (bio, headline, social links, etc.)
 * - update_signup_profile: Update profile fields (with overwrite warning)
 *
 * NB confirmed: signup_profile ID must be looked up via sideloading on the signup,
 * then fetched directly at /api/v2/signup_profiles/{signup_profile_id}
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { SignupProfileAttributes } from "../types/index.js";
import { formatSignupProfile, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

async function getProfileId(
  client: NationBuilderClient,
  signup_id: string
): Promise<string | null> {
  const signupResponse = await client.getById("signups", signup_id, {
    include: "signup_profile",
  });

  // The profile ID comes from the relationship data on the signup
  const rel = (signupResponse.data as { relationships?: { signup_profile?: { data?: { id?: string } } } })
    .relationships?.signup_profile?.data;

  return rel?.id ?? null;
}

export function registerSignupProfileTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.tool(
    "get_signup_profile",
    "Get the profile for a person in NationBuilder (bio, headline, social media links, etc.).",
    {
      signup_id: z.string().describe("The NationBuilder signup ID"),
    },
    async (params) => {
      try {
        const profileId = await getProfileId(client, params.signup_id);

        if (!profileId) {
          return {
            content: [{ type: "text" as const, text: `No profile found for person ${params.signup_id}.` }],
          };
        }

        const response = await client.getById<SignupProfileAttributes>("signup_profiles", profileId);
        const result = formatSignupProfile(response.data);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "get_signup_profile failed", rawError: error, context: { signup_id: params.signup_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error getting profile: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.tool(
    "update_signup_profile",
    "WARNING: OVERWRITES existing profile fields with the values you provide. Any field you set will REPLACE the current value. Fields you omit are left unchanged. Verify the changes before proceeding.",
    {
      signup_id: z.string().describe("The NationBuilder signup ID to update the profile for"),
      bio: z.string().optional().describe("Biography text"),
      headline: z.string().optional().describe("Profile headline"),
      website: z.string().optional().describe("Website URL"),
      facebook_url: z.string().optional().describe("Facebook profile URL"),
      twitter_url: z.string().optional().describe("Twitter profile URL"),
      linkedin_url: z.string().optional().describe("LinkedIn profile URL"),
    },
    async (params) => {
      try {
        const { signup_id, ...fields } = params;
        const attributes: Partial<SignupProfileAttributes> = {};
        for (const [key, value] of Object.entries(fields)) {
          if (value !== undefined) {
            (attributes as Record<string, unknown>)[key] = value;
          }
        }

        if (Object.keys(attributes).length === 0) {
          return {
            content: [{ type: "text" as const, text: "No fields to update. Provide at least one field to change." }],
          };
        }

        const profileId = await getProfileId(client, signup_id);

        if (!profileId) {
          return {
            content: [{ type: "text" as const, text: `No profile found for person ${signup_id}. The person may not have a profile yet.` }],
          };
        }

        const response = await client.update<SignupProfileAttributes>(
          "signup_profiles",
          profileId,
          {
            data: {
              id: profileId,
              type: "signup_profiles",
              attributes,
            },
          }
        );

        const result = `Profile updated successfully:\n\n${formatSignupProfile(response.data)}`;

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "update_signup_profile failed", rawError: error, context: { signup_id: params.signup_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error updating profile: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
