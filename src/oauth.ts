/**
 * OAuth 2.0 flow for NationBuilder
 *
 * Adds /oauth/authorize and /oauth/callback routes.
 * Persists tokens to a JSON file on the Railway volume so they survive restarts,
 * falling back to the NATIONBUILDER_ACCESS_TOKEN / NATIONBUILDER_REFRESH_TOKEN
 * env vars when no token file exists yet (first boot after this change, and
 * local stdio use).
 *
 * NationBuilder rotates the refresh token on every refresh, so whatever we
 * persist is the *only* way back after a restart — if the write fails, the next
 * restart leaves the connector with no NationBuilder access until a human
 * re-runs /oauth/authorize. This previously wrote back to Railway env vars via
 * the platform API, which required a privileged RAILWAY_API_TOKEN inside the
 * container and failed silently for months. A file on a mounted volume needs no
 * credentials and no network call.
 *
 * Security: CSRF state parameter, PKCE (S256), HTML output escaping.
 * The token file holds live credentials, so it's written 0600.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { randomBytes, createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { reportError, reportErrorThrottled, resetThrottle, safeErr } from "./utils/errorReporter.js";
import { isAuthorized } from "./utils/httpAuth.js";

interface TokenData {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null; // epoch ms, null = never expires (V1 tokens)
}

let tokenData: TokenData | null = null;

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
function oauthErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.length <= 64 ? parsed.error : null;
  } catch {
    return null;
  }
}

/**
 * Where the token file lives. TOKEN_STORE_PATH overrides; otherwise it sits on
 * the Railway volume mount. Nothing outside the volume survives a restart, so a
 * wrong path here silently reintroduces the exact bug this replaced.
 */
function getTokenStorePath(): string {
  if (process.env.TOKEN_STORE_PATH) return process.env.TOKEN_STORE_PATH;
  const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  return mount ? join(mount, "nb-tokens.json") : "";
}

/** Persist tokens to the volume. Returns true only if the bytes actually landed. */
function persistTokens(data: TokenData): boolean {
  const path = getTokenStorePath();

  if (!path) {
    console.error(
      "CRITICAL: no token store path (RAILWAY_VOLUME_MOUNT_PATH unset and no " +
      "TOKEN_STORE_PATH). Tokens are in memory only — the next restart will " +
      "leave this connector with no NationBuilder access until someone re-runs " +
      "/oauth/authorize. Mount a volume on this service."
    );
    reportError({
      category: "auth_error",
      message: "NationBuilder token persistence unavailable — no volume mounted",
    });
    return false;
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    // Write-then-rename so a crash mid-write can't leave a truncated file that
    // reads back as corrupt on the next boot.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    console.error(`OAuth tokens persisted to ${path}`);
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `CRITICAL: could not write tokens to ${path} (${detail}). This service ` +
      `will lose NationBuilder access on its next restart until someone ` +
      `re-runs /oauth/authorize.`
    );
    reportError({
      category: "auth_error",
      message: `NationBuilder token persistence failed: ${detail}`,
      context: { path },
    });
    return false;
  }
}

/**
 * Report where tokens will be written and whether that location actually works,
 * by probing it rather than assuming. Exposed on /oauth/status and logged at
 * boot so a missing volume is visible immediately — otherwise the only signal
 * is a failed write during authorize, which is far too late: by then someone
 * has already re-authorized and will silently lose it on the next restart.
 */
