/**
 * NationBuilder API v2 client
 * Generic JSON:API client with rate limiting and retries
 */

import type {
  JsonApiResponse,
  JsonApiDocument,
  JsonApiCreatePayload,
  JsonApiUpdatePayload,
  JsonApiErrorResponse,
  QueryParams,
} from "../types/index.js";
import { RateLimiter } from "../utils/rateLimiter.js";
import { reportError } from "../utils/errorReporter.js";
import { forceRefreshToken } from "../oauth.js";

export interface NationBuilderClient {
  get<T>(resource: string, params?: QueryParams): Promise<JsonApiResponse<T>>;
  getById<T>(resource: string, id: string, params?: QueryParams): Promise<JsonApiDocument<T>>;
  create<T>(resource: string, payload: JsonApiCreatePayload<T>): Promise<JsonApiDocument<T>>;
  update<T>(resource: string, id: string, payload: JsonApiUpdatePayload<T>): Promise<JsonApiDocument<T>>;
  delete(resource: string, id: string): Promise<void>;
}

export function createNationBuilderClient(
  slug: string,
  accessToken: string | (() => string)
): NationBuilderClient {
  const baseUrl = `https://${slug}.nationbuilder.com/api/v2`;
  const rateLimiter = new RateLimiter();
  const retryLimit = 3;

  function getToken(): string {
    return typeof accessToken === "function" ? accessToken() : accessToken;
  }

  function buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${getToken()}`,
    };
  }

  function buildQueryString(params?: QueryParams): string {
    if (!params) return "";

    const searchParams = new URLSearchParams();

    if (params.filter) {
      for (const [key, value] of Object.entries(params.filter)) {
        if (typeof value === "string") {
          searchParams.set(`filter[${key}]`, value);
        } else if (typeof value === "object") {
          for (const [op, val] of Object.entries(value)) {
            searchParams.set(`filter[${key}][${op}]`, val);
          }
        }
      }
    }

    if (params.sort) {
      searchParams.set("sort", params.sort);
    }

    if (params.page_size) {
      searchParams.set("page[size]", String(params.page_size));
    }

    if (params.page_number) {
      searchParams.set("page[number]", String(params.page_number));
    }

    if (params.fields) {
      for (const [resource, fieldList] of Object.entries(params.fields)) {
        searchParams.set(`fields[${resource}]`, fieldList);
      }
    }

    if (params.include) {
      searchParams.set("include", params.include);
    }

    const qs = searchParams.toString();
    return qs ? `?${qs}` : "";
  }

  function formatApiErrors(errorResponse: JsonApiErrorResponse): string {
    return errorResponse.errors
      .map((e) => {
        const parts: string[] = [];
        if (e.title) parts.push(e.title);
        if (e.detail) parts.push(e.detail);
        if (e.source?.pointer) parts.push(`(at ${e.source.pointer})`);
        return parts.join(": ") || "Unknown error";
      })
      .join("; ");
  }

  async function makeRequest<R>(
    method: string,
    url: string,
    body?: unknown
  ): Promise<R> {
    await rateLimiter.acquire();

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retryLimit; attempt++) {
      try {
        const fetchOptions: RequestInit = {
          method,
          headers: buildHeaders(),
        };

        if (body) {
          fetchOptions.body = JSON.stringify(body);
        }

        const response = await fetch(url, fetchOptions);

        // Handle auth errors — try auto-refresh, then direct user to re-authorize
        if (response.status === 401 && attempt < retryLimit - 1) {
          console.error("Got 401 — attempting token refresh...");
          const refreshed = await forceRefreshToken();
          if (refreshed) {
            console.error("Token refreshed, retrying request...");
            continue; // retry with new token (buildHeaders() will pick it up)
          }
          // Refresh failed — fall through to throw
          const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
          const authorizeUrl = domain
            ? `https://${domain}/oauth/authorize`
            : "/oauth/authorize";
          throw new Error(
            `NationBuilder authentication failed. Your access token is expired and refresh failed.\n` +
            `Re-authorize here: ${authorizeUrl}`
          );
        } else if (response.status === 401) {
          const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
          const authorizeUrl = domain
            ? `https://${domain}/oauth/authorize`
            : "/oauth/authorize";
          throw new Error(
            `NationBuilder authentication failed. Your access token is missing or expired.\n` +
            `Re-authorize here: ${authorizeUrl}`
          );
        }

        // Handle rate limiting
        if (response.status === 429) {
          await rateLimiter.handleError(429);
          continue;
        }

        // Handle server errors with retry
        if (response.status >= 500) {
          const waitMs = Math.min(1000 * Math.pow(2, attempt), 10000);
          console.error(
            `Server error ${response.status}, retrying in ${waitMs}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }

        // No content (successful delete)
        if (response.status === 204) {
          return undefined as R;
        }

        // Check content type before parsing
        const contentType = response.headers.get("content-type") || "";
        const responseText = await response.text();

        if (!contentType.includes("json")) {
          const preview = responseText.substring(0, 200).replace(/\s+/g, " ").trim();
          throw new Error(
            `NationBuilder API error: HTTP ${response.status} returned non-JSON (${contentType}). URL: ${url}. Preview: ${preview}`
          );
        }

        let data: unknown;
        try {
          data = JSON.parse(responseText);
        } catch {
          throw new Error(
            `NationBuilder API error: HTTP ${response.status} invalid JSON. Preview: ${responseText.substring(0, 200)}`
          );
        }

        // Check for JSON:API error responses
        if (!response.ok) {
          if (data && typeof data === "object" && "errors" in data) {
            throw new Error(
              `NationBuilder API error (${response.status}): ${formatApiErrors(data as JsonApiErrorResponse)}`
            );
          }
          throw new Error(
            `NationBuilder API error: HTTP ${response.status}. Body: ${responseText.substring(0, 200)}`
          );
        }

        return data as R;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < retryLimit - 1 && !lastError.message.includes("NationBuilder API error")) {
          console.error(
            `Request failed (attempt ${attempt + 1}/${retryLimit}): ${lastError.message}`
          );
        } else {
          break;
        }
      }
    }

    reportError({
      category: "api_error",
      message: lastError?.message || "Request failed after retries",
      rawError: lastError,
      context: { method, url },
    });

    throw lastError || new Error("Request failed after retries");
  }

  return {
    async get<T>(
      resource: string,
      params?: QueryParams
    ): Promise<JsonApiResponse<T>> {
      const url = `${baseUrl}/${resource}${buildQueryString(params)}`;
      return makeRequest<JsonApiResponse<T>>("GET", url);
    },

    async getById<T>(
      resource: string,
      id: string,
      params?: QueryParams
    ): Promise<JsonApiDocument<T>> {
      const url = `${baseUrl}/${resource}/${id}${buildQueryString(params)}`;
      return makeRequest<JsonApiDocument<T>>("GET", url);
    },

    async create<T>(
      resource: string,
      payload: JsonApiCreatePayload<T>
    ): Promise<JsonApiDocument<T>> {
      const url = `${baseUrl}/${resource}`;
      return makeRequest<JsonApiDocument<T>>("POST", url, payload);
    },

    async update<T>(
      resource: string,
      id: string,
      payload: JsonApiUpdatePayload<T>
    ): Promise<JsonApiDocument<T>> {
      const url = `${baseUrl}/${resource}/${id}`;
      return makeRequest<JsonApiDocument<T>>("PATCH", url, payload);
    },

    async delete(resource: string, id: string): Promise<void> {
      const url = `${baseUrl}/${resource}/${id}`;
      await makeRequest<void>("DELETE", url);
    },
  };
}
