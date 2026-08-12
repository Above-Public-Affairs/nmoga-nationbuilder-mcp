/**
 * Centralized error reporting to Above's Error Reporter service.
 *
 * `reportError` is fire-and-forget: never awaited, never blocks the caller,
 * no-ops if ERROR_API_URL/ERROR_API_KEY are unset (safe for local dev).
 *
 * Everything else here is additive on top of that baseline — existing
 * callers of reportError() are unaffected by any of it:
 *   - reportAndFlush: awaitable. For fatal paths where the process is about
 *     to exit and a fire-and-forget POST would be dropped before it lands.
 *   - reportErrorThrottled / resetThrottle: rate-limited reporting for paths
 *     that can fire once per request (auth failures, public endpoints) so a
 *     persistent failure doesn't flood the digest with one row per call.
 *   - scrub / safeErr: shared hygiene so token-adjacent paths (OAuth, the API
 *     client's retry loop) can't leak credential material into a report or
 *     a Railway log line.
 */

const PROJECT = "nmoga-nationbuilder-mcp";

function config(): { url: string; key: string } | null {
  const url = process.env.ERROR_API_URL;
  const key = process.env.ERROR_API_KEY;
  return url && key ? { url, key } : null;
}

/**
 * Redact credential-shaped substrings before anything leaves the process.
 * Belt-and-suspenders: call sites should already avoid passing secrets in
 * message/rawError, but this catches what slips through — e.g. an upstream
 * error message that echoes a bearer token, a raw token/secret field from a
 * request body, or a JWT.
 */
export function scrub(text: string): string {
  return text
    .replace(/Bearer\s+[\w\-.]+/gi, "Bearer [redacted]")
    .replace(/(access|refresh)_token"?\s*[:=]\s*"?[\w\-.]+"?/gi, (_m, kind: string) => `${kind}_token=[redacted]`)
    .replace(/client_secret"?\s*[:=]\s*"?[\w\-.]+"?/gi, "client_secret=[redacted]")
    .replace(/code_verifier"?\s*[:=]\s*"?[\w\-.]+"?/gi, "code_verifier=[redacted]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[redacted-jwt]");
}

function flatten(rawError: unknown): string | undefined {
  if (rawError === undefined || rawError === null) return undefined;
  const text = rawError instanceof Error
    ? `${rawError.message}\n${rawError.stack ?? ""}`
    : String(rawError);
  return scrub(text).slice(0, 2000);
}

/**
 * Facts attached to every report — lets the digest separate a prod HTTP
 * incident from a developer's local stdio run, and join a row back to a
 * Railway deployment. Caller-supplied context keys win on conflict.
 */
function baseContext(): Record<string, unknown> {
  const ctx: Record<string, unknown> = { transport: process.env.PORT ? "http" : "stdio" };
  if (process.env.RAILWAY_ENVIRONMENT_NAME) ctx.env = process.env.RAILWAY_ENVIRONMENT_NAME;
  if (process.env.RAILWAY_DEPLOYMENT_ID) ctx.deployment = process.env.RAILWAY_DEPLOYMENT_ID;
  if (process.env.RAILWAY_GIT_COMMIT_SHA) ctx.commit = process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7);
  return ctx;
}

export interface ReportParams {
  category: string;
  message: string;
  provider?: string;
  rawError?: unknown;
  context?: Record<string, unknown>;
}

function buildBody(params: ReportParams): string {
  return JSON.stringify({
    project: PROJECT,
    category: params.category.slice(0, 100),
    message: scrub(params.message).slice(0, 500),
    provider: params.provider,
    rawError: flatten(params.rawError),
    context: { ...baseContext(), ...params.context },
  });
}

/**
 * Report an error to the centralized Error Reporter API.
 * Fire-and-forget: never awaited, never blocks the request.
 * No-op if env vars are not set (safe for local dev).
 */
export function reportError(params: ReportParams): void {
  const cfg = config();
  if (!cfg) return;
  try {
    fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": cfg.key },
      body: buildBody(params),
    }).catch(() => {});
  } catch {
    /* telemetry must never break the caller's request */
  }
}

// --- Throttling -----------------------------------------------------------

const DEFAULT_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

