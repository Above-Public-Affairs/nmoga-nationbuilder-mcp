/**
 * OAuth 2.0 flow for NationBuilder.
 *
 * This file owns everything this server needs to talk to NationBuilder's
 * OAuth endpoints — config, the actual code exchange, the best-effort
 * identity probe, and per-user refresh — and mounts the one route
 * NationBuilder itself calls back on. The Authorization Server this server
 * presents to claude.ai (src/auth/provider.ts) is a separate, upstream
 * concern: it drives the actual `/authorize` request that starts a person's
 * login and then hands off to this file's exchangeCodeForNbTokens() /
 * probeNationBuilderIdentity() once NationBuilder redirects back to
 * `/oauth/callback`, below, via completeUpstreamAuth().
 *
 * `/oauth/callback`'s path is registered with NationBuilder and can't be
 * moved without updating that registration — so it stays here, fixed, while
 * everything that constructs the URL a person is sent to lives in
 * src/auth/provider.ts.
 *
 * Security: CSRF state parameter (owned by provider.ts's pending-auth map),
 * PKCE (S256), HTML output escaping.
 */

import { Router } from "express";
import { reportError, reportErrorThrottled, resetThrottle, safeErr } from "./utils/errorReporter.js";
import * as tokenStore from "./auth/store.js";
import { LEGACY_USER_KEY } from "./auth/store.js";
import { verifyMcpToken } from "./auth/tokens.js";
import { completeUpstreamAuth } from "./auth/provider.js";

// --- HTML escaping to prevent XSS ---
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function errorPage(title: string, message: string): string {
  return `
    <html><body style="font-family:system-ui;max-width:500px;margin:80px auto;text-align:center">
      <h2>${escapeHtml(title)}</h2>
      <p>${message}</p>
    </body></html>
  `;
}

/**
 * Pull the OAuth2 `error` code out of a token-endpoint error body without
 * ever forwarding the body itself. NationBuilder's error responses can echo
 * the request params we just sent — client_secret, refresh_token, code,
 * code_verifier — so the raw body must never reach a log line or a report.
 * The bounded `error` code (invalid_grant, invalid_client, ...) is the
 * actual diagnostic and is safe: it's from a small OAuth2-spec vocabulary.
 */
export function oauthErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.length <= 64 ? parsed.error : null;
  } catch {
    return null;
  }
}

export function getConfig() {
  const slug = process.env.NATIONBUILDER_SLUG!;
  const clientId = process.env.NATIONBUILDER_CLIENT_ID;
  const clientSecret = process.env.NATIONBUILDER_CLIENT_SECRET;
  const callbackUrl =
    process.env.NATIONBUILDER_OAUTH_CALLBACK_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/oauth/callback`
      : null);

  return { slug, clientId, clientSecret, callbackUrl };
}

/**
 * NationBuilder's own OAuth host for this nation. Overridable via
 * NB_OAUTH_BASE_URL so local verification can point this whole flow at a
 * throwaway fake upstream instead of the real nation — the only way to
 * exercise the authorize -> callback -> token-exchange round trip without a
 * live NationBuilder credential.
 */
export function getNbOAuthBaseUrl(slug: string): string {
  return process.env.NB_OAUTH_BASE_URL || `https://${slug}.nationbuilder.com`;
}

/** Returns true if OAuth env vars are configured */
export function isOAuthConfigured(): boolean {
  const { clientId, clientSecret, callbackUrl } = getConfig();
  return !!(clientId && clientSecret && callbackUrl);
}

/**
 * Hydrate the legacy identity from env vars, if nothing was persisted (or
 * migrated) yet. The store's own load() already handles the "an old
 * pre-per-user file exists" migration automatically and lazily — this is
 * only the remaining case: no file at all yet, first boot, env vars as the
 * seed. This identity is a migration artifact only — nothing can create a
 * new one interactively now that the shared-secret authorize route is gone;
 * it exists solely so a pre-existing single-token deploy doesn't lose its
 * NationBuilder connection outright the moment this ships.
 */
