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
import { prefixedId, SPACE_ID_RE } from "@appstrate/db/ids";
import {
  packages,
  orgPackageOffers,
  spacePackages,
  runs,
  runLogs,
  spaces,
  endUsers,
  schedules,
  apiKeys,
  modelProviderCredentials,
  orgModels,
  orgInvitations,
  packageVersions,
  packageDistTags,
  spaceMembers,
  spaceRoles,
  user as userTable,
} from "@appstrate/db/schema";
import type { OrgOfferMode } from "@appstrate/db/schema";
import { and, eq, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import { zipArtifact } from "@appstrate/core/zip";
import type { CredentialDeathCause } from "@appstrate/core/sidecar-types";
import { computeIntegrity } from "@appstrate/core/integrity";
import { PACKAGE_CONTENT_ENTRY } from "@appstrate/core/package-files";
import * as storage from "@appstrate/db/storage";
import { AGENT_PACKAGES_BUCKET, versionZipKey } from "../../src/services/package-storage-keys.ts";
import {
  SYSTEM_STORAGE_NAMESPACE,
  uploadPackageFiles,
} from "../../src/services/package-items/storage.ts";
import { extractKeyPrefix, generateApiKey, hashApiKey } from "../../src/services/api-keys.ts";

// ─── Packages / Agents ───────────────────────────────────

type PackageInsert = Partial<InferInsertModel<typeof packages>> & {
  orgId: string | null;
};

/**
 * An organization's package is always homed in one of its spaces
 * (`packages_org_package_has_home`), and the home of one that belongs to no
 * team is the organization's DEFAULT space — so a fixture that names no home
 * gets that one, exactly as the platform would. Passing `homeSpaceId`
 * explicitly still wins, including `null` for the two rows allowed to be
 * homeless: a system package (`orgId: null`) and an inline run's shadow row
 * (`ephemeral: true`).
 *
 * Resolved per call rather than cached: `truncateAll` runs between tests, so a
 * remembered id would point at a space that no longer exists.
 */
async function defaultSpaceIdOf(orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), eq(spaces.isDefault, true)))
    .limit(1);
  return row?.id ?? null;
}

export async function seedPackage(
  overrides: PackageInsert,
): Promise<InferSelectModel<typeof packages>> {
  const orgSlug = overrides.id?.split("/")[0]?.replace("@", "") ?? "testorg";
  const name = overrides.id?.split("/")[1] ?? `agent-${crypto.randomUUID().slice(0, 8)}`;
  const id = overrides.id ?? `@${orgSlug}/${name}`;
  const homeSpaceId =
    "homeSpaceId" in overrides || overrides.orgId === null || overrides.ephemeral === true
      ? (overrides.homeSpaceId ?? null)
      : await defaultSpaceIdOf(overrides.orgId);

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
      homeSpaceId,
    })
    .returning();
  return pkg!;
}

/** Alias for seedPackage — the default type is already "agent". */
export const seedAgent = seedPackage;

/** A shipped skill's canonical row and file tree, as installed by system package sync. */
export async function seedSystemSkill(
  id: string,
  content: string,
  extraFiles: Record<string, Uint8Array> = {},
): Promise<void> {
  const manifest = { name: id, version: "1.0.0", type: "skill" };
  await seedPackage({
    id,
    orgId: null,
    source: "system",
    type: "skill",
    draftManifest: manifest,
    draftContent: content,
  });
  const encoder = new TextEncoder();
  await uploadPackageFiles("skills", SYSTEM_STORAGE_NAMESPACE, id, {
    ...extraFiles,
    "manifest.json": encoder.encode(JSON.stringify(manifest)),
    "SKILL.md": encoder.encode(content),
  });
}

/**
 * Place a package in a space, switched ON unless `overrides` says otherwise —
 * the `space_packages` row the runtime gate requires for a package to be usable
 * in that space. Idempotent: on an existing row it switches it on and applies
 * the overrides.
 */
export async function seedSpacePackage(
  spaceId: string,
  packageId: string,
  overrides?: Partial<InferInsertModel<typeof spacePackages>>,
): Promise<void> {
  await db
    .insert(spacePackages)
    .values({ spaceId, packageId, enabled: true, ...overrides })
    .onConflictDoUpdate({
      target: [spacePackages.spaceId, spacePackages.packageId],
      set: { enabled: true, ...overrides },
    });
}

