/**
 * MCP access/refresh token signing + PKCE primitives.
 *
 * The MCP tokens this server issues to claude.ai (or any other MCP client)
 * are a stateless HMAC, not a JWT and not an opaque handle into a lookup
 * table: no JWT library (so no algorithm-confusion surface), and no
 * server-side token map that a Railway redeploy would wipe out from under
 * every live connector session. The signing secret itself (from
 * auth/store.ts) IS persisted, which is what actually survives a restart —
 * the tokens verify against it fresh every time.
 *
 * PKCE helpers are shared between the pre-per-user flow in oauth.ts (kept
 * alive until the gate flips) and the Authorization Server's own upstream
 * leg in auth/provider.ts, which is why they live here rather than in
 * either of those two files.
 */

import { createHmac, createHash, randomBytes, timingSafeEqual } from "crypto";
import * as tokenStore from "./store.js";

export const MCP_ACCESS_TTL_S = 12 * 60 * 60; // 12 hours
export const MCP_REFRESH_TTL_S = 90 * 24 * 60 * 60; // 90 days

export type McpTokenType = "access" | "refresh";

export interface McpTokenPayload {
  v: 1;
  typ: McpTokenType;
  /** userKey — see auth/store.ts. Never a NationBuilder token itself. */
  sub: string;
  /** MCP client_id (ours, not NationBuilder's). */
  cid: string;
  /** This server's canonical /mcp resource URL — RFC 8707 audience binding. */
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

const PREFIX: Record<McpTokenType, string> = { access: "mcp_at_", refresh: "mcp_rt_" };

/**
 * This server's canonical public base URL — used both as the audience
 * claim on tokens we mint and as the expected audience when verifying them.
 * Deliberately env-derived rather than read per-request from headers: it
 * must be IDENTICAL across the mint and the (much later, different-request)
 * verify, and X-Forwarded-Host can vary between requests in ways a stored
 * claim can't tolerate. PUBLIC_BASE_URL overrides for anything
 * RAILWAY_PUBLIC_DOMAIN doesn't cover (custom domains, local tunnels).
 */
export function publicBaseUrl(): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  const port = process.env.PORT || "3000";
  return `http://localhost:${port}`;
}

export function timingSafeCompare(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function signPayload(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export function signMcpToken(params: { typ: McpTokenType; sub: string; cid: string; ttlSeconds: number }): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: McpTokenPayload = {
    v: 1,
    typ: params.typ,
    sub: params.sub,
    cid: params.cid,
    aud: `${publicBaseUrl()}/mcp`,
    iat: now,
    exp: now + params.ttlSeconds,
    jti: randomBytes(12).toString("base64url"),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = signPayload(payloadB64, tokenStore.getSigningSecret());
  return `${PREFIX[params.typ]}${payloadB64}.${sig}`;
}

/**
 * Verify a token of the expected type. Returns null on ANY failure — bad
 * prefix, bad signature, wrong type, expired, or wrong audience — never
 * throws. Callers that need to surface an OAuth-shaped rejection (the
 * bearer-auth middleware, the refresh-token grant) turn a null into their
 * own InvalidTokenError/InvalidGrantError; this function only answers
 * "valid or not."
 */
export function verifyMcpToken(token: string, expectedTyp: McpTokenType): McpTokenPayload | null {
  const prefix = PREFIX[expectedTyp];
  if (!token.startsWith(prefix)) return null;

  const rest = token.slice(prefix.length);
  const dot = rest.lastIndexOf(".");
  if (dot < 0) return null;
  const payloadB64 = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);

  const expectedSig = signPayload(payloadB64, tokenStore.getSigningSecret());
  if (!timingSafeCompare(sig, expectedSig)) return null;

  let payload: McpTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8")) as McpTokenPayload;
  } catch {
    return null;
  }

  if (payload.v !== 1 || payload.typ !== expectedTyp) return null;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (payload.aud !== `${publicBaseUrl()}/mcp`) return null;

  return payload;
}

// --- PKCE (shared between the legacy flow and the Authorization Server's
// own upstream-to-NationBuilder leg) -----------------------------------------

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