export function initTokenFromEnv(): void {
  if (tokenStore.getUser(LEGACY_USER_KEY)) return;

  const accessToken = process.env.NATIONBUILDER_ACCESS_TOKEN;
  const refreshToken = process.env.NATIONBUILDER_REFRESH_TOKEN;
  if (!accessToken) return;

  tokenStore.setUserTokens(LEGACY_USER_KEY, {
    accessToken,
    refreshToken: refreshToken ?? null,
    expiresAt: null, // unknown — the startup sweep will establish it
  });
  console.error(
    `No persisted token yet — loaded from env vars (refresh token: ${refreshToken ? "yes" : "no"})`
  );
}

/** Returns the current (legacy-identity) OAuth access token, or null. */
export function getOAuthToken(): string | null {
  return tokenStore.getUserAccessToken(LEGACY_USER_KEY);
}

// --- NationBuilder token exchange (used by the Authorization Server's
// upstream leg — see src/auth/provider.ts's completeUpstreamAuth) ----------

export type NbTokenExchangeResult =
  | { ok: true; accessToken: string; refreshToken: string | null; expiresAt: number; tokenType: string; scope?: string }
  | { ok: false; httpStatus: number; errorCode: string | null };

/**
 * Exchange an authorization code for a NationBuilder token pair. There is
 * exactly one way this server talks to NationBuilder's token endpoint —
 * this function — regardless of which flow (or which future one) got a
 * person here.
 */
export async function exchangeCodeForNbTokens(code: string, codeVerifier: string): Promise<NbTokenExchangeResult> {
  const { slug, clientId, clientSecret, callbackUrl } = getConfig();
  if (!clientId || !clientSecret || !callbackUrl) {
    return { ok: false, httpStatus: 500, errorCode: "server_not_configured" };
  }

  try {
    const tokenResponse = await fetch(`${getNbOAuthBaseUrl(slug)}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: callbackUrl,
        code_verifier: codeVerifier,
      }),
    });

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text();
      // Never log or report `text` raw — the request body we just sent
      // contains client_secret, code, and code_verifier, and
      // NationBuilder's error response can echo them back.
      const errorCode = oauthErrorCode(text);
      console.error(`Token exchange failed: HTTP ${tokenResponse.status}${errorCode ? ` (${errorCode})` : ""}`);
      // Unthrottled: reaching this requires a `state` we issued, so volume
      // is bounded by real authorize attempts, not by internet scanners.
      reportError({
        category: "auth_error",
        message: "oauth_callback: token exchange rejected",
        context: { http_status: tokenResponse.status, oauth_error: errorCode },
      });
      return { ok: false, httpStatus: tokenResponse.status, errorCode };
    }

    const data = (await tokenResponse.json()) as {
      access_token: string;
      token_type: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };

    return {
      ok: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      // Default to a 23h fuse (NB tokens live 24h) rather than "never" when
      // expires_in is absent — see the same default in doRefreshUser() below.
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : Date.now() + 23 * 60 * 60 * 1000,
      tokenType: data.token_type,
      scope: data.scope,
    };
  } catch (err) {
    // A SyntaxError parsing a 200 response quotes the offending body in its
    // message, which can contain the access token — never pass it through as-is.
    const safe = err instanceof SyntaxError
      ? new Error("SyntaxError parsing token response (body withheld)")
      : err;
    console.error("OAuth token exchange error:", safeErr(safe));
    reportError({ category: "auth_error", message: "oauth_callback: token exchange failed", rawError: safe });
    return { ok: false, httpStatus: 0, errorCode: null };
  }
}

export interface NbIdentityProbe {
  nbUserId: string;
  label: string | null;
}

/**
 * Best-effort identity probe: try NationBuilder's legacy V1 `people/me` to
 * learn who just authorized. There is no V2 equivalent — NationBuilder's own
 * docs describe no current-user/userinfo endpoint, and the OAuth token
 * response itself carries no subject, just `{access_token, refresh_token,
 * token_type, expires_in, scope, created_at}`. So this is genuinely
 * best-effort: a null return means "use an opaque key," not an error.
 *
 * Deliberately bypasses the API client/rate limiter/error reporter — a
 * failed probe must be silent and free, since attribution in NationBuilder's
 * own logs comes from the access token itself, not from this lookup. The
 * label this produces is cosmetic.
 */
export async function probeNationBuilderIdentity(slug: string, accessToken: string): Promise<NbIdentityProbe | null> {
  const base = getNbOAuthBaseUrl(slug);
  const url = `${base}/api/v1/people/me`;

  try {
    let response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      // V1 has traditionally also accepted the token as a query param —
      // try once more before giving up.
      response = await fetch(`${url}?access_token=${encodeURIComponent(accessToken)}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
    }
    if (!response.ok) return null;

    const data = (await response.json()) as {
      person?: { id?: number | string; first_name?: string; last_name?: string; email?: string };
    };
    const person = data.person;
    if (!person?.id) return null;

    const name = [person.first_name, person.last_name].filter(Boolean).join(" ").trim();
    return { nbUserId: String(person.id), label: name || person.email || null };
  } catch {
    return null;
  }
}

