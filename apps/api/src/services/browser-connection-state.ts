// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import { decrypt, encrypt } from "@appstrate/connect";
import type { Actor } from "@appstrate/connect";
import type {
  BrowserProviderBinding,
  BrowserProviderId,
  BrowserProviderProxy,
} from "@appstrate/core/sidecar-types";
import { db } from "@appstrate/db/client";
import {
  applications,
  browserConnectionAttempts,
  browserConnectionBindings,
  browserProfileDeletions,
  browserSessionLeases,
} from "@appstrate/db/schema";
import { and, eq, gt, lt, or, sql } from "drizzle-orm";

import type { AppScope } from "../lib/scope.ts";
import {
  createBrowserProfileManager,
  type BrowserProfileManager,
} from "./browser-profile-manager.ts";
import {
  drainBrowserProfileDeletions,
  enqueueBrowserProfileDeletion,
} from "./browser-profile-deletions.ts";
import { parseStoredBrowserProviderProxy } from "./browser-provider-routing.ts";

const DEFAULT_ATTEMPT_TTL_MS = 25 * 60_000;
const MIN_ATTEMPT_TTL_MS = 60_000;
const MAX_ATTEMPT_TTL_MS = 30 * 60_000;
const MAX_BROWSER_STATE_BYTES = 900 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_ATTEMPT_STATUSES = [
  "pending",
  "claimed",
  "state_received",
  "provisioning",
  "interaction_required",
] as const;
const TERMINAL_ATTEMPT_STATUSES = ["complete", "failed", "expired", "cancelled"] as const;
const DEFAULT_TERMINAL_RETENTION_MS = 24 * 60 * 60_000;

export type BrowserConnectionAttemptStatus =
  (typeof ACTIVE_ATTEMPT_STATUSES)[number] | "complete" | "failed" | "expired" | "cancelled";

export class BrowserAttemptUnauthorizedError extends Error {
  constructor() {
    super("browser companion attempt is invalid or expired");
    this.name = "BrowserAttemptUnauthorizedError";
  }
}

export class BrowserSessionBusyError extends Error {
  constructor() {
    super("BROWSER_SESSION_BUSY: browser connection profile is already leased");
    this.name = "BrowserSessionBusyError";
  }
}

function hashToken(token: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(token);
  return hasher.digest("hex");
}

function actorColumns(actor: Actor):
  | { userId: string; endUserId?: never }
  | {
      userId?: never;
      endUserId: string;
    } {
  return actor.type === "user" ? { userId: actor.id } : { endUserId: actor.id };
}

