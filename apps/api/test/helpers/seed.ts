// SPDX-License-Identifier: Apache-2.0

/**
 * Core entity factories for seeding test data.
 *
 * All factories insert real records into the test database.
 * They return the created record for assertions.
 *
 * Module-owned entities have their own seed helpers next to each module
 * (e.g. apps/api/src/modules/webhooks/test/helpers/seed.ts) so core tests
 * running alone have zero dependency on module schemas.
 */
import { db } from "./db.ts";
import {
  packages,
  applicationPackages,
  runs,
  runLogs,
  applications,
  endUsers,
  schedules,
  apiKeys,
  orgProxies,
  modelProviderCredentials,
  orgModels,
  orgInvitations,
  packageVersions,
} from "@appstrate/db/schema";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

// ─── Packages / Agents ───────────────────────────────────

type PackageInsert = Partial<InferInsertModel<typeof packages>> & {
  orgId: string | null;
};

export async function seedPackage(
  overrides: PackageInsert,
): Promise<InferSelectModel<typeof packages>> {
  const orgSlug = overrides.id?.split("/")[0]?.replace("@", "") ?? "testorg";
  const name = overrides.id?.split("/")[1] ?? `agent-${crypto.randomUUID().slice(0, 8)}`;
  const id = overrides.id ?? `@${orgSlug}/${name}`;

  const [pkg] = await db
    .insert(packages)
    .values({
      id,
      type: "agent",
      source: "local",
      draftManifest: {
        name: `@${orgSlug}/${name}`,
        version: "0.1.0",
        type: "agent",
        description: "Test agent",
      },
      draftContent: "Test prompt content",
      ...overrides,
    })
    .returning();
  return pkg!;
}

/** Alias for seedPackage — the default type is already "agent". */
export const seedAgent = seedPackage;

/**
 * Install (activate) a package in an application — creates the
 * `application_packages` row the runtime gate requires for a package to be
 * usable in that app. Idempotent.
 */
export async function seedInstalledPackage(
  applicationId: string,
  packageId: string,
  overrides?: Partial<InferInsertModel<typeof applicationPackages>>,
): Promise<void> {
  await db
    .insert(applicationPackages)
    .values({ applicationId, packageId, ...overrides })
    .onConflictDoUpdate({
      target: [applicationPackages.applicationId, applicationPackages.packageId],
      // Apply overrides on conflict so callers can flip e.g. `enabled` on an
      // already-installed package; no-op write when there are none.
      set: overrides && Object.keys(overrides).length > 0 ? overrides : { applicationId },
    });
}

// ─── Package Versions ─────────────────────────────────────

type PackageVersionInsert = Partial<InferInsertModel<typeof packageVersions>> & {
  packageId: string;
};

export async function seedPackageVersion(
  overrides: PackageVersionInsert,
): Promise<InferSelectModel<typeof packageVersions>> {
  const [version] = await db
    .insert(packageVersions)
    .values({
      version: "0.1.0",
      integrity: "sha256-test",
      artifactSize: 1024,
      manifest: { name: overrides.packageId, version: "0.1.0", type: "agent" },
      ...overrides,
    })
    .returning();
  return version!;
}

// ─── Runs ─────────────────────────────────────────────────

type RunInsert = Partial<InferInsertModel<typeof runs>> & {
  packageId: string;
  orgId: string;
  applicationId: string;
};

export async function seedRun(overrides: RunInsert): Promise<InferSelectModel<typeof runs>> {
  const [run] = await db
    .insert(runs)
    .values({
      id: `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      status: "pending",
      ...overrides,
    })
    .returning();
  return run!;
}

// ─── Run Logs ─────────────────────────────────────────────

type RunLogInsert = Partial<InferInsertModel<typeof runLogs>> & {
  runId: string;
  orgId: string;
};

export async function seedRunLog(
  overrides: RunLogInsert,
): Promise<InferSelectModel<typeof runLogs>> {
  const [log] = await db
    .insert(runLogs)
    .values({
      type: "progress",
      level: "info",
      message: "Test log message",
      ...overrides,
    })
    .returning();
  return log!;
}

// ─── Applications ─────────────────────────────────────────

type ApplicationInsert = Partial<InferInsertModel<typeof applications>> & {
  orgId: string;
};

export async function seedApplication(
  overrides: ApplicationInsert,
): Promise<InferSelectModel<typeof applications>> {
  const [app] = await db
    .insert(applications)
    .values({
      id: `app_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      name: "Test App",
      ...overrides,
    })
    .returning();
  return app!;
}