/** Upper bound on distinct throttle keys tracked at once. Most keys here are
 *  fixed strings, but per-user auth throttle keys (one per connected
 *  NationBuilder account) and the per-OAuth-error-code key on the public
 *  callback route are both derived from request/user input, so this is a
 *  backstop against unbounded growth — sized well above what a normal team
 *  plus a handful of external users should ever reach. */
const MAX_THROTTLE_KEYS = 500;

interface ThrottleState {
  lastSentAt: number;
  suppressed: number;
}
const throttleState = new Map<string, ThrottleState>();

export interface ThrottledReportParams extends ReportParams {
  /** Key identifying the specific failure mode. Distinct failure modes (e.g.
   *  "refresh rejected" vs "Railway persist failed") must use distinct keys
   *  — sharing one across unrelated failures means one masks the other. */
  throttleKey: string;
  /** Window length. Defaults to 1h: long enough that a persistent failure
   *  (e.g. a revoked refresh token, hit on every tool call) doesn't flood
   *  the digest, short enough that a same-day fix is visible same-day. */
  throttleMs?: number;
  /** Bypass an open window — use on a healthy -> broken transition so the
   *  first failure after a recovery is never swallowed by a stale window. */
  force?: boolean;
}

/**
 * Rate-limited report for paths that can fire once per request or once per
 * public HTTP hit. The first report in a window delivers immediately;
 * further ones in the same window are counted, not sent — the count rides
 * along on the next delivery as `context.suppressed_since_last`, so the
 * digest still shows true volume without being flooded by it.
 */
export function reportErrorThrottled(params: ThrottledReportParams): void {
  const { throttleKey, throttleMs = DEFAULT_THROTTLE_MS, force, ...rest } = params;
  const now = Date.now();
  const state = throttleState.get(throttleKey);

  if (state && !force && now - state.lastSentAt < throttleMs) {
    state.suppressed++;
    return;
  }

  // Evict the single oldest key rather than clear()ing the whole map: with
  // per-user keys now in play, hitting the ceiling is plausible in normal
  // operation, and a full clear() would reopen every other key's suppression
  // window at once — a burst of duplicate reports for users who were already
  // being throttled correctly, not just the one that pushed us over.
  if (!state && throttleState.size >= MAX_THROTTLE_KEYS) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, entry] of throttleState) {
      if (entry.lastSentAt < oldestAt) {
        oldestAt = entry.lastSentAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) throttleState.delete(oldestKey);
  }
  const suppressed = state?.suppressed ?? 0;
  throttleState.set(throttleKey, { lastSentAt: now, suppressed: 0 });

  reportError({
    ...rest,
    context: {
      throttle_key: throttleKey,
      ...(suppressed > 0 ? { suppressed_since_last: suppressed } : {}),
      ...rest.context,
    },
  });
}

/**
 * Clear a key's window so the next failure on that path reports immediately.
 * Call on recovery (e.g. a refresh that finally succeeds again) rather than
 * relying on `force` at the call site every time.
 */
export function resetThrottle(throttleKey: string): void {
  throttleState.delete(throttleKey);
}

// --- Fatal-path flush -------------------------------------------------------

/**
 * Awaitable report for fatal paths (uncaughtException, unhandledRejection,
 * startup failure) where the process is about to exit and the fire-and-
 * forget POST in reportError() would be dropped before the socket flushes.
 * Never throws; resolves immediately without env vars. Bounded by its own
 * timeout so a slow/unreachable Error Reporter can't hang a shutdown.
 */
export async function reportAndFlush(params: ReportParams): Promise<void> {
  const cfg = config();
  if (!cfg) return;
  try {
    await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": cfg.key },
      body: buildBody(params),
      signal: AbortSignal.timeout(1400),
    });
  } catch {
    /* swallow — telemetry must never delay or block a shutdown */
  }
}

// --- Log/report hygiene on token-adjacent paths -----------------------------

/**
 * Log-safe rendering of an error: name + message + status/code only. Use on
 * OAuth/token paths where console-dumping the whole object risks splattering
 * a request body (client_secret, refresh_token) into Railway logs. The full
 * object can still go to `rawError` in a report, where scrub() applies.
 */
export function safeErr(err: unknown): string {
  if (!(err instanceof Error)) return scrub(String(err));
  const withCode = err as { status?: unknown; code?: unknown };
  const status = withCode.status ?? withCode.code;
  const base = `${err.name}: ${err.message}`;
  return scrub(status !== undefined ? `${base} (${String(status)})` : base);
}