/**
 * Place a package in a space switched OFF — what `POST …/shares` leaves behind
 * when the sharer may not activate in the target (RBAC spec §6.9, §6.10).
 *
 * A fixture for the sharer's act, without going through `POST …/shares` and its
 * authority checks. An existing row is left as it stands.
 */
export async function seedPackageShare(
  spaceId: string,
  packageId: string,
  sharedBy: string | null = null,
): Promise<void> {
  await db
    .insert(spacePackages)
    .values({ spaceId, packageId, enabled: false, sharedBy })
    .onConflictDoNothing();
}

/** Offer a package to its organization (`org_package_offers`) in `mode`, bypassing the door. */
export async function seedOrgOffer(
  orgId: string,
  packageId: string,
  mode: OrgOfferMode,
): Promise<void> {
  await db.insert(orgPackageOffers).values({ orgId, packageId, mode }).onConflictDoNothing();
}

/**
 * Simulate a published version whose artifact left storage (bucket loss, a
 * manual purge): a raw delete, bypassing `deleteVersionZip`, which refuses to
 * delete the artifact of a version row that still exists.
 */
export async function loseVersionArchive(packageId: string, version: string): Promise<void> {
  await storage.deleteFile(AGENT_PACKAGES_BUCKET, versionZipKey(packageId, version));
}

/**
 * Publish a version of a package: upload a real AFPS archive, record the
 * `package_versions` row that matches its integrity, and move the `latest`
 * dist-tag onto it.
 *
 * The BYTES matter. Outside its home a package runs its latest published
 * version, and the resolver reads that version's prompt out of storage — a
 * row with no object behind it answers `422 version_artifact_unavailable`,
 * which would make a fixture fail for a reason no test meant to assert.
 *
 * The manifest and content default to the package's own draft, which is what
 * "the author published what they have" looks like and keeps a suite's
 * assertions about the draft true of the published version too. The content
 * lands in the type's own content entry (`PACKAGE_CONTENT_ENTRY`); an OPTIONAL
 * entry (an integration's `INTEGRATION.md`) is written only from an explicit
 * `content`, since the draft column there may hold no documentation at all.
 */
export async function seedPublishedVersion(
  packageId: string,
  version: string,
  opts?: { manifest?: Record<string, unknown>; content?: string },
): Promise<InferSelectModel<typeof packageVersions>> {
  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`seedPublishedVersion: package ${packageId} is not seeded`);
  const manifest = opts?.manifest ?? {
    ...(pkg.draftManifest as Record<string, unknown>),
    name: packageId,
    version,
    type: pkg.type,
  };
  const entry = PACKAGE_CONTENT_ENTRY[pkg.type];
  const content = entry?.required
    ? (opts?.content ?? pkg.draftContent ?? "content")
    : opts?.content;
  const zip = zipArtifact({
    "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
    ...(entry && content !== undefined ? { [entry.path]: new TextEncoder().encode(content) } : {}),
  });
  await storage.uploadFile(AGENT_PACKAGES_BUCKET, versionZipKey(packageId, version), zip);
  const row = await seedPackageVersion({
    packageId,
    version,
    manifest,
    integrity: computeIntegrity(zip),
    artifactSize: zip.byteLength,
  });
  await db
    .insert(packageDistTags)
    .values({ packageId, tag: "latest", versionId: row.id })
    .onConflictDoUpdate({
      target: [packageDistTags.packageId, packageDistTags.tag],
      set: { versionId: row.id, updatedAt: new Date() },
    });
  return row;
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
  spaceId: string;
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

// ─── Spaces ───────────────────────────────────────────────

type SpaceInsert = Partial<InferInsertModel<typeof spaces>> & {
  orgId: string;
};

