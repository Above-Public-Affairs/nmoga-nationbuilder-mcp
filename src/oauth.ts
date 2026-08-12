/**
 * OAuth 2.0 flow for NationBuilder.
 *
 * Adds /oauth/authorize and /oauth/callback routes.
 *
 * As of this commit, refresh/persistence internals are backed by the
 * per-user store in ./auth/store.ts rather than a single module-global
 * token. Externally nothing has changed yet — every route and export here
 * still operates on exactly one identity, `LEGACY_USER_KEY`, so this is a
 * plumbing swap, not a behavior change. The routes below become genuinely
 * per-user once the Authorization Server (src/auth/provider.ts) replaces
 * `/oauth/:secret/authorize` with claude.ai's own OAuth handshake, at which
 * point `LEGACY_USER_KEY` only ever refers to whatever was migrated from
 * the pre-per-user token file, if anything was.
 *
 * Security: CSRF state parameter, PKCE (S256), HTML output escaping.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { randomBytes, createHash } from "crypto";
import { reportError, reportErrorThrottled, resetThrottle, safeErr } from "./utils/errorReporter.js";
import { isAuthorized } from "./utils/httpAuth.js";
import * as tokenStore from "./auth/store.js";
import { LEGACY_USER_KEY } from "./auth/store.js";

// --- PKCE helpers ---
function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// --- CSRF state + PKCE storage (keyed by state value, expires after 10 min) ---
interface PendingAuth {
  codeVerifier: string;
  createdAt: number;
}
const pendingAuths = new Map<string, PendingAuth>();

function cleanupPendingAuths(): void {
  const tenMinutes = 10 * 60 * 1000;
  const now = Date.now();
  for (const [state, pending] of pendingAuths) {
    if (now - pending.createdAt > tenMinutes) {
      pendingAuths.delete(state);
    }
  }
}

// --- HTML escaping to prevent XSS ---
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
 * seed. Matches the old initTokenFromEnv()'s env-fallback behavior exactly.
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
 * module's throttle map (the old module-global REFRESH_THROTTLE_KEY did
 * exactly that). `force` defaults to "this user's healthy -> broken
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
    const response = await fetch(`https://${slug}.nationbuilder.com/oauth/token`, {
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

/** Force a refresh of the legacy identity (e.g. after a 401). Kept as the
 *  external contract index.ts's HTTP-mode tokenGetter still relies on until
 *  session/user binding lands. */
export async function forceRefreshToken(): Promise<boolean> {
  return refreshUserToken(LEGACY_USER_KEY);
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

/**
 * Gates /oauth/authorize and /oauth/status: either credential accepted by
 * isAuthorized() (MCP_URL_SECRET as a path segment, or an MCP_AUTH_TOKEN
 * Bearer header) unlocks the route. Without one, /oauth/authorize can
 * initiate a flow that replaces the server's working NationBuilder token
 * with whatever any visitor authorizes, and /oauth/status leaks token
 * expiry, store path, and writability — to anyone with the URL.
 *
 * 404, not 401: a wrong path segment shouldn't confirm that a gated route
 * exists at all.
 *
 * This gate — and the routes it protects — are the pre-per-user shared flow
 * and are superseded once the Authorization Server (src/auth/provider.ts)
 * ships; kept working as-is until then so there's a single migration point
 * rather than two.
 */
function requireOauthAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthorized(req, req.params.oauthSecret)) {
    next();
    return;
  }
  res.status(404).json({ error: "not_found" });
}

