/**
 * OAuth 2.0 flow for NationBuilder
 *
 * Adds /oauth/authorize and /oauth/callback routes.
 * Persists tokens to Railway env var (NATIONBUILDER_ACCESS_TOKEN) so they survive restarts.
 * Falls back to NATIONBUILDER_ACCESS_TOKEN env var on startup.
 *
 * Security: CSRF state parameter, PKCE (S256), HTML output escaping.
 */

import { Router } from "express";
import { randomBytes, createHash } from "crypto";
import { reportError } from "./utils/errorReporter.js";

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
 * Persist the access + refresh tokens to Railway env vars so they survive restarts.
 *
 * NationBuilder rotates the refresh token on every refresh, so if this write
 * fails the copy in Railway's env goes stale immediately — and the next restart
 * hydrates a dead refresh token, which can't be recovered from without a human
 * re-running /oauth/authorize. That makes a silent failure here far more
 * expensive than it looks, so failures are logged loudly and reported.
 *
 * Railway accepts two different credential styles and they are NOT
 * interchangeable: account/workspace tokens go in `Authorization: Bearer`,
 * project tokens go in the `Project-Access-Token` header. Sending a project
 * token as a Bearer yields "Not Authorized", so try both before giving up.
 */
async function persistTokenToRailway(accessToken: string, refreshToken?: string | null): Promise<boolean> {
  const railwayToken = process.env.RAILWAY_API_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  const serviceId = process.env.RAILWAY_SERVICE_ID;

  if (!railwayToken || !projectId || !environmentId || !serviceId) {
    console.error(
      "Token persistence skipped — missing Railway config. " +
      "Tokens will be lost on restart and someone will have to re-run /oauth/authorize."
    );
    return false;
  }

  const mutation = `
    mutation UpsertVariables($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }
  `;

  const body = JSON.stringify({
    query: mutation,
    variables: {
      input: {
        projectId,
        environmentId,
        serviceId,
        variables: {
          NATIONBUILDER_ACCESS_TOKEN: accessToken,
          ...(refreshToken ? { NATIONBUILDER_REFRESH_TOKEN: refreshToken } : {}),
        },
      },
    },
  });

  const authStyles: { label: string; headers: Record<string, string> }[] = [
    { label: "account token", headers: { Authorization: `Bearer ${railwayToken}` } },
    { label: "project token", headers: { "Project-Access-Token": railwayToken } },
  ];

  const failures: string[] = [];

  for (const style of authStyles) {
    try {
      const response = await fetch("https://backboard.railway.app/graphql/v2", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...style.headers },
        body,
      });

      const data = (await response.json()) as { errors?: { message: string }[] };

      if (!data.errors?.length && response.ok) {
        console.error(`OAuth token persisted to Railway env vars (via ${style.label})`);
        return true;
      }

      failures.push(`${style.label}: ${data.errors?.[0]?.message ?? `HTTP ${response.status}`}`);
    } catch (err) {
      failures.push(`${style.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const detail = failures.join(" | ");
  console.error(
    `CRITICAL: could not persist NationBuilder tokens to Railway (${detail}). ` +
    `The refresh token in Railway env is now STALE — this service will lose ` +
    `NationBuilder access on its next restart until someone re-runs /oauth/authorize. ` +
    `Fix RAILWAY_API_TOKEN (needs write access to this service's variables).`
  );
  reportError({
    category: "auth_error",
    message: `NationBuilder token persistence to Railway failed: ${detail}`,
    context: { projectId, serviceId },
  });
  return false;
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

/** Hydrate in-memory tokenData from env vars on startup (so refresh works after restarts) */
export function initTokenFromEnv(): void {
  const accessToken = process.env.NATIONBUILDER_ACCESS_TOKEN;
  const refreshToken = process.env.NATIONBUILDER_REFRESH_TOKEN;

  if (accessToken && !tokenData) {
    tokenData = {
      accessToken,
      refreshToken: refreshToken ?? null,
      expiresAt: null, // unknown — will refresh on first 401
    };
    console.error(
      `Loaded token from env vars (refresh token: ${refreshToken ? "yes" : "no"})`
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

  const ok = await doRefresh();
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
      console.error(`Token refresh failed: ${response.status} ${text}`);
      return false;
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    tokenData = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? tokenData.refreshToken,
      expiresAt: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : null,
    };

    console.error("OAuth token refreshed successfully");
    persistTokenToRailway(data.access_token, data.refresh_token ?? tokenData.refreshToken).catch(() => {});
    return true;
  } catch (error) {
    console.error("Token refresh error:", error);
    return false;
  }
}

/** Refresh the token if we have a refresh token and it's near expiry */
export async function refreshTokenIfNeeded(): Promise<void> {
  if (!tokenData || !tokenData.refreshToken || !tokenData.expiresAt) return;

  // Refresh if within 5 minutes of expiry
  const fiveMinutes = 5 * 60 * 1000;
  if (Date.now() < tokenData.expiresAt - fiveMinutes) return;

  await doRefresh();
}

/** Force a token refresh (e.g. after a 401). Returns true if successful. */
export async function forceRefreshToken(): Promise<boolean> {
  return doRefresh();
}

/** Create Express router with OAuth routes */
export function createOAuthRouter(): Router {
  const router = Router();

  // GET /oauth/authorize — redirect user to NationBuilder consent screen
  router.get("/oauth/authorize", (_req, res) => {
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
        console.error(`Token exchange failed: ${tokenResponse.status} ${text}`);
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

      // Persist to Railway env vars so tokens survive restarts
      persistTokenToRailway(data.access_token, data.refresh_token).catch(() => {});

      const expiryInfo = data.expires_in
        ? `Token expires in ${Math.round(data.expires_in / 3600)} hours (auto-refresh enabled).`
        : "Token does not expire.";

      console.error(
        `OAuth token obtained. Type: ${data.token_type}, Scope: ${data.scope ?? "default"}, Refresh: ${data.refresh_token ? "yes" : "no"}`
      );

      res.send(`
        <html><body style="font-family:system-ui;max-width:500px;margin:80px auto;text-align:center">
          <h2>Authorization Successful</h2>
          <p>NationBuilder OAuth token obtained.</p>
          <p style="color:#666;font-size:14px">${expiryInfo}</p>
          <p style="color:#666;font-size:14px">You can close this window. The MCP server is now using your OAuth credentials.</p>
        </body></html>
      `);
    } catch (err) {
      console.error("OAuth callback error:", err);
      res.status(500).send(`
        <html><body style="font-family:system-ui;max-width:500px;margin:80px auto;text-align:center">
          <h2>Error</h2>
          <p>Failed to exchange authorization code for token.</p>
        </body></html>
      `);
    }
  });

  // GET /oauth/status — check current auth state
  router.get("/oauth/status", (_req, res) => {
    const oauthConfigured = isOAuthConfigured();
    const hasOAuthToken = !!tokenData;
    const hasStaticToken = !!process.env.NATIONBUILDER_ACCESS_TOKEN;

    res.json({
      oauthConfigured,
      hasOAuthToken,
      hasStaticToken,
      activeMethod: hasOAuthToken ? "oauth" : hasStaticToken ? "static_token" : "none",
      tokenExpiry: tokenData?.expiresAt
        ? new Date(tokenData.expiresAt).toISOString()
        : null,
      hasRefreshToken: !!tokenData?.refreshToken,
    });
  });

  return router;
}
