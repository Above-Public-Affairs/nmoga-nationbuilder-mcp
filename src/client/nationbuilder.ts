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
import { getRateLimiter } from "../utils/rateLimiter.js";
import { reportError, reportErrorThrottled } from "../utils/errorReporter.js";

/**
 * The exact prefix `index.ts`'s tokenGetter throws when no token is
 * available for the caller. Exported so both sides of the contract read from
 * one source instead of two independent string literals held together only
 * by a comment — the client below fast-fails on this exact prefix rather
 * than burning retries on a condition that can't self-resolve.
 */
export const NO_TOKEN_PREFIX = "No access token available";

export interface NationBuilderClient {
  get<T>(resource: string, params?: QueryParams): Promise<JsonApiResponse<T>>;
  getById<T>(resource: string, id: string, params?: QueryParams): Promise<JsonApiDocument<T>>;
  create<T>(resource: string, payload: JsonApiCreatePayload<T>): Promise<JsonApiDocument<T>>;
  update<T>(resource: string, id: string, payload: JsonApiUpdatePayload<T>): Promise<JsonApiDocument<T>>;
  delete(resource: string, id: string): Promise<void>;
  v1Request<R>(method: string, path: string, body?: unknown): Promise<R>;
}

export interface NationBuilderClientOptions {
  /**
   * Called on a 401 to attempt a token refresh. Returns true if the caller
   * should retry with a fresh token. Deliberately not calling `forceRefreshToken`
   * from oauth.ts directly — that was a hardwired dependency on exactly one
   * (module-global) token, which is what made this client unable to serve
   * more than one caller. The caller now owns *whose* token gets refreshed.
   */
  onUnauthorized?: () => Promise<boolean>;
  /**
   * Scopes auth-related throttle keys (nb_no_token, nb_401_unrecovered) to a
   * specific caller, so one broken connection doesn't suppress the report
   * for every other caller sharing the same throttle window. Leave unset for
   * a single shared caller (e.g. stdio mode) where that scoping isn't needed.
   * Rate-limit/5xx throttle keys stay global regardless — those are per-IP
   * infrastructure facts, not per-caller ones.
   */
  userTag?: string;
}

