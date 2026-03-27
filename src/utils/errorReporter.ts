const ERROR_API_URL = process.env.ERROR_API_URL;
const ERROR_API_KEY = process.env.ERROR_API_KEY;

/**
 * Report an error to the centralized Error Reporter API.
 * Fire-and-forget: never awaited, never blocks the request.
 * No-op if env vars are not set (safe for local dev).
 */
export function reportError(params: {
  category: string;
  message: string;
  provider?: string;
  rawError?: unknown;
  context?: Record<string, unknown>;
}): void {
  if (!ERROR_API_URL || !ERROR_API_KEY) return;

  const rawError = params.rawError
    ? (params.rawError instanceof Error
        ? `${params.rawError.message}\n${params.rawError.stack}`
        : String(params.rawError)
      ).slice(0, 2000)
    : undefined;

  fetch(ERROR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": ERROR_API_KEY,
    },
    body: JSON.stringify({
      project: "nmoga-nationbuilder-mcp",
      category: params.category,
      message: params.message,
      provider: params.provider,
      rawError,
      context: params.context,
    }),
  }).catch(() => {});
}