export async function seedSpace(overrides: SpaceInsert): Promise<InferSelectModel<typeof spaces>> {
  // `prefixedId("spc")` is the ONLY shape `assertSpaceId` accepts — a fixture
  // that mints anything else is rejected by the platform, not by the test.
  const id = overrides.id ?? prefixedId("spc");
  if (!SPACE_ID_RE.test(id)) {
    throw new Error(`test fixture minted a space id the platform rejects: ${id}`);
  }
  const [space] = await db
    .insert(spaces)
    .values({
      name: "Test Space",
      ...overrides,
      id,
    })
    .returning();
  return space!;
}

/**
 * A space of `orgId` that NOBODY else in the organization reaches: a stranger's
 * PERSONAL space (RBAC spec §3.6). Returns its id.
 *
 * This is the home to give a package a fixture means to keep OUT of the calling
 * space's reach. A homeless organization package is not an option — every one
 * has a home (`packages_org_package_has_home`) — and a private TEAM space is
 * not one either: an organization owner or admin holds `admin` in every team
 * space, private included, so only a personal space is genuinely unreachable.
 *
 * The owner is a bare `user` row, not a signed-in test user: nothing ever
 * authenticates as them, and a session would only slow the fixture down.
 */
export async function seedUnreachableSpace(orgId: string, name = "Out of reach"): Promise<string> {
  const ownerUserId = crypto.randomUUID();
  await db.insert(userTable).values({
    id: ownerUserId,
    name: `Stranger ${ownerUserId.slice(0, 8)}`,
    email: `stranger-${ownerUserId}@test.com`,
    emailVerified: false,
    realm: "platform",
  });
  const space = await seedSpace({ orgId, name, ownerUserId, visibility: "private" });
  return space.id;
}

// ─── Space roles (custom bundles) ─────────────────────────

/**
 * An org-defined space-role bundle (`space_roles`). Org-scoped, so a fixture
 * can prove the cross-org refusal by seeding one in the OTHER org.
 */
