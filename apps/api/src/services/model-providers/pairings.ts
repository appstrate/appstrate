// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot pairing tokens for the dashboard-initiated OAuth model provider
 * connection flow.
 *
 *   1. Dashboard mints a token via `createPairing()` (returns the plaintext
 *      ONCE — only its SHA-256 is persisted in `model_provider_pairings`).
 *   2. The user runs `npx @appstrate/connect-helper <token>`. The helper
 *      decodes the token (header carries platform URL + providerId), runs
 *      the loopback OAuth dance, then POSTs credentials to
 *      /api/model-providers-oauth/import using the pairing token as Bearer
 *      credentials.
 *   3. The Bearer auth path calls `consumePairing()`, which atomically
 *      flips `consumed_at` from NULL to now() and returns the row. Any
 *      second consumption (replay, retry, race) loses the UPDATE and gets
 *      a 410 Gone.
 *
 * Single-use semantics rely on the predicate-guarded UPDATE — DO NOT split
 * the consume into a SELECT-then-UPDATE pair, that would re-introduce the
 * race the partial index was designed to close.
 */

import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderPairings } from "@appstrate/db/schema";
import {
  encodePairingToken,
  hashPairingSecret,
  randomBase64Url,
} from "@appstrate/core/pairing-token";
import { gone } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";

/** Generated id prefix — mirrors `ask_` (api keys) and `appp_` (pairing token). */
const PAIRING_ID_PREFIX = "pair_";

/** Random secret length in bytes — 32B = 256 bits, base64url-encoded → 43 chars. */
const SECRET_BYTES = 32;

/** Grace window after `expires_at` before the cleanup worker DELETEs the row. */
const CLEANUP_GRACE_HOURS = 1;

export interface CreatePairingArgs {
  userId: string;
  orgId: string;
  providerId: string;
  /** Public platform URL embedded in the token so the helper knows where to POST back. */
  platformUrl: string;
  /** Lifetime in seconds — typically 300 (5 min). */
  ttlSeconds: number;
}

export interface CreatePairingResult {
  id: string;
  /**
   * The plaintext pairing token — `appp_<base64url(header)>.<base64url(secret)>`.
   * Returned to the caller ONCE; only its SHA-256 is stored.
   */
  token: string;
  expiresAt: Date;
}

export interface ConsumedPairing {
  id: string;
  userId: string;
  orgId: string;
  providerId: string;
  expiresAt: Date;
  consumedAt: Date;
}

export interface PairingRow {
  id: string;
  userId: string;
  orgId: string;
  providerId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  credentialId: string | null;
  createdAt: Date;
}

function generateSecret(): string {
  return randomBase64Url(SECRET_BYTES);
}

function generatePairingId(): string {
  // Same shape as `pair_<22 chars>` — opaque to the user, included in logs/UI.
  return `${PAIRING_ID_PREFIX}${randomBase64Url(16)}`;
}

/**
 * Mint a new pairing token. Persists ONLY the SHA-256 hash of the secret
 * portion; the plaintext is returned exactly once and the caller is
 * responsible for surfacing it back to the dashboard.
 */
export async function createPairing(args: CreatePairingArgs): Promise<CreatePairingResult> {
  const secret = generateSecret();
  const token = encodePairingToken(
    { platformUrl: args.platformUrl, providerId: args.providerId },
    secret,
  );
  const tokenHash = await hashPairingSecret(token);
  const id = generatePairingId();
  const expiresAt = new Date(Date.now() + args.ttlSeconds * 1000);

  await db.insert(modelProviderPairings).values({
    id,
    tokenHash,
    userId: args.userId,
    orgId: args.orgId,
    providerId: args.providerId,
    expiresAt,
  });

  return { id, token, expiresAt };
}