// --- Refresh ---------------------------------------------------------------

/**
 * NationBuilder refresh tokens are single-use — a request that races another
 * refresh for the same user, or that lands while a refresh is already in
 * flight, must never send a second concurrent refresh_token grant, since the
 * first one to land revokes it upstream and the second gets `invalid_grant`
 * for a token that was actually fine seconds ago. Callers racing each other
 * now share one promise instead of one calling doRefreshUser() out from
 * under the other.
 */
const refreshInFlight = new Map<string, Promise<boolean>>();

/** Skip a network round-trip for this long after a refresh attempt fails —
 *  a persistently-broken refresh token won't fix itself on the very next
 *  tool call a few seconds later, and this bounds how often we hit
 *  NationBuilder while it's failing. */
const NEGATIVE_CACHE_MS = 30 * 1000;
const lastRefreshFailedAt = new Map<string, number>();

const REFRESH_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Report a refresh failure, throttled per-user so one broken connection
 * doesn't suppress the report for every other connected person sharing this
 * module's throttle map. `force` defaults to "this user's healthy -> broken
 * transition", read from the store *before* the caller flips it, so the
 * first failure after a healthy period always gets through immediately —
 * even inside a throttle window left open by an earlier, different user's
 * outage.
 */
function reportRefreshFailure(
  userKey: string,
  message: string,
  context: Record<string, unknown>,
  opts: { rawError?: unknown; force?: boolean } = {}
): void {
  const user = tokenStore.getUser(userKey);
  const wasHealthy = user?.refreshHealthy ?? true;
  tokenStore.upsertUser(userKey, { refreshHealthy: false });
  tokenStore.save();

  const tag = tokenStore.userTag(userKey);
  reportErrorThrottled({
    category: "auth_error",
    message,
    rawError: opts.rawError,
    context: { ...context, user_tag: tag, first_failure_since_healthy: wasHealthy },
    throttleKey: `oauth_refresh_failed:${tag}`,
    throttleMs: REFRESH_THROTTLE_MS,
    force: opts.force ?? wasHealthy,
  });
}