export async function seedSpaceRole(
  overrides: Partial<InferInsertModel<typeof spaceRoles>> & { orgId: string },
): Promise<InferSelectModel<typeof spaceRoles>> {
  const key = overrides.key ?? `role-${crypto.randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(spaceRoles)
    .values({
      id: prefixedId("srl"),
      name: "Test Space Role",
      permissions: ["agents:read"],
      ...overrides,
      key,
    })
    .returning();
  return row!;
}

// ─── Space membership ─────────────────────────────────────

/**
 * Grant `userId` an explicit role in `spaceId`. Straight to the table, so a
 * test can seed a shape the write route refuses (an owner's row, say) when
 * that is exactly what it is asserting about.
 */
export async function seedSpaceMember(
  overrides: Partial<InferInsertModel<typeof spaceMembers>> & {
    spaceId: string;
    userId: string;
  },
): Promise<InferSelectModel<typeof spaceMembers>> {
  const [row] = await db
    .insert(spaceMembers)
    .values({ presetRole: "viewer", ...overrides })
    .returning();
  return row!;
}

/** Grant `userId` a custom space role holding exactly `permissions` in `spaceId`. */
export async function seedSpaceGrant(args: {
  orgId: string;
  spaceId: string;
  userId: string;
  permissions: string[];
}): Promise<void> {
  const role = await seedSpaceRole({ orgId: args.orgId, permissions: args.permissions });
  await seedSpaceMember({
    spaceId: args.spaceId,
    userId: args.userId,
    presetRole: null,
    customRoleId: role.id,
  });
}

// ─── End Users ────────────────────────────────────────────

type EndUserInsert = Partial<InferInsertModel<typeof endUsers>> & {
  spaceId: string;
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
  spaceId: string;
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
  spaceId: string;
};

export async function seedApiKey(
  overrides: ApiKeyInsert,
): Promise<InferSelectModel<typeof apiKeys> & { rawKey: string }> {
  const rawKey = generateApiKey();
  const keyHash = await hashApiKey(rawKey);

  const [key] = await db
    .insert(apiKeys)
    .values({
      name: "Test API Key",
      keyHash,
      keyPrefix: extractKeyPrefix(rawKey),
      ...overrides,
    })
    .returning();
  return { ...key!, rawKey };
}

// ─── Model Provider Credentials ─────────────────────────────

import { encryptCredentials } from "@appstrate/connect";
import { modelConfigs } from "@appstrate/db/schema";
import { isNull } from "drizzle-orm";
import { getModelProvider } from "../../src/services/model-providers/registry.ts";
import {
  configProviderOf,
  isGatewayProvider,
} from "../../src/services/model-providers/credential-chain.ts";

/** The configuration a stored connection is filed under. */
export async function configIdOf(credentialId: string): Promise<string> {
  const [row] = await db
    .select({ configId: modelProviderCredentials.configId })
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.id, credentialId))
    .limit(1);
  if (!row?.configId)
    throw new Error(`configIdOf: connection ${credentialId} has no configuration`);
  return row.configId;
}

/**
 * The model configuration a seeded connection or model of `providerId` joins: its family's
 * (gateway: per endpoint, the provider default when none is given), created when missing.
 */
export async function seedModelConfigFor(
  orgId: string,
  providerId: string,
  baseUrl: string | null = null,
  personalConnectionsAllowed = true,
): Promise<string> {
  const configProviderId = configProviderOf(providerId);
  const endpoint = isGatewayProvider(providerId)
    ? (baseUrl ?? getModelProvider(providerId)?.defaultBaseUrl ?? null)
    : null;
  const [existing] = await db
    .select({ id: modelConfigs.id })
    .from(modelConfigs)
    .where(
      and(
        eq(modelConfigs.orgId, orgId),
        eq(modelConfigs.providerId, configProviderId),
        endpoint === null ? isNull(modelConfigs.baseUrl) : eq(modelConfigs.baseUrl, endpoint),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const [row] = await db
    .insert(modelConfigs)
    .values({
      orgId,
      providerId: configProviderId,
      label: getModelProvider(configProviderId)?.displayName ?? configProviderId,
      baseUrl: endpoint,
      personalConnectionsAllowed,
    })
    .returning({ id: modelConfigs.id });
  return row!.id;
}

/**
 * A model configuration stored under exactly `providerId` (no family normalisation), for
 * tests that pick the configuration's provider themselves.
 */
export async function seedModelConfig(overrides: {
  orgId: string;
  providerId: string;
  baseUrl?: string | null;
  label?: string;
  personalConnectionsAllowed?: boolean;
}): Promise<string> {
  const [row] = await db
    .insert(modelConfigs)
    .values({
      orgId: overrides.orgId,
      providerId: overrides.providerId,
      label: overrides.label ?? overrides.providerId,
      baseUrl: overrides.baseUrl ?? null,
      personalConnectionsAllowed: overrides.personalConnectionsAllowed ?? true,
    })
    .returning({ id: modelConfigs.id });
  return row!.id;
}

interface ModelProviderCredentialSeed {
  orgId: string;
  /** Configuration joined; omitted = the provider's (gateway: endpoint's) configuration. */
  configId?: string;
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
  /** Personal credential owner; omitted = organization credential. */
  ownerUserId?: string | null;
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
  // baseUrl host wins over apiShape when both are supplied — catalog tests
  // pin against the canonical provider (`openai` for gpt-4o cost lookup)
  // regardless of which wire format the harness happens to use.
  if (baseUrl && /openai\.com/i.test(baseUrl)) return "openai";
  if (baseUrl && /anthropic\.com/i.test(baseUrl)) return "anthropic";
  if (baseUrl && /mistral\.ai/i.test(baseUrl)) return "mistral";

  // Otherwise route by wire format. `openai-completions` is served by the
  // `openai-compatible` gateway (no catalog: its connections serve any model id,
  // as `servesModel` reads it); the canonical `openai` provider uses
  // `openai-responses` natively.
  switch (apiShape) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai":
      return "openai-compatible";
    case "openai-completions":
      return "openai-compatible";
    case "mistral-conversations":
      return "mistral";
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
      configId:
        overrides.configId ??
        (await seedModelConfigFor(overrides.orgId, providerId, baseUrlOverride)),
      createdBy: overrides.createdBy ?? null,
      ownerUserId: overrides.ownerUserId ?? null,
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
  /** Recorded with `needsReconnection: true`; omitted = flagged before causes were recorded. */
  needsReconnectionCause?: CredentialDeathCause;
  accountId?: string;
  createdBy?: string | null;
  /** Personal credential owner; omitted = organization credential. */
  ownerUserId?: string | null;
  /** Configuration joined; omitted = the provider's family configuration. */
  configId?: string;
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
  const expiresAt = overrides.expiresAt === undefined ? Date.now() + 3600_000 : overrides.expiresAt;
  const needsReconnection = overrides.needsReconnection ?? false;
  const oauthProviderId = overrides.providerId ?? "test-oauth";
  const configId =
    overrides.configId ?? (await seedModelConfigFor(overrides.orgId, oauthProviderId));
  const [row] = await db
    .insert(modelProviderCredentials)
    .values({
      orgId: overrides.orgId,
      label: overrides.label ?? "Test OAuth Credential",
      providerId: oauthProviderId,
      configId,
      credentialsEncrypted: encryptCredentials({
        kind: "oauth",
        accessToken: overrides.accessToken ?? "test-access-token",
        refreshToken: overrides.refreshToken ?? "test-refresh-token",
        expiresAt,
        ...(overrides.accountId !== undefined ? { accountId: overrides.accountId } : {}),
      }),
      // The expiry column mirrors the blob (the refresh sweep reads it); the death flag lives in
      // its columns alone.
      expiresAt: expiresAt === null ? null : new Date(expiresAt),
      needsReconnection,
      ...(needsReconnection
        ? {
            needsReconnectionCause: overrides.needsReconnectionCause ?? null,
            needsReconnectionAt: new Date(),
          }
        : {}),
      createdBy: overrides.createdBy ?? null,
      ownerUserId: overrides.ownerUserId ?? null,
    })
    .returning();
  return row!;
}

/**
 * Make a seeded model-provider credential undecryptable the way production
 * would: a key rotation retires a kid rows still reference, or the stored bytes
 * are damaged. The envelope stays syntactically valid (`v1:<kid>:<base64>`,
 * real kid) and only the ciphertext is flipped, so it fails GCM authentication
 * exactly as a wrong key does — the read paths swallow that into `null` and
 * must never throw.
 */
export async function corruptCredentialBlob(credentialId: string): Promise<void> {
  const [row] = await db
    .select({ credentialsEncrypted: modelProviderCredentials.credentialsEncrypted })
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.id, credentialId))
    .limit(1);
  const [version, kid, payload] = row!.credentialsEncrypted.split(":");
  const packed = Buffer.from(payload!, "base64");
  packed[packed.length - 1] = packed[packed.length - 1]! ^ 0xff;
  await db
    .update(modelProviderCredentials)
    .set({ credentialsEncrypted: `${version}:${kid}:${packed.toString("base64")}` })
    .where(eq(modelProviderCredentials.id, credentialId));
}

// ─── Org Models ───────────────────────────────────────────

/**
 * A seeded organization model: its configuration is `configId`, else its (retired, read only by
 * script 0062) `credentialId`'s, else `providerId`'s family configuration.
 */
type OrgModelInsert = Partial<InferInsertModel<typeof orgModels>> & { orgId: string };

/** `providerId` of a bound credential: an unbound model must name its provider explicitly. */
async function boundCredential(
  credentialId: string | null | undefined,
): Promise<{ providerId: string; configId: string | null } | null> {
  if (!credentialId) return null;
  const [row] = await db
    .select({
      providerId: modelProviderCredentials.providerId,
      configId: modelProviderCredentials.configId,
    })
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.id, credentialId))
    .limit(1);
  if (!row) throw new Error(`seedOrgModel: credential ${credentialId} not found`);
  return row;
}

export async function seedOrgModel(
  overrides: OrgModelInsert,
): Promise<InferSelectModel<typeof orgModels>> {
  const bound = await boundCredential(overrides.credentialId);
  const providerId = overrides.providerId ?? bound?.providerId;
  if (!overrides.configId && !bound?.configId && !providerId) {
    throw new Error("seedOrgModel: needs configId, a credentialId or a providerId");
  }
  const configId =
    overrides.configId ??
    bound?.configId ??
    (await seedModelConfigFor(overrides.orgId, providerId!));
  const [model] = await db
    .insert(orgModels)
    .values({
      label: "Test Model",
      modelId: "claude-sonnet-4-20250514",
      ...overrides,
      providerId: providerId ?? null,
      configId,
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