export function getTokenStoreStatus(): { path: string | null; writable: boolean; reason?: string } {
  const path = getTokenStorePath();
  if (!path) {
    return { path: null, writable: false, reason: "no RAILWAY_VOLUME_MOUNT_PATH or TOKEN_STORE_PATH — is a volume mounted?" };
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    const probe = `${path}.probe`;
    writeFileSync(probe, "", { mode: 0o600 });
    unlinkSync(probe);
    return { path, writable: true };
  } catch (err) {
    return { path, writable: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Read persisted tokens from the volume, or null if absent/unreadable. */
function loadPersistedTokens(): TokenData | null {
  const path = getTokenStorePath();
  if (!path) return null;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<TokenData>;
    if (!parsed.accessToken) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken ?? null,
      expiresAt: parsed.expiresAt ?? null,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.error(`Could not read token store at ${path}: ${String(err)}`);
    }
    return null;
  }
}

function getConfig() {
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
 * Hydrate in-memory tokenData on startup.
 *
 * The volume is the source of truth; env vars are only a fallback for the first
 * boot after a fresh authorize (and for local stdio use). Preferring the file
 * matters because the env copy is frozen at whatever was last written there —
 * trusting it over a newer file would hand back an already-rotated token.
 */
export function initTokenFromEnv(): void {
  if (tokenData) return;

  const persisted = loadPersistedTokens();
  if (persisted) {
    tokenData = persisted;
    console.error(
      `Loaded tokens from ${getTokenStorePath()} ` +
      `(refresh token: ${persisted.refreshToken ? "yes" : "no"})`
    );
    return;
  }

  const accessToken = process.env.NATIONBUILDER_ACCESS_TOKEN;
  const refreshToken = process.env.NATIONBUILDER_REFRESH_TOKEN;

  if (accessToken) {
    tokenData = {
      accessToken,
      refreshToken: refreshToken ?? null,
      expiresAt: null, // unknown — startup refresh will establish it
    };
    console.error(
      `No token file yet — loaded token from env vars (refresh token: ${refreshToken ? "yes" : "no"})`
    );
  }
}

/**
 * Exercise the stored refresh token once at startup.
 *
 * Hydrating from env leaves expiresAt null, which makes refreshTokenIfNeeded a
 * no-op — so nothing would touch the token until a user's first tool call took
 * a 401. Refreshing here means a restart either re-establishes the rotation
 * chain (and re-persists it) or surfaces a dead refresh token in the deploy
 * logs immediately, instead of as a broken connector for whoever tries first.
 */
export async function bootstrapToken(): Promise<void> {
  if (!tokenData?.refreshToken) {
    console.error(
      "No refresh token available at startup — running on a static token. " +
      "If NationBuilder rejects it, re-authorize at /oauth/authorize."
    );
    return;
  }

  const ok = await refreshSingleFlight();
  if (!ok) {
    console.error(
      "CRITICAL: startup token refresh failed. The stored refresh token is " +
      "likely stale or revoked, so NationBuilder tool calls will fail. " +
      "Re-authorize at /oauth/authorize to restore access."
    );
    reportError({
      category: "auth_error",
      message: "NationBuilder startup token refresh failed — connector has no usable token",
    });
  }
}

/** Returns true if OAuth env vars are configured */
export function isOAuthConfigured(): boolean {
  const { clientId, clientSecret, callbackUrl } = getConfig();
  return !!(clientId && clientSecret && callbackUrl);
}

/** Returns the current OAuth access token, or null if not yet obtained */
export function getOAuthToken(): string | null {
  return tokenData?.accessToken ?? null;
}

/**
 * Composed auth-state snapshot — backs both the /oauth/status HTTP route and
 * the connection_status MCP tool, so the two surfaces can never drift apart.
 */
export function getAuthStatus(): {
  oauthConfigured: boolean;
  hasOAuthToken: boolean;
  hasStaticToken: boolean;
  activeMethod: "oauth" | "static_token" | "none";
  tokenExpiry: string | null;
  hasRefreshToken: boolean;
  tokenStore: { path: string | null; writable: boolean; reason?: string };
} {
  const oauthConfigured = isOAuthConfigured();
  const hasOAuthToken = !!tokenData;
  const hasStaticToken = !!process.env.NATIONBUILDER_ACCESS_TOKEN;

  return {
    oauthConfigured,
    hasOAuthToken,
    hasStaticToken,
    activeMethod: hasOAuthToken ? "oauth" : hasStaticToken ? "static_token" : "none",
    tokenExpiry: tokenData?.expiresAt
      ? new Date(tokenData.expiresAt).toISOString()
      : null,
    hasRefreshToken: !!tokenData?.refreshToken,
    // Check this BEFORE authorizing: if writable is false, the token you're
    // about to obtain won't survive the next restart.
    tokenStore: getTokenStoreStatus(),
  };
}

/**
 * The client force-refreshes on EVERY 401 — and does so twice per failed
 * request (the retry loop's error-message heuristic doesn't recognize an
 * auth failure as terminal, so it retries once more before giving up). An
 * unthrottled report here means one row per tool call for as long as the
 * refresh token stays revoked. `refreshHealthy` tracks working -> broken so
 * the first failure after a healthy period always gets through immediately,
 * even inside an open throttle window from a stale/earlier outage.
 */
const REFRESH_THROTTLE_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_THROTTLE_KEY = "oauth_refresh_failed";
let refreshHealthy = true;

function reportRefreshFailure(message: string, context: Record<string, unknown>, rawError?: unknown): void {
  const transition = refreshHealthy;
  refreshHealthy = false;
  reportErrorThrottled({
    category: "auth_error",
    message,
    rawError,
    context: { ...context, first_failure_since_healthy: transition },
    throttleKey: REFRESH_THROTTLE_KEY,
    throttleMs: REFRESH_THROTTLE_MS,
    force: transition,
  });
}

/**
 * Single-flight guard around doRefresh(). NationBuilder rotates the refresh
 * token on every refresh, so two concurrent callers (e.g. two simultaneous
 * 401s from two concurrent tool calls) each running their own doRefresh()
 * would race: whichever lands second sends an already-rotated refresh token
 * and gets rejected, potentially clobbering tokenData with a failed/partial
 * state — reintroducing the "dead connector, must re-authorize" failure mode
 * the volume-persistence work above exists to prevent. Concurrent callers
 * instead await the same in-flight refresh.
 */
let refreshInFlight: Promise<boolean> | null = null;

function refreshSingleFlight(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Internal refresh logic shared by refreshTokenIfNeeded and forceRefreshToken */
async function doRefresh(): Promise<boolean> {
  if (!tokenData?.refreshToken) return false;

  const { slug, clientId, clientSecret } = getConfig();
  if (!clientId || !clientSecret) return false;

  console.error("Refreshing OAuth token...");

  try {
    const response = await fetch(
      `https://${slug}.nationbuilder.com/oauth/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: tokenData.refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      // Never log or report `text` raw: the request body we just sent
      // contains client_secret and refresh_token, and NationBuilder's error
      // response can echo request params back.
      const code = oauthErrorCode(text);
      console.error(`Token refresh failed: HTTP ${response.status}${code ? ` (${code})` : ""}`);
      reportRefreshFailure("oauth_refresh: NationBuilder rejected the refresh token", {
        http_status: response.status,
        oauth_error: code,
      });
      return false;
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    tokenData = {
      accessToken: data.access_token,
      // NB doesn't always return a new refresh token; keep the current one when it doesn't.
      refreshToken: data.refresh_token ?? tokenData.refreshToken,
      expiresAt: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : null,
    };

    console.error("OAuth token refreshed successfully");
    // Recovery: clear the window so the next breakage alerts immediately
    // instead of being swallowed by a throttle window left over from before
    // this fix.
    if (!refreshHealthy) {
      refreshHealthy = true;
      resetThrottle(REFRESH_THROTTLE_KEY);
    }
    persistTokens(tokenData);
    return true;
  } catch (error) {
    // A SyntaxError parsing a 200 response quotes the offending body in its
    // message, which can contain the access token — never pass it through
    // as-is.
    const safe = error instanceof SyntaxError
      ? new Error("SyntaxError parsing token response (body withheld)")
      : error;
    console.error("Token refresh error:", safeErr(safe));
    reportRefreshFailure("oauth_refresh: request to NationBuilder failed", { phase: "network_or_parse" }, safe);
    return false;
  }
}

/** Refresh the token if we have a refresh token and it's near expiry */
export async function refreshTokenIfNeeded(): Promise<void> {
  if (!tokenData || !tokenData.refreshToken || !tokenData.expiresAt) return;

  // Refresh if within 5 minutes of expiry
  const fiveMinutes = 5 * 60 * 1000;
  if (Date.now() < tokenData.expiresAt - fiveMinutes) return;

  await refreshSingleFlight();
}

/** Force a token refresh (e.g. after a 401). Returns true if successful. */
export async function forceRefreshToken(): Promise<boolean> {
  return refreshSingleFlight();
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

      tokenData = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? null,
        expiresAt: data.expires_in
          ? Date.now() + data.expires_in * 1000
          : null,
      };

      // Persist to the volume so tokens survive restarts
      const persisted = persistTokens(tokenData);

      const expiryInfo = data.expires_in
        ? `Token expires in ${Math.round(data.expires_in / 3600)} hours (auto-refresh enabled).`
        : "Token does not expire.";

      // Say so on the page rather than only in the logs — whoever just clicked
      // through is the one person positioned to fix a bad volume mount, and
      // otherwise they'd only find out at the next restart.
      const persistenceNote = persisted
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
    res.json(getAuthStatus());
  });

  return router;
}