async function doRefreshUser(userKey: string): Promise<boolean> {
  const user = tokenStore.getUser(userKey);
  // Also covers the terminal invalid_grant case below: once markRevoked()
  // runs, every subsequent call returns here without ever hitting the
  // network again — which is what makes "report once per user" true
  // without any extra bookkeeping.
  if (!user || !user.refreshToken || user.revoked) return false;

  const { slug, clientId, clientSecret } = getConfig();
  if (!clientId || !clientSecret) return false;

  const tag = tokenStore.userTag(userKey);
  console.error(`Refreshing NationBuilder token for ${tag}...`);

  try {
    const response = await fetch(`${getNbOAuthBaseUrl(slug)}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: user.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      // Never log or report `text` raw: the request body we just sent
      // contains client_secret and refresh_token, and NationBuilder's error
      // response can echo request params back.
      const code = oauthErrorCode(text);
      console.error(`Token refresh failed for ${tag}: HTTP ${response.status}${code ? ` (${code})` : ""}`);
      lastRefreshFailedAt.set(userKey, Date.now());

      if (code === "invalid_grant") {
        // Terminal: this refresh token is dead, not just temporarily
        // unreachable. Mark revoked so the guard above stops retrying, and
        // report once, unthrottled — there is nothing else to say about
        // this user's connection until they re-authorize.
        tokenStore.markRevoked(userKey, true);
        reportRefreshFailure(
          userKey,
          "oauth_refresh: NationBuilder rejected the refresh token (invalid_grant) — needs re-authorization",
          { http_status: response.status, oauth_error: code },
          { force: true }
        );
      } else {
        reportRefreshFailure(userKey, "oauth_refresh: NationBuilder rejected the refresh token", {
          http_status: response.status,
          oauth_error: code,
        });
      }
      return false;
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const wasHealthy = user.refreshHealthy;
    tokenStore.setUserTokens(userKey, {
      accessToken: data.access_token,
      // NB doesn't always return a new refresh token; keep the current one when it doesn't.
      refreshToken: data.refresh_token ?? user.refreshToken,
      // Default to a 23h fuse (NB tokens live 24h) rather than null when
      // expires_in is absent: null previously meant "never refresh this,"
      // permanently, since refreshTokenIfNeeded() treated null expiresAt as
      // "nothing to do" — the only thing that ever caught a token in that
      // state was the 401 path on an actual tool call.
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : Date.now() + 23 * 60 * 60 * 1000,
    });

    console.error(`NationBuilder token refreshed for ${tag}`);
    lastRefreshFailedAt.delete(userKey);
    // Recovery: clear this user's throttle window so their next breakage
    // alerts immediately instead of being swallowed by a stale window.
    if (!wasHealthy) resetThrottle(`oauth_refresh_failed:${tag}`);
    return true;
  } catch (error) {
    // A SyntaxError parsing a 200 response quotes the offending body in its
    // message, which can contain the access token — never pass it through
    // as-is.
    const safe = error instanceof SyntaxError
      ? new Error("SyntaxError parsing token response (body withheld)")
      : error;
    console.error(`Token refresh error for ${tag}:`, safeErr(safe));
    lastRefreshFailedAt.set(userKey, Date.now());
    reportRefreshFailure(userKey, "oauth_refresh: request to NationBuilder failed", { phase: "network_or_parse" }, { rawError: safe });
    return false;
  }
}

/**
 * Refresh one user's NationBuilder token. Safe to call concurrently for the
 * same user — a second caller while a refresh is already in flight awaits
 * the same promise rather than sending a second refresh_token grant (which
 * would race the first for a single-use token). Returns false, without a
 * network call, within NEGATIVE_CACHE_MS of a failed attempt.
 */
export async function refreshUserToken(userKey: string): Promise<boolean> {
  const inFlight = refreshInFlight.get(userKey);
  if (inFlight) return inFlight;

  const failedAt = lastRefreshFailedAt.get(userKey);
  if (failedAt !== undefined && Date.now() - failedAt < NEGATIVE_CACHE_MS) return false;

  const promise = doRefreshUser(userKey).finally(() => {
    refreshInFlight.delete(userKey);
  });
  refreshInFlight.set(userKey, promise);
  return promise;
}

const SWEEP_REFRESH_WINDOW_MS = 60 * 60 * 1000; // refresh once inside 60 min of expiry
const SWEEP_GAP_MS = 250; // spacing between refreshes in one sweep pass

/**
 * Refresh every user whose token is expired, unknown, or due soon —
 * sequentially, with a small gap between each, since NationBuilder's rate
 * limit is per IP and this container shares one IP across every connected
 * person; a burst of N refreshes in one tick is a needless spike against
 * that same budget every tool call also draws from. Also prunes stale
 * entries (see auth/store.ts) so the store doesn't grow without bound
 * across restarts and re-authorizations.
 */
export async function sweepUserTokens(): Promise<void> {
  for (const userKey of tokenStore.allUserKeys()) {
    const user = tokenStore.getUser(userKey);
    if (!user || user.revoked || !user.refreshToken) continue;

    const dueSoon = user.expiresAt === null || Date.now() > user.expiresAt - SWEEP_REFRESH_WINDOW_MS;
    if (!dueSoon) continue;

    await refreshUserToken(userKey);
    await new Promise((resolve) => setTimeout(resolve, SWEEP_GAP_MS));
  }

  tokenStore.pruneUsers();
  tokenStore.pruneLegacyUserIfStale();
  tokenStore.pruneClients();
}

/**
 * Exercise every stored refresh token once at startup — a restart otherwise
 * leaves everyone's `expiresAt` however it was at shutdown, so nothing would
 * touch a stale token until that person's first tool call took a 401. This
 * either re-establishes each rotation chain (and re-persists it) or surfaces
 * a dead refresh token in the deploy logs immediately, instead of as a
 * broken connector for whoever tries first.
 */
export async function bootstrapToken(): Promise<void> {
  const userKeys = tokenStore.allUserKeys();
  if (userKeys.length === 0) {
    console.error("No connected NationBuilder users at startup.");
    return;
  }
  await sweepUserTokens();
}

/** Create Express router with OAuth routes */
export function createOAuthRouter(): Router {
  const router = Router();

  // GET /oauth/callback — NationBuilder's registered redirect target. This
  // path can never change without re-registering it with NationBuilder, so
  // it stays fixed here while everything upstream of it (constructing the
  // authorize URL a person is sent to) lives in src/auth/provider.ts.
  router.get("/oauth/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    const error = req.query.error as string | undefined;
    const state = req.query.state as string | undefined;

    if (error) {
      // A user declining consent is not a defect — don't report that case.
      // This endpoint is public and unauthenticated, so anything else here
      // (invalid_client, unauthorized_client, server_error, ...) is worth a
      // throttled row: an internet scanner hitting it with garbage `error`
      // values is a flood vector otherwise.
      const errorCode = /^[a-z_]{1,40}$/.test(error) ? error : "unrecognized";
      if (errorCode !== "access_denied") {
        reportErrorThrottled({
          category: "auth_error",
          message: `oauth_callback: NationBuilder returned ${errorCode}`,
          context: { oauth_error: errorCode },
          throttleKey: `oauth_callback_error:${errorCode}`,
          throttleMs: 60 * 60 * 1000,
        });
      }
      res.status(400).send(errorPage("Authorization Denied", `NationBuilder returned error: <code>${escapeHtml(error)}</code>`));
      return;
    }

    if (!state) {
      reportErrorThrottled({
        category: "auth_error",
        message: "oauth_callback: missing state",
        context: { state_present: false },
        throttleKey: "oauth_callback_bad_state",
        throttleMs: 60 * 60 * 1000,
      });
      res.status(400).send(errorPage("Invalid State", "OAuth state parameter is missing. Please try again."));
      return;
    }

    if (!code) {
      res.status(400).send(errorPage("Missing Code", "No authorization code received from NationBuilder."));
      return;
    }

    // Sanitize code: NB codes should be alphanumeric with possible dashes/underscores
    if (!/^[\w\-.]+$/.test(code) || code.length > 512) {
      // `code` is itself a credential — length only, never the value.
      reportErrorThrottled({
        category: "auth_error",
        message: "oauth_callback: malformed authorization code",
        context: { code_length: code.length },
        throttleKey: "oauth_callback_bad_code",
        throttleMs: 60 * 60 * 1000,
      });
      res.status(400).send(errorPage("Invalid Code", "The authorization code has an unexpected format."));
      return;
    }

    // completeUpstreamAuth() owns the rest: exchanging the code, the
    // identity probe, persisting that person's NationBuilder tokens, and
    // minting the code claude.ai redeems at /token. An unknown/expired
    // `state` (nothing pending, or already consumed) comes back as an
    // error result here rather than throwing — never a 500.
    const result = await completeUpstreamAuth(state, code);
    if ("redirectTo" in result) {
      res.redirect(302, result.redirectTo);
    } else {
      res.status(400).send(errorPage("Authorization Failed", `Could not complete sign-in: ${escapeHtml(result.error)}. Please try connecting again.`));
    }
  });

  // GET /oauth/status — public but tiered: the baseline body has no secrets
  // (never a live NationBuilder token, never anyone's label). Present a
  // valid MCP bearer (the same one claude.ai holds for your connector) and
  // the response additionally includes your own record.
  router.get("/oauth/status", (req, res) => {
    const summaries = tokenStore.listUsersSummary();
    const body: Record<string, unknown> = {
      oauthConfigured: isOAuthConfigured(),
      userCount: summaries.length,
      needsReauthCount: summaries.filter((u) => u.needsReauth).length,
      tokenStore: tokenStore.getStoreStatus(),
    };

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const payload = verifyMcpToken(authHeader.slice(7), "access");
      const user = payload ? tokenStore.getUser(payload.sub) : null;
      if (user) {
        body.you = {
          label: user.label,
          expiresAt: user.expiresAt ? new Date(user.expiresAt).toISOString() : null,
          hasRefreshToken: !!user.refreshToken,
          refreshHealthy: user.refreshHealthy,
          revoked: user.revoked,
          needsReauth: user.needsReauth,
        };
      }
    }

    res.json(body);
  });

  return router;
}