// ─── End Users ────────────────────────────────────────────

type EndUserInsert = Partial<InferInsertModel<typeof endUsers>> & {
  applicationId: string;
  orgId: string;
};

export async function seedEndUser(
  overrides: EndUserInsert,
): Promise<InferSelectModel<typeof endUsers>> {
  const [eu] = await db
    .insert(endUsers)
    .values({
      id: `eu_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      ...overrides,
    })
    .returning();
  return eu!;
}

// ─── Schedules ────────────────────────────────────────────

type ScheduleInsert = Partial<InferInsertModel<typeof schedules>> & {
  packageId: string;
  orgId: string;
  applicationId: string;
};

export async function seedSchedule(
  overrides: ScheduleInsert,
): Promise<InferSelectModel<typeof schedules>> {
  const [schedule] = await db
    .insert(schedules)
    .values({
      id: `sched_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      cronExpression: "0 * * * *",
      ...overrides,
    })
    .returning();
  return schedule!;
}

// ─── API Keys ─────────────────────────────────────────────

type ApiKeyInsert = Partial<InferInsertModel<typeof apiKeys>> & {
  orgId: string;
  applicationId: string;
};

export async function seedApiKey(
  overrides: ApiKeyInsert,
): Promise<InferSelectModel<typeof apiKeys> & { rawKey: string }> {
  const rawKey = `ask_${crypto.randomUUID().replace(/-/g, "")}`;
  const keyHash = new Bun.CryptoHasher("sha256").update(rawKey).digest("hex");

  const [key] = await db
    .insert(apiKeys)
    .values({
      name: "Test API Key",
      keyHash,
      keyPrefix: rawKey.slice(0, 12),
      ...overrides,
    })
    .returning();
  return { ...key!, rawKey };
}

// ─── Org Proxies ──────────────────────────────────────────

type OrgProxyInsert = Partial<InferInsertModel<typeof orgProxies>> & {
  orgId: string;
};

export async function seedOrgProxy(
  overrides: OrgProxyInsert,
): Promise<InferSelectModel<typeof orgProxies>> {
  const [proxy] = await db
    .insert(orgProxies)
    .values({
      label: "Test Proxy",
      urlEncrypted: "encrypted-url-placeholder",
      ...overrides,
    })
    .returning();
  return proxy!;
}

// ─── Model Provider Credentials ─────────────────────────────

import { encryptCredentials } from "@appstrate/connect";

interface ModelProviderCredentialSeed {
  orgId: string;
  label?: string;
  /** Convenience alias for callers that think in apiShape terms — mapped to a built-in providerId. */
  apiShape?: string;
  baseUrl?: string;
  /** Plaintext API key, wrapped into a `kind: "api_key"` blob before encryption. */
  apiKey?: string;
  /** Canonical registry providerId. Defaults derive from `apiShape` if absent. */
  providerId?: string;
  /** Override for self-hosted endpoints; honored only by providers with `baseUrlOverridable: true`. */
  baseUrlOverride?: string | null;
  createdBy?: string | null;
}

/**
 * Best-effort default mapping for the built-in api shapes the test suite
 * uses. Real production code uses the registry directly — this stays in
 * the helper so existing tests calling `seedOrgModelProviderKey({ apiShape: "openai" })`
 * keep working without each one knowing about providerIds.
 *
 * Returns a registered providerId whose `apiShape` matches. Test-time
 * `seedTestModelProviders` flips `baseUrlOverridable: true` on every
 * registered provider so the credential's `baseUrlOverride` is always
 * honored — pointing any provider at a mock endpoint is trivial.
 */