export function createNationBuilderClient(
  slug: string,
  accessToken: string | (() => string),
  opts: NationBuilderClientOptions = {}
): NationBuilderClient {
  const baseUrl = `https://${slug}.nationbuilder.com/api/v2`;
  // Shared per-nation, not per-client: NationBuilder's 250-req/10s limit is
  // per IP, and every client instance on this container shares one IP.
  const rateLimiter = getRateLimiter(slug);
  const retryLimit = 3;
  const throttleKey = (base: string): string => opts.userTag ? `${base}:${opts.userTag}` : base;

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

    if (params.extra_fields) {
      for (const [resource, fieldList] of Object.entries(params.extra_fields)) {
        searchParams.set(`extra_fields[${resource}]`, fieldList);
      }
    }

    if (params.include) {
      searchParams.set("include", params.include);
    }

    const qs = searchParams.toString();
    return qs ? `?${qs}` : "";
  }

  /**
   * Path only, numeric IDs collapsed, query string dropped — safe to put in a
   * report's context. NationBuilder query strings carry filter values
   * (filter[email]=..., filter[first_name]=...), which are member PII and
   * must never leave the process in a report.
   */
  function safePath(url: string): string {
    try {
      return new URL(url).pathname.replace(/\/\d+(?=\/|$)/g, "/:id");
    } catch {
      return "unknown";
    }
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
    // Separate from lastError: the 429 and 5xx `continue` paths below never
    // throw, so they never reach the catch that sets lastError. Without this,
    // the final report loses the actual status and falls back to a generic
    // "Request failed after retries" with no rawError — the exact failure
    // mode this tracks around.
    let lastStatus: number | null = null;
    let noToken = false;
    let attemptsMade = 0;

    for (let attempt = 0; attempt < retryLimit; attempt++) {
      attemptsMade++;
      try {
        const fetchOptions: RequestInit = {
          method,
          headers: buildHeaders(),
        };

        if (body) {
          fetchOptions.body = JSON.stringify(body);
        }

        const response = await fetch(url, fetchOptions);

        // Handle auth errors — try auto-refresh, then direct the caller to reconnect.
        // Note there is no working /oauth/authorize link to print here: this
        // server's connector flow runs entirely inside claude.ai's own OAuth
        // dance, not a link a tool-call error message can hand back.
        const RECONNECT_HINT =
          "Reconnect this connector in claude.ai: Settings → Connectors → " +
          "remove and re-add this connector, then complete the NationBuilder login.";
        if (response.status === 401 && attempt < retryLimit - 1) {
          console.error("Got 401 — attempting token refresh...");
          const refreshed = (await opts.onUnauthorized?.()) ?? false;
          if (refreshed) {
            console.error("Token refreshed, retrying request...");
            continue; // retry with new token (buildHeaders() will pick it up)
          }
          // Refresh failed — fall through to throw. Deliberately not setting
          // lastStatus on a *successful* refresh+retry above (the `continue`
          // case): if attempt 0 was a 401 that recovered and attempt 1 then
          // hits a 500, the final report should reflect the 500, not a stale
          // 401 that already resolved itself.
          lastStatus = 401;
          throw new Error(
            `NationBuilder authentication failed. Your access token is expired and refresh failed.\n${RECONNECT_HINT}`
          );
        } else if (response.status === 401) {
          lastStatus = 401;
          throw new Error(
            `NationBuilder authentication failed. Your access token is missing or expired.\n${RECONNECT_HINT}`
          );
        }

        // Handle rate limiting
        if (response.status === 429) {
          lastStatus = 429;
          await rateLimiter.handleError(429);
          continue;
        }

        // Handle server errors with retry
        if (response.status >= 500) {
          lastStatus = response.status;
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
          lastStatus = response.status;
          const preview = responseText.substring(0, 200).replace(/\s+/g, " ").trim();
          // Path only, not the full URL — the query string carries filter
          // values (filter[email]=..., filter[first_name]=...), which are
          // member PII and this message can end up in a reported error.
          throw new Error(
            `NationBuilder API error: HTTP ${response.status} returned non-JSON (${contentType}). Path: ${safePath(url)}. Preview: ${preview}`
          );
        }

        let data: unknown;
        try {
          data = JSON.parse(responseText);
        } catch {
          lastStatus = response.status;
          throw new Error(
            `NationBuilder API error: HTTP ${response.status} invalid JSON. Preview: ${responseText.substring(0, 200)}`
          );
        }

        // Check for JSON:API error responses
        if (!response.ok) {
          lastStatus = response.status;
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
        // A missing token will not fix itself on retry — stop immediately
        // instead of burning the remaining attempts (and duplicating this
        // report up to `retryLimit` times).
        if (lastError.message.startsWith(NO_TOKEN_PREFIX)) {
          noToken = true;
          break;
        }
        // A refresh that already failed once will not succeed on the next
        // attempt either — this string is thrown only after
        // opts.onUnauthorized() already returned false above. Without this
        // check, the outer `else` branch below (which only recognizes the
        // "NationBuilder API error" prefix as terminal) let a dead refresh
        // token retry into a *second* 401-and-refresh-attempt before giving
        // up, doubling both the NationBuilder round-trips and the refresh
        // calls for every request that lands here.
        if (lastError.message.startsWith("NationBuilder authentication failed")) {
          break;
        }
        if (attempt < retryLimit - 1 && !lastError.message.includes("NationBuilder API error")) {
          console.error(
            `Request failed (attempt ${attempt + 1}/${retryLimit}): ${lastError.message}`
          );
        } else {
          break;
        }
      }
    }

    const path = safePath(url);

    if (noToken) {
      // Scoped per-caller (when userTag is set): one connector with a dead
      // token must not suppress this report for every other connected user
      // sharing the module-level throttle map.
      reportErrorThrottled({
        category: "auth_error",
        message: "nationbuilder_client: no access token available",
        context: { method, path },
        throttleKey: throttleKey("nb_no_token"),
        throttleMs: 60 * 60 * 1000,
      });
    } else if (lastStatus === 401) {
      reportErrorThrottled({
        category: "auth_error",
        message: "nationbuilder_client: still 401 after token refresh",
        context: { method, path, attempts: attemptsMade },
        throttleKey: throttleKey("nb_401_unrecovered"),
        throttleMs: 60 * 60 * 1000,
      });
    } else if (lastStatus === 429) {
      reportErrorThrottled({
        category: "rate_limit",
        message: "nationbuilder_client: rate limited after retries",
        context: { method, path, attempts: attemptsMade },
        throttleKey: "nb_429",
        throttleMs: 60 * 60 * 1000,
      });
    } else if (lastStatus !== null && lastStatus >= 500) {
      reportErrorThrottled({
        category: "api_error",
        message: `nationbuilder_client: HTTP ${lastStatus} after ${attemptsMade} attempts`,
        rawError: lastError,
        context: { method, path, status: lastStatus, attempts: attemptsMade },
        throttleKey: "nb_5xx",
        throttleMs: 30 * 60 * 1000,
      });
    } else if (lastStatus !== null) {
      // A per-request fault (404/422/malformed body/...) tied to one user
      // action. The tool layer already reports a `tool_error` for this same
      // event, so reporting it here too would double every "person not
      // found" typo — deliberately not reported.
    } else {
      // No response reached us at all (network failure, DNS, etc.) — the one
      // case with no HTTP status to classify by.
      reportError({
        category: "api_error",
        message: `nationbuilder_client: ${method} failed with no response after ${attemptsMade} attempts`,
        rawError: lastError,
        context: { method, path, attempts: attemptsMade },
      });
    }

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

    async v1Request<R>(method: string, path: string, body?: unknown): Promise<R> {
      const v1BaseUrl = baseUrl.replace("/api/v2", "/api/v1");
      const url = `${v1BaseUrl}${path}`;
      return makeRequest<R>(method, url, body);
    },
  };
}
