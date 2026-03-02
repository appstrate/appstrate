import { randomBytes, createHash } from "node:crypto";
import { getEnv } from "@appstrate/env";
import { RegistryClient } from "@appstrate/registry-client";
import { encrypt, decrypt } from "@appstrate/connect";
import { eq } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { registryConnections } from "@appstrate/db/schema";
import { getRegistryDiscovery } from "./registry-provider.ts";
import { logger } from "../lib/logger.ts";

// ─── PKCE in-memory state ────────────────────────────────

interface PkceState {
  codeVerifier: string;
  userId: string;
  createdAt: number;
}

const pendingStates = new Map<string, PkceState>();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TOKEN_TTL_DAYS = 30;

function cleanExpiredStates() {
  const now = Date.now();
  for (const [key, val] of pendingStates) {
    if (now - val.createdAt > STATE_TTL_MS) {
      pendingStates.delete(key);
    }
  }
}

// ─── OAuth initiation ────────────────────────────────────

export async function initiateRegistryOAuth(
  userId: string,
): Promise<{ authUrl: string; state: string }> {
  cleanExpiredStates();

  const env = getEnv();
  if (!env.REGISTRY_CLIENT_ID) {
    throw new Error("REGISTRY_CLIENT_ID not configured");
  }

  const discovery = getRegistryDiscovery();
  if (!discovery?.oauth) {
    throw new Error("Registry does not support OAuth");
  }

  // Generate PKCE
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomUUID();

  pendingStates.set(state, { codeVerifier, userId, createdAt: Date.now() });

  const callbackUrl = `${env.APP_URL}/api/registry/callback`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.REGISTRY_CLIENT_ID,
    redirect_uri: callbackUrl,
    scope: "read write publish",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${discovery.oauth.authorizationUrl}?${params.toString()}`;
  return { authUrl, state };
}

// ─── OAuth callback ──────────────────────────────────────

export async function handleRegistryCallback(
  code: string,
  state: string,
): Promise<{ username: string }> {
  cleanExpiredStates();

  const pending = pendingStates.get(state);
  if (!pending) {
    throw new Error("Invalid or expired OAuth state");
  }
  pendingStates.delete(state);

  const env = getEnv();
  const discovery = getRegistryDiscovery();
  if (!discovery?.oauth) {
    throw new Error("Registry does not support OAuth");
  }

  // Exchange code for token (JSON body, not URLSearchParams)
  const callbackUrl = `${env.APP_URL}/api/registry/callback`;
  const tokenRes = await fetch(discovery.oauth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl,
      client_id: env.REGISTRY_CLIENT_ID,
      client_secret: env.REGISTRY_CLIENT_SECRET,
      code_verifier: pending.codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    logger.error("Registry token exchange failed", { status: tokenRes.status, body });
    throw new Error(`Token exchange failed: ${tokenRes.status}`);
  }

  const tokenData = (await tokenRes.json()) as { access_token: string; expires_in?: number };
  const accessToken = tokenData.access_token;

  // Get user info from registry
  const client = new RegistryClient({ baseUrl: env.REGISTRY_URL!, accessToken });
  const me = await client.getMe();

  // Encrypt token and upsert connection
  const encryptedToken = encrypt(accessToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db
    .insert(registryConnections)
    .values({
      userId: pending.userId,
      accessTokenEncrypted: encryptedToken,
      registryUsername: me.username,
      registryUserId: me.id,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [registryConnections.userId],
      set: {
        accessTokenEncrypted: encryptedToken,
        registryUsername: me.username,
        registryUserId: me.id,
        expiresAt,
        updatedAt: new Date(),
      },
    });

  logger.info("Registry connection established", { userId: pending.userId, username: me.username });
  return { username: me.username };
}

// ─── Connection management ───────────────────────────────

async function getRegistryConnection(
  userId: string,
): Promise<{ accessToken: string; username: string; expiresAt: Date } | null> {
  const [row] = await db
    .select()
    .from(registryConnections)
    .where(eq(registryConnections.userId, userId))
    .limit(1);

  if (!row) return null;

  // Check expiration
  if (row.expiresAt < new Date()) {
    return null;
  }

  const accessToken = decrypt(row.accessTokenEncrypted);
  return { accessToken, username: row.registryUsername, expiresAt: row.expiresAt };
}

/** Build an authenticated RegistryClient for a user, or null if not connected. */
export async function getAuthenticatedRegistryClient(
  userId: string,
): Promise<RegistryClient | null> {
  const conn = await getRegistryConnection(userId);
  if (!conn) return null;
  const env = getEnv();
  return new RegistryClient({ baseUrl: env.REGISTRY_URL!, accessToken: conn.accessToken });
}

export async function disconnectRegistry(userId: string): Promise<void> {
  await db.delete(registryConnections).where(eq(registryConnections.userId, userId));
  logger.info("Registry disconnected", { userId });
}

export async function getRegistryStatus(
  userId: string,
): Promise<{ connected: boolean; username?: string; expiresAt?: string; expired?: boolean }> {
  const conn = await getRegistryConnection(userId);
  if (!conn) return { connected: false };

  const expired = conn.expiresAt < new Date();
  return {
    connected: true,
    username: conn.username,
    expiresAt: conn.expiresAt.toISOString(),
    expired,
  };
}
