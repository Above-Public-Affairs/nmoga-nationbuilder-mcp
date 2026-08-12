/**
 * The Authorization Server this MCP server presents to claude.ai (or any
 * other MCP client), backed by a real NationBuilder login per person.
 *
 * Two independent OAuth legs, two independent PKCE/state pairs, kept apart
 * by naming: everything claude-side is `mcp*`, everything NationBuilder-
 * side is `nb*`. We never see claude's `code_verifier` (that's the whole
 * point of PKCE) and never forward our own `nbCodeVerifier` downstream.
 *
 *   1. claude.ai -> GET /authorize (this module's authorize()) -> we mint an
 *      nbState + nbCodeVerifier, stash the pending claude.ai request keyed
 *      by nbState, and 302 to NationBuilder's real consent screen.
 *   2. NationBuilder -> GET /oauth/callback (oauth.ts, delegating here via
 *      completeUpstreamAuth()) -> exchange the NB code, run the identity
 *      probe, persist that person's NB tokens, mint our own short-lived
 *      mcpCode, and 302 back to claude.ai's redirect_uri.
 *   3. claude.ai -> POST /token (this module's exchangeAuthorizationCode())
 *      -> the SDK verifies claude's own code_verifier against the challenge
 *      we stored for mcpCode; we mint the MCP access/refresh pair.
 *   4. claude.ai -> /mcp with that bearer -> verifyAccessToken() resolves it
 *      to a userKey, which is what session binding (index.ts) uses to route
 *      every tool call through that person's own NationBuilder token.
 *   5. claude.ai -> POST /token (refresh_token) -> exchangeRefreshToken(),
 *      entirely independent of NationBuilder's own 24h token lifecycle.
 *
 * This module intentionally has a two-way relationship with ../oauth.ts:
 * oauth.ts's /oauth/callback route calls completeUpstreamAuth() here (since
 * NationBuilder's registered callback path can't be duplicated for a second
 * route), and this module calls oauth.ts's getConfig()/exchangeCodeForNbTokens()/
 * probeNationBuilderIdentity() (there is exactly one way this server talks
 * to NationBuilder's token endpoint). Node ESM handles this cycle safely as
 * long as neither side calls into the other at module-evaluation time —
 * every call here happens inside a request handler, well after both modules
 * have finished loading. Do not "fix" this into a bigger shared module
 * without cause.
 */

import { randomBytes } from "crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError, InvalidGrantError, InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import * as tokenStore from "./store.js";
import { signMcpToken, verifyMcpToken, generateCodeVerifier, generateCodeChallenge, MCP_ACCESS_TTL_S, MCP_REFRESH_TTL_S } from "./tokens.js";
import { getConfig, getNbOAuthBaseUrl, exchangeCodeForNbTokens, probeNationBuilderIdentity } from "../oauth.js";
import { reportErrorThrottled } from "../utils/errorReporter.js";

// --- Redirect-origin allowlist for Dynamic Client Registration -------------

/**
 * The SDK's own DCR handler (register.js) accepts ANY redirect_uris with no
 * validation — that's a phishing primitive without this: an attacker
 * registers a client pointing at their own domain, sends a legitimate
 * NationBuilder admin a link on OUR domain ("reconnect your connector"),
 * the admin sees our real domain, gets bounced to real NationBuilder, logs
 * in, and approves — and the resulting code lands at the ATTACKER's
 * redirect_uri, which (being a public client with no secret required) they
 * can redeem for an MCP token carrying that admin's NationBuilder
 * permissions. This allowlist means a registered client can only ever
 * receive a code at claude.ai/claude.com or a loopback address (native/
 * desktop clients, local dev) — never an attacker-controlled domain.
 */
