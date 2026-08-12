/**
 * Two small gaps the MCP SDK's own OAuth router leaves for us to fill:
 *
 *  1. It serves RFC 9728 Protected Resource Metadata only at the
 *     resource-scoped path (`/.well-known/oauth-protected-resource/mcp`)
 *     and RFC 8414 Authorization Server Metadata only at
 *     `/.well-known/oauth-authorization-server` — never the bare PRM path,
 *     never an OpenID-Connect-discovery alias. Some clients probe the bare
 *     path first, or only know to look for `/.well-known/openid-configuration`
 *     — this mirrors the SDK's own metadata verbatim at those paths rather
 *     than redirecting, since a redirect isn't guaranteed to be followed by
 *     every minimal HTTP client doing discovery.
 *  2. `/mcp` itself needs CORS that EXPOSES `WWW-Authenticate` and
 *     `Mcp-Session-Id` — browser-based MCP clients can't read either header
 *     off a cross-origin response without `Access-Control-Expose-Headers`
 *     naming them, which breaks both the OAuth discovery trigger and
 *     session continuation for anyone using this over the web. Hand-rolled
 *     rather than depending on the `cors` package directly: it's only a
 *     transitive dependency of the SDK today, and relying on that without
 *     declaring it ourselves is one npm resolution change away from a
 *     silent breakage.
 */

import type { Request, Response, NextFunction, Router as ExpressRouter } from "express";
import { Router } from "express";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface WellKnownAliasOptions {
  /** The exact metadata object passed to mcpAuthRouter — reused here so the
   *  aliases can never drift from what the canonical paths actually serve. */
  oauthMetadata: OAuthMetadata;
  resourceServerUrl: URL;
  scopesSupported?: string[];
  resourceName?: string;
  serviceDocumentationUrl?: URL;
}

export function wellKnownAliasRouter(opts: WellKnownAliasOptions): ExpressRouter {
  const router = Router();

  // Mirrors the shape the SDK's own mcpAuthMetadataRouter builds internally
  // for the resource-scoped path (server/auth/router.js) — kept in sync by
  // hand since that construction isn't exported as a standalone function.
  const protectedResourceMetadata = {
    resource: opts.resourceServerUrl.href,
    authorization_servers: [opts.oauthMetadata.issuer],
    scopes_supported: opts.scopesSupported,
    resource_name: opts.resourceName,
    resource_documentation: opts.serviceDocumentationUrl?.href,
  };

  router.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
    res.status(200).json(protectedResourceMetadata);
  });

  router.get("/.well-known/openid-configuration", (_req: Request, res: Response) => {
    res.status(200).json(opts.oauthMetadata);
  });

  return router;
}

/**
 * Apply to /mcp (and, harmlessly, anywhere else that's fetched cross-origin
 * during discovery). Reflects the request's Origin rather than emitting a
 * bare `*`: this endpoint requires a bearer token either way, so there's no
 * cookie/credential boundary a wildcard origin would weaken, and reflecting
 * the origin is what lets `Access-Control-Allow-Credentials` be added later
 * without a second change if that's ever needed.
 */
export function mcpCorsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}
