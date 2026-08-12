/**
 * Per-user credential store.
 *
 * Replaces the single module-global `tokenData` in oauth.ts with a store
 * keyed by `userKey` — one NationBuilder access/refresh pair per connected
 * person, so each person's tool calls run under their own NationBuilder
 * identity and NationBuilder's own logs attribute correctly. Also holds the
 * MCP token-signing secret and any dynamically-registered OAuth clients
 * (claude.ai's connector, per RFC 7591), since both need to survive a
 * restart the same way the NationBuilder credentials do.
 *
 * One file, same path convention as before (`TOKEN_STORE_PATH` or
 * `$RAILWAY_VOLUME_MOUNT_PATH/nb-tokens.json`) — a second volume path would
 * just be a second chance to misconfigure the mount.
 *
 * Concurrency: writes are synchronous (`writeFileSync` -> `fsyncSync` ->
 * `renameSync` -> fsync the directory). Node is single-threaded, so a sync
 * write cannot interleave with another turn's read-modify-write — that is
 * what protects a rotated NationBuilder refresh token (single-use; losing a
 * rotation strands that person until they re-authorize by hand) from a lost
 * update if two requests refresh around the same tick. Do NOT convert this
 * to fs.promises; async writes reintroduce exactly that race.
 */

import {
  readFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  existsSync,
} from "fs";
import { dirname, join } from "path";
import { randomBytes, randomUUID, createHash } from "crypto";
import { reportError } from "../utils/errorReporter.js";

export interface StoredUserToken {
  userKey: string;
  /** From the identity probe, when it succeeds. Cosmetic only — attribution
   *  in NationBuilder's own logs comes from the token itself, not this field. */
  nbUserId: string | null;
  label: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null; // epoch ms
  createdAt: number;
  lastRefreshAt: number | null;
  lastSeenAt: number;
  refreshHealthy: boolean;
  revoked: boolean;
  needsReauth: boolean;
  /** True only for the single migrated pre-per-user entry. Never resolvable
   *  by any bearer token — see migrateLegacyShape() below. */
  legacy?: boolean;
}

export interface StoredClient {
  /** OAuthClientInformationFull fields live here (client_id, redirect_uris,
   *  token_endpoint_auth_method, ...) — kept loose rather than importing the
   *  SDK's type, so this module has no compile-time dependency on it. */
  [key: string]: unknown;
  client_id: string;
  dynamic: boolean;
  createdAt: number;
  lastUsedAt: number;
}

interface StoreShapeV2 {
  version: 2;
  signingSecret: string;
  clients: Record<string, StoredClient>;
  users: Record<string, StoredUserToken>;
}

/** The shape this file has had since the very first OAuth commit — no
 *  `version`, no `users`, just one token at the top level. */
interface LegacyShapeV1 {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
}

const LEGACY_USER_KEY = "legacy:shared";
const USER_PRUNE_IDLE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const REVOKED_PRUNE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ANON_USER_CAP = 200;
const CLIENT_CAP = 500;

let store: StoreShapeV2 | null = null;
/** Set once per process if load() ever needed to invent a signing secret
 *  ephemerally (no env var, no persisted value could be written). Surfaced
 *  on /oauth/status so it doesn't hide silently in logs alone. */
let signingSecretIsEphemeral = false;

// --- Path + status (moved here verbatim from the old oauth.ts, which this
// module now supersedes) ------------------------------------------------------

function getTokenStorePath(): string {
  if (process.env.TOKEN_STORE_PATH) return process.env.TOKEN_STORE_PATH;
  const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  return mount ? join(mount, "nb-tokens.json") : "";
}

/**
 * Report where the store will be written and whether that location actually
 * works, by probing it rather than assuming. A missing volume otherwise only
 * shows up as a failed write during a refresh — by then someone has already
 * authorized and will silently lose it on the next restart.
 */