const ALLOWED_REDIRECT_ORIGINS = new Set(["https://claude.ai", "https://claude.com"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isAllowedRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return ALLOWED_REDIRECT_ORIGINS.has(parsed.origin) || LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

interface StoredClientWithMeta extends OAuthClientInformationFull {
  dynamic: boolean;
}

const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const stored = tokenStore.getClient(clientId);
    if (!stored) return undefined;
    tokenStore.touchClient(clientId);
    // Strip our own bookkeeping fields (dynamic/createdAt/lastUsedAt) —
    // the SDK only expects the OAuthClientInformationFull shape.
    const { dynamic, createdAt, lastUsedAt, ...clientInfo } = stored as unknown as StoredClientWithMeta & {
      createdAt: number;
      lastUsedAt: number;
    };
    void dynamic;
    void createdAt;
    void lastUsedAt;
    return clientInfo;
  },

  registerClient(client) {
    const redirectUris = client.redirect_uris ?? [];
    for (const uri of redirectUris) {
      if (!isAllowedRedirectUri(uri)) {
        reportErrorThrottled({
          category: "auth_error",
          message: "oauth_register: rejected redirect_uri outside the claude.ai/loopback allowlist",
          context: { redirect_uri_origin: (() => { try { return new URL(uri).origin; } catch { return "unparseable"; } })() },
          throttleKey: "oauth_register_rejected",
          throttleMs: 60 * 60 * 1000,
        });
        throw new InvalidClientMetadataError(
          `redirect_uri is not allowed: only claude.ai, claude.com, and loopback addresses may register a client.`
        );
      }
    }

    // With the default clientIdGeneration:true (see index.ts's mcpAuthRouter
    // options), the handler has already set client_id/client_id_issued_at on
    // this object before calling us — but don't rely on that silently.
    const now = Math.floor(Date.now() / 1000);
    const clientId = (client as Partial<OAuthClientInformationFull>).client_id ?? randomBytes(16).toString("hex");
    const clientIdIssuedAt = (client as Partial<OAuthClientInformationFull>).client_id_issued_at ?? now;

    const full: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: clientIdIssuedAt,
    };

    tokenStore.putClient({
      ...full,
      dynamic: true,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });

    console.error(
      `OAuth client registered: ${clientId} (${full.client_name ?? "unnamed"}, ` +
      `redirect origins: ${redirectUris.map((u) => { try { return new URL(u).origin; } catch { return "?"; } }).join(", ")})`
    );

    return full;
  },
};

// --- Leg 1: pending claude.ai authorization, keyed by our own nbState ------

interface PendingUpstreamAuth {
  nbCodeVerifier: string;
  mcpClientId: string;
  mcpRedirectUri: string;
  mcpCodeChallenge: string;
  mcpState?: string;
  mcpResource?: string;
  createdAt: number;
}
const pendingUpstreamAuths = new Map<string, PendingUpstreamAuth>();
const PENDING_UPSTREAM_TTL_MS = 10 * 60 * 1000; // match the legacy flow's window

function cleanupPendingUpstreamAuths(): void {
  const now = Date.now();
  for (const [state, pending] of pendingUpstreamAuths) {
    if (now - pending.createdAt > PENDING_UPSTREAM_TTL_MS) pendingUpstreamAuths.delete(state);
  }
}

// --- Leg 3: our own short-lived authorization code, keyed by mcpCode -------

interface McpAuthCode {
  mcpClientId: string;
  mcpCodeChallenge: string;
  mcpRedirectUri: string;
  userKey: string;
  createdAt: number;
  expiresAt: number;
}
const mcpAuthCodes = new Map<string, McpAuthCode>();
const MCP_AUTH_CODE_TTL_MS = 120 * 1000;

function cleanupMcpAuthCodes(): void {
  const now = Date.now();
  for (const [code, entry] of mcpAuthCodes) {
    if (entry.expiresAt < now) mcpAuthCodes.delete(code);
  }
}

/**
 * Complete the upstream (NationBuilder) leg of the flow: exchange the code,
 * probe for identity, persist that person's NationBuilder tokens, and mint
 * our own authorization code for claude.ai to redeem at /token. Called
 * directly from oauth.ts's /oauth/callback — NationBuilder's registered
 * callback path can't be duplicated for a second route, so that file owns
 * the fixed route and delegates the actual completion here. An unknown or
 * already-consumed `nbState` (nothing pending) comes back as an `error`
 * result, never a throw.
 */
