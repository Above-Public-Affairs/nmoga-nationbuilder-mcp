/**
 * Shared HTTP auth for the MCP and OAuth endpoints.
 *
 * Two independent credentials are honored everywhere in this module, so
 * either one alone is sufficient:
 *
 *   - MCP_URL_SECRET — a long random path segment. claude.ai org connectors
 *     cannot send custom headers, so for that caller the URL itself has to
 *     carry the credential (e.g. /mcp/<secret>).
 *   - MCP_AUTH_TOKEN — a Bearer token, for callers that *can* send headers
 *     (mcp-remote, curl, local dev).
 *
 * Comparisons are constant-time to avoid leaking the secret length/prefix
 * through response timing.
 */

import { timingSafeEqual } from "crypto";
import type { Request } from "express";

/** Constant-time string equality. False (not a throw) on any length mismatch. */
export function safeCompare(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function getMcpAuthToken(): string | null {
  return process.env.MCP_AUTH_TOKEN || null;
}

export function getMcpUrlSecret(): string | null {
  return process.env.MCP_URL_SECRET || null;
}

/** True if the request carries a valid `Authorization: Bearer <MCP_AUTH_TOKEN>` header. */
export function isValidBearerToken(req: Request): boolean {
  const token = getMcpAuthToken();
  if (!token) return false;
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return false;
  return safeCompare(header.slice(7), token);
}

/** True if `candidate` (a URL path segment) matches the configured MCP_URL_SECRET. */
export function isValidUrlSecret(candidate: string | string[] | undefined): boolean {
  const secret = getMcpUrlSecret();
  if (!secret) return false;
  // Express types a route param as string | string[] to cover repeated
  // segments (e.g. a "*" wildcard) — a single named param is always one
  // string, but a candidate that somehow arrived as an array can never be
  // the secret, since the secret itself is never an array.
  if (Array.isArray(candidate)) return false;
  return safeCompare(candidate, secret);
}

/** True if either credential checks out — the shared gate for /mcp, /sse, and /oauth/*. */
export function isAuthorized(req: Request, urlSecretCandidate?: string | string[]): boolean {
  return isValidUrlSecret(urlSecretCandidate) || isValidBearerToken(req);
}
