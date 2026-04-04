// SPDX-License-Identifier: Apache-2.0

/**
 * Entity factories for seeding test data.
 *
 * All factories insert real records into the test database.
 * They return the created record for assertions.
 */
import { db } from "./db.ts";
import {
  packages,
  runs,
  runLogs,
  applications,
  endUsers,
  webhooks,
  packageSchedules,
  apiKeys,
  orgProxies,
  orgProviderKeys,
  orgModels,
  connectionProfiles,
  userProviderConnections,
  orgInvitations,
  packageVersions,
  providerCredentials,
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
      id: `exec_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
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

// ─── Webhooks ─────────────────────────────────────────────

type WebhookInsert = Partial<InferInsertModel<typeof webhooks>> & {
  orgId: string;
  applicationId: string;
};

export async function seedWebhook(
  overrides: WebhookInsert,
): Promise<InferSelectModel<typeof webhooks>> {
  const [wh] = await db
    .insert(webhooks)
    .values({
      url: "https://example.com/webhook",
      events: ["run.completed"],
      secret: crypto.randomUUID(),
      ...overrides,
    } as InferInsertModel<typeof webhooks>)
    .returning();
  return wh!;
}

// ─── Schedules ────────────────────────────────────────────

type ScheduleInsert = Partial<InferInsertModel<typeof packageSchedules>> & {
  packageId: string;
  connectionProfileId: string;
  orgId: string;
  applicationId: string;
};

export async function seedSchedule(
  overrides: ScheduleInsert,
): Promise<InferSelectModel<typeof packageSchedules>> {
  const [schedule] = await db
    .insert(packageSchedules)
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

// ─── Org Provider Keys ───────────────────────────────────

type OrgProviderKeyInsert = Partial<InferInsertModel<typeof orgProviderKeys>> & {
  orgId: string;
};

export async function seedOrgProviderKey(
  overrides: OrgProviderKeyInsert,
): Promise<InferSelectModel<typeof orgProviderKeys>> {
  const [key] = await db
    .insert(orgProviderKeys)
    .values({
      label: "Test Provider Key",
      api: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKeyEncrypted: "encrypted-key-placeholder",
      ...overrides,
    })
    .returning();
  return key!;
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
  ({ userId: string } | { orgId: string });

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
  profileId: string;
  providerId: string;
  orgId: string;
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

type ProviderCredentialsInsert = Partial<InferInsertModel<typeof providerCredentials>> & {
  providerId: string;
  orgId: string;
};

export async function seedProviderCredentials(
  overrides: ProviderCredentialsInsert,
): Promise<InferInsertModel<typeof providerCredentials>> {
  const values = {
    enabled: true,
    credentialsEncrypted: "test-admin-encrypted",
    ...overrides,
  };
  await db
    .insert(providerCredentials)
    .values(values)
    .onConflictDoUpdate({
      target: [providerCredentials.providerId, providerCredentials.orgId],
      set: values,
    });
  return values;
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