export function getStoreStatus(): { path: string | null; writable: boolean; reason?: string } {
  const path = getTokenStorePath();
  if (!path) {
    return { path: null, writable: false, reason: "no RAILWAY_VOLUME_MOUNT_PATH or TOKEN_STORE_PATH — is a volume mounted?" };
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    const probe = `${path}.probe`;
    writeFileSyncSafe(probe, "");
    unlinkSync(probe);
    return { path, writable: true };
  } catch (err) {
    return { path, writable: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** writeFileSync equivalent, used only for the zero-byte probe above — no
 *  need for the fsync/rename machinery real saves use. */
function writeFileSyncSafe(path: string, data: string): void {
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

// --- Load + migrate -----------------------------------------------------------

function isLegacyShape(parsed: unknown): parsed is LegacyShapeV1 {
  return !!parsed && typeof parsed === "object" && "accessToken" in parsed && !("version" in parsed);
}

function isV2Shape(parsed: unknown): parsed is StoreShapeV2 {
  return !!parsed && typeof parsed === "object" && (parsed as { version?: unknown }).version === 2;
}

/**
 * Wrap the pre-per-user single token as `users["legacy:shared"]`, marked
 * `legacy: true` so verifyAccessToken() (in tokens.ts) never resolves any
 * bearer to it. Its only jobs: keep the existing NationBuilder refresh chain
 * warm across the migration (included in the sweep, same as any other user)
 * and show up in /oauth/status so it isn't a silent surprise. Pruned after
 * 30 days once real per-user entries are proven working.
 */
function migrateLegacyShape(legacy: LegacyShapeV1): StoreShapeV2 {
  const now = Date.now();
  return {
    version: 2,
    signingSecret: generateSigningSecret(),
    clients: {},
    users: {
      [LEGACY_USER_KEY]: {
        userKey: LEGACY_USER_KEY,
        nbUserId: null,
        label: "legacy shared token (pre-per-user)",
        accessToken: legacy.accessToken,
        refreshToken: legacy.refreshToken ?? null,
        expiresAt: legacy.expiresAt ?? null,
        createdAt: now,
        lastRefreshAt: null,
        lastSeenAt: now,
        refreshHealthy: true,
        revoked: false,
        needsReauth: false,
        legacy: true,
      },
    },
  };
}

function generateSigningSecret(): string {
  return randomBytes(48).toString("base64url");
}

/**
 * Load the store into memory. Safe to call more than once — subsequent
 * calls are a no-op if already loaded, matching the old oauth.ts's
 * `initTokenFromEnv`'s "if (tokenData) return" guard.
 */
export function load(): void {
  if (store) return;

  const path = getTokenStorePath();
  let parsed: unknown = null;

  if (path && existsSync(path)) {
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        console.error(`Could not read token store at ${path}: ${String(err)}`);
      }
    }
  }

  if (isV2Shape(parsed)) {
    store = parsed;
    // Backfill in case an older v2 write predates a field added later.
    store.clients ??= {};
    store.users ??= {};
  } else if (isLegacyShape(parsed)) {
    console.error(`Migrating pre-per-user token store at ${path} to per-user shape`);
    store = migrateLegacyShape(parsed);
    save();
  } else {
    // Leave signingSecret empty here, not pre-generated: resolveSigningSecret()
    // below decides where the secret comes from and — critically — whether it
    // could be persisted. Pre-filling it here would make its
    // `if (store.signingSecret) return` check think a secret already exists
    // and skip straight past that decision, silently generating and using a
    // brand-new unpersisted secret on every restart with no volume mounted,
    // with none of the CRITICAL logging that scenario is supposed to get.
    store = { version: 2, signingSecret: "", clients: {}, users: {} };
  }

  resolveSigningSecret();
}

/**
 * Signing-secret resolution order: MCP_TOKEN_SIGNING_SECRET env var (
 * recommended — survives a store-file loss independently) -> the secret
 * already persisted in the store file -> generate one and persist it. If
 * persistence itself is failing (no volume), fall back to the in-memory
 * value and flag it: every restart will then force every connected person
 * through a fresh NationBuilder login, because tokens signed with the old
 * ephemeral secret stop verifying.
 */
function resolveSigningSecret(): void {
  if (!store) return;

  const envSecret = process.env.MCP_TOKEN_SIGNING_SECRET;
  if (envSecret) {
    if (envSecret.length < 24) {
      console.error(
        "CRITICAL: MCP_TOKEN_SIGNING_SECRET is shorter than 24 characters. Use a " +
        "longer random value (e.g. `openssl rand -base64 48`) — a short signing " +
        "secret is guessable and lets an attacker forge MCP access tokens."
      );
      reportError({
        category: "auth_error",
        message: "startup: MCP_TOKEN_SIGNING_SECRET is too short",
      });
    }
    store.signingSecret = envSecret;
    return;
  }

  if (store.signingSecret) return; // already generated on a prior boot, persisted in the file

  store.signingSecret = generateSigningSecret();
  const persisted = save();
  if (!persisted) {
    signingSecretIsEphemeral = true;
    console.error(
      "CRITICAL: no MCP_TOKEN_SIGNING_SECRET env var and the generated signing " +
      "secret could not be persisted (store not writable). Every restart will " +
      "force every connected person to log into NationBuilder again. Set " +
      "MCP_TOKEN_SIGNING_SECRET or fix the volume mount."
    );
    reportError({
      category: "auth_error",
      message: "startup: signing secret is ephemeral — every restart re-authenticates everyone",
    });
  }
}

export function getSigningSecret(): string {
  load();
  return store!.signingSecret;
}

/** Whether the signing secret exists only in this process's memory. Surfaced
 *  on /oauth/status rather than only in a boot log line. */
export function isSigningSecretEphemeral(): boolean {
  return signingSecretIsEphemeral;
}

// --- Save --------------------------------------------------------------------

/**
 * Persist the store. Returns true only if the bytes actually landed —
 * callers must check this, unlike the old persistTokens(), whose return
 * value was discarded at its one call site, so a failed write reported
 * success while holding a credential that had already been revoked
 * upstream (NationBuilder refresh tokens are single-use).
 *
 * Also emits the pre-v2 top-level {accessToken, refreshToken, expiresAt}
 * keys (copied from the legacy user, if one still exists) purely so that a
 * rollback to pre-per-user code reading this same file doesn't crash on an
 * unrecognized shape. Those values go stale the moment any refresh rotates
 * past them — a rollback still needs a fresh /oauth/authorize regardless.
 */
export function save(): boolean {
  if (!store) return false;
  const path = getTokenStorePath();

  if (!path) {
    console.error(
      "CRITICAL: no token store path (RAILWAY_VOLUME_MOUNT_PATH unset and no " +
      "TOKEN_STORE_PATH). Credentials are in memory only — a restart will lose " +
      "every connected person's NationBuilder access until they re-authorize."
    );
    reportError({
      category: "auth_error",
      message: "token store persistence unavailable — no volume mounted",
    });
    return false;
  }

  const legacy = store.users[LEGACY_USER_KEY];
  const onDisk: StoreShapeV2 & Partial<LegacyShapeV1> = {
    ...store,
    ...(legacy
      ? { accessToken: legacy.accessToken, refreshToken: legacy.refreshToken, expiresAt: legacy.expiresAt }
      : {}),
  };

  try {
    mkdirSync(dirname(path), { recursive: true });
    // Unique temp name, not a fixed one: a fixed name means two concurrent
    // writers (a refresh racing a client registration, say) can interleave
    // bytes into the same temp file before either renames it, corrupting the
    // store for every connected person at once, not just the two writers.
    const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(onDisk, null, 2));
      fsyncSync(fd); // bytes durable before the rename that makes them visible
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    // fsync the directory too — without this, a crash right after the
    // rename can still leave the directory entry unresolvable to the new
    // inode on some filesystems/after a hard power loss. Best-effort: this
    // is defence-in-depth, not something to fail the save over.
    try {
      const dirFd = openSync(dirname(path), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      /* not fatal — the file rename itself already landed */
    }
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `CRITICAL: could not write token store to ${path} (${detail}). Any credential ` +
      `rotated in this process turn exists only in memory now.`
    );
    reportError({
      category: "auth_error",
      message: `token store persistence failed: ${detail}`,
      context: { path },
    });
    return false;
  }
}

// --- Users ---------------------------------------------------------------

export function getUser(userKey: string): StoredUserToken | null {
  load();
  return store!.users[userKey] ?? null;
}

export function getUserAccessToken(userKey: string): string | null {
  const user = getUser(userKey);
  return user && !user.revoked ? user.accessToken : null;
}

export function upsertUser(userKey: string, patch: Partial<StoredUserToken>): StoredUserToken {
  load();
  const now = Date.now();
  const existing = store!.users[userKey];
  // Defaults live in their own variable, spread first, so TS doesn't (rightly)
  // flag "explicit property overwritten by a later spread" — the point here
  // IS for existing/patch to override the defaults. userKey is set explicitly
  // last so neither spread can ever redirect this record under a different key.
  const defaults: StoredUserToken = {
    userKey,
    nbUserId: null,
    label: null,
    accessToken: "",
    refreshToken: null,
    expiresAt: null,
    createdAt: now,
    lastRefreshAt: null,
    lastSeenAt: now,
    refreshHealthy: true,
    revoked: false,
    needsReauth: false,
  };
  const merged: StoredUserToken = { ...defaults, ...existing, ...patch, userKey };
  store!.users[userKey] = merged;
  return merged;
}

/**
 * Set a user's NationBuilder tokens and persist immediately — this is the
 * one write in this module that MUST land on disk before returning, since
 * NationBuilder refresh tokens are single-use: the old one is already dead
 * upstream by the time this is called, so an unpersisted new pair means
 * that person is one restart away from having no working credential at
 * all. `save()` already logs CRITICAL and reports on a failed write; this
 * still returns the in-memory record either way (the caller should keep
 * using it — memory is the only correct copy once NB has revoked the old
 * token, whether or not the disk write landed).
 */
export function setUserTokens(
  userKey: string,
  tokens: { accessToken: string; refreshToken: string | null; expiresAt: number | null }
): StoredUserToken {
  const user = upsertUser(userKey, {
    ...tokens,
    lastRefreshAt: Date.now(),
    refreshHealthy: true,
    revoked: false,
    needsReauth: false,
  });
  save();
  return user;
}

/** Only persists if lastSeenAt moved by more than 5 minutes, so a chatty MCP
 *  session doesn't turn into a disk write per JSON-RPC message. */
export function markSeen(userKey: string): void {
  const user = getUser(userKey);
  if (!user) return;
  const now = Date.now();
  if (now - user.lastSeenAt < 5 * 60 * 1000) return;
  user.lastSeenAt = now;
  save();
}

export function markRevoked(userKey: string, needsReauth: boolean): void {
  const user = getUser(userKey);
  if (!user) return;
  user.revoked = true;
  user.needsReauth = needsReauth;
  save();
}

export function deleteUser(userKey: string): void {
  load();
  delete store!.users[userKey];
  save();
}

/** Non-secret summary for /oauth/status and boot logging — never includes
 *  accessToken/refreshToken. */
export function listUsersSummary(): Array<{
  userTag: string;
  label: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number | null;
  refreshHealthy: boolean;
  revoked: boolean;
  needsReauth: boolean;
  legacy: boolean;
}> {
  load();
  return Object.values(store!.users).map((u) => ({
    userTag: userTag(u.userKey),
    label: u.label,
    createdAt: u.createdAt,
    lastSeenAt: u.lastSeenAt,
    expiresAt: u.expiresAt,
    refreshHealthy: u.refreshHealthy,
    revoked: u.revoked,
    needsReauth: u.needsReauth,
    legacy: !!u.legacy,
  }));
}

export function allUserKeys(): string[] {
  load();
  return Object.keys(store!.users);
}

/**
 * Prune stale entries: idle > 90 days; revoked+needsReauth > 30 days;
 * `anon:`-prefixed entries (identity probe failed at authorize time, so
 * every re-authorization mints a fresh one) capped at 200, oldest-seen
 * evicted first. One save() if anything changed.
 */
export function pruneUsers(): void {
  load();
  const now = Date.now();
  let changed = false;

  for (const [key, user] of Object.entries(store!.users)) {
    if (user.legacy) continue; // pruned separately, see pruneLegacyUser()
    if (now - user.lastSeenAt > USER_PRUNE_IDLE_MS) {
      delete store!.users[key];
      changed = true;
      continue;
    }
    if (user.revoked && user.needsReauth && now - user.lastSeenAt > REVOKED_PRUNE_MS) {
      delete store!.users[key];
      changed = true;
    }
  }

  const anonEntries = Object.values(store!.users)
    .filter((u) => u.userKey.startsWith("anon:"))
    .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
  while (anonEntries.length > ANON_USER_CAP) {
    const evicted = anonEntries.shift()!;
    delete store!.users[evicted.userKey];
    changed = true;
  }

  if (changed) save();
}

/** Legacy entry gets a longer, separate grace period (30 days from first
 *  load, not from "idle") since it's meant to survive the whole migration
 *  window, not just the first re-authorization. */
export function pruneLegacyUserIfStale(maxAgeMs: number = REVOKED_PRUNE_MS): void {
  load();
  const legacy = store!.users[LEGACY_USER_KEY];
  if (legacy && Date.now() - legacy.createdAt > maxAgeMs) {
    delete store!.users[LEGACY_USER_KEY];
    save();
  }
}

// --- Clients (DCR registrations) ------------------------------------------

export function getClient(clientId: string): StoredClient | null {
  load();
  return store!.clients[clientId] ?? null;
}

export function putClient(client: StoredClient): void {
  load();
  store!.clients[client.client_id] = client;
  save();
}

export function touchClient(clientId: string): void {
  load();
  const client = store!.clients[clientId];
  if (!client) return;
  client.lastUsedAt = Date.now();
  // Not saved on every touch — see markSeen()'s rationale; a client is
  // touched on every token exchange, which would otherwise be a write per
  // MCP token refresh across every connected person.
}

export function pruneClients(): void {
  load();
  const entries = Object.values(store!.clients).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  let changed = false;
  while (entries.length > CLIENT_CAP) {
    const evicted = entries.shift()!;
    delete store!.clients[evicted.client_id];
    changed = true;
  }
  if (changed) save();
}

// --- Shared helpers --------------------------------------------------------

/** Short, PII-safe stand-in for a userKey in logs/reports/throttle keys —
 *  never the userKey itself, which for tier-1 identities embeds an NB user id. */
export function userTag(userKey: string): string {
  return createHash("sha256").update(userKey).digest("hex").slice(0, 8);
}

export { LEGACY_USER_KEY };
