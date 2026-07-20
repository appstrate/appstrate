// SPDX-License-Identifier: Apache-2.0

/**
 * Short-lived, purpose-bound capability tokens for sidecar-only connect
 * workloads. These workloads deliberately have no `runs` row, so they cannot
 * use a normal run token to fetch the one MCP bundle they need to boot.
 *
 * The signature is domain-separated from run tokens. A connect token therefore
 * cannot be accepted by `parseSignedToken`, even though both token families use
 * the same rotation keyring.
 */
import { timingSafeEqual } from "node:crypto";

import { getEnv } from "@appstrate/env";
import { z } from "zod";

const TOKEN_PREFIX = "cw1";
const SIGNING_DOMAIN = "appstrate:connect-workload:v1\0";
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_LIFETIME_MS = 5 * 60_000;
const MAX_CLOCK_SKEW_MS = 30_000;

const claimsSchema = z
  .object({
    audience: z.literal("internal:mcp-server-bundle"),
    connectId: z.string().min(1).max(256),
    orgId: z.string().min(1).max(256),
    applicationId: z.string().min(1).max(256),
    integrationId: z.string().min(1).max(256),
    mcpServerId: z.string().min(1).max(256),
    mcpServerVersion: z.string().min(1).max(256).nullable(),
    mcpServerSource: z.enum(["system", "version"]),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type ConnectWorkloadClaims = z.infer<typeof claimsSchema>;

export interface SignConnectWorkloadTokenInput {
  readonly connectId: string;
  readonly orgId: string;
  readonly applicationId: string;
  readonly integrationId: string;
  readonly mcpServerId: string;
  readonly mcpServerVersion: string | null;
  readonly mcpServerSource: "system" | "version";
  /** Token lifetime in milliseconds. Connect launchers include their timeout. */
  readonly ttlMs: number;
}

function keyring(): readonly string[] {
  return getEnv()
    .RUN_TOKEN_SECRET.split(",")
    .filter((key) => key.length > 0);
}

function signatureFor(signingInput: string, key: string): Buffer {
  const hasher = new Bun.CryptoHasher("sha256", key);
  hasher.update(SIGNING_DOMAIN);
  hasher.update(signingInput);
  return Buffer.from(hasher.digest("hex"), "hex");
}

/** Mint a capability that authorizes exactly one MCP bundle fetch surface. */
export function signConnectWorkloadToken(
  input: SignConnectWorkloadTokenInput,
  now = Date.now(),
): string {
  if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > MAX_LIFETIME_MS) {
    throw new Error(`connect workload token ttl must be between 1 and ${MAX_LIFETIME_MS}ms`);
  }
  if (
    (input.mcpServerSource === "system" && input.mcpServerVersion !== null) ||
    (input.mcpServerSource === "version" && input.mcpServerVersion === null)
  ) {
    throw new Error("connect workload token source/version provenance is inconsistent");
  }
  const [activeKey] = keyring();
  if (!activeKey) throw new Error("RUN_TOKEN_SECRET produced an empty keyring");

  const claims = claimsSchema.parse({
    audience: "internal:mcp-server-bundle",
    connectId: input.connectId,
    orgId: input.orgId,
    applicationId: input.applicationId,
    integrationId: input.integrationId,
    mcpServerId: input.mcpServerId,
    mcpServerVersion: input.mcpServerVersion,
    mcpServerSource: input.mcpServerSource,
    issuedAt: now,
    expiresAt: now + input.ttlMs,
  });
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = `${TOKEN_PREFIX}.${payload}`;
  return `${signingInput}.${signatureFor(signingInput, activeKey).toString("hex")}`;
}

/** Verify signature, schema, purpose and lifetime. Returns null on any failure. */
export function parseConnectWorkloadToken(
  token: string,
  now = Date.now(),
): ConnectWorkloadClaims | null {
  if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) return null;
  if (!/^[a-f0-9]{64}$/.test(parts[2])) return null;

  const signingInput = `${parts[0]}.${parts[1]}`;
  const actual = Buffer.from(parts[2], "hex");
  let authenticated = false;
  for (const key of keyring()) {
    const expected = signatureFor(signingInput, key);
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      authenticated = true;
    }
  }
  if (!authenticated) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = claimsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const claims = parsed.data;
  if (claims.issuedAt > now + MAX_CLOCK_SKEW_MS) return null;
  if (claims.expiresAt <= now) return null;
  if (claims.expiresAt <= claims.issuedAt) return null;
  if (claims.expiresAt - claims.issuedAt > MAX_LIFETIME_MS) return null;
  if (claims.mcpServerSource === "system" && claims.mcpServerVersion !== null) return null;
  if (claims.mcpServerSource === "version" && claims.mcpServerVersion === null) return null;
  return claims;
}

export function isConnectWorkloadToken(token: string): boolean {
  return token.startsWith(`${TOKEN_PREFIX}.`);
}
