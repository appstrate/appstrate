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
  runs,
  runLogs,
  applications,
  endUsers,
  schedules,
  apiKeys,
  orgProxies,
  modelProviderCredentials,
  orgModels,
  connectionProfiles,
  userProviderConnections,
  orgInvitations,
  packageVersions,
  applicationProviderCredentials,
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
  connectionProfileId: string;
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
import { resolveProviderIdFromApiKeyForm } from "../../src/services/org-model-provider-keys.ts";

interface ModelProviderCredentialSeed {
  orgId: string;
  label?: string;
  /** Wire format the legacy contract expects. Used to derive `providerId` if not given explicitly. */
  api?: string;
  /** Base URL — combined with `api` to reverse-resolve `providerId` against the registry. */
  baseUrl?: string;
  /** Plaintext API key, wrapped into a `kind: "api_key"` blob before encryption. */
  apiKey?: string;
  /** Skips reverse-resolution when provided. Must be a registered registry id. */
  providerId?: string;
  createdBy?: string | null;
}

export async function seedOrgModelProviderKey(
  overrides: ModelProviderCredentialSeed,
): Promise<InferSelectModel<typeof modelProviderCredentials>> {
  const api = overrides.api ?? "anthropic-messages";
  const baseUrl = overrides.baseUrl ?? "https://api.anthropic.com";
  const apiKey = overrides.apiKey ?? "sk-test-placeholder";

  const resolved = overrides.providerId
    ? { providerId: overrides.providerId, baseUrlOverride: null }
    : resolveProviderIdFromApiKeyForm(api, baseUrl);

  const [row] = await db
    .insert(modelProviderCredentials)
    .values({
      orgId: overrides.orgId,
      label: overrides.label ?? "Test Model Provider Key",
      providerId: resolved.providerId,
      credentialsEncrypted: encryptCredentials({ kind: "api_key", apiKey }),
      baseUrlOverride: resolved.baseUrlOverride,
      createdBy: overrides.createdBy ?? null,
    })
    .returning();
  return row!;
}

// ─── Org Models ───────────────────────────────────────────

type OrgModelInsert = Partial<InferInsertModel<typeof orgModels>> & {
  orgId: string;
  providerKeyId: string;
};

export async function seedOrgModel(
  overrides: OrgModelInsert,
): Promise<InferSelectModel<typeof orgModels>> {
  const [model] = await db
    .insert(orgModels)
    .values({
      label: "Test Model",
      api: "anthropic",
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-sonnet-4-20250514",
      ...overrides,
    })
    .returning();
  return model!;
}

// ─── Connection Profiles ──────────────────────────────────

type ConnectionProfileInsert = Partial<InferInsertModel<typeof connectionProfiles>> &
  ({ userId: string } | { applicationId: string });

export async function seedConnectionProfile(
  overrides: ConnectionProfileInsert,
): Promise<InferSelectModel<typeof connectionProfiles>> {
  const [profile] = await db
    .insert(connectionProfiles)
    .values({
      name: "Test Profile",
      ...overrides,
    })
    .returning();
  return profile!;
}

// ─── User Provider Connections ────────────────────────────

type UserConnectionInsert = Partial<InferInsertModel<typeof userProviderConnections>> & {
  connectionProfileId: string;
  providerId: string;
  orgId: string;
  providerCredentialId: string;
};

export async function seedUserConnection(
  overrides: UserConnectionInsert,
): Promise<InferSelectModel<typeof userProviderConnections>> {
  const [conn] = await db
    .insert(userProviderConnections)
    .values({
      credentialsEncrypted: "test-encrypted",
      ...overrides,
    })
    .returning();
  return conn!;
}

// ─── Provider Credentials ────────────────────────────────

type ProviderCredentialsInsert = Partial<
  InferInsertModel<typeof applicationProviderCredentials>
> & {
  applicationId: string;
  providerId: string;
};

export async function seedProviderCredentials(
  overrides: ProviderCredentialsInsert,
): Promise<InferInsertModel<typeof applicationProviderCredentials> & { id: string }> {
  const values = {
    enabled: true,
    credentialsEncrypted: "test-admin-encrypted",
    ...overrides,
  };
  const [row] = await db
    .insert(applicationProviderCredentials)
    .values(values)
    .onConflictDoUpdate({
      target: [
        applicationProviderCredentials.applicationId,
        applicationProviderCredentials.providerId,
      ],
      set: values,
    })
    .returning();
  return { ...values, id: row!.id };
}

// ─── Connections (with auto-created provider credentials) ──

import { saveConnection } from "@appstrate/connect";

/**
 * Seed a user connection with auto-created applicationProviderCredentials.
 * Simplifies tests by handling the providerCredentialId requirement.
 */
export async function seedConnectionForApp(
  connectionProfileId: string,
  providerId: string,
  orgId: string,
  applicationId: string,
  credentials: Record<string, unknown>,
  options?: { scopesGranted?: string[]; expiresAt?: string | null },
): Promise<void> {
  // Ensure provider package exists (FK target for applicationProviderCredentials)
  await seedPackage({ orgId: null, id: providerId, type: "provider", source: "system" }).catch(
    () => {},
  );
  const cred = await seedProviderCredentials({ applicationId, providerId });
  await saveConnection(db, connectionProfileId, providerId, orgId, credentials, {
    providerCredentialId: cred.id,
    ...options,
  });
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