export async function completeUpstreamAuth(
  nbState: string,
  nbCode: string
): Promise<{ redirectTo: string } | { error: string }> {
  const pending = pendingUpstreamAuths.get(nbState);
  pendingUpstreamAuths.delete(nbState); // single-use regardless of outcome

  if (!pending) return { error: "expired_or_unknown_state" };

  const exchange = await exchangeCodeForNbTokens(nbCode, pending.nbCodeVerifier);
  if (!exchange.ok) return { error: exchange.errorCode ?? "token_exchange_failed" };

  const { slug } = getConfig();
  const probe = await probeNationBuilderIdentity(slug, exchange.accessToken);

  let userKey: string;
  if (probe) {
    userKey = `nb:${probe.nbUserId}`;
  } else {
    // Tier 2: a client registered via DCR gets a stable key across
    // re-authorizations by the same person (claude.ai registers one client
    // per connector install). A pasted STATIC client_id is shared by
    // everyone, so this fallback only applies to dynamically-registered
    // clients — otherwise every person using a shared static client would
    // collapse onto the same userKey.
    const client = tokenStore.getClient(pending.mcpClientId) as StoredClientWithMeta | null;
    userKey = client?.dynamic ? `client:${pending.mcpClientId}` : `anon:${randomBytes(16).toString("base64url")}`;
  }

  tokenStore.setUserTokens(userKey, {
    accessToken: exchange.accessToken,
    refreshToken: exchange.refreshToken,
    expiresAt: exchange.expiresAt,
  });
  if (probe) {
    tokenStore.upsertUser(userKey, { nbUserId: probe.nbUserId, label: probe.label });
    tokenStore.save();
  }

  const mcpCode = `mcp_ac_${randomBytes(32).toString("base64url")}`;
  cleanupMcpAuthCodes();
  mcpAuthCodes.set(mcpCode, {
    mcpClientId: pending.mcpClientId,
    mcpCodeChallenge: pending.mcpCodeChallenge,
    mcpRedirectUri: pending.mcpRedirectUri,
    userKey,
    createdAt: Date.now(),
    expiresAt: Date.now() + MCP_AUTH_CODE_TTL_MS,
  });

  const redirect = new URL(pending.mcpRedirectUri);
  redirect.searchParams.set("code", mcpCode);
  if (pending.mcpState) redirect.searchParams.set("state", pending.mcpState);
  return { redirectTo: redirect.toString() };
}

// --- The provider itself ----------------------------------------------------