function actorRef(actor: Actor): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${actor.type}:${actor.id}`);
  return `actor-${hasher.digest("hex")}`;
}

export interface BrowserAttemptView {
  id: string;
  scope: AppScope;
  actor: Actor;
  integrationId: string;
  authKey: string;
  connectionId: string | null;
  targetProvider: BrowserProviderId;
  profileRef: string;
  status: BrowserConnectionAttemptStatus;
  expiresAt: Date;
  interactionUrl: string | null;
  errorCode: string | null;
  proxy?: BrowserProviderProxy;
}

function toAttemptView(
  row: typeof browserConnectionAttempts.$inferSelect,
  orgId: string,
): BrowserAttemptView {
  if (!row.profileRef) throw new Error("browser attempt has no allocated profile");
  const actor: Actor = row.userId
    ? { type: "user", id: row.userId }
    : { type: "end_user", id: row.endUserId! };
  let interactionUrl: string | null = null;
  if (row.interactionEncrypted) {
    try {
      interactionUrl = decrypt(row.interactionEncrypted);
    } catch {
      interactionUrl = null;
    }
  }
  return {
    id: row.id,
    scope: { orgId, applicationId: row.applicationId },
    actor,
    integrationId: row.integrationId,
    authKey: row.authKey,
    connectionId: row.connectionId,
    targetProvider: row.targetProvider as BrowserProviderId,
    profileRef: row.profileRef,
    status: row.status as BrowserConnectionAttemptStatus,
    expiresAt: row.expiresAt,
    interactionUrl,
    errorCode: row.errorCode,
    ...(row.proxyConfigEncrypted
      ? {
          proxy: parseStoredBrowserProviderProxy(
            JSON.parse(decrypt(row.proxyConfigEncrypted)) as unknown,
          ),
        }
      : {}),
  };
}

export async function createBrowserConnectionAttempt(
  input: {
    scope: AppScope;
    actor: Actor;
    integrationId: string;
    authKey: string;
    connectionId?: string;
    targetProvider: BrowserProviderId;
    proxy?: BrowserProviderProxy;
    ttlMs?: number;
  },
  profileManager: BrowserProfileManager = createBrowserProfileManager(),
): Promise<{ attempt: BrowserAttemptView; token: string }> {
  const ttlMs = input.ttlMs ?? DEFAULT_ATTEMPT_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_ATTEMPT_TTL_MS || ttlMs > MAX_ATTEMPT_TTL_MS) {
    throw new Error("browser companion attempt ttl is outside the allowed range");
  }
  const id = crypto.randomUUID();
  const token = randomBytes(32).toString("base64url");
  const profileRef = await profileManager.allocate({
    provider: input.targetProvider,
    attemptId: id,
    actorRef: actorRef(input.actor),
  });
  try {
    const [row] = await db
      .insert(browserConnectionAttempts)
      .values({
        id,
        applicationId: input.scope.applicationId,
        integrationId: input.integrationId,
        authKey: input.authKey,
        ...actorColumns(input.actor),
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        targetProvider: input.targetProvider,
        profileRef,
        ...(input.proxy ? { proxyConfigEncrypted: encrypt(JSON.stringify(input.proxy)) } : {}),
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + ttlMs),
      })
      .returning();
    if (!row) throw new Error("browser companion attempt insert returned no row");
    return {
      attempt: toAttemptView(row, input.scope.orgId),
      token,
    };
  } catch (error) {
    await profileManager.remove(input.targetProvider, profileRef).catch(() => undefined);
    throw error;
  }
}

export async function authenticateBrowserConnectionAttempt(
  attemptId: string,
  token: string,
  options: { claim?: boolean; now?: Date } = {},
): Promise<BrowserAttemptView> {
  if (!UUID_PATTERN.test(attemptId) || token.length < 32 || token.length > 256) {
    throw new BrowserAttemptUnauthorizedError();
  }
  const now = options.now ?? new Date();
  const tokenHash = hashToken(token);
  if (options.claim) {
    await db
      .update(browserConnectionAttempts)
      .set({ status: "claimed", claimedAt: now, updatedAt: now })
      .where(
        and(
          eq(browserConnectionAttempts.id, attemptId),
          eq(browserConnectionAttempts.tokenHash, tokenHash),
          eq(browserConnectionAttempts.status, "pending"),
          gt(browserConnectionAttempts.expiresAt, now),
        ),
      );
  }
  const [result] = await db
    .select({ attempt: browserConnectionAttempts, orgId: applications.orgId })
    .from(browserConnectionAttempts)
    .innerJoin(applications, eq(applications.id, browserConnectionAttempts.applicationId))
    .where(
      and(
        eq(browserConnectionAttempts.id, attemptId),
        eq(browserConnectionAttempts.tokenHash, tokenHash),
        gt(browserConnectionAttempts.expiresAt, now),
      ),
    )
    .limit(1);
  if (!result || result.attempt.status === "cancelled" || result.attempt.status === "expired") {
    throw new BrowserAttemptUnauthorizedError();
  }
  return toAttemptView(result.attempt, result.orgId);
}

/** Internal lookup used by the durable provisioning worker (no bearer path). */
export async function authenticateBrowserConnectionAttemptById(
  attemptId: string,
  now = new Date(),
): Promise<BrowserAttemptView> {
  const [result] = await db
    .select({ attempt: browserConnectionAttempts, orgId: applications.orgId })
    .from(browserConnectionAttempts)
    .innerJoin(applications, eq(applications.id, browserConnectionAttempts.applicationId))
    .where(
      and(
        eq(browserConnectionAttempts.id, attemptId),
        gt(browserConnectionAttempts.expiresAt, now),
        or(
          ...ACTIVE_ATTEMPT_STATUSES.map((status) => eq(browserConnectionAttempts.status, status)),
        ),
      ),
    )
    .limit(1);
  if (!result) throw new BrowserAttemptUnauthorizedError();
  return toAttemptView(result.attempt, result.orgId);
}

function allowedHosts(allowedOrigins: readonly string[]): Set<string> {
  const hosts = new Set<string>();
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin) {
      throw new Error("browser companion allowed origins must be exact HTTPS origins");
    }
    hosts.add(url.hostname.toLowerCase());
  }
  return hosts;
}

/** Validate and canonicalize the untrusted companion's portable browser state. */
export function validatePortableBrowserState(
  encoded: string,
  allowedOrigins: readonly string[],
): string {
  if (Buffer.byteLength(encoded) === 0 || Buffer.byteLength(encoded) > MAX_BROWSER_STATE_BYTES) {
    throw new Error("browser companion state exceeds the size limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("browser companion state is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("browser companion state must be an object");
  }
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    !Array.isArray(state.cookies) ||
    !Array.isArray(state.origins) ||
    state.cookies.length > 256 ||
    state.origins.length > 64 ||
    Object.keys(state).some((key) => !["version", "cookies", "origins"].includes(key))
  ) {
    throw new Error("browser companion state has an unsupported shape");
  }
  const hosts = allowedHosts(allowedOrigins);
  const cookies: Array<Record<string, unknown>> = [];
  const cookieKeys = new Set<string>();
  for (const raw of state.cookies) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("browser companion state contains a malformed cookie");
    }
    const cookie = raw as Record<string, unknown>;
    const domain =
      typeof cookie.domain === "string" ? cookie.domain.toLowerCase().replace(/^\./, "") : "";
    if (
      !hosts.has(domain) ||
      Object.keys(cookie).some(
        (key) =>
          ![
            "name",
            "value",
            "domain",
            "path",
            "expires",
            "httpOnly",
            "secure",
            "sameSite",
          ].includes(key),
      ) ||
      typeof cookie.name !== "string" ||
      cookie.name.length < 1 ||
      cookie.name.length > 256 ||
      typeof cookie.value !== "string" ||
      cookie.value.length > 262_144
    ) {
      throw new Error("browser companion state contains a forbidden cookie");
    }
    if (
      (cookie.path !== undefined &&
        (typeof cookie.path !== "string" ||
          !cookie.path.startsWith("/") ||
          cookie.path.length > 4096)) ||
      (cookie.expires !== undefined &&
        (typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires))) ||
      (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== "boolean") ||
      (cookie.secure !== undefined && typeof cookie.secure !== "boolean") ||
      (cookie.sameSite !== undefined &&
        cookie.sameSite !== "Strict" &&
        cookie.sameSite !== "Lax" &&
        cookie.sameSite !== "None")
    ) {
      throw new Error("browser companion state contains a malformed cookie");
    }
    const cookieKey = JSON.stringify([domain, cookie.path ?? "/", cookie.name]);
    if (cookieKeys.has(cookieKey)) {
      throw new Error("browser companion state contains a duplicate cookie");
    }
    cookieKeys.add(cookieKey);
    cookies.push({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path ?? "/",
      expires: cookie.expires ?? -1,
      httpOnly: cookie.httpOnly ?? false,
      secure: cookie.secure ?? false,
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    });
  }
  const origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }> = [];
  const originKeys = new Set<string>();
  for (const raw of state.origins) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("browser companion state contains malformed origin storage");
    }
    const origin = raw as Record<string, unknown>;
    if (
      Object.keys(origin).some((key) => key !== "origin" && key !== "localStorage") ||
      typeof origin.origin !== "string" ||
      !allowedOrigins.includes(origin.origin) ||
      !Array.isArray(origin.localStorage) ||
      origin.localStorage.length > 256
    ) {
      throw new Error("browser companion state contains forbidden origin storage");
    }
    if (originKeys.has(origin.origin)) {
      throw new Error("browser companion state contains duplicate origin storage");
    }
    originKeys.add(origin.origin);
    const localStorage: Array<{ name: string; value: string }> = [];
    const localStorageKeys = new Set<string>();
    for (const rawEntry of origin.localStorage) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        throw new Error("browser companion local storage is malformed");
      }
      const entry = rawEntry as Record<string, unknown>;
      if (
        Object.keys(entry).some((key) => key !== "name" && key !== "value") ||
        typeof entry.name !== "string" ||
        entry.name.length > 1024 ||
        typeof entry.value !== "string" ||
        entry.value.length > 262_144
      ) {
        throw new Error("browser companion local storage is malformed");
      }
      if (localStorageKeys.has(entry.name)) {
        throw new Error("browser companion local storage contains a duplicate key");
      }
      localStorageKeys.add(entry.name);
      localStorage.push({ name: entry.name, value: entry.value });
    }
    origins.push({ origin: origin.origin, localStorage });
  }
  const canonical = JSON.stringify({ version: 1, cookies, origins });
  if (Buffer.byteLength(canonical) > MAX_BROWSER_STATE_BYTES) {
    throw new Error("browser companion state exceeds the size limit");
  }
  return canonical;
}

export async function storeBrowserAttemptHandoff(input: {
  attemptId: string;
  token: string;
  browserState: string;
  allowedOrigins: readonly string[];
}): Promise<BrowserAttemptView> {
  await authenticateBrowserConnectionAttempt(input.attemptId, input.token, { claim: true });
  const browserState = validatePortableBrowserState(input.browserState, input.allowedOrigins);
  const now = new Date();
  const [row] = await db
    .update(browserConnectionAttempts)
    .set({
      status: "state_received",
      handoffEncrypted: encrypt(browserState),
      interactionEncrypted: null,
      errorCode: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(browserConnectionAttempts.id, input.attemptId),
        eq(browserConnectionAttempts.tokenHash, hashToken(input.token)),
        or(
          eq(browserConnectionAttempts.status, "pending"),
          eq(browserConnectionAttempts.status, "claimed"),
        ),
        gt(browserConnectionAttempts.expiresAt, now),
      ),
    )
    .returning();
  if (!row) throw new BrowserAttemptUnauthorizedError();
  return authenticateBrowserConnectionAttempt(input.attemptId, input.token);
}

export async function consumeBrowserAttemptHandoff(attemptId: string): Promise<string> {
  const now = new Date();
  const [row] = await db
    .update(browserConnectionAttempts)
    .set({ status: "provisioning", updatedAt: now })
    .where(
      and(
        eq(browserConnectionAttempts.id, attemptId),
        eq(browserConnectionAttempts.status, "state_received"),
        gt(browserConnectionAttempts.expiresAt, now),
      ),
    )
    .returning({ handoffEncrypted: browserConnectionAttempts.handoffEncrypted });
  if (!row?.handoffEncrypted) throw new BrowserAttemptUnauthorizedError();
  return decrypt(row.handoffEncrypted);
}

export async function setBrowserAttemptInteraction(attemptId: string, url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || url.length > 4096) {
    throw new Error("browser provider returned an unsafe interaction URL");
  }
  const now = new Date();
  const rows = await db
    .update(browserConnectionAttempts)
    .set({
      status: "interaction_required",
      interactionEncrypted: encrypt(url),
      updatedAt: now,
    })
    .where(
      and(
        eq(browserConnectionAttempts.id, attemptId),
        or(
          eq(browserConnectionAttempts.status, "provisioning"),
          eq(browserConnectionAttempts.status, "interaction_required"),
        ),
        gt(browserConnectionAttempts.expiresAt, now),
      ),
    )
    .returning({ id: browserConnectionAttempts.id });
  if (rows.length !== 1) throw new BrowserAttemptUnauthorizedError();
}

export async function failBrowserConnectionAttempt(
  attemptId: string,
  errorCode: string,
): Promise<void> {
  const safeCode = /^BROWSER_[A-Z_]{1,64}$/.test(errorCode) ? errorCode : "BROWSER_UNAVAILABLE";
  const rows = await db
    .update(browserConnectionAttempts)
    .set({
      status: "failed",
      errorCode: safeCode,
      handoffEncrypted: null,
      interactionEncrypted: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(browserConnectionAttempts.id, attemptId),
        or(
          ...ACTIVE_ATTEMPT_STATUSES.map((status) => eq(browserConnectionAttempts.status, status)),
        ),
      ),
    )
    .returning({
      provider: browserConnectionAttempts.targetProvider,
      profileRef: browserConnectionAttempts.profileRef,
    });
  const row = rows[0];
  if (row?.profileRef) {
    await enqueueBrowserProfileDeletion(row.provider as BrowserProviderId, row.profileRef);
  }
}

/**
 * Fail only the local-acquisition portion of an attempt. The bearer is
 * authenticated first, and the guarded transition cannot abort a handoff that
 * has already moved into durable provider provisioning.
 */
export async function failBrowserConnectionAttemptFromCompanion(input: {
  attemptId: string;
  token: string;
  errorCode: string;
}): Promise<boolean> {
  await authenticateBrowserConnectionAttempt(input.attemptId, input.token);
  const safeCode = /^BROWSER_[A-Z_]{1,64}$/.test(input.errorCode)
    ? input.errorCode
    : "BROWSER_UNAVAILABLE";
  const now = new Date();
  const rows = await db
    .update(browserConnectionAttempts)
    .set({
      status: "failed",
      errorCode: safeCode,
      handoffEncrypted: null,
      interactionEncrypted: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(browserConnectionAttempts.id, input.attemptId),
        eq(browserConnectionAttempts.tokenHash, hashToken(input.token)),
        or(
          eq(browserConnectionAttempts.status, "pending"),
          eq(browserConnectionAttempts.status, "claimed"),
        ),
        gt(browserConnectionAttempts.expiresAt, now),
      ),
    )
    .returning({
      provider: browserConnectionAttempts.targetProvider,
      profileRef: browserConnectionAttempts.profileRef,
    });
  const row = rows[0];
  if (row?.profileRef) {
    await enqueueBrowserProfileDeletion(row.provider as BrowserProviderId, row.profileRef);
  }
  return row !== undefined;
}

export async function finalizeBrowserConnectionBinding(input: {
  attemptId: string;
  connectionId: string;
  verifiedAt?: Date;
}): Promise<BrowserProviderBinding> {
  const verifiedAt = input.verifiedAt ?? new Date();
  const binding = await db.transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(browserConnectionAttempts)
      .where(eq(browserConnectionAttempts.id, input.attemptId))
      .limit(1)
      .for("update");
    if (
      !attempt?.profileRef ||
      (attempt.status !== "provisioning" && attempt.status !== "interaction_required") ||
      attempt.expiresAt <= verifiedAt
    ) {
      throw new Error("browser attempt is not ready to finalize");
    }
    const [previous] = await tx
      .select({
        id: browserConnectionBindings.id,
        provider: browserConnectionBindings.provider,
        profileRef: browserConnectionBindings.profileRef,
      })
      .from(browserConnectionBindings)
      .where(eq(browserConnectionBindings.connectionId, input.connectionId))
      .limit(1)
      .for("update");
    if (previous) {
      const [activeLease] = await tx
        .select({ bindingId: browserSessionLeases.bindingId })
        .from(browserSessionLeases)
        .where(
          and(
            eq(browserSessionLeases.bindingId, previous.id),
            gt(browserSessionLeases.expiresAt, verifiedAt),
          ),
        )
        .limit(1);
      if (activeLease) throw new BrowserSessionBusyError();
    }
    const [next] = await tx
      .insert(browserConnectionBindings)
      .values({
        connectionId: input.connectionId,
        provider: attempt.targetProvider,
        profileRef: attempt.profileRef,
        proxyConfigEncrypted: attempt.proxyConfigEncrypted,
        status: "ready",
        lastVerifiedAt: verifiedAt,
      })
      .onConflictDoUpdate({
        target: browserConnectionBindings.connectionId,
        set: {
          provider: attempt.targetProvider,
          profileRef: attempt.profileRef,
          proxyConfigEncrypted: attempt.proxyConfigEncrypted,
          status: "ready",
          stateVersion: sql`${browserConnectionBindings.stateVersion} + 1`,
          lastVerifiedAt: verifiedAt,
          updatedAt: verifiedAt,
        },
      })
      .returning();
    if (!next) throw new Error("browser connection binding upsert returned no row");
    if (
      previous &&
      (previous.provider !== attempt.targetProvider || previous.profileRef !== attempt.profileRef)
    ) {
      await tx
        .insert(browserProfileDeletions)
        .values({ provider: previous.provider, profileRef: previous.profileRef })
        .onConflictDoNothing({
          target: [browserProfileDeletions.provider, browserProfileDeletions.profileRef],
        });
    }
    await tx
      .update(browserConnectionAttempts)
      .set({
        connectionId: input.connectionId,
        status: "complete",
        handoffEncrypted: null,
        interactionEncrypted: null,
        errorCode: null,
        completedAt: verifiedAt,
        updatedAt: verifiedAt,
      })
      .where(eq(browserConnectionAttempts.id, input.attemptId));
    return next;
  });
  return {
    bindingId: binding.id,
    provider: binding.provider as BrowserProviderId,
    profileRef: binding.profileRef,
    stateVersion: binding.stateVersion,
    ...(binding.proxyConfigEncrypted
      ? {
          proxy: parseStoredBrowserProviderProxy(
            JSON.parse(decrypt(binding.proxyConfigEncrypted)) as unknown,
          ),
        }
      : {}),
  };
}

export async function getBrowserProviderBinding(
  connectionId: string,
): Promise<BrowserProviderBinding | null> {
  const [row] = await db
    .select()
    .from(browserConnectionBindings)
    .where(
      and(
        eq(browserConnectionBindings.connectionId, connectionId),
        eq(browserConnectionBindings.status, "ready"),
      ),
    )
    .limit(1);
  return row
    ? {
        bindingId: row.id,
        provider: row.provider as BrowserProviderId,
        profileRef: row.profileRef,
        stateVersion: row.stateVersion,
        ...(row.proxyConfigEncrypted
          ? {
              proxy: parseStoredBrowserProviderProxy(
                JSON.parse(decrypt(row.proxyConfigEncrypted)) as unknown,
              ),
            }
          : {}),
      }
    : null;
}

export interface BrowserSessionLease {
  bindingId: string;
  ownerId: string;
  fencingToken: number;
  expiresAt: Date;
}

export async function acquireBrowserSessionLease(input: {
  bindingId: string;
  ownerId: string;
  ttlMs: number;
  expectedStateVersion?: number;
  now?: Date;
}): Promise<BrowserSessionLease> {
  if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > 4 * 60 * 60_000) {
    throw new Error("browser session lease ttl is outside the allowed range");
  }
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + input.ttlMs);
  return db.transaction(async (tx) => {
    // Lock the binding while claiming its lease. Reconnect finalization takes
    // the same lock, so a plan can never launch against a profile revision
    // that was replaced between resolution and workload start.
    const [binding] = await tx
      .select({
        status: browserConnectionBindings.status,
        stateVersion: browserConnectionBindings.stateVersion,
      })
      .from(browserConnectionBindings)
      .where(eq(browserConnectionBindings.id, input.bindingId))
      .limit(1)
      .for("update");
    if (
      !binding ||
      binding.status !== "ready" ||
      (input.expectedStateVersion !== undefined &&
        binding.stateVersion !== input.expectedStateVersion)
    ) {
      throw new Error("BROWSER_STATE_CONFLICT: browser connection profile changed");
    }
    const [inserted] = await tx
      .insert(browserSessionLeases)
      .values({ bindingId: input.bindingId, ownerId: input.ownerId, expiresAt, updatedAt: now })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      return {
        bindingId: inserted.bindingId,
        ownerId: inserted.ownerId,
        fencingToken: inserted.fencingToken,
        expiresAt: inserted.expiresAt,
      };
    }
    const [taken] = await tx
      .update(browserSessionLeases)
      .set({
        ownerId: input.ownerId,
        fencingToken: sql`${browserSessionLeases.fencingToken} + 1`,
        expiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(browserSessionLeases.bindingId, input.bindingId),
          or(
            lt(browserSessionLeases.expiresAt, now),
            eq(browserSessionLeases.ownerId, input.ownerId),
          ),
        ),
      )
      .returning();
    if (!taken) throw new BrowserSessionBusyError();
    return {
      bindingId: taken.bindingId,
      ownerId: taken.ownerId,
      fencingToken: taken.fencingToken,
      expiresAt: taken.expiresAt,
    };
  });
}

export async function releaseBrowserSessionLease(lease: BrowserSessionLease): Promise<boolean> {
  const rows = await db
    .delete(browserSessionLeases)
    .where(
      and(
        eq(browserSessionLeases.bindingId, lease.bindingId),
        eq(browserSessionLeases.ownerId, lease.ownerId),
        eq(browserSessionLeases.fencingToken, lease.fencingToken),
      ),
    )
    .returning({ bindingId: browserSessionLeases.bindingId });
  return rows.length === 1;
}

export async function expireBrowserConnectionAttempts(
  profileManager: BrowserProfileManager = createBrowserProfileManager(),
  now = new Date(),
): Promise<number> {
  const expired = await db
    .update(browserConnectionAttempts)
    .set({
      status: "expired",
      handoffEncrypted: null,
      interactionEncrypted: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        lt(browserConnectionAttempts.expiresAt, now),
        or(
          ...ACTIVE_ATTEMPT_STATUSES.map((status) => eq(browserConnectionAttempts.status, status)),
        ),
      ),
    )
    .returning({
      provider: browserConnectionAttempts.targetProvider,
      profileRef: browserConnectionAttempts.profileRef,
    });
  await Promise.all(
    expired.map(({ provider, profileRef }) =>
      profileRef
        ? enqueueBrowserProfileDeletion(provider as BrowserProviderId, profileRef)
        : Promise.resolve(),
    ),
  );
  await drainBrowserProfileDeletions(profileManager).catch(() => undefined);
  return expired.length;
}

/** Bound capability metadata retention after clients have stopped polling. */
export async function purgeFinishedBrowserConnectionAttempts(
  now = new Date(),
  retentionMs = DEFAULT_TERMINAL_RETENTION_MS,
): Promise<number> {
  if (
    !Number.isInteger(retentionMs) ||
    retentionMs < 60_000 ||
    retentionMs > 30 * 24 * 60 * 60_000
  ) {
    throw new Error("browser attempt retention is outside the allowed range");
  }
  const rows = await db
    .delete(browserConnectionAttempts)
    .where(
      and(
        lt(browserConnectionAttempts.expiresAt, new Date(now.getTime() - retentionMs)),
        or(
          ...TERMINAL_ATTEMPT_STATUSES.map((status) =>
            eq(browserConnectionAttempts.status, status),
          ),
        ),
      ),
    )
    .returning({ id: browserConnectionAttempts.id });
  return rows.length;
}

/** Return a bounded queue slice for crash-safe companion provisioning. */
export async function listBrowserAttemptsReadyForProvisioning(limit = 10): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("browser attempt queue limit is outside the allowed range");
  }
  const rows = await db
    .select({ id: browserConnectionAttempts.id })
    .from(browserConnectionAttempts)
    .where(
      and(
        eq(browserConnectionAttempts.status, "state_received"),
        gt(browserConnectionAttempts.expiresAt, new Date()),
      ),
    )
    .orderBy(browserConnectionAttempts.createdAt)
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * Recover a provisioning claim left behind by a crashed API process. Normal
 * companion proof workloads time out at ten minutes; the eleven-minute grace avoids
 * duplicating a merely slow proof while still leaving time inside the 25-minute
 * attempt capability to retry after a crash.
 */
export async function recoverStaleBrowserProvisioningAttempts(
  now = new Date(),
  staleAfterMs = 11 * 60_000,
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleAfterMs);
  const rows = await db
    .update(browserConnectionAttempts)
    .set({ status: "state_received", updatedAt: now })
    .where(
      and(
        eq(browserConnectionAttempts.status, "provisioning"),
        lt(browserConnectionAttempts.updatedAt, cutoff),
        gt(browserConnectionAttempts.expiresAt, now),
        sql`${browserConnectionAttempts.handoffEncrypted} IS NOT NULL`,
      ),
    )
    .returning({ id: browserConnectionAttempts.id });
  return rows.length;
}