/** Create Express router with OAuth routes */
export function createOAuthRouter(): Router {
  const router = Router();

  // GET /oauth/:oauthSecret/authorize — redirect user to NationBuilder consent screen
  router.get("/oauth/:oauthSecret/authorize", requireOauthAuth, (_req, res) => {
    const { slug, clientId, callbackUrl } = getConfig();

    if (!clientId || !callbackUrl) {
      res.status(500).json({
        error: "OAuth not configured. Set NATIONBUILDER_CLIENT_ID and NATIONBUILDER_CLIENT_SECRET env vars.",
      });
      return;
    }

    // Generate CSRF state token
    const state = randomBytes(24).toString("base64url");

    // Generate PKCE code verifier + challenge (S256)
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // Store state → verifier mapping (expires after 10 min)
    cleanupPendingAuths();
    pendingAuths.set(state, { codeVerifier, createdAt: Date.now() });

    const authorizeUrl = new URL(
      `https://${slug}.nationbuilder.com/oauth/authorize`
    );
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    res.redirect(authorizeUrl.toString());
  });

  // GET /oauth/callback — exchange code for access token
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
      res.status(400).send(`
        <html><body style="font-family:system-ui;max-width:500px;margin:80px auto;text-align:center">
          <h2>Authorization Denied</h2>
          <p>NationBuilder returned error: <code>${escapeHtml(error)}</code></p>
        </body></html>
      `);
      return;
    }

    // Verify CSRF state parameter
    if (!state || !pendingAuths.has(state)) {
      // Never echo `state` itself — treat it as opaque. Public and
      // unauthenticated endpoint, so throttle this too.
      reportErrorThrottled({
        category: "auth_error",
        message: "oauth_callback: missing or expired CSRF state",
        context: { state_present: !!state, state_length: state?.length ?? 0, pending_auths: pendingAuths.size },
        throttleKey: "oauth_callback_bad_state",
        throttleMs: 60 * 60 * 1000,
      });
      res.status(400).send(`
        <html><body style="font-family:system-ui;max-width:500px;margin:80px auto;text-align:center">
          <h2>Invalid State</h2>
          <p>OAuth state parameter is missing or invalid. This may indicate a CSRF attack or an expired authorization. Please try again.</p>
        </body></html>
      `);
      return;
    }

    // Retrieve and consume the pending auth (one-time use)
    const pendingAuth = pendingAuths.get(state)!;
    pendingAuths.delete(state);

    if (!code) {
      res.status(400).send(`
        <html><body style="font-family:system-ui;max-width:500px;margin:80px auto;text-align:center">
          <h2>Missing Code</h2>
          <p>No authorization code received from NationBuilder.</p>
        </body></html>
      `);
      return;
    }

    // Sanitize code: NB codes should be alphanumeric with possible dashes/underscores
    if (!/^[\w\-\.]+$/.test(code) || code.length > 512) {
      // `code` is itself a credential — length only, never the value.
      reportErrorThrottled({
        category: "auth_error",
        message: "oauth_callback: malformed authorization code",
        context: { code_length: code.length },
        throttleKey: "oauth_callback_bad_code",
        throttleMs: 60 * 60 * 1000,
      });
      res.status(400).send(`
        <html><body style="font-family:system-ui;max-width:500px;margin:80px auto;text-align:center">
          <h2>Invalid Code</h2>
          <p>The authorization code has an unexpected format.</p>
        </body></html>
      `);
      return;
    }

    const { slug, clientId, clientSecret, callbackUrl } = getConfig();

    if (!clientId || !clientSecret || !callbackUrl) {
      res.status(500).json({ error: "OAuth not configured" });
      return;
    }

    try {
      const tokenResponse = await fetch(
        `https://${slug}.nationbuilder.com/oauth/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: callbackUrl,
            code_verifier: pendingAuth.codeVerifier,
          }),
        }
      );

      if (!tokenResponse.ok) {
        const text = await tokenResponse.text();
        // Never log or report `text` raw — the request body we just sent
        // contains client_secret, code, and code_verifier, and
        // NationBuilder's error response can echo them back.
        const exchangeErrorCode = oauthErrorCode(text);
        console.error(`Token exchange failed: HTTP ${tokenResponse.status}${exchangeErrorCode ? ` (${exchangeErrorCode})` : ""}`);
        // Unthrottled: reaching this requires a `state` we issued, so volume
        // is bounded by real authorize attempts, not by internet scanners.
        reportError({
          category: "auth_error",
          message: "oauth_callback: token exchange rejected",
          context: { http_status: tokenResponse.status, oauth_error: exchangeErrorCode },
        });
        res.status(500).send(`
          <html><body style="font-family:system-ui;max-width:500px;margin:80px auto;text-align:center">
            <h2>Token Exchange Failed</h2>
            <p>HTTP ${tokenResponse.status}</p>
          </body></html>
        `);
        return;
      }

      const data = (await tokenResponse.json()) as {
        access_token: string;
        token_type: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        created_at?: number;
      };

      tokenStore.setUserTokens(LEGACY_USER_KEY, {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? null,
        expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : Date.now() + 23 * 60 * 60 * 1000,
      });

      const expiryInfo = data.expires_in
        ? `Token expires in ${Math.round(data.expires_in / 3600)} hours (auto-refresh enabled).`
        : "Token does not expire.";

      // Say so on the page rather than only in the logs — whoever just clicked
      // through is the one person positioned to fix a bad volume mount, and
      // otherwise they'd only find out at the next restart.
      const storeStatus = tokenStore.getStoreStatus();
      const persistenceNote = storeStatus.writable
        ? `<p style="color:#666;font-size:14px">Tokens saved to persistent storage — they will survive restarts.</p>`
        : `<p style="color:#b00;font-size:14px"><strong>Warning:</strong> tokens could NOT be saved to persistent storage. ` +
          `They are in memory only, so the next restart will require re-authorizing here again. ` +
          `Check that a volume is mounted on this service (see the deploy logs for details).</p>`;

      console.error(
        `OAuth token obtained. Type: ${data.token_type}, Scope: ${data.scope ?? "default"}, Refresh: ${data.refresh_token ? "yes" : "no"}`
      );

      res.send(`
        <html><body style="font-family:system-ui;max-width:500px;margin:80px auto;text-align:center">
          <h2>Authorization Successful</h2>
          <p>NationBuilder OAuth token obtained.</p>
          <p style="color:#666;font-size:14px">${expiryInfo}</p>
          ${persistenceNote}
          <p style="color:#666;font-size:14px">You can close this window. The MCP server is now using your OAuth credentials.</p>
        </body></html>
      `);
    } catch (err) {
      // A SyntaxError parsing a 200 response quotes the offending body in
      // its message, which can contain the access token — never pass it
      // through as-is.
      const safe = err instanceof SyntaxError
        ? new Error("SyntaxError parsing token response (body withheld)")
        : err;
      console.error("OAuth callback error:", safeErr(safe));
      // Unthrottled: reaching this requires a `state` we issued, so volume is
      // bounded by real authorize attempts.
      reportError({
        category: "auth_error",
        message: "oauth_callback: token exchange failed",
        rawError: safe,
      });
      res.status(500).send(`
        <html><body style="font-family:system-ui;max-width:500px;margin:80px auto;text-align:center">
          <h2>Error</h2>
          <p>Failed to exchange authorization code for token.</p>
        </body></html>
      `);
    }
  });

  // GET /oauth/:oauthSecret/status — check current auth state
  router.get("/oauth/:oauthSecret/status", requireOauthAuth, (_req, res) => {
    const oauthConfigured = isOAuthConfigured();
    const legacyUser = tokenStore.getUser(LEGACY_USER_KEY);
    const hasOAuthToken = !!legacyUser && !legacyUser.revoked;
    const hasStaticToken = !!process.env.NATIONBUILDER_ACCESS_TOKEN;

    res.json({
      oauthConfigured,
      hasOAuthToken,
      hasStaticToken,
      activeMethod: hasOAuthToken ? "oauth" : hasStaticToken ? "static_token" : "none",
      tokenExpiry: legacyUser?.expiresAt ? new Date(legacyUser.expiresAt).toISOString() : null,
      hasRefreshToken: !!legacyUser?.refreshToken,
      // Check this BEFORE authorizing: if writable is false, the token you're
      // about to obtain won't survive the next restart.
      tokenStore: tokenStore.getStoreStatus(),
    });
  });

  return router;
}