export function createNationBuilderOAuthProvider(): OAuthServerProvider {
  return {
    clientsStore,

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
      const { slug, clientId, callbackUrl } = getConfig();

      if (!clientId || !callbackUrl) {
        // OAuthServerProvider.authorize() is documented to always end in a
        // redirect (success or error) — never throw an unrelated 500 here.
        const url = new URL(params.redirectUri);
        url.searchParams.set("error", "server_error");
        url.searchParams.set("error_description", "NationBuilder OAuth is not configured on this server.");
        if (params.state) url.searchParams.set("state", params.state);
        res.redirect(302, url.toString());
        return;
      }

      const nbState = randomBytes(24).toString("base64url");
      const nbCodeVerifier = generateCodeVerifier();
      const nbCodeChallenge = generateCodeChallenge(nbCodeVerifier);

      cleanupPendingUpstreamAuths();
      pendingUpstreamAuths.set(nbState, {
        nbCodeVerifier,
        mcpClientId: client.client_id,
        mcpRedirectUri: params.redirectUri,
        mcpCodeChallenge: params.codeChallenge,
        mcpState: params.state,
        mcpResource: params.resource?.toString(),
        createdAt: Date.now(),
      });

      const authorizeUrl = new URL(`${getNbOAuthBaseUrl(slug)}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", clientId);
      authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
      authorizeUrl.searchParams.set("state", nbState);
      authorizeUrl.searchParams.set("code_challenge", nbCodeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      res.redirect(302, authorizeUrl.toString());
    },

    async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
      cleanupMcpAuthCodes();
      const entry = mcpAuthCodes.get(authorizationCode);
      if (!entry || entry.mcpClientId !== client.client_id || entry.expiresAt < Date.now()) {
        throw new InvalidGrantError("Unknown, expired, or mismatched authorization code");
      }
      return entry.mcpCodeChallenge;
    },

    async exchangeAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string,
      _codeVerifier?: string,
      redirectUri?: string
    ): Promise<OAuthTokens> {
      const entry = mcpAuthCodes.get(authorizationCode);
      // challengeForAuthorizationCode() already validated existence/expiry/
      // client match moments earlier in the same request — re-checked here
      // defensively, and this is where single-use is actually enforced
      // (delete-on-read), not there, since a failed PKCE check must leave
      // the code alive for a legitimate retry.
      if (!entry || entry.mcpClientId !== client.client_id || entry.expiresAt < Date.now()) {
        throw new InvalidGrantError("Unknown, expired, or mismatched authorization code");
      }
      mcpAuthCodes.delete(authorizationCode);

      if (redirectUri && redirectUri !== entry.mcpRedirectUri) {
        throw new InvalidGrantError("redirect_uri does not match the one used to obtain this code");
      }

      const accessToken = signMcpToken({ typ: "access", sub: entry.userKey, cid: client.client_id, ttlSeconds: MCP_ACCESS_TTL_S });
      const refreshToken = signMcpToken({ typ: "refresh", sub: entry.userKey, cid: client.client_id, ttlSeconds: MCP_REFRESH_TTL_S });

      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: MCP_ACCESS_TTL_S,
        refresh_token: refreshToken,
        scope: "nationbuilder",
      };
    },

    async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
      const payload = verifyMcpToken(refreshToken, "refresh");
      if (!payload) throw new InvalidGrantError("Invalid or expired refresh token");
      if (payload.cid !== client.client_id) throw new InvalidGrantError("Refresh token was not issued to this client");

      const user = tokenStore.getUser(payload.sub);
      if (!user || user.revoked) {
        throw new InvalidGrantError("This connector's access has been revoked. Reconnect to sign in again.");
      }

      const accessToken = signMcpToken({ typ: "access", sub: payload.sub, cid: client.client_id, ttlSeconds: MCP_ACCESS_TTL_S });
      // Rotate but don't invalidate the old refresh token — there is no
      // reuse-detection store here, deliberately: a client retrying a
      // dropped refresh response would otherwise be stranded into a full
      // NationBuilder re-login. The token is worthless the moment the user
      // record it references is gone, which is the actual revocation lever.
      const newRefreshToken = signMcpToken({ typ: "refresh", sub: payload.sub, cid: client.client_id, ttlSeconds: MCP_REFRESH_TTL_S });

      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: MCP_ACCESS_TTL_S,
        refresh_token: newRefreshToken,
        scope: "nationbuilder",
      };
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const payload = verifyMcpToken(token, "access");
      if (!payload) throw new InvalidTokenError("Invalid, expired, or malformed access token");

      const user = tokenStore.getUser(payload.sub);
      if (!user || user.revoked) throw new InvalidTokenError("This connector's access has been revoked");

      return {
        token,
        clientId: payload.cid,
        scopes: ["nationbuilder"],
        expiresAt: payload.exp,
        resource: new URL(payload.aud),
        extra: { userKey: payload.sub },
      };
    },

    // revokeToken is deliberately NOT implemented: our MCP tokens are
    // stateless (no per-token denylist, by design — see exchangeRefreshToken
    // above), so the only thing we could actually revoke here is the whole
    // user record, which is a much bigger blast radius than "revoke this one
    // token" implies. The SDK omits /revoke from discovery entirely when this
    // is unset, so no client should ever call it. Real revocation is
    // deleting/marking-revoked the user's store entry (auth/store.ts) — same
    // lever the refresh-failure path already uses on invalid_grant.
  };
}