function defaultProviderId(apiShape: string | undefined, baseUrl: string | undefined): string {
  // baseUrl host wins over apiShape when both are supplied — pricing-catalog
  // tests pin against the canonical provider (`openai` for gpt-4o cost
  // lookup) regardless of which wire format the harness happens to use.
  if (baseUrl && /openai\.com/i.test(baseUrl)) return "openai";
  if (baseUrl && /anthropic\.com/i.test(baseUrl)) return "anthropic";
  if (baseUrl && /mistral\.ai/i.test(baseUrl)) return "mistral";

  // Otherwise route by wire format. `openai-completions` is served by the
  // `cerebras` registry entry (apiShape match); the canonical `openai`
  // provider uses `openai-responses` natively.
  switch (apiShape) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai":
    case "openai-chat":
      return "openai-compatible";
    case "openai-completions":
      return "cerebras";
    case "mistral-conversations":
      return "mistral";
    case "google-generative-ai":
      return "google-ai";
  }
  return "openai-compatible";
}

export async function seedOrgModelProviderKey(
  overrides: ModelProviderCredentialSeed,
): Promise<InferSelectModel<typeof modelProviderCredentials>> {
  const apiKey = overrides.apiKey ?? "sk-test-placeholder";
  const providerId =
    overrides.providerId ?? defaultProviderId(overrides.apiShape, overrides.baseUrl);
  // Test-time providers are registered with `baseUrlOverridable: true`
  // (see `test/helpers/model-providers.ts`), so any `baseUrl` the test passes
  // through propagates to the credential row as `baseUrlOverride` regardless
  // of the underlying providerId. The prod registry remains strict.
  const baseUrlOverride =
    overrides.baseUrlOverride !== undefined
      ? overrides.baseUrlOverride
      : (overrides.baseUrl ?? null);

  const [row] = await db
    .insert(modelProviderCredentials)
    .values({
      orgId: overrides.orgId,
      label: overrides.label ?? "Test Model Provider Key",
      providerId,
      credentialsEncrypted: encryptCredentials({ kind: "api_key", apiKey }),
      baseUrlOverride,
      createdBy: overrides.createdBy ?? null,
    })
    .returning();
  return row!;
}

interface OAuthCredentialSeed {
  orgId: string;
  providerId?: string;
  label?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms. `null` means "no upstream expiry" — passes through to the resolver as-is. */
  expiresAt?: number | null;
  needsReconnection?: boolean;
  createdBy?: string | null;
}

/**
 * Companion to `seedOrgModelProviderKey` for OAuth-backed model provider
 * credentials. Both call-sites (`/internal/oauth-token` route tests,
 * `/api/models/seed` integration tests, token-resolver tests, etc.)
 * were repeating the same `db.insert(modelProviderCredentials)` boilerplate
 * with slightly different blob fields — centralizing here keeps drift
 * (e.g. a `kind` rename in the blob shape) to a single update.
 */
export async function seedOrgModelProviderOAuth(
  overrides: OAuthCredentialSeed,
): Promise<InferSelectModel<typeof modelProviderCredentials>> {
  const [row] = await db
    .insert(modelProviderCredentials)
    .values({
      orgId: overrides.orgId,
      label: overrides.label ?? "Test OAuth Credential",
      providerId: overrides.providerId ?? "test-oauth",
      credentialsEncrypted: encryptCredentials({
        kind: "oauth",
        accessToken: overrides.accessToken ?? "test-access-token",
        refreshToken: overrides.refreshToken ?? "test-refresh-token",
        expiresAt: overrides.expiresAt === undefined ? Date.now() + 3600_000 : overrides.expiresAt,
        needsReconnection: overrides.needsReconnection ?? false,
      }),
      createdBy: overrides.createdBy ?? null,
    })
    .returning();
  return row!;
}

// ─── Org Models ───────────────────────────────────────────

type OrgModelInsert = Partial<InferInsertModel<typeof orgModels>> & {
  orgId: string;
  credentialId: string;
};

export async function seedOrgModel(
  overrides: OrgModelInsert,
): Promise<InferSelectModel<typeof orgModels>> {
  const [model] = await db
    .insert(orgModels)
    .values({
      label: "Test Model",
      modelId: "claude-sonnet-4-20250514",
      ...overrides,
    })
    .returning();
  return model!;
}

// ─── Invitations ──────────────────────────────────────────

type InvitationInsert = Partial<InferInsertModel<typeof orgInvitations>> & {
  orgId: string;
  email: string;
};

export async function seedInvitation(
  overrides: InvitationInsert,
): Promise<InferSelectModel<typeof orgInvitations>> {
  const [inv] = await db
    .insert(orgInvitations)
    .values({
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 48), // 48h
      role: "member",
      ...overrides,
    })
    .returning();
  return inv!;
}
