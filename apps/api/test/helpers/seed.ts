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
  packageShares,
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
import { and, eq, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import { mcpServerManifest } from "./integration-manifests.ts";
import { zipArtifact } from "@appstrate/core/zip";
import { computeIntegrity } from "@appstrate/core/integrity";
import * as storage from "@appstrate/db/storage";
import { AGENT_PACKAGES_BUCKET, versionZipKey } from "../../src/services/package-storage-keys.ts";
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

/**
 * Install (activate) a package in a space — creates the
 * `space_packages` row the runtime gate requires for a package to be
 * usable in that space. Idempotent.
 */
export async function seedSpacePackage(
  spaceId: string,
  packageId: string,
  overrides?: Partial<InferInsertModel<typeof spacePackages>>,
): Promise<void> {
  await db
    .insert(spacePackages)
    .values({ spaceId, packageId, ...overrides })
    .onConflictDoUpdate({
      target: [spacePackages.spaceId, spacePackages.packageId],
      // Apply overrides on conflict so callers can flip e.g. `enabled` on a
      // package the space already holds a row for; no-op write when there are
      // none.
      set: overrides && Object.keys(overrides).length > 0 ? overrides : { spaceId },
    });
}

/**
 * The state the activation door leaves behind for a package the space does NOT
 * home: the OFFER that places it, plus the `space_packages` row that switches
 * it on. Two writes, because they are two facts — and a row without the offer
 * behind it is an ORPHAN, which the platform reads as nothing at all
 * (`services/package-activation.ts`).
 *
 * Reach for this whenever a fixture means "this space runs that package" and
 * the package lives somewhere else. {@link seedSpacePackage} stays the raw row,
 * for the cases that assert what an orphan gets — and for a package the space
 * already homes, where the home IS the placement.
 */
export async function seedPlacedPackage(
  spaceId: string,
  packageId: string,
  overrides?: Partial<InferInsertModel<typeof spacePackages>>,
): Promise<void> {
  await seedPackageShare(spaceId, packageId);
  await seedSpacePackage(spaceId, packageId, overrides);
}

/**
 * Offer a package to a space (`package_shares`) — the PLACEMENT that makes it
 * readable and installable there (RBAC spec §6.9, §6.10).
 *
 * A fixture for the sharer's act, not for the recipient's: it writes the offer
 * and nothing else, so a test can set up "this space was offered the package"
 * without going through `POST …/shares` and its authority checks. Pair it with
 * {@link seedSpacePackage} when the space should also have taken it up.
 * `sharedBy` is nullable for the same reason `scripts/migration/0016` leaves it
 * null: nobody in particular made this offer.
 */
export async function seedPackageShare(
  spaceId: string,
  packageId: string,
  sharedBy: string | null = null,
): Promise<void> {
  await db.insert(packageShares).values({ spaceId, packageId, sharedBy }).onConflictDoNothing();
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
 * assertions about the draft true of the published version too.
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
  const content = opts?.content ?? pkg.draftContent ?? "content";
  const zip = zipArtifact({
    "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
    [pkg.type === "skill" ? "SKILL.md" : "prompt.md"]: new TextEncoder().encode(content),
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

// ─── MCP Servers ──────────────────────────────────────────

type McpServerInsert = {
  /** Scoped AFPS id (`@scope/name`) an integration's `server_name` references. */
  id: string;
  orgId: string | null;
  version?: string;
  serverType?: "node" | "python" | "binary" | "uv";
  entryPoint?: string;
  /** The space that HOMES it — one of the two placements. */
  homeSpaceId?: string;
};

/**
 * Seed an `mcp-server` package AND the published version that goes with it —
 * the pair the integration spawn resolver needs to turn a `server_name`
 * reference into a spawn spec. Seeding only the package leaves the reference
 * unresolvable, which is a different (and easy to seed by accident) fixture.
 */
export async function seedMcpServer(overrides: McpServerInsert): Promise<void> {
  const version = overrides.version ?? "1.0.0";
  const manifest = mcpServerManifest({
    name: overrides.id,
    version,
    serverType: overrides.serverType ?? "node",
    entryPoint: overrides.entryPoint ?? "./server.js",
  });
  await seedPackage({
    id: overrides.id,
    orgId: overrides.orgId,
    type: "mcp-server",
    source: "local",
    draftManifest: manifest,
    ...(overrides.homeSpaceId ? { homeSpaceId: overrides.homeSpaceId } : {}),
  });
  await seedPackageVersion({ packageId: overrides.id, version, manifest });
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
  accountId?: string;
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
        ...(overrides.accountId !== undefined ? { accountId: overrides.accountId } : {}),
      }),
      createdBy: overrides.createdBy ?? null,
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