/**
 * Atomically consume a pairing token. Returns the full row on success.
 *
 * The single-statement UPDATE filters by `token_hash`, `consumed_at IS NULL`,
 * and `expires_at > now()` simultaneously — a concurrent retry that loses
 * the race observes 0 affected rows and gets the same `gone()` as a
 * replayed-after-consume call. Idempotency is by absence (no row returned),
 * not by re-issuing the result, because re-issuing credentials to a second
 * caller would defeat the one-shot guarantee.
 */
export async function consumePairing(token: string, fromIp?: string): Promise<ConsumedPairing> {
  const tokenHash = await hashPairingSecret(token);

  const rows = await db
    .update(modelProviderPairings)
    .set({
      consumedAt: sql`now()`,
      consumedFromIp: fromIp ?? null,
    })
    .where(
      and(
        eq(modelProviderPairings.tokenHash, tokenHash),
        sql`${modelProviderPairings.consumedAt} IS NULL`,
        sql`${modelProviderPairings.expiresAt} > now()`,
      ),
    )
    .returning({
      id: modelProviderPairings.id,
      userId: modelProviderPairings.userId,
      orgId: modelProviderPairings.orgId,
      providerId: modelProviderPairings.providerId,
      expiresAt: modelProviderPairings.expiresAt,
      consumedAt: modelProviderPairings.consumedAt,
    });

  const row = rows[0];
  if (!row || !row.consumedAt) {
    throw gone("pairing_expired_or_consumed", "Pairing token has expired or was already consumed");
  }

  return {
    id: row.id,
    userId: row.userId,
    orgId: row.orgId,
    providerId: row.providerId,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
}

/** Read a pairing row by id, scoped to the calling org. Returns null if not found. */
export async function getPairing(id: string, orgId: string): Promise<PairingRow | null> {
  const [row] = await db
    .select({
      id: modelProviderPairings.id,
      userId: modelProviderPairings.userId,
      orgId: modelProviderPairings.orgId,
      providerId: modelProviderPairings.providerId,
      expiresAt: modelProviderPairings.expiresAt,
      consumedAt: modelProviderPairings.consumedAt,
      credentialId: modelProviderPairings.credentialId,
      createdAt: modelProviderPairings.createdAt,
    })
    .from(modelProviderPairings)
    .where(and(eq(modelProviderPairings.id, id), eq(modelProviderPairings.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * Link the credential created by the helper's POST /import back to its
 * pairing row, so the dashboard's poll endpoint can surface the resulting
 * credential id without a separate list call. Best-effort: if the pairing
 * disappears between consume and link (TTL purge race), log and continue —
 * the credential is already persisted.
 */
export async function linkPairingCredential(
  pairingId: string,
  credentialId: string,
): Promise<void> {
  await db
    .update(modelProviderPairings)
    .set({ credentialId })
    .where(eq(modelProviderPairings.id, pairingId));
}

/**
 * Delete a pairing row by id, scoped to the calling org. Idempotent — a
 * no-op when the row is absent (already deleted, never existed, or
 * belongs to a different org).
 */
export async function cancelPairing(id: string, orgId: string): Promise<void> {
  await db
    .delete(modelProviderPairings)
    .where(and(eq(modelProviderPairings.id, id), eq(modelProviderPairings.orgId, orgId)));
}

/**
 * DELETE rows whose `expires_at` is more than `CLEANUP_GRACE_HOURS` in the
 * past. Keeps the table footprint bounded without removing recently-expired
 * rows that the UI/audit layer might still want to surface as "expired"
 * for a few minutes.
 */
export async function cleanupExpiredPairings(): Promise<number> {
  const cutoff = new Date(Date.now() - CLEANUP_GRACE_HOURS * 60 * 60 * 1000);
  const rows = await db
    .delete(modelProviderPairings)
    .where(lt(modelProviderPairings.expiresAt, cutoff))
    .returning({ id: modelProviderPairings.id });
  if (rows.length > 0) {
    logger.info("model_provider_pairings_cleanup", { deleted: rows.length });
  }
  return rows.length;
}
