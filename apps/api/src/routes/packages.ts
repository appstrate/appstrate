// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import { makePermissionGuard, reportPermissionDenial } from "@appstrate/core/permissions";
import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { parsePackageZip, PackageZipError, zipArtifact } from "@appstrate/core/zip";
import { buildDownloadHeaders } from "@appstrate/core/integrity";
import { eq, and, inArray } from "drizzle-orm";
import { packages, profiles } from "@appstrate/db/schema";
import { db } from "@appstrate/db/client";
import { listResponse } from "../lib/list-response.ts";
import { postInstallPackage } from "../services/post-install-package.ts";
import { bundleImportAuditRecords, handleImportBundle } from "../services/bundle-import.ts";
import {
  activatePackage,
  activatePackageWithin,
  assertMcpServerActivatable,
} from "../services/space-packages.ts";
import { listPackageShares, revokePackageShare, sharePackage } from "../services/package-shares.ts";
import { reconcilePlacementsAfterRehome } from "../services/package-placement.ts";
import { ensurePersonalSpaceFor, findPersonalSpace } from "../services/spaces.ts";
import { createPackageShareNotification } from "../services/state/notifications.ts";
import { getOrgMember } from "../services/organizations.ts";
import { parseManifestFromFiles } from "../lib/manifest-parser.ts";
import { unzipPackageArchive } from "../services/package-archive.ts";
import { getAllPackageIds } from "../services/package-catalog.ts";
import { isSystemPackage } from "../services/system-packages.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { getVersionForDownload, replaceVersionContent } from "../services/package-versions.ts";
import { downloadVersionZip } from "../services/package-storage.ts";
import { computeIntegrity } from "@appstrate/core/integrity";
import {
  getPackageById,
  listOrgItems,
  getOrgItem,
  deleteOrgItem,
  PackageAlreadyExistsError,
} from "../services/package-items/crud.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  CONFIG_BY_TYPE,
  assertContentConforms,
  assertArchiveContentConforms,
  type PackageTypeConfig,
} from "../services/package-items/config.ts";
import { validateManifest, type PackageType } from "@appstrate/core/validation";
import { decodeSkillMarkdown } from "@appstrate/afps-shared/companion-files";
import { SLUG_REGEX, attachmentDisposition } from "@appstrate/core/naming";
import { ifNoneMatchSatisfied } from "../lib/if-none-match.ts";
import { isValidVersion } from "@appstrate/core/semver";
import {
  getVersionDetail,
  getVersionCount,
  getMatchingDistTags,
  listPackageVersions,
  getVersionInfo,
  getLatestVersionId,
  getLatestVersionCreatedAt,
  computeHasUnpublishedChanges,
  createVersionFromDraft,
  createVersionAndUpload,
  finalizeDraftPublication,
  deletePackageVersion,
} from "../services/package-versions.ts";
import { agentDetailHandler, buildAgentDetailDto } from "./agent-detail-handler.ts";
import { readJsonBody } from "@appstrate/core/request-body";
import { rateLimit } from "../middleware/rate-limit.ts";
import { VERSION_SELECTOR_DRAFT } from "../services/agent-version-resolver.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import {
  assertCatalogPackageAccess,
  assertDraftSelectorAllowed,
  assertPackageCopyAllowed,
  assertPackageDependenciesAccessible,
  assertForkSourceAccess,
  authorizeBundlePackages,
  assertExistingPackageActivationAccess,
  defaultDefinitionSelector,
  PACKAGE_WRITE_PERMISSIONS,
  assertPackageMutationAccess,
  assertPackageShareAccess,
  holdsPackageShareAuthority,
  homeWireForCaller,
  isPackageReadableInSpace,
  packageAccessSpaces,
  holdsHomeAuthority,
  packagePermission,
  requireAgentRead,
} from "../lib/package-access.ts";
import { requirePackageInOrg } from "../middleware/guards.ts";
import { requireAnyPermission, requirePermission } from "../middleware/require-permission.ts";
import { getRunningRunsForPackage } from "../services/state/runs.ts";
import { logger } from "../lib/logger.ts";
import { asRecord } from "@appstrate/core/safe-json";
import { forkPackage } from "../services/package-fork.ts";
import { tryParseSkillOnlyZip } from "../services/skill-zip.ts";
import { fetchGithubDirectory, GithubImportError } from "../services/github-import.ts";
import { validateAgentIntegrationSelections } from "../services/integration-scope-validation.ts";
import { SCOPED_PACKAGE_ROUTE } from "./scoped-package-route.ts";
import { assertSpaceId, isSpaceId } from "../lib/ids.ts";
import {
  resolvePackageFileValidator,
  readPackageSnapshot,
  resolveDraftContent,
  mutatePackageDraftFiles,
  buildFileIndex,
  indexEtag,
  fileEtag,
  applyFileOperations,
  validateAuthoredPackageFiles,
  createPackageDraft,
  type PackageFileOperation,
  type PackageFileSource,
} from "../services/package-files.ts";
import {
  PackageFileWriteError,
  type PackageFileWriteErrorCode,
} from "@appstrate/core/package-file-operations";
import { PACKAGE_CONTENT_ENTRY, PACKAGE_MANIFEST_FILE } from "@appstrate/core/package-files";
import {
  collectConnectLoginWarnings,
  collectMetaWarnings,
} from "../services/integration-import-warnings.ts";
import { collectAgentImportWarnings } from "../services/agent-import-warnings.ts";
import {
  ApiError,
  invalidRequest,
  forbidden,
  notFound,
  conflict,
  internalError,
  validationFailed,
  type ValidationFieldError,
} from "../lib/errors.ts";
import { parsePathMessages } from "../lib/field-errors.ts";
import { isManifestTextFallback } from "../lib/manifest-utils.ts";

function manifestErrorsToFieldErrors(errors: string[]): ValidationFieldError[] {
  return parsePathMessages(errors, {
    code: "invalid_manifest",
    title: "Invalid Manifest",
    fieldPrefix: "manifest.",
  });
}

/**
 * Phase 1 gate — after `validateManifest` accepts an agent manifest,
 * cross-check that any `integrations_configuration[id]` selection (§4.4)
 * is a subset of the referenced integration's catalog. Skips silently for
 * non-agent types, integrations with no configuration entry, and
 * integrations not visible to the org (the latter handled by run-time dep
 * validation).
 *
 * `requireCallableTools` adds the declared-but-empty gate on top. It belongs
 * to the paths that FREEZE an artifact (publish, import), never to a draft
 * write: the editor's own add-integration → tick-a-tool flow autosaves
 * through the empty state.
 */
async function assertAgentIntegrationScopesValid(
  manifest: Record<string, unknown>,
  orgId: string,
  requireCallableTools = false,
): Promise<void> {
  const scopeErrors = await validateAgentIntegrationSelections({
    manifest,
    orgId,
    requireCallableTools,
  });
  if (scopeErrors.length > 0) {
    throw validationFailed(scopeErrors);
  }
}

/**
 * The manifest gate every package write goes through — schema validation, the
 * route/manifest `type` agreement check, then the integration-scope subset
 * check — returning the VALIDATED (normalized) manifest callers persist.
 *
 * `direction` says where the manifest came from, and both policies key off it:
 *
 * - `"author"` — the manifest is in THIS request (create; a PUT supplying
 *   `manifest`). The `type` gate applies: the route family fixes the package
 *   type while `validateManifest` dispatches purely on the manifest's own root
 *   `type`, so without it a wrong-type manifest validates against ITS OWN
 *   schema and then has `type` rewritten to the route's downstream —
 *   persisting a manifest no schema ever accepted (issue #987). Retired
 *   `runtime_tools` ids reject, so a typo or a removed id is reported instead
 *   of silently stripped.
 * - `"stored"` — the manifest is already persisted (PUT content-only
 *   carry-forward; publishing an existing draft). NO `type` gate: stored
 *   artifacts are tolerated on read (#983), and gating here would make a
 *   legacy drifted draft permanently un-publishable. Retired ids drop so such
 *   a draft stays editable and publishable.
 *
 * `direction` is orthogonal to `opts.requireCallableTools`: it says where the
 * bytes came from, not whether they are being frozen. Publishing a draft is
 * `"stored"` yet must run the declared-but-empty gate; a PUT carrying a
 * manifest is `"author"` yet must not.
 */
async function validateManifestForRoute(
  manifest: unknown,
  expectedType: PackageType,
  c: Context<AppEnv>,
  direction: "author" | "stored",
  opts: { requireCallableTools?: boolean; previous?: Record<string, unknown> } = {},
): Promise<Record<string, unknown> & { name: string }> {
  const result = validateManifest(
    manifest,
    direction === "stored" ? { retiredRuntimeTools: "drop" } : undefined,
  );
  if (!result.valid) {
    throw validationFailed(manifestErrorsToFieldErrors(result.errors));
  }
  // Every AFPS manifest schema requires `name` as a string, so the validated
  // shape always carries it — callers use it as the package id.
  const validated = result.manifest as Record<string, unknown> & { name: string };

  // Checked AFTER validation so a missing/unknown `type` keeps producing the
  // validator's own typed `type:` error rather than a mismatch message.
  if (direction === "author" && validated.type !== expectedType) {
    throw validationFailed([
      {
        field: "manifest.type",
        code: "invalid_manifest",
        title: "Invalid Manifest",
        message: `expected "${expectedType}", received "${String(validated.type)}"`,
      },
    ]);
  }

  if (direction === "author")
    await assertPackageDependenciesAccessible(c, validated, opts.previous);
  await assertAgentIntegrationScopesValid(validated, c.get("orgId"), opts.requireCallableTools);
  return validated;
}

// ═══════════════════════════════════════════════
// Shared helpers for package CRUD routes
// ═══════════════════════════════════════════════

export const githubImportSchema = z
  .object({
    url: z.url("Missing 'url' field"),
  })
  .strict();

export const forkSchema = z
  .object({
    name: z.string().regex(SLUG_REGEX, "Name must match slug format").optional(),
  })
  .strict();

/**
 * JSON-body create/update payloads for the manifest-driven package types
 * (agent). `manifest` is validated structurally here (must be an object) and
 * then deeply by `validateManifest`. Bodies with a wrong-typed `content`
 * (e.g. `content: 1`) are rejected as a 400 instead of blowing up downstream
 * as a 500.
 *
 * All three bodies below are `.strict()`. They were open, and the retired
 * `source_code` key was the reason: dropped when its last reader died with the
 * `tool` package type, it kept being accepted here — stripped in silence, so a
 * client still sending it got a 201 and a package without it, with nothing
 * anywhere saying the field had gone. A retired name must fail loudly
 * (`docs/NO_TRANSITIONAL_CODE.md` §1), which is the rule that closed the four
 * launch surfaces in #1187; the barrier is generic and names no field.
 */
const packageFilePathSchema = z.string().min(1).max(1024);

const packageFileOperationsSchema = z
  .array(
    z.discriminatedUnion("op", [
      z
        .object({
          op: z.literal("write"),
          path: packageFilePathSchema,
          text: z.string().optional(),
          bytes_base64: z.string().optional(),
        })
        .strict()
        .refine((op) => (op.text === undefined) !== (op.bytes_base64 === undefined), {
          error: "A write operation carries exactly one of `text` or `bytes_base64`",
        }),
      z.object({ op: z.literal("delete"), path: packageFilePathSchema }).strict(),
      z
        .object({
          op: z.literal("move"),
          from: packageFilePathSchema,
          to: packageFilePathSchema,
        })
        .strict(),
    ]),
  )
  .min(1)
  .max(200);

export const packageJsonCreateSchema = z
  .object({
    manifest: z.record(z.string(), z.unknown()),
    content: z.string().optional(),
    operations: packageFileOperationsSchema.optional(),
  })
  .strict();

/**
 * The create body of a type whose content file is MANDATORY — `agent` and
 * `skill`, i.e. every {@link PackageRouteConfig} carrying `requireContent`.
 *
 * The requirement is spelled here rather than as a handler check so the
 * published body can state it: the create schemas back the spec's request
 * bodies through `zod-schema-registry.ts`, and a handler-only rule left
 * `POST /api/packages/agents {"manifest": …}` documented as valid and
 * answered with a 400. Blank-but-present content is refused by the same rule
 * — an all-whitespace prompt is the empty prompt with extra characters — and
 * it is a `refine` rather than `.min(1)` because "not blank" has no JSON
 * Schema spelling, so the published body says `required` and nothing more.
 */
export const packageJsonCreateWithContentSchema = z
  .object({
    manifest: z.record(z.string(), z.unknown()),
    content: z.string().refine((v) => v.trim().length > 0, "Content cannot be empty"),
    operations: packageFileOperationsSchema.optional(),
  })
  .strict();

export const packageJsonUpdateSchema = z
  .object({
    manifest: z.record(z.string(), z.unknown()).optional(),
    content: z.string().optional(),
    operations: packageFileOperationsSchema.optional(),
    /**
     * Optimistic-lock token. Mandatory and integral — the value is a row version,
     * never a fraction. This used to be `z.number().optional()` with a hand-rolled
     * `null / typeof !== "number"` check in the handler restating both rules; the
     * schema now carries them, so the spec's `required: ["lock_version"]` and
     * `type: "integer"` have exactly one runtime counterpart.
     */
    lock_version: z.number().int(),
  })
  .strict();

export const createVersionBodySchema = z.object({ version: z.string().min(1).optional() }).strict();

/**
 * Body of `PUT /api/packages/{scope}/{name}/home` — the package's home space,
 * i.e. the space whose `<type>:write` governs it (`packages.home_space_id`).
 * REQUIRED and non-nullable: an organization's package is always homed in one
 * of its spaces (`packages_org_package_has_home`), so there is no "move it
 * nowhere" to express — a package that belongs to no team is homed in the
 * organization's DEFAULT space like any other. `.strict()` so this route can
 * never be mistaken for the draft editor: the draft is `PUT`, with its
 * optimistic lock.
 *
 * The id is SHAPE-CHECKED, like every other space id arriving in a body
 * (`lib/space-role-assignment.ts`): a retired `app_` spelling resolves to no
 * space, and without the refinement this route reports that as "space not
 * found" — the silence `SPACE_ID_RE` exists to end.
 */
export const packageHomeSpaceSchema = z
  .object({
    home_space_id: z.string().refine(isSpaceId, {
      message: "Malformed space id. Expected `spc_` followed by a canonical UUID.",
    }),
    /**
     * Does the space the package is LEAVING keep it? Default `true`, which is
     * the move as it has always behaved: the old home keeps reading and
     * running the package through the authorless offer
     * `reconcilePlacementsAfterRehome` writes, so nothing it had scheduled
     * stops.
     *
     * `false` completes the move instead — the old home's offer AND its
     * placement row go, in the same transaction. It is a field rather than a
     * second route because it is one act with one modifier.
     *
     * The flag governs a space that was RUNNING the package. A space that held
     * no `space_packages` row is LEFT either way, whatever the flag says
     * (`reconcilePlacementsAfterRehome` backfills from `space_packages`): the
     * backfill exists to keep running what was running, and writing an offer to
     * a space that never switched the package on would widen what that space
     * sees rather than preserve it.
     *
     * Asking it costs no authority beyond the move's own `<type>:write` in
     * BOTH homes. Requiring `<type>:share` as well — the permission
     * `DELETE …/shares/{target}` asks — would mean a builder holding `write`
     * and not `share` could never move a package cleanly, only ever leave a
     * copy behind; and withdrawing an access is the safe direction, which
     * §6.9 already says when it calls revoking the lighter act.
     */
    keep_in_previous_home: z.boolean().optional().default(true),
  })
  .strict();

/**
 * Body of `POST /api/packages/{scope}/{name}/shares` — WHO the package is
 * offered to (RBAC spec §6.10).
 *
 * Two kinds, and a person is not a space: a `user` target is resolved
 * server-side to that member's personal space, so the sharer never handles
 * (nor learns) the id of a space §3.6 says does not exist for them. A `space`
 * target must be one the sharer can already reach, and is SHAPE-CHECKED like
 * every other space id in a body (`lib/space-role-assignment.ts`) so a
 * malformed one is a 400 rather than the 404 an unreachable space answers.
 * `.strict()` on both arms — a typo'd key is a 400, not a share to the wrong
 * subject.
 */
export const shareTargetSchema = z
  .object({
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("user"), user_id: z.string().min(1) }).strict(),
      z
        .object({
          kind: z.literal("space"),
          space_id: z.string().refine(isSpaceId, {
            message: "Malformed space id. Expected `spc_` followed by a canonical UUID.",
          }),
        })
        .strict(),
    ]),
  })
  .strict();

/** Enrich items with creator display names (batch lookup). */
async function enrichWithCreatorNames<T extends { created_by?: string | null }>(
  items: T[],
): Promise<(T & { created_by_name?: string })[]> {
  const userIds = [...new Set(items.map((i) => i.created_by).filter(Boolean))] as string[];
  if (userIds.length === 0) return items;

  const rows = await db
    .select({ id: profiles.id, displayName: profiles.displayName })
    .from(profiles)
    .where(inArray(profiles.id, userIds));

  const nameMap = new Map(rows.map((p) => [p.id, p.displayName]));

  return items.map((item) => ({
    ...item,
    created_by_name: item.created_by ? (nameMap.get(item.created_by) ?? undefined) : undefined,
  }));
}

// --- Shared ZIP upload parsing ---

interface ParsedUpload {
  id: string;
  name?: string;
  description?: string;
  archive: Uint8Array;
  manifest: Record<string, unknown>;
}

async function readPackageUpload(c: Context<AppEnv>): Promise<ParsedUpload> {
  if (!(c.req.header("content-type") ?? "").includes("multipart/form-data")) {
    throw new ApiError({
      status: 415,
      code: "archive_required",
      title: "Archive Required",
      detail: "MCP-server packages must be uploaded as a multipart .afps or .zip archive.",
    });
  }
  const formData = await c.req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) throw invalidRequest("File is required", "file");
  if (!file.name.endsWith(".afps") && !file.name.endsWith(".zip"))
    throw invalidRequest("Only .afps and .zip files are accepted", "file");
  const id = file.name.replace(/\.(afps|zip)$/i, "");
  if (!SLUG_REGEX.test(id))
    throw invalidRequest("Invalid file name (kebab-case slug required)", "file");
  const name = formData.get("name");
  const description = formData.get("description");
  const archive = new Uint8Array(await file.arrayBuffer());
  let manifest: Record<string, unknown>;
  try {
    manifest = parseManifestFromFiles(unzipPackageArchive(archive));
  } catch (err) {
    throw invalidRequest(getErrorMessage(err), "file");
  }
  return {
    id,
    name: typeof name === "string" ? name : undefined,
    description: typeof description === "string" ? description : undefined,
    archive,
    manifest,
  };
}

/** Publish a valid initial snapshot; incomplete authoring drafts remain editable. */
async function createVersionSafe(params: {
  packageId: string;
  orgId: string;
  userId: string;
  manifest: Record<string, unknown>;
  normalizedFiles: Record<string, Uint8Array>;
  lockVersion: number;
}): Promise<boolean> {
  const version = params.manifest.version as string | undefined;
  if (!version || !isValidVersion(version)) {
    logger.warn("Skipping version creation: missing or invalid version in manifest", {
      packageId: params.packageId,
    });
    return false;
  }
  const gateErrors = await validateAgentIntegrationSelections({
    manifest: params.manifest,
    orgId: params.orgId,
    requireCallableTools: true,
  });
  if (gateErrors.length > 0) {
    logger.warn("Skipping version creation: manifest would be refused at publish", {
      packageId: params.packageId,
      codes: gateErrors.map((e) => e.code),
    });
    return false;
  }
  try {
    const manifestToStore = params.manifest;
    const entries: Record<string, Uint8Array> = { ...params.normalizedFiles };
    entries["manifest.json"] = new TextEncoder().encode(JSON.stringify(params.manifest, null, 2));
    const zipBuffer = Buffer.from(zipArtifact(entries, 6));

    const published = await createVersionAndUpload({
      packageId: params.packageId,
      version,
      createdBy: params.userId,
      zipBuffer,
      manifest: manifestToStore,
    });
    if (!published) return false;
    if (published.outcome === "created") {
      await finalizeDraftPublication({
        packageId: params.packageId,
        orgId: params.orgId,
        lockVersion: params.lockVersion,
        versionId: published.id,
      });
    }
    return true;
  } catch (error) {
    logger.warn("Version upload failed (non-fatal)", { packageId: params.packageId, error });
    return false;
  }
}

// --- Route configuration per package type ---

interface PackageRouteConfig {
  cfg: PackageTypeConfig;
  /** URL path segment used for routing (e.g. "skills", "integrations"). */
  path: string;
  /** Storage entry for the content field: primary text or the portable manifest. */
  storageFileName: string;
  /** If true, version create/restore require no running runs (agents). */
  requireMutableForVersionOps?: boolean;
  /** If true, this type uses JSON body for create (not ZIP upload parsing). */
  jsonBodyCreate?: boolean;
  /**
   * If true, this type's content file is mandatory: create refuses a body
   * without a non-blank `content` (through
   * {@link packageJsonCreateWithContentSchema}, so the published body says so
   * too), and update refuses a save that would leave the stored content blank.
   */
  requireContent?: boolean;
  /** Custom GET detail handler, replaces makeGetHandler when provided. */
  getHandler?: (c: Context<AppEnv>) => Promise<Response>;
  /**
   * Custom builder for the package detail DTO returned by mutating endpoints
   * (create / update / fork). When provided it overrides the generic
   * `buildPackageDetailDto` so the type's own GET serializer is reused
   * (agents return the richer Agent detail via `buildAgentDetailDto`).
   * Returns `null` when the package cannot be resolved.
   */
  detailDto?: (
    c: Context<AppEnv>,
    itemId: string,
    orgId: string,
  ) => Promise<Record<string, unknown> | null>;
}

// Three types have JSON creation forms; MCP server creation accepts an archive.
const ROUTE_CONFIGS: Record<PackageType, PackageRouteConfig> = {
  skill: {
    cfg: CONFIG_BY_TYPE.skill,
    path: "skills",
    storageFileName: "SKILL.md",
    jsonBodyCreate: true,
    requireContent: true,
  },
  agent: {
    cfg: CONFIG_BY_TYPE.agent,
    path: "agents",
    storageFileName: "prompt.md",
    jsonBodyCreate: true,
    requireContent: true,
    requireMutableForVersionOps: true,
    getHandler: agentDetailHandler,
    // Mutating endpoints echo the full Agent detail (same serializer as the
    // GET). `requireAccess: false` — the caller just wrote this agent in their
    // org, so the space activation gate must not 404 a successful write.
    detailDto: (c, itemId) =>
      buildAgentDetailDto(c, { itemId, requireAccess: false, version: "draft" }),
  },
  // Integrations are authored via a JSON-body manifest editor (parity with
  // agents/skills). The stored `manifest.json` content mirrors the DB
  // `draft_manifest` — the runtime reads the manifest from the DB
  // (`fetchIntegrationManifest`), the storage file exists for export/bundle
  // portability. Bundle-backed (`source.kind: "local"`) integrations still
  // arrive via the import pipeline; the editor authors `remote`/`none`
  // sources that need no server bundle.
  integration: {
    cfg: CONFIG_BY_TYPE.integration,
    path: "integrations",
    storageFileName: "manifest.json",
    jsonBodyCreate: true,
  },
  // Standalone MCP bundles are created by import and edited through the shared draft editor.
  "mcp-server": {
    cfg: CONFIG_BY_TYPE["mcp-server"],
    path: "mcp-servers",
    storageFileName: "manifest.json",
    jsonBodyCreate: false,
  },
};

// --- Handler factories ---

function makeListHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const spaceId = c.get("spaceId");
    // The ACTIVE set of this space, and only it — the index page answers "what
    // can I launch here?". The ONE activation rule decides
    // (`services/package-activation.ts`, applied in SQL by `listOrgItems`): the
    // placement row when there is one and the package is placed here, the
    // deployment's default when there is not. That is the same rule the
    // integration resolver, the run gate and the caller-context hints state,
    // the env-backed system integrations active without a row included, so no
    // type needs a correction pass behind this listing.
    //
    // What is merely PLACED here — a pending offer, a package switched off —
    // belongs to the space library (`GET /api/spaces/{spaceId}/library`), which
    // carries the per-placement state and the switch that repairs it.
    const items = await listOrgItems(orgId, rcfg.cfg, spaceId);
    const enriched = await enrichWithCreatorNames(items);
    // `home_space_id` / `home_writable` are computed HERE, not in
    // `listOrgItems`: both depend on the caller's reach (RBAC spec §6.9), which
    // a service has no access to. One `packageAccessSpaces` read for the page.
    const accessible = await packageAccessSpaces(c);
    return c.json(
      listResponse(
        enriched.map(({ homeSpaceId, ...item }) => ({
          ...item,
          ...homeWireForCaller(
            { type: rcfg.cfg.type, source: item.source, homeSpaceId },
            accessible,
          ),
        })),
      ),
    );
  };
}

function makeCreateHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const orgSlug = c.get("orgSlug");
    const user = c.get("user");

    let draft: Parameters<typeof createPackageDraft>[0];
    // Validate the complete tree before either store is written.
    if (rcfg.jsonBodyCreate) {
      // The two create bodies differ only in whether `content` is mandatory,
      // which is what `requireContent` means. Selecting the schema here — as
      // opposed to re-checking the parsed body afterwards — is what lets the
      // spec publish the difference: `zod-schema-registry.ts` registers
      // whichever of the two schemas this package type's route uses.
      const body = await readJsonBody(
        c,
        rcfg.requireContent ? packageJsonCreateWithContentSchema : packageJsonCreateSchema,
      );

      const manifest = body.manifest;
      let content = body.content ?? "";

      const validatedManifest = await validateManifestForRoute(
        manifest,
        rcfg.cfg.type,
        c,
        "author",
      );

      assertContentConforms(rcfg.cfg.type, content, "content");

      const manifestText = JSON.stringify(validatedManifest, null, 2);
      let normalizedFiles: Record<string, Uint8Array> = {
        [rcfg.storageFileName]: new TextEncoder().encode(
          rcfg.cfg.manifestIsStoredFile ? manifestText : content,
        ),
      };
      if (body.operations || rcfg.requireContent) {
        try {
          normalizedFiles = applyFileOperations(
            { ...normalizedFiles, [PACKAGE_MANIFEST_FILE]: new TextEncoder().encode(manifestText) },
            [
              // The primary file travels as content, but has the same write limit.
              ...(rcfg.requireContent
                ? [
                    {
                      op: "write" as const,
                      path: rcfg.storageFileName,
                      bytes: normalizedFiles[rcfg.storageFileName]!,
                    },
                  ]
                : []),
              ...toDraftFileOperations(body.operations ?? []),
            ],
            { type: rcfg.cfg.type },
          );
          content = validateAuthoredPackageFiles(
            normalizedFiles,
            rcfg.cfg.type,
            validatedManifest,
            body.operations !== undefined,
          );
          if (!rcfg.cfg.manifestIsStoredFile) delete normalizedFiles[PACKAGE_MANIFEST_FILE];
        } catch (error) {
          if (error instanceof PackageFileWriteError) throw draftFileWriteApiError(error);
          throw error;
        }
      }

      const packageId = validatedManifest.name;

      // Scope no longer gates creation, but a system package id must never be shadowed by an
      // org-owned row — the boot sync upserts system rows by id and would later overwrite it
      // (orgId→null). Mirror the system-package guard the update/delete/version handlers apply.
      if (isSystemPackage(packageId)) {
        throw forbidden(`'${packageId}' is a system package and cannot be created`);
      }

      // Check for name collision
      const existingIds = await getAllPackageIds(orgId);
      if (existingIds.includes(packageId)) {
        throw new ApiError({
          status: 400,
          code: "name_collision",
          title: "Name Collision",
          detail: `A ${rcfg.cfg.type} with identifier '${packageId}' already exists`,
        });
      }

      draft = {
        orgId,
        id: packageId,
        content,
        createdBy: user.id,
        homeSpaceId: c.get("spaceId"),
        type: rcfg.cfg.type,
        manifest: validatedManifest,
        files: normalizedFiles,
      };
    } else {
      const parsed = await readPackageUpload(c);
      // Report schema/type errors before checking companion files for another type.
      await validateManifestForRoute(parsed.manifest, rcfg.cfg.type, c, "author");
      let canonical;
      try {
        canonical = parsePackageZip(parsed.archive);
      } catch (err) {
        if (err instanceof PackageZipError) throw invalidRequest(err.message, "file");
        throw err;
      }
      const packageId = `@${orgSlug}/${parsed.id}`;
      if (canonical.packageId !== packageId) {
        throw invalidRequest(
          `Archive manifest name '${canonical.packageId}' must match upload package id '${packageId}'.`,
          "manifest.name",
        );
      }
      if (isSystemPackage(packageId))
        throw forbidden(`'${packageId}' is a system package and cannot be created`);
      assertContentConforms(rcfg.cfg.type, canonical.content, "content");
      draft = {
        orgId,
        id: packageId,
        name: parsed.name,
        description: parsed.description,
        content: canonical.content,
        createdBy: user.id,
        homeSpaceId: c.get("spaceId"),
        type: rcfg.cfg.type,
        manifest: canonical.manifest,
        files: canonical.files,
      };
    }

    const createdItem = await createPackageDraft(draft).catch((err: unknown) => {
      if (err instanceof PackageAlreadyExistsError) throw conflict("name_collision", err.message);
      throw err;
    });
    const packageId = createdItem.id;
    const manifest = asRecord(createdItem.draftManifest);
    // Snapshot the committed draft manifest, including its storage normalization.
    const versionCreated = await createVersionSafe({
      packageId,
      orgId,
      userId: user.id,
      manifest,
      normalizedFiles: draft.files,
      lockVersion: createdItem.lockVersion,
    });
    // The package was just created HERE (`homeSpaceId: spaceId` above), so the
    // placement rule is satisfied and this is an upsert that cannot conflict.
    // WARN nonetheless: a create whose package never became active in the space
    // is a half-finished act, and it has to be visible to an operator.
    const spaceId = c.get("spaceId");
    if (spaceId && versionCreated) {
      await activatePackage({ orgId, spaceId }, packageId).catch((e: unknown) =>
        logger.warn("auto-activation skipped", { packageId, spaceId, err: getErrorMessage(e) }),
      );
    }
    await recordAuditFromContext(c, {
      action: "package.created",
      resourceType: "package",
      resourceId: packageId,
      after: { type: rcfg.cfg.type, version: manifest.version ?? null },
    });
    const detail = await loadPackageDetailDto(c, rcfg, packageId, orgId);
    if (!detail) {
      logger.error("Created package could not be re-read", { packageId, orgId });
      throw internalError();
    }
    return c.json(detail, 201);
  };
}

/** Extract item ID from either `:id` (unscoped) or `:scope/:name` (scoped) route params. */
export function getItemId(c: Context<AppEnv>): string {
  const scope = c.req.param("scope");
  const name = c.req.param("name");
  if (scope && name) return `${scope}/${name}`;
  return c.req.param("id")!;
}

/**
 * Load the org's package of this route's type, or 404 with the type's own
 * wording ("Skill '@acme/x' not found").
 *
 * Seven handlers needed exactly this pair and each spelled it out again. It is
 * a plain call, not a middleware like {@link requirePackageInOrg}: three of the
 * seven run the lookup only AFTER their `isSystemPackage` 403 and their
 * running-runs 409, and a middleware — which necessarily runs before the
 * handler — would answer 404 where those answer 403/409 today. Keeping it a
 * call keeps every handler's check order exactly where its author put it.
 */
async function loadOrgItemOr404(rcfg: PackageRouteConfig, orgId: string, itemId: string) {
  const item = await getOrgItem(orgId, itemId, rcfg.cfg);
  if (!item) {
    throw notFound(`${rcfg.cfg.labelSingular} '${itemId}' not found`);
  }
  return item;
}

/**
 * The manifest-derived half of a package detail, read from a PUBLISHED
 * snapshot instead of the draft columns — `getOrgItem`'s projection applied to
 * a version's own manifest and archive, so the two halves of a detail response
 * never come from two different definitions.
 *
 * The manifest is the `package_versions.manifest` column: authoritative, one
 * DB read, and immune to an archive that will not open. The CONTENT is the
 * archive entry this type is authored around ({@link PACKAGE_CONTENT_ENTRY}),
 * and the fallbacks below are the exact inverse of `applyDraftOverlay`: a type
 * with no content entry at all (`mcp-server`, whose content IS its manifest)
 * and an `integration` published without its optional `INTEGRATION.md` both
 * store the manifest TEXT in `draft_content`, so the published projection
 * reproduces that rather than handing back a `null` the editor would render as
 * an empty file.
 *
 * That fallback stands for an entry MISSING FROM AN ARCHIVE THAT OPENED, and
 * for nothing else. An archive the storage cannot produce at all is a broken
 * artifact for every type, and gets the same `422 version_artifact_unavailable`
 * the run path answers for a published agent with no readable prompt — as does
 * an archive that opened without a REQUIRED entry (`prompt.md`, `SKILL.md`).
 */
async function loadPublishedDefinition(
  type: PackageType,
  packageId: string,
  spec: string,
): Promise<Record<string, unknown>> {
  const detail = await getVersionDetail(packageId, spec);
  if (!detail) throw notFound(`Version '${spec}' not found`);
  const m = asRecord(detail.manifest);
  const entry = PACKAGE_CONTENT_ENTRY[type];
  // TWO different failures, and only the first is a failure at all.
  //
  // `getVersionDetail` CATCHES a storage or unzip failure and answers
  // `content: null` rather than throwing, so that null is the ONLY evidence
  // that the published bytes could not be read — and it is type-independent.
  // Asking the per-type entry FIRST made this 422 unreachable for the two types
  // that have no REQUIRED entry — `integration` (`INTEGRATION.md` is optional)
  // and `mcp-server` (no entry at all): an archive nothing could open answered
  // 200 with the manifest text as `content` and `definition: "published"`, i.e.
  // other bytes than the published ones, presented as the published ones.
  if (detail.content === null) {
    throw new ApiError({
      status: 422,
      code: "version_artifact_unavailable",
      title: "Version Artifact Unavailable",
      detail: `Published '${packageId}@${detail.version}' has no readable archive`,
    });
  }
  const bytes = entry ? detail.content[entry.path] : undefined;
  // The archive OPENED and the entry is not in it. For a REQUIRED entry that is
  // a broken artifact and gets the same 422; for an optional one — or a type
  // with no content entry — it is the normal published shape, and the manifest
  // text below is the definition, exactly as `applyDraftOverlay` stores it.
  if (entry?.required && !bytes) {
    throw new ApiError({
      status: 422,
      code: "version_artifact_unavailable",
      title: "Version Artifact Unavailable",
      detail: `Published '${packageId}@${detail.version}' has no readable '${entry.path}' in its archive`,
    });
  }
  return {
    // Same projection `getOrgItem` runs over the draft manifest, field for
    // field: a reader must not be able to tell which definition answered by
    // the SHAPE of what came back.
    name: typeof m.display_name === "string" ? m.display_name : packageId,
    description: typeof m.description === "string" ? m.description : null,
    version: typeof m.version === "string" ? m.version : null,
    manifest_name: typeof m.name === "string" ? m.name : null,
    manifest: m,
    content: bytes ? decodeSkillMarkdown(bytes) : JSON.stringify(m, null, 2),
  };
}

/**
 * Build the canonical package detail DTO for skills / integrations / mcp-servers
 * — the exact object the `GET` detail endpoint serializes (`OrgPackageItemDetail`).
 * Org-scoped (no space activation gate): the GET handler applies that gate before
 * calling this, while mutating endpoints (create / update / fork) reuse this
 * directly to echo what the caller just wrote (issue #646). Returns `null` when
 * the package is not found in the org.
 *
 * WHICH definition the manifest-derived fields are projected from is the agent
 * page's question, answered by the agent page's two functions — `?version=draft`
 * is an author's act (`403 draft_not_writable`), and with no selector a caller
 * who may WRITE the package reads their draft while everybody else reads the
 * latest published version, falling back to the draft when nothing is published
 * at all. {@link resolveFileExplorerVersion} is that pair, already worded once;
 * calling it here is what stops this page and its own Files tab answering
 * "which definition am I looking at" differently in the same second.
 *
 * Mutating callers pass `draft` explicitly: they have just written that copy,
 * and the echo has to be it whether or not a version is published.
 */
async function buildPackageDetailDto(
  c: Context<AppEnv>,
  rcfg: PackageRouteConfig,
  itemId: string,
  orgId: string,
  opts: { version?: string } = {},
): Promise<Record<string, unknown> | null> {
  const [item, versionCount, latestVersionDate, accessible] = await Promise.all([
    getOrgItem(orgId, itemId, rcfg.cfg),
    getVersionCount(itemId),
    getLatestVersionCreatedAt(itemId),
    packageAccessSpaces(c),
  ]);

  if (!item) return null;

  const spec = await resolveFileExplorerVersion(
    c,
    { id: item.id, source: item.source },
    opts.version?.trim() || undefined,
  );
  // The answer comes back in the version-SPEC vocabulary, where the stored tree
  // has two spellings — an omitted selector and the literal `draft` — and
  // `resolvePackageFileValidator` treats them as one. So must this: `draft` is
  // not a row in `package_versions`, and handing it to the version resolver
  // would 404 the very page an author just asked for by name.
  const rendersStoredTree = spec === undefined || spec === VERSION_SELECTOR_DRAFT;
  // For an org-authored package that stored tree IS the draft; for a system
  // package it is the definition the platform ships, published by
  // construction. The bytes are the same either way — only the wire name
  // differs, and a system package must never be labelled `draft` or the SPA
  // renders "never published" over something that cannot be published at all.
  const definition = rendersStoredTree && item.source !== "system" ? "draft" : "published";
  const published = rendersStoredTree
    ? null
    : await loadPublishedDefinition(rcfg.cfg.type, item.id, spec);

  const { homeSpaceId, ...rest } = item;
  return {
    ...rest,
    ...published,
    definition,
    ...homeWireForCaller({ type: rcfg.cfg.type, source: item.source, homeSpaceId }, accessible),
    version_count: versionCount,
    // Authoring metadata, never projected: it compares the DRAFT against the
    // latest version, and that answer does not change with the definition the
    // reader was served.
    has_unarchived_changes: computeHasUnpublishedChanges(
      item.source,
      versionCount,
      item.updatedAt ? new Date(item.updatedAt) : null,
      latestVersionDate,
    ),
  };
}

/**
 * Resolve the package detail DTO a mutating endpoint should echo — the agent's
 * richer Agent detail when configured (`rcfg.detailDto`), otherwise the generic
 * package detail. Single source of truth so create / update / fork stay in
 * lockstep with their respective GET serializers.
 *
 * `draft` is named on BOTH branches, for the reason the agent branch already
 * names it: a write echoes the bytes it just wrote. Left to the default
 * selector, a caller who publishes and then saves would read their new save
 * back as the published version they are now ahead of. The selector costs them
 * nothing — naming the draft requires write authority, which they have just
 * exercised.
 */
function loadPackageDetailDto(
  c: Context<AppEnv>,
  rcfg: PackageRouteConfig,
  itemId: string,
  orgId: string,
): Promise<Record<string, unknown> | null> {
  return rcfg.detailDto
    ? rcfg.detailDto(c, itemId, orgId)
    : buildPackageDetailDto(c, rcfg, itemId, orgId, { version: VERSION_SELECTOR_DRAFT });
}

function makeGetHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const spaceId = c.get("spaceId");
    const itemId = getItemId(c);

    // Space-level visibility: offered here, homed here, or a system package.
    if (!(await isPackageReadableInSpace(spaceId, itemId))) {
      throw notFound(`${rcfg.cfg.labelSingular} '${itemId}' not found`);
    }

    const dto = await buildPackageDetailDto(c, rcfg, itemId, orgId, {
      version: c.req.query("version"),
    });
    if (!dto) {
      throw notFound(`${rcfg.cfg.labelSingular} '${itemId}' not found`);
    }

    return c.json(dto);
  };
}

function makeUpdateHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);

    if (isSystemPackage(itemId)) {
      throw forbidden(
        `${rcfg.cfg.labelSingular} '${itemId}' is a system package and cannot be modified`,
      );
    }

    const existing = await loadOrgItemOr404(rcfg, orgId, itemId);

    const body = await readJsonBody(c, packageJsonUpdateSchema);

    // A PUT that omits `manifest` is a content-only edit: the stored draft is
    // carried forward untouched. That makes this handler directional per
    // request — `manifest` SUPPLIED is author input, `manifest` OMITTED is the
    // already-stored draft — and the direction decides both the `type` gate and
    // how a retired `runtime_tools` id is treated (see
    // `validateManifestForRoute`). Concretely, a content-only save must not 400
    // on fields the request never mentioned.
    const authoredManifest = body.manifest;
    const manifest =
      authoredManifest ?? (existing as { manifest?: Record<string, unknown> }).manifest ?? {};
    const content = body.content ?? existing.content ?? "";

    // Everything downstream — the persisted row and the
    // id-immutability check — reads the VALIDATED manifest, never the raw one.
    // The create path already did; this one persisted the raw shape, so the
    // normalisation validation had just performed was thrown away on every
    // save. That is what made the carry-forward case above a permanent no-op
    // instead of a self-healing write, and let a non-SPA client (CLI, MCP,
    // curl) keep a retired id alive in the draft indefinitely.
    const validatedManifest = await validateManifestForRoute(
      manifest,
      rcfg.cfg.type,
      c,
      authoredManifest ? "author" : "stored",
      { previous: asRecord(existing.manifest) },
    );
    const manifestText = JSON.stringify(validatedManifest, null, 2);

    // Ensure ID immutability (all types)
    const newScopedName = validatedManifest.name;
    if (newScopedName && newScopedName !== itemId) {
      throw invalidRequest("name cannot change", "name");
    }

    // Content required check
    if (!body.operations && rcfg.requireContent && !content.trim()) {
      throw invalidRequest("Content cannot be empty", "content");
    }

    // The RESOLVED content: the body's when supplied, the stored draft's when
    // carried forward.
    if (!body.operations && content) assertContentConforms(rcfg.cfg.type, content, "content");

    // A manifest-only integration PUT has no authored `content`. When the
    // overloaded column contains the manifest fallback (rather than a real
    // INTEGRATION.md), refresh it from the validated manifest instead of
    // carrying the old fallback forward. A real companion remains protected.
    const entry = PACKAGE_CONTENT_ENTRY[rcfg.cfg.type];
    const draftContentInput =
      body.content === undefined &&
      entry?.required === false &&
      (!existing.content || isManifestTextFallback(existing.content))
        ? manifestText
        : content;

    // Bytes for `rcfg.storageFileName`. When that file is NOT the type's
    // content entry it is the manifest (integration, mcp-server), and it is
    // rebuilt from the VALIDATED manifest rather than echoing `content`: this
    // route accepts a manifest-only PUT, and the `existing.content`
    // carried forward above is `packages.draft_content` — which for an
    // integration is its INTEGRATION.md. Echoing it would overwrite the
    // package's `manifest.json` with its documentation.
    const storageContent = rcfg.cfg.manifestIsStoredFile ? manifestText : content;

    // One read-modify-write for the row and the stored tree, under the package's
    // advisory lock — the same helper the file-tree writes take, so two writers
    // of one package queue instead of overwriting each other's merge. The tree
    // it hands `mutate` is the draft as the explorer shows it, so every file
    // this PUT does not name is carried through untouched.
    //
    // `content` feeds TWO sinks that are the same file for `agent`/`skill` and
    // different files for the manifest-backed types — see `storageFileName`.
    // `resolveDraftContent` guards the column; the storage entry is resolved on
    // its own terms.
    try {
      await mutatePackageDraftFiles(
        { id: itemId, type: rcfg.cfg.type, orgId },
        {
          precondition: { lockVersion: body.lock_version },
          manifest: validatedManifest,
          validateBundle: body.operations !== undefined,
          // File operations own the content column when they are supplied.
          draftContent: body.operations
            ? undefined
            : resolveDraftContent(rcfg.cfg.type, existing.content, draftContentInput),
          mutate: (files) => {
            const next = { ...files };
            if (body.content !== undefined || !body.operations)
              next[rcfg.storageFileName] = new TextEncoder().encode(storageContent);
            return applyFileOperations(next, toDraftFileOperations(body.operations ?? []), {
              type: rcfg.cfg.type,
            });
          },
        },
      );
    } catch (error) {
      if (error instanceof PackageFileWriteError) throw draftFileWriteApiError(error);
      throw error;
    }

    await recordAuditFromContext(c, {
      action: "package.updated",
      resourceType: "package",
      resourceId: itemId,
      after: {
        type: rcfg.cfg.type,
        filePaths: body.operations?.map((op) =>
          op.op === "move" ? `${op.from} → ${op.to}` : op.path,
        ),
      },
    });

    // Return the updated package resource bare — same serializer as the GET
    // detail (issue #657). The resource carries `lock_version`, the NEW
    // optimistic-lock token consumers must read back for the next edit.
    const detail = await loadPackageDetailDto(c, rcfg, itemId, orgId);
    if (!detail) {
      logger.error("Updated package could not be re-read", { packageId: itemId, orgId });
      throw internalError();
    }
    return c.json(detail);
  };
}

/**
 * Reject (409) when an agent package has runs in progress. No-op for package
 * types that don't gate version/delete ops on running runs (skills/tools, where
 * `requireMutableForVersionOps` is unset). Shared by the delete / create-version
 * / restore-version / delete-version handlers so the conflict message + the
 * `(orgId, spaceId)` scoping stay identical across all four.
 */
async function assertNoRunningRuns(
  c: Context<AppEnv>,
  rcfg: PackageRouteConfig,
  itemId: string,
): Promise<void> {
  if (!rcfg.requireMutableForVersionOps) return;
  const running = await getRunningRunsForPackage(
    { orgId: c.get("orgId"), spaceId: c.get("spaceId") },
    itemId,
  );
  if (running > 0) {
    throw conflict(
      "agent_in_use",
      `${running} run(s) still running for this ${rcfg.cfg.labelSingular.toLowerCase()}`,
    );
  }
}

function makeDeleteHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);

    if (isSystemPackage(itemId)) {
      throw forbidden(
        `${rcfg.cfg.labelSingular} '${itemId}' is a system package and cannot be deleted`,
      );
    }

    await assertNoRunningRuns(c, rcfg, itemId);

    const result = await deleteOrgItem(orgId, itemId, rcfg.cfg);
    if (!result.ok) {
      throw conflict(
        "in_use",
        `${rcfg.cfg.labelSingular} '${itemId}' is used by ${result.dependents!.length} package(s)`,
      );
    }

    await recordAuditFromContext(c, {
      action: "package.deleted",
      resourceType: "package",
      resourceId: itemId,
      after: { type: rcfg.cfg.type },
    });

    return c.body(null, 204);
  };
}

function makeListVersionsHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);
    await loadOrgItemOr404(rcfg, orgId, itemId);
    await assertCatalogPackageAccess(c, itemId);
    const versions = await listPackageVersions(itemId);
    return c.json({ versions });
  };
}

/**
 * Build the canonical version detail DTO — the exact object the `GET` version
 * detail endpoint serializes. Reused by the version create / restore endpoints
 * so they echo the resulting version resource instead of an id/message stub
 * (issue #646). Returns `null` when the version query resolves nothing.
 */
async function buildVersionDetailDto(
  rcfg: PackageRouteConfig,
  itemId: string,
  versionSpec: string,
): Promise<Record<string, unknown> | null> {
  const detail = await getVersionDetail(itemId, versionSpec);
  if (!detail) return null;

  const matchingTags = await getMatchingDistTags(itemId, detail.version);

  // Extract primary content file from the ZIP
  let content: string | null = null;
  if (detail.content) {
    const fileData = detail.content[rcfg.storageFileName];
    if (fileData) {
      content = new TextDecoder().decode(fileData);
    }
  }

  return {
    id: detail.id,
    version: detail.version,
    manifest: detail.manifest,
    content,
    yanked: detail.yanked,
    yanked_reason: detail.yankedReason,
    integrity: detail.integrity,
    artifact_size: detail.artifactSize,
    createdAt: detail.createdAt,
    dist_tags: matchingTags,
  };
}

function makeVersionDetailHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);
    const versionSpec = c.req.param("version")!;

    await loadOrgItemOr404(rcfg, orgId, itemId);
    await assertCatalogPackageAccess(c, itemId);

    const dto = await buildVersionDetailDto(rcfg, itemId, versionSpec);
    if (!dto) {
      throw notFound(`Version '${versionSpec}' not found`);
    }

    return c.json(dto);
  };
}

function makeVersionInfoHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);
    await loadOrgItemOr404(rcfg, orgId, itemId);
    await assertCatalogPackageAccess(c, itemId);
    const info = await getVersionInfo(itemId, orgId);
    return c.json(info);
  };
}

function makeCreateVersionHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const itemId = getItemId(c);

    if (isSystemPackage(itemId)) {
      throw forbidden(`${rcfg.cfg.labelSingular} '${itemId}' is a system package`);
    }

    await assertNoRunningRuns(c, rcfg, itemId);

    await loadOrgItemOr404(rcfg, orgId, itemId);

    // Parse optional version override from request body. The body itself is
    // optional (OpenAPI `requestBody.required: false` — the SPA omits it
    // entirely when no override is chosen), so only read it when present;
    // a present-but-malformed body is a 400, not a silent no-override.
    let versionOverride: string | undefined;
    if (c.req.raw.body !== null) {
      const body = await readJsonBody(c, createVersionBodySchema);
      versionOverride = body.version;
    }

    const result = await createVersionFromDraft({
      packageId: itemId,
      orgId,
      userId: user.id,
      version: versionOverride,
      // Validate the exact snapshot that will be published, including its
      // version override. The route's earlier read is not a coherent snapshot.
      // Stored manifests may carry retired tools; empty callable selections
      // remain forbidden at publish time, even when draft saves allow them.
      validateManifest: (manifest, type) =>
        validateManifestForRoute(manifest, type, c, "stored", {
          requireCallableTools: true,
        }),
    });

    if ("error" in result) {
      if (result.error === "no_changes") {
        throw conflict("no_changes", "No changes since the last version");
      }
      if (result.error === "version_exists") {
        throw conflict(
          "version_exists",
          "This version is already published and immutable — bump the version to publish the changed content",
        );
      }
      if (result.error === "invalid_bundle") {
        throw invalidRequest(
          result.detail ?? "MCP-server package archive is not executable",
          "manifest.server.entry_point",
        );
      }
      throw invalidRequest("Failed to create version (invalid or duplicate)");
    }

    await recordAuditFromContext(c, {
      action: "package.version_created",
      resourceType: "package",
      resourceId: itemId,
      after: { type: rcfg.cfg.type, version: result.version },
    });

    // Return the created version resource bare — same DTO/serializer as the
    // GET version detail — so callers see the snapshot (manifest, integrity,
    // dist_tags, …) without a follow-up GET (issue #657). `id` (version row
    // id) and `version` are part of the resource.
    const detail = await buildVersionDetailDto(rcfg, itemId, result.version);
    if (!detail) {
      logger.error("Created version could not be re-read", { packageId: itemId, orgId });
      throw internalError();
    }
    return c.json(detail, 201);
  };
}

function makeRestoreVersionHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);

    if (isSystemPackage(itemId)) {
      throw forbidden(`${rcfg.cfg.labelSingular} '${itemId}' is a system package`);
    }

    await assertNoRunningRuns(c, rcfg, itemId);

    const versionSpec = c.req.param("version")!;
    const detail = await getVersionDetail(itemId, versionSpec);
    if (!detail) {
      throw notFound(`Version '${versionSpec}' not found`);
    }

    const existing = await loadOrgItemOr404(rcfg, orgId, itemId);
    if (!existing.lock_version) {
      throw notFound(`${rcfg.cfg.labelSingular} '${itemId}' not found`);
    }

    // Extract `packages.draft_content` from the version ZIP.
    //
    // The column mirrors the archive's CONTENT ENTRY (`PACKAGE_CONTENT_ENTRY`),
    // NOT the file this type's editor `content` is stored under
    // (`rcfg.storageFileName`). The two names agree for `agent`/`skill` and
    // DIVERGE for `integration`, whose column holds the optional
    // `INTEGRATION.md` while its editor content is `manifest.json` — reading
    // the storage name restored a manifest copy over the docs, the exact
    // overload `parsePackageZip` avoids. Falling back to the storage name
    // reproduces that parser's own manifest-text fallback for a bundle that
    // ships no companion, and is a no-op for the three types whose two names
    // already coincide.
    const contentEntryPath = PACKAGE_CONTENT_ENTRY[rcfg.cfg.type]?.path;
    let content = detail.prompt ?? "";
    if (detail.content) {
      const fileData =
        (contentEntryPath ? detail.content[contentEntryPath] : undefined) ??
        detail.content[rcfg.storageFileName];
      if (fileData) {
        // BOM-preserving: gated below AND written back as the draft.
        content = decodeSkillMarkdown(fileData);
      }
    }

    // A restore WRITES authored content. Before the write below, so a
    // violation leaves both stores untouched.
    if (content) assertContentConforms(rcfg.cfg.type, content, "content");

    await assertPackageDependenciesAccessible(
      c,
      asRecord(detail.manifest),
      asRecord(existing.manifest),
    );
    // Restores share the writer lock and replace the complete tree when the
    // version has one. Legacy metadata-only versions leave existing files alone.
    await mutatePackageDraftFiles(
      { id: itemId, type: rcfg.cfg.type, orgId },
      {
        precondition: { lockVersion: existing.lock_version },
        manifest: asRecord(detail.manifest),
        draftContent: content,
        ...(detail.content
          ? { replace: detail.content }
          : { mutate: (files: Record<string, Uint8Array>) => files }),
      },
    );

    // If restoring the latest version, align updatedAt so the draft
    // doesn't appear as having unpublished changes.
    const latestDate = await getLatestVersionCreatedAt(itemId);
    if (
      latestDate &&
      detail.createdAt &&
      new Date(detail.createdAt).getTime() === latestDate.getTime()
    ) {
      await db
        .update(packages)
        .set({ updatedAt: latestDate })
        .where(and(eq(packages.id, itemId), eq(packages.orgId, orgId)));
    }

    await recordAuditFromContext(c, {
      action: "package.version_restored",
      resourceType: "package",
      resourceId: itemId,
      after: { type: rcfg.cfg.type, version: detail.version },
    });

    // Restore mutates the package draft — return the updated PACKAGE resource
    // bare, same DTO/serializer as the package GET detail (issue #657). The
    // restored version info is reflected in the resource itself (`version`,
    // `manifest`, `content`), and the resource carries `lock_version`, the
    // package's NEW optimistic-lock token to read back before the next edit.
    const packageDto = await loadPackageDetailDto(c, rcfg, itemId, orgId);
    if (!packageDto) {
      logger.error("Restored package could not be re-read", { packageId: itemId, orgId });
      throw internalError();
    }
    return c.json(packageDto);
  };
}

function makeDeleteVersionHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);

    if (isSystemPackage(itemId)) {
      throw forbidden(`${rcfg.cfg.labelSingular} '${itemId}' is a system package`);
    }

    // Verify org ownership before deletion
    await loadOrgItemOr404(rcfg, orgId, itemId);

    await assertNoRunningRuns(c, rcfg, itemId);

    const versionSpec = c.req.param("version")!;
    const deleted = await deletePackageVersion(itemId, versionSpec);
    if (!deleted) {
      throw notFound(`Version '${versionSpec}' not found`);
    }

    await recordAuditFromContext(c, {
      action: "package.version_deleted",
      resourceType: "package",
      resourceId: itemId,
      after: { type: rcfg.cfg.type, version: versionSpec },
    });

    return c.body(null, 204);
  };
}

// ═══════════════════════════════════════════════
// File explorer (read-only)
// ═══════════════════════════════════════════════

const fileIndexQuerySchema = z.object({
  version: z.string().trim().min(1).optional(),
});
const fileContentQuerySchema = z.object({
  version: z.string().trim().min(1).optional(),
  // NOT trimmed: `unzipArtifact` preserves leading/trailing spaces in ZIP entry
  // names, so an entry the index advertises as `"notes .md "` must stay
  // fetchable by that exact key. Trimming would make it permanently 404.
  path: z.string().min(1),
});

function parseFileQuery<T extends z.ZodType>(c: Context<AppEnv>, schema: T): z.infer<T> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalidRequest(issue?.message ?? "Invalid query", issue?.path.join(".") || undefined);
  }
  return parsed.data;
}

/**
 * Resolve the package a file-explorer request targets AND authorize the read —
 * 404 when the package is not reachable, 403 when it is but the caller may not
 * read it.
 *
 * Two gates that answer different questions, both required:
 *
 * - `isPackageReadableInSpace` is VISIBILITY: "is this a system package,
 *   offered to THIS space, or homed here?" (it also excludes ephemeral
 *   shadows). It says nothing about what the caller is ALLOWED to do — a
 *   credential with `scopes: []` passes it. Believing otherwise is exactly the
 *   mistake #1124 had to undo across the rest of the package surface.
 * - `requirePackageReadPermission` is AUTHORIZATION: the resolved row's
 *   `<type>:read` scope. Both file-explorer routes are registered on the
 *   router ROOT, so the RBAC resource is not knowable from the path — only
 *   from the row — which is why the guard runs here and not as route-level
 *   middleware.
 *
 * The row read in between adds the org boundary (`isPackageReadableInSpace`
 * does not filter `orgId`) and fetches the draft columns the overlay needs
 * plus the `source` {@link resolveFileExplorerVersion} reads.
 *
 * Authorizing HERE rather than at each call site is what makes the ordering
 * safe. Both handlers call this before they touch a validator, so no
 * response — 200, 304 or 404 — is reachable without the permission check. A
 * guard placed after the ETag short-circuit would still leave `/files/content`
 * an oracle: replaying an `If-None-Match` would answer 304 and tell an
 * unauthorized caller that this exact file exists with this exact content.
 *
 * 404-before-403 is forced, not a policy choice: the RBAC resource comes from
 * the row, so visibility has to be settled first. Same order as
 * `/{version}/download`.
 */
async function loadFileExplorerPackage(c: Context<AppEnv>): Promise<FileExplorerPackage> {
  const packageId = getItemId(c);
  const orgId = c.get("orgId");
  const spaceId = c.get("spaceId");

  if (!(await isPackageReadableInSpace(spaceId, packageId))) {
    throw notFound("Package not found");
  }

  const [pkg] = await db
    .select({
      id: packages.id,
      type: packages.type,
      source: packages.source,
      orgId: packages.orgId,
      draftManifest: packages.draftManifest,
      draftContent: packages.draftContent,
    })
    .from(packages)
    .where(and(eq(packages.id, packageId), orgOrSystemFilter(orgId), notEphemeralFilter()))
    .limit(1);
  if (!pkg) {
    throw notFound("Package not found");
  }

  // The index lists every file and inlines text content; `/files/content`
  // serves any byte of the artifact. Both are at least as sensitive as the
  // detail route, so both need the same `<type>:read`.
  await requirePackageReadPermission(c, pkg.type);

  return pkg;
}

/**
 * The file-explorer row: a {@link PackageFileSource} plus the `source` column,
 * which is what tells a platform-shipped definition from an org-authored one.
 */
type FileExplorerPackage = PackageFileSource & { source: string };

/**
 * WHICH definition a file-explorer read renders — the same question the agent
 * detail page answers, from the same two functions, because they are the same
 * question (RBAC spec §6.10).
 *
 * Reading is not executing, so an omitted `?version` gets the definition that
 * EXISTS for this caller: the author's draft when they may write the package,
 * the latest published version otherwise, and the draft again when nothing is
 * published — a readable package whose explorer 404s is a tab the detail page
 * has just promised and cannot honour. That is {@link defaultDefinitionSelector},
 * verbatim, mapped onto the version-spec vocabulary these two routes speak:
 * `undefined` is their word for the draft and `latest` for the published tag.
 *
 * An EXPLICIT `?version=draft` is the other act, and keeps the other rule:
 * naming the working copy is an author's move, refused with
 * `403 draft_not_writable` ({@link assertDraftSelectorAllowed}). Without it
 * these two routes would be a fifth door to a draft the run, the schedule, the
 * readiness and the bundle export all close.
 *
 * A system package ships its definition with the platform and owns no
 * `package_versions` rows, so `latest` would resolve to nothing: its stored
 * tree IS its published definition, and every selector but the named `draft`
 * reads it. Same rule the run path applies (`resolveAgentRunVersion` ignores
 * the selector for `source === "system"`), stated here rather than inherited
 * because the 404 it prevents shows up only on a system package's Files tab.
 *
 * Takes the two columns it reads rather than a whole row, because the DETAIL
 * projection asks the same question from a different query
 * ({@link buildPackageDetailDto}) and must get it from this function rather
 * than from a second spelling of it.
 */
async function resolveFileExplorerVersion(
  c: Context<AppEnv>,
  pkg: Pick<FileExplorerPackage, "id" | "source">,
  explicit: string | undefined,
): Promise<string | undefined> {
  await assertDraftSelectorAllowed(c, pkg.id, explicit);
  if (pkg.source === "system") return undefined;
  if (explicit) return explicit;
  const { selector } = await defaultDefinitionSelector(c, pkg);
  return selector === VERSION_SELECTOR_DRAFT ? undefined : "latest";
}

/**
 * One policy for every response on both routes: `private, no-cache`.
 *
 * `private` is mandatory: these are authenticated, tenant-scoped bytes and a
 * shared cache must never hold them. `no-cache` is mandatory for the same
 * reason — it still allows the 304 round-trip, it only forbids serving without
 * one, and that round-trip is what keeps authorization live. Any fresh window,
 * however short, is served by the browser with ZERO server contact: revoke
 * `<type>:read`, remove the member from the org, or revoke the offer that
 * places the package in the space, and the cached 200 keeps being handed out
 * until it expires.
 * `Vary` cannot rescue that — revocation changes no request header. Forcing the
 * round-trip re-enters `loadFileExplorerPackage`, so `isPackageReadableInSpace`
 * and `requirePackageReadPermission` run on every hit.
 *
 * The revalidation this costs is nearly free: `resolvePackageFileValidator`
 * answers a version's 304 from one DB read, with no storage GET and no unzip.
 * That is the entire reason it is split out from `readPackageSnapshot`.
 *
 * `Vary` is NOT optional here. The response body depends on `X-Org-Id` /
 * `X-Space-Id` (via `isPackageReadableInSpace`) while the URL does not mention
 * either. Without it, switching spaces in the SPA re-issues an identical
 * URL and the browser answers from cache — showing space B an artifact
 * that is only placed in space A.
 */
function fileCacheHeaders(etag: string, yanked: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    ETag: etag,
    "Cache-Control": "private, no-cache",
    Vary: "X-Org-Id, X-Space-Id",
  };
  if (yanked) headers["X-Yanked"] = "true";
  return headers;
}

// ═══════════════════════════════════════════════
// Draft tree writes
// ═══════════════════════════════════════════════

/**
 * `PackageFileWriteError` → the HTTP answer, in one place.
 *
 * `applyFileOperations` answers WHAT is wrong with a batch and deliberately
 * knows no status codes; this is the boundary that says it with a number. The
 * error's own `code` is carried through as the problem code rather than
 * flattened into `invalid_request`: the editor renders a different message for
 * a bad path, a protected entry and a taken destination, and it needs the
 * machine-readable half to pick one.
 */
const DRAFT_FILE_WRITE_PROBLEM: Record<
  PackageFileWriteErrorCode,
  { status: number; title: string }
> = {
  invalid_bundle: { status: 400, title: "Invalid Bundle" },
  invalid_path: { status: 400, title: "Invalid Request" },
  reserved_entry: { status: 400, title: "Invalid Request" },
  content_entry_immovable: { status: 400, title: "Invalid Request" },
  path_conflict: { status: 400, title: "Invalid Request" },
  not_found: { status: 404, title: "Not Found" },
  file_too_large: { status: 413, title: "Payload Too Large" },
  tree_too_large: { status: 413, title: "Payload Too Large" },
};

function draftFileWriteApiError(err: PackageFileWriteError): ApiError {
  const { status, title } = DRAFT_FILE_WRITE_PROBLEM[err.code];
  return new ApiError({
    status,
    code: err.code,
    title,
    detail: err.message,
    param: "operations",
    cause: err,
  });
}

/** Standard base64 alphabet, padding stripped before the test. */
const BASE64_ALPHABET_RE = /^[A-Za-z0-9+/]*$/;

/**
 * Decode one `bytes_base64` payload.
 *
 * `Buffer.from(s, "base64")` never fails — it drops every character outside the
 * alphabet and returns whatever is left — so a truncated or mistyped payload
 * would be stored as a shorter file the author never wrote. The alphabet and
 * the length are therefore checked first: a `length % 4 === 1` remainder is
 * unreachable for any valid base64 string, which is what makes it the signal of
 * a truncated one. Trailing padding is optional — it carries no information the
 * length does not already give. URL-safe base64 is refused rather than folded:
 * this payload is produced by the editor, and accepting a second spelling would
 * mean two encodings of the same bytes reach the same tree.
 */
function decodeOperationBytes(value: string, index: number): Uint8Array {
  const normalized = value.replace(/=+$/, "");
  if (!BASE64_ALPHABET_RE.test(normalized) || normalized.length % 4 === 1) {
    throw invalidRequest(
      `operations[${index}].bytes_base64 is not valid base64`,
      `operations[${index}].bytes_base64`,
    );
  }
  return new Uint8Array(Buffer.from(normalized, "base64"));
}

/**
 * Wire operations → the service's byte-level ones. This is the only place the
 * two `write` spellings collapse: `text` is encoded UTF-8, `bytes_base64` is
 * decoded, and everything below sees one shape.
 */
function toDraftFileOperations(
  operations: z.infer<typeof packageFileOperationsSchema>,
): PackageFileOperation[] {
  const encoder = new TextEncoder();
  return operations.map((op, index) => {
    if (op.op !== "write") return op;
    // The schema refuses a `write` that carries neither field, so the absence
    // of one is the presence of the other.
    return op.text !== undefined
      ? { op: "write", path: op.path, bytes: encoder.encode(op.text) }
      : { op: "write", path: op.path, bytes: decodeOperationBytes(op.bytes_base64!, index) };
  });
}

// ═══════════════════════════════════════════════
// Read permission
// ═══════════════════════════════════════════════

type ReadGuard = (c: Context<AppEnv>, next: () => Promise<void>) => Promise<unknown>;

/**
 * `type` → the `*:read` guard for that type's RBAC resource.
 *
 * The per-type routes get their resource straight from the route path
 * (`skills` → `skills:read`), but a route registered on the router ROOT
 * (`/:scope/:name/...`, e.g. `/{version}/download` or `/files`) does not name a
 * type in its path — the resource is only knowable from the resolved package
 * row. This map is what lets such a route reach the same guard, so downloading
 * a skill's ZIP is gated on `skills:read` exactly like
 * `GET /skills/@scope/name`.
 *
 * Built from `ROUTE_CONFIGS` rather than hand-written so a new package type
 * cannot land with a per-type guard and no root-route guard.
 */
const READ_GUARD_BY_TYPE = new Map<PackageType, ReadGuard>(
  Object.entries(ROUTE_CONFIGS).flatMap(([type, rcfg]) =>
    rcfg
      ? [
          [
            type as PackageType,
            requirePermission(rcfg.path as import("../lib/permissions.ts").Resource, "read"),
          ] as const,
        ]
      : [],
  ),
);

/**
 * Enforce the resolved package's `*:read` permission from INSIDE a handler.
 *
 * Route-level middleware cannot do this job on the router-root routes: the
 * resource depends on the row, and the row is only read once the handler runs.
 * Reusing the guard (rather than an inline `permissions.has()`) keeps the
 * denial audit hook, the 403 shape, and the fail-closed semantics identical to
 * every other RBAC call site.
 *
 * An unmapped type fails CLOSED — a package type with no route config has no
 * read scope to satisfy, so nobody may read its bytes.
 */
async function requirePackageReadPermission(c: Context<AppEnv>, type: string): Promise<void> {
  const guard = READ_GUARD_BY_TYPE.get(type as PackageType);
  if (!guard) {
    throw forbidden(`Insufficient permissions: no read scope is defined for type '${type}'`);
  }
  await guard(c, async () => {});
}

/** Reject non-authors before parsing uploads or fetching a GitHub archive. */
const requireAnyPackageWrite = requireAnyPermission(PACKAGE_WRITE_PERMISSIONS);

// ═══════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════

export function createPackagesRouter() {
  const router = new Hono<AppEnv>();

  // --- Package CRUD routes (skills, agents, integrations) ---
  for (const rcfg of Object.values(ROUTE_CONFIGS)) {
    if (!rcfg) continue;
    const { path } = rcfg;
    // Permission resource matches the route path (e.g. "skills", "agents", "integrations")
    const resource = path as import("../lib/permissions.ts").Resource;
    const readGuard = requirePermission(resource, "read");
    // Creation only. Every route that mutates an EXISTING package is guarded by
    // `requirePackageInOrg()` alone: authority is the package's home space, and
    // a second guard against the current space would re-impose the conjunction
    // the home rule replaced (RBAC spec §6.9).
    const writeGuard = requirePermission(resource, "write");

    // `readGuard` on every GET: the visibility check inside the handlers
    // (`isPackageReadableInSpace`) answers "is this package reachable from
    // this space", never "may this caller read it". Without the guard a
    // credential scoped without `<type>:read` still gets the manifest and, on
    // the detail route, the full `content` (SKILL.md / prompt.md).
    router.get(`/${path}`, readGuard, makeListHandler(rcfg));
    router.post(`/${path}`, writeGuard, makeCreateHandler(rcfg));
    // Version routes — must be registered before generic get to avoid conflict
    router.get(
      `/${path}/${SCOPED_PACKAGE_ROUTE}/versions`,
      readGuard,
      makeListVersionsHandler(rcfg),
    );
    // Version info + create version + restore — BEFORE :version param to avoid matching
    router.get(
      `/${path}/${SCOPED_PACKAGE_ROUTE}/versions/info`,
      readGuard,
      makeVersionInfoHandler(rcfg),
    );
    router.post(
      `/${path}/${SCOPED_PACKAGE_ROUTE}/versions`,
      requirePackageInOrg(),
      makeCreateVersionHandler(rcfg),
    );
    router.post(
      `/${path}/${SCOPED_PACKAGE_ROUTE}/versions/:version/restore`,
      requirePackageInOrg(),
      makeRestoreVersionHandler(rcfg),
    );
    router.delete(
      `/${path}/${SCOPED_PACKAGE_ROUTE}/versions/:version`,
      requirePackageInOrg("delete"),
      makeDeleteVersionHandler(rcfg),
    );
    router.get(
      `/${path}/${SCOPED_PACKAGE_ROUTE}/versions/:version`,
      readGuard,
      makeVersionDetailHandler(rcfg),
    );
    // Scoped IDs (@scope/name) — must be registered before unscoped to match first
    router.get(
      `/${path}/${SCOPED_PACKAGE_ROUTE}`,
      // `agents:run` opens the agent DETAIL too, in the summary projection the
      // launch form reads its `input` from (§3.4). This route only: the
      // listing above, the versions and the file explorer stay on `agents:read`.
      rcfg.cfg.type === "agent" ? requireAgentRead : readGuard,
      rcfg.getHandler ?? makeGetHandler(rcfg),
    );
    router.put(`/${path}/${SCOPED_PACKAGE_ROUTE}`, requirePackageInOrg(), makeUpdateHandler(rcfg));
    router.delete(
      `/${path}/${SCOPED_PACKAGE_ROUTE}`,
      requirePackageInOrg("delete"),
      makeDeleteHandler(rcfg),
    );
    // There is deliberately no unscoped `/:id` variant.
    //
    // There was one — GET/PUT/DELETE per package type, 12 endpoints — for an
    // identifier shape that cannot be constructed. `buildPackageId()` returns
    // `@${scope}/${name}` unconditionally (`@appstrate/core/naming`), inline
    // runs mint `@scope/...` shadow ids, and `0000_init.sql` is a squashed
    // init, so no pre-scope row survives anywhere and no backfill ever created
    // one. Every `packages.id` in existence is scoped. The endpoints were
    // reachable only by `%2F`-encoding a scoped id into the segment — which
    // the SPA never emits (`apps/web/src/api/client.ts:31`) and no caller in
    // this repo or its two out-of-tree consumers ever did.
    //
    // Removing them is an intentional contract deletion. `detect:breaking`
    // has no waiver mechanism by design — the only way to accept a break is to
    // regenerate `apps/api/src/openapi/baseline.json`, which is what the
    // commit that removed these did, with the 12 flagged endpoints recorded in
    // its message.
  }

  // --- The type-agnostic act family: `/{scope}/{name}/<act>` ---
  //
  // `/api/packages/{scope}/{name}` is a NAMESPACE, never a resource: the package
  // itself is read and written at `/api/packages/{type}/{scope}/{name}`, whose
  // DTO is type-specific. What hangs off the untyped path are the acts that do
  // not depend on the type — `home`, `shares`, `fork`, `files`,
  // `{version}/download` — which is why none of them is a verb on the base path.
  //
  // ORDERING: `/{scope}/{name}/:version/download` takes a PARAMETER in the act
  // slot, so it shadows any `GET` whose fourth segment is the literal `download`
  // registered after it (Hono matches in order, with no specificity rule). No
  // act has that shape today, so the constraint binds the NEXT one written;
  // `no-route-shadows-version-download.test.ts` reads the route table and fails
  // on one that does.
  //
  // --- Move a package to another home space ---
  //
  // Without it a package is a prisoner of the space it was born in: write
  // authority follows `home_space_id` and nothing else could change it.
  //
  // No route-level permission guard: like every other mutation of an existing
  // package, the authority is the home space, which `assertPackageMutationAccess`
  // is the one reader of. It runs before the body is parsed so a caller who may
  // not touch this package learns nothing about the body's shape.
  router.put(`/${SCOPED_PACKAGE_ROUTE}/home`, async (c) => {
    const packageId = getItemId(c);
    const orgId = c.get("orgId");

    const accessible = await packageAccessSpaces(c);
    // Authority in the CURRENT home first — 404 for an id the caller cannot
    // reach at all, 403 when they can see it but do not govern it. It hands
    // back the row, so the type and the old home are not read twice.
    const pkg = await assertPackageMutationAccess(c, packageId, "write");

    const body = await readJsonBody(c, packageHomeSpaceSchema);
    const target = body.home_space_id;

    const destination = accessible.find((space) => space.id === target);
    // A space the caller cannot reach must not be confirmed to exist — and the
    // 404 stays silent, since naming the permission would confirm it.
    if (!destination) throw notFound(`Space '${target}' not found`);
    // A PERSONAL space is never a destination. A builder of a team space also
    // holds `<type>:write` in their OWN personal space (preset `admin`), so the
    // move went through — and §3.6 gives no administrator a way into a personal
    // space, which left the team's package beyond every admin's reach (no edit,
    // no delete, no move back) until its owner left the organization and the
    // sweeper re-homed it. A private copy is `POST …/fork`, which creates a NEW
    // package instead of carrying this one off.
    //
    // Conditioned on the home actually MOVING, because a package already homed
    // in the caller's own personal space is a legitimate state — creating or
    // forking there is how it got one — and a read-modify-write client that
    // PUTs back the home it just read must get the idempotent 200 the no-op
    // below answers with, not a refusal of the state it is already in.
    if (target !== pkg.homeSpaceId && destination.ownerUserId !== null) {
      throw conflict(
        "home_move_into_personal_space",
        `A personal space homes only what is created or forked in it — fork '${packageId}' to get a private copy.`,
      );
    }
    if (!destination.permissions.has(packagePermission(pkg.type, "write"))) {
      reportPermissionDenial(c, packagePermission(pkg.type, "write"));
      throw forbidden(
        `Moving '${packageId}' into that space requires '${packagePermission(pkg.type, "write")}' there.`,
      );
    }

    if (target !== pkg.homeSpaceId) {
      // `updatedAt` is deliberately NOT stamped: it is the DRAFT's timestamp,
      // and `has_unarchived_changes` compares it against the latest version's
      // (`computeHasUnpublishedChanges`). Moving the home changes no bytes, so
      // touching it would report a fully-published package as dirty.
      //
      // The move and the PLACEMENTS it invalidates travel in ONE transaction,
      // through `reconcilePlacementsAfterRehome`, whose docstring carries the
      // reasoning.
      //
      // An mcp-server whose `latest` archive does not parse is refused
      // activation by the door; the move must not be the way in. Run outside
      // the transaction, exactly as `activatePackage` runs it, because it reads
      // object storage — a 422 here fails the whole move, which is the point.
      await assertMcpServerActivatable({ orgId, spaceId: target }, packageId);
      const activation = await db.transaction(async (tx) => {
        // The SOURCE authority, re-asked against the home this transaction
        // HOLDS — the discipline `sharePackage` applies, for a heavier stake.
        // The assert above judged the home as it stood when the request
        // arrived; a concurrent move committing in between would leave this
        // caller carrying the package OUT of a space whose write they never
        // held. `FOR UPDATE`, not `FOR SHARE`: this transaction rewrites that
        // column, so two moves racing must serialize.
        const [locked] = await tx
          .select({ homeSpaceId: packages.homeSpaceId })
          .from(packages)
          .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)))
          .limit(1)
          .for("update");
        if (!locked) throw notFound(`Package '${packageId}' not found`);
        if (locked.homeSpaceId !== pkg.homeSpaceId) {
          // It moved under us. Re-ask the rule rather than re-deriving it, and
          // refuse plainly: the caller's own next read shows the new home, and
          // retrying from there is one request.
          if (!holdsHomeAuthority(locked, accessible, packagePermission(pkg.type, "write"))) {
            throw forbidden(
              `Moving '${packageId}' requires '${packagePermission(pkg.type, "write")}' in its home space — the package moved home while this request was in flight.`,
            );
          }
          // No special case for "a concurrent move already put it on `target`":
          // the UPDATE, the reconciliation and the activation below are each
          // idempotent, so the loser of that race commits the same state the
          // winner did rather than a refusal the caller cannot act on.
        }
        await tx
          .update(packages)
          .set({ homeSpaceId: target })
          .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)));
        await reconcilePlacementsAfterRehome(tx, {
          packageId,
          orgId,
          newHomeSpaceId: target,
          // The one placement this act gets to decide. `locked.homeSpaceId`
          // rather than `pkg.homeSpaceId`: a concurrent move may have changed
          // the home under us and the branch above re-authorized against THAT
          // row, so the space being left is the one this transaction holds.
          ...(locked.homeSpaceId
            ? { previousHome: { spaceId: locked.homeSpaceId, keep: body.keep_in_previous_home } }
            : {}),
        });
        // The new home ACTIVATES it, exactly as creation does — arriving in a
        // space that cannot run it would make the move a two-step act with no
        // second button. Through the activation door itself, in THIS
        // transaction, so `space_packages` keeps a single writer.
        // `keepExistingDecision`: a space that deliberately switched the package
        // off keeps that decision — the move is about authority, not about what
        // this space runs.
        return activatePackageWithin(tx, { orgId, spaceId: target }, packageId, {
          keepExistingDecision: true,
        });
      });
      // The OLD home can be a personal space — its owner moving a package out
      // to a team. Its id is withheld from the trail exactly as
      // `package.shared` withholds it (§3.6), and the owner is recorded
      // instead: that is the audited subject, and the space is its
      // implementation. `after` needs no such care, a personal destination
      // being refused above. The old home is necessarily in `accessible` —
      // nothing else could have authorized the move.
      const previousHomeOwnerId =
        accessible.find((space) => space.id === pkg.homeSpaceId)?.ownerUserId ?? null;
      await recordAuditFromContext(c, {
        action: "package.home_space_changed",
        resourceType: "package",
        resourceId: packageId,
        // CAMELCASE, like every other audit payload in this file and like the
        // `package.activated` entry twelve lines below: carve-out 4m
        // (`docs/CASING_CONVENTIONS.md`) — a SIEM indexes these keys, so they
        // are named here on purpose and never copied from the snake_case
        // request body. `keptInPreviousHome` is the body's
        // `keep_in_previous_home` re-spelled for that reason.
        before:
          previousHomeOwnerId === null
            ? { homeSpaceId: pkg.homeSpaceId }
            : { homeSpaceId: null, homeOwnerUserId: previousHomeOwnerId },
        // `keptInPreviousHome` is the half of this act that is NOT the home
        // column: `false` means the space being left lost the package — its
        // offer and its placement row both — which is a withdrawal of access
        // and belongs in the trail beside the move that performed it. It rides
        // on THIS event rather than a second `package.unshared`, because one
        // act is one entry and the entry should name what did it.
        after: { homeSpaceId: target, keptInPreviousHome: body.keep_in_previous_home },
      });
      // Symmetric with the HTTP door: recorded only when the destination
      // actually started running the package, and naming the act that did it —
      // the move, not a click on a switch that nobody pressed. A destination
      // that kept an `enabled = false` row changed nothing and is audited as
      // nothing.
      if (activation.placement.enabled && !activation.wasActive) {
        await recordAuditFromContext(c, {
          action: "package.activated",
          resourceType: "package",
          resourceId: packageId,
          after: { spaceId: target, via: "move" },
        });
      }
    }

    const rcfg = ROUTE_CONFIGS[pkg.type];
    const detail = rcfg ? await loadPackageDetailDto(c, rcfg, packageId, orgId) : null;
    if (!detail) {
      logger.error("Moved package could not be re-read", { packageId, orgId });
      throw internalError();
    }
    return c.json(detail);
  });

  // --- Fork route ---
  router.post(`/${SCOPED_PACKAGE_ROUTE}/fork`, requireAnyPackageWrite, async (c) => {
    const packageId = getItemId(c);
    const orgId = c.get("orgId");
    const orgSlug = c.get("orgSlug");
    const user = c.get("user");

    // A missing/empty body is fine (auto-name), but a present-and-invalid
    // `name` must surface as a 400 — `allowEmpty` maps an empty body to `{}`
    // while still 400ing on malformed JSON or a bad-shape `name`.
    const parsed = await readJsonBody(c, forkSchema, { allowEmpty: true });
    const customName = parsed.name;
    const source = await assertForkSourceAccess(c, packageId);
    await makePermissionGuard(packagePermission(source.type, "write"))(c, async () => {});

    const result = await forkPackage(
      orgId,
      orgSlug,
      packageId,
      // The fork is a NEW package in the space the caller forked from; the
      // source's home says nothing about who may edit the copy.
      c.get("spaceId"),
      user.id,
      customName,
    );

    if ("code" in result) {
      switch (result.code) {
        case "ALREADY_OWNED":
          throw invalidRequest("You already own this package");
        case "NOT_FOUND":
          throw notFound("Package not found");
        case "NAME_COLLISION":
          throw new ApiError({
            status: 400,
            code: "name_collision",
            title: "Name Collision",
            detail: "A package with this name already exists in your organization",
          });
        case "UNKNOWN_TYPE":
          throw invalidRequest(`Unsupported package type: ${result.type}`);
        case "NO_PUBLISHED_VERSION":
          throw invalidRequest("Source package has no published version");
      }
    }

    // The fork is homed in the current space, so its placement is this space's
    // by construction and the activation is an upsert that cannot conflict.
    // WARN, not debug: a fork the caller cannot find afterwards is a bug report.
    const spaceId = c.get("spaceId");
    if (spaceId) {
      await activatePackage({ orgId, spaceId }, result.packageId).catch((e: unknown) =>
        logger.warn("auto-activation skipped", {
          packageId: result.packageId,
          spaceId,
          err: getErrorMessage(e),
        }),
      );
    }

    await recordAuditFromContext(c, {
      action: "package.forked",
      resourceType: "package",
      resourceId: result.packageId,
      after: { type: result.type, forkedFrom: packageId },
    });

    // Return the forked package resource bare — same DTO/serializer as the new
    // package's GET detail, selected by its type (issue #657). The fork
    // provenance is resource state: `forked_from` is part of the detail DTO.
    const forkedRcfg = ROUTE_CONFIGS[result.type as PackageType];
    const detail = forkedRcfg
      ? await loadPackageDetailDto(c, forkedRcfg, result.packageId, orgId)
      : null;
    if (!detail) {
      logger.error("Forked package could not be re-read", {
        packageId: result.packageId,
        type: result.type,
        orgId,
      });
      throw internalError();
    }
    return c.json(detail, 201);
  });

  // --- Sharing: a package's AUDIENCE (RBAC spec §6.10) ---
  //
  // All three routes — offer, list, revoke — are authorized by `<type>:share`
  // in the package's HOME space, the same authority helper the write routes
  // use, so they have no route-level permission guard either. `share` is in no
  // API key's allowlist, so all three are session-borne in effect without a
  // transport check of their own.
  //
  // There is no ACCEPT route: taking up an offer is ACTIVATING, and activating
  // has one door, `POST /api/spaces/{spaceId}/packages` — for a personal space
  // exactly as for a team one, with ownership standing in for the activation grant
  // there (§3.6).
  //

  router.post(`/${SCOPED_PACKAGE_ROUTE}/shares`, async (c) => {
    const packageId = getItemId(c);
    const orgId = c.get("orgId");
    const accessible = await packageAccessSpaces(c);
    // Authority first, before the body is read: a caller who may not share this
    // package learns nothing about the body's shape (or the package's existence).
    const pkg = await assertPackageShareAccess(c, packageId);
    const { target } = await readJsonBody(c, shareTargetSchema);

    // Outside its home a package runs the LATEST PUBLISHED version, always, so
    // an offer of a package with nothing published is an offer of nothing: the
    // recipient activates it and every launch answers `404 no_published_version`.
    // Refusing HERE puts the refusal on the only principal who can clear it —
    // the author, in the act they are performing. Every target, person or space,
    // receives the package under the same rule, and this runs BEFORE the target
    // is resolved, so THIS refusal provisions no personal space.
    //
    // It is the only one of the three refusals that can promise that: the other
    // two are re-asked inside `sharePackage`, against the home it has LOCKED,
    // which is necessarily after `ensurePersonalSpaceFor` has run. A `user`
    // target that loses a race against `PUT …/home` therefore leaves the
    // recipient's personal space created and no offer in it — inert, since that
    // space is provisioned on their first space-scoped request anyway.
    if ((await getLatestVersionId(packageId)) === null) {
      throw conflict(
        "package_has_no_version",
        `Package '${packageId}' has no published version to offer — publish one first, since a package runs its latest published version outside the space that owns it.`,
      );
    }

    let spaceId: string;
    let recipientUserId: string | null = null;
    if (target.kind === "user") {
      // Naming a person means reading the org directory — the same permission
      // the member picker needs. A `guest` does not hold it, which is why a
      // guest shares to a space they reach and not to a colleague.
      await makePermissionGuard("members:read")(c, async () => {});
      const membership = await getOrgMember(orgId, target.user_id);
      if (!membership) throw notFound(`User '${target.user_id}' not found in this organization`);
      const space = await ensurePersonalSpaceFor(orgId, target.user_id);
      spaceId = space.id;
      recipientUserId = target.user_id;
    } else {
      // A space the caller cannot reach must not be confirmed to exist. Since
      // `packageAccessSpaces` never loads somebody else's personal space, this
      // is also what makes such a space untargetable by a guessed id.
      const destination = accessible.find((space) => space.id === target.space_id);
      if (!destination) throw notFound(`Space '${target.space_id}' not found`);
      spaceId = destination.id;
    }

    // BOTH the authority and `share_target_is_home` are decided by
    // `sharePackage`, under the lock that holds the home still for the length of
    // the insert. `assertPackageShareAccess` above judged the home as it stood
    // when this request arrived; a `PUT …/{scope}/{name}/home` committing in
    // between moves the package to a home this caller may govern not at all, and
    // the offer would land carrying an authority nobody holds. The predicate is
    // the SAME rule that guard enforces, re-asked against the locked row.
    const sharePermission = packagePermission(pkg.type, "share");
    const { created } = await sharePackage({
      packageId,
      spaceId,
      orgId,
      sharedBy: c.get("user").id,
      authorizeHome: (homeSpaceId) =>
        holdsHomeAuthority({ homeSpaceId }, accessible, sharePermission),
    });
    if (created) {
      await recordAuditFromContext(c, {
        action: "package.shared",
        resourceType: "package",
        resourceId: packageId,
        // The SUBJECT as the sharer named it. A `user` target records the
        // person, never the personal space it resolved to: that id is withheld
        // from the sharer on the wire (plan decision 5b), so writing it into
        // the trail would publish through the audit log what §3.6 withholds
        // everywhere else — and it names the wrong thing besides, since the
        // space is an implementation of "Bob" and not the audited act.
        after: recipientUserId
          ? { recipientUserId, targetKind: "user" }
          : { spaceId, targetKind: "space" },
      });
      if (recipientUserId) {
        // Best-effort: the share is committed, and a notification row that
        // will not write must not report it as failed.
        try {
          await createPackageShareNotification({
            orgId,
            spaceId,
            recipientUserId,
            packageId,
            packageType: pkg.type,
            sharedByName: c.get("user").name,
          });
        } catch (err) {
          logger.warn("package share notification failed", {
            packageId,
            spaceId,
            err: String(err),
          });
        }
      }
    }

    // 200 either way — sharing the same pair twice is the same state, not a
    // conflict. Rendered through the SAME projection as the listing, so a
    // personal-space target comes back as its owner here too.
    const [view] = await listPackageShares(packageId, orgId, spaceId);
    if (!view) {
      logger.error("Share could not be re-read", { packageId, spaceId, orgId });
      throw internalError();
    }
    return c.json({ object: "package_share", ...view });
  });

  router.get(`/${SCOPED_PACKAGE_ROUTE}/shares`, async (c) => {
    const packageId = getItemId(c);
    const orgId = c.get("orgId");
    await assertPackageShareAccess(c, packageId);
    const shares = await listPackageShares(packageId, orgId);
    return c.json(listResponse(shares.map((share) => ({ object: "package_share", ...share }))));
  });

  // The path segment is the target as the LISTING published it: a space id for
  // a space share, a member's user id for a share made to a person. There is
  // deliberately no third spelling — the id of somebody else's personal space
  // is never on the wire (plan decision 5b), so it cannot be the handle here.
  router.delete(`/${SCOPED_PACKAGE_ROUTE}/shares/:target`, async (c) => {
    const packageId = getItemId(c);
    const target = c.req.param("target")!;
    const orgId = c.get("orgId");
    const revokeSpaces = await packageAccessSpaces(c);
    const revokePkg = await assertPackageShareAccess(c, packageId);

    let spaceId: string;
    let recipientUserId: string | null = null;
    // The `spc_` prefix DISCRIMINATES; the full shape is then asserted. Testing
    // the whole shape as the discriminator instead sends a malformed space id
    // down the user-id branch, where it reports "not a member of this
    // organization" — a wrong reason for a malformed id, and the 400 this
    // asserts is the right one. A user id never starts with `spc_`
    // (Better Auth mints unprefixed ids), so the prefix is unambiguous.
    if (target.startsWith("spc_")) {
      assertSpaceId(target, "target");
      spaceId = target;
    } else {
      const membership = await getOrgMember(orgId, target);
      if (!membership) throw notFound(`User '${target}' not found in this organization`);
      // READ-ONLY, unlike the offer route: a revoke must not be the act that
      // brings the recipient's personal space into existence. No space means no
      // share to withdraw, which is the same 404 the missing row answers.
      const space = await findPersonalSpace(orgId, target);
      if (!space) throw notFound(`Package '${packageId}' is not shared with '${target}'`);
      spaceId = space.id;
      recipientUserId = target;
    }

    // Withdrawing the offer withdraws the placement it backs, in one
    // transaction (plan decision 3) — otherwise the package keeps running in a
    // space that is no longer allowed to see it.
    const revoked = await revokePackageShare({
      packageId,
      spaceId,
      orgId,
      authorizeHome: (homeSpaceId) =>
        holdsHomeAuthority(
          { homeSpaceId },
          revokeSpaces,
          packagePermission(revokePkg.type, "share"),
        ),
    });
    if (!revoked) throw notFound(`Package '${packageId}' is not shared with '${target}'`);
    await recordAuditFromContext(c, {
      action: "package.unshared",
      resourceType: "package",
      resourceId: packageId,
      // The subject as the caller named it — a person for a `user` target, and
      // never the personal space it resolved to, for the reason `package.shared`
      // states. `placementRemoved` is the other half of what this act did: the
      // offer went, and the placement row it backed went with it. CamelCase
      // throughout, carve-out 4m (`docs/CASING_CONVENTIONS.md`).
      after: recipientUserId
        ? { recipientUserId, targetKind: "user", placementRemoved: revoked.placementRemoved }
        : { spaceId, targetKind: "space", placementRemoved: revoked.placementRemoved },
    });
    return c.body(null, 204);
  });

  // --- Package import/download/publish routes ---

  // --- Shared import logic (used by /import and /import-github) ---

  /** A parsed package plus the exact bytes that must be published for it. */
  interface ParsedImport {
    parsed: ReturnType<typeof parsePackageZip>;
    /**
     * Bytes to store as the version's content — NOT necessarily the upload.
     * INVARIANT: this buffer and `parsed.files` declare the same
     * `manifest.json`. Readers of a published artifact take the manifest from
     * the archive (`extractRootFromAfps`), so a disagreement publishes a
     * version that cannot be assembled.
     */
    artifact: Buffer;
  }

  /**
   * Shared ZIP parse for `POST /import` (operator uploads a file) and
   * `POST /import-github` (fetch a repo directory).
   *
   * Returns the artifact with the parse because only this function knows
   * whether they are the same bytes: an ordinary AFPS parse publishes the
   * upload verbatim (re-zipping would drop whatever the parser doesn't model —
   * a detached signature above all — and invalidate any signature over the
   * original bytes), while the skill-only fallback must rebuild the archive
   * because it synthesizes the `manifest.json` the upload lacks.
   *
   * WRITE direction — retired/unknown `runtime_tools` ids REJECT, passed
   * explicitly so the choice reads as deliberate at the call site. Both routes
   * are author input, not content the platform already holds: `/import-github`
   * fetches hand-written source files from a repository, and the two routes
   * share this helper.
   *
   * The policy is binary — it cannot tell a retired id from a typo — so `drop`
   * here would silently swallow `"lgo"` on the primary hand-authoring route and
   * ship an agent missing a tool with no signal. `POST /import-bundle` is the
   * sanctioned path for re-ingesting platform-produced artifacts, and it DOES
   * drop; a single rejected upload is locally repairable, since the error names
   * the offending field and value.
   */
  async function parseZipWithSkillFallback(upload: Buffer, orgSlug: string): Promise<ParsedImport> {
    const zipBytes = new Uint8Array(upload);
    try {
      const parsed = parsePackageZip(zipBytes, { retiredRuntimeTools: "reject" });
      // `parsePackageZip` applies the lenient loader rule (it also reads
      // already-published artifacts); an import is author input.
      assertArchiveContentConforms(parsed.type, parsed.files, "file");
      return { parsed, artifact: upload };
    } catch (err) {
      if (err instanceof PackageZipError && err.code === "MISSING_MANIFEST") {
        const result = await tryParseSkillOnlyZip(zipBytes, orgSlug);
        if (result.ok) {
          // `result.parsed.files` is the upload's entries (wrapper prefix
          // stripped) plus the synthesized `manifest.json`. `zipArtifact` is
          // deterministic, so identical content still yields identical bytes.
          return {
            parsed: result.parsed,
            artifact: Buffer.from(zipArtifact(result.parsed.files)),
          };
        }
        if (result.reason === "unchanged") {
          throw conflict("skill_unchanged", "This skill already exists with the same content");
        }
        throw new ApiError({
          status: 400,
          code: err.code.toLowerCase(),
          title: "Package Error",
          detail: err.message,
        });
      }
      if (err instanceof PackageZipError) {
        throw new ApiError({
          status: 400,
          code: err.code.toLowerCase(),
          title: "Package Error",
          detail: err.message,
        });
      }
      throw err;
    }
  }

  /**
   * Persist a parsed import. `artifact` is the {@link ParsedImport} buffer, not
   * the raw upload: it is both what gets stored and what every integrity
   * comparison below is made against, so the two cannot disagree about which
   * bytes this version is.
   */
  async function handleImport(
    c: Context<AppEnv>,
    parsed: ReturnType<typeof parsePackageZip>,
    artifact: Buffer,
    force: boolean,
    source: "zip" | "github",
  ) {
    const user = c.get("user");
    const orgId = c.get("orgId");
    const { manifest, content, files, type: packageType, packageId } = parsed;
    await makePermissionGuard(packagePermission(packageType, "write"))(c, async () => {});

    // System packages are immutable
    if (isSystemPackage(packageId)) {
      throw new ApiError({
        status: 400,
        code: "name_collision",
        title: "Name Collision",
        detail: `'${packageId}' is a system package and cannot be overwritten`,
      });
    }

    // Phase 1 — for agent imports, cross-check integrations_configuration
    // selections against the referenced integration catalogs. `parsePackageZip`
    // already ran `validateManifest`; this is the niveau 2 follow-up.
    //
    // An import is a FINAL artifact, not an editing step — `postInstallPackage`
    // below cuts a version from it — so the declared-but-empty gate applies
    // here too.

    // Check for existing user package
    const existing = await getPackageById(packageId);

    if (existing?.orgId === orgId) {
      await assertPackageMutationAccess(c, packageId, "write");
      await assertExistingPackageActivationAccess(c, packageId, existing.type);
    }
    await assertPackageDependenciesAccessible(
      c,
      asRecord(manifest),
      asRecord(existing?.draftManifest),
    );
    await assertAgentIntegrationScopesValid(manifest as Record<string, unknown>, orgId, true);
    if (existing) {
      if (existing.orgId !== orgId) {
        throw new ApiError({
          status: 400,
          code: "name_collision",
          title: "Name Collision",
          detail: `A package with identifier '${packageId}' already exists`,
        });
      }
      if (existing.type !== packageType) {
        throw new ApiError({
          status: 400,
          code: "type_mismatch",
          title: "Type Mismatch",
          detail: `Package '${packageId}' exists as type '${existing.type}', cannot import as '${packageType}'`,
        });
      }
      // Draft overwrite protection
      if (!force) {
        const [vCount, latestDate] = await Promise.all([
          getVersionCount(packageId),
          getLatestVersionCreatedAt(packageId),
        ]);
        if (
          computeHasUnpublishedChanges(
            existing.source,
            vCount,
            existing.updatedAt ?? null,
            latestDate,
          )
        ) {
          throw conflict(
            "draft_overwrite",
            "This package has unpublished changes that will be overwritten by the import.",
          );
        }
      }

      // Integrity mismatch detection — same version, different content
      const importedVersion = (manifest as Record<string, unknown>).version as string | undefined;
      if (!force && importedVersion) {
        const existingVer = await getVersionForDownload(packageId, importedVersion);
        if (existingVer) {
          const importedIntegrity = computeIntegrity(new Uint8Array(artifact));
          if (existingVer.integrity !== importedIntegrity) {
            throw conflict(
              "integrity_mismatch",
              "This version already exists with different content. Use the force option to replace.",
            );
          }
        }
      }
    }

    // Persist the imported draft and publish its version.
    try {
      await postInstallPackage({
        create: !existing,
        packageType,
        packageId,
        orgId,
        userId: user.id,
        content,
        files,
        zipBuffer: artifact,
        homeSpaceId: c.get("spaceId"),
        draftManifest: manifest as Record<string, unknown>,
        lockVersion: force ? undefined : existing?.lockVersion,
      });
    } catch (err) {
      if (err instanceof PackageAlreadyExistsError) throw conflict("name_collision", err.message);
      if (err instanceof ApiError) throw err;
      const message = getErrorMessage(err);
      logger.error("Post-install failed", { packageId, packageType, error: message });
      throw new ApiError({
        status: 400,
        code: "post_install_failed",
        title: "Post-Install Failed",
        detail: message,
      });
    }

    // Same as the create route: the import homes the package here, so the
    // placement rule is satisfied and the upsert cannot conflict. WARN so a
    // silent non-activation is still visible.
    const spaceId = c.get("spaceId");
    if (spaceId) {
      await activatePackage({ orgId, spaceId }, packageId).catch((e: unknown) =>
        logger.warn("auto-activation skipped", { packageId, spaceId, err: getErrorMessage(e) }),
      );
    }

    // Force import: replace existing version content if integrity differs
    const importedVersionForReplace = (manifest as Record<string, unknown>).version as
      string | undefined;
    if (existing && force && importedVersionForReplace) {
      const existingVer = await getVersionForDownload(packageId, importedVersionForReplace);
      if (existingVer) {
        const importedIntegrity = computeIntegrity(new Uint8Array(artifact));
        if (existingVer.integrity !== importedIntegrity) {
          await replaceVersionContent({
            packageId,
            version: importedVersionForReplace,
            zipBuffer: artifact,
            manifest: manifest as Record<string, unknown>,
          });
        }
      }
    }

    logger.info("Package imported", { packageId, type: packageType, orgId });
    const importedVersion = (manifest as Record<string, unknown>).version as string | undefined;
    await recordAuditFromContext(c, {
      action: existing ? "package.updated" : "package.created",
      resourceType: "package",
      resourceId: packageId,
      after: {
        type: packageType,
        version: importedVersion ?? null,
        via: `import:${source}`,
        force,
      },
    });
    // Surface engine-subset limitations for integration manifests as
    // non-blocking warnings (AFPS §7.7). Publishers learn
    // about unsupported `connect.login` selectors / criteria at import
    // time rather than chasing the runtime LoginError later. Also lift the
    // validator's `_meta` Appendix B regex soft-fail warnings to the same
    // channel so publishers see them on import. Same channel again for an
    // agent values narrowed by deployment policy — the run applies the
    // effective values regardless, and import is the first author-visible seam.
    // No retired-dependency-key warning here, unlike the bundle path: this
    // route parses through `parseZipWithSkillFallback`, which rejects them
    // outright, so such a manifest is a 400 long before this line.
    const importWarnings = [
      ...collectConnectLoginWarnings(manifest),
      ...collectMetaWarnings(manifest),
      ...collectAgentImportWarnings(manifest),
    ];
    return c.json(
      {
        packageId,
        type: packageType,
        version: importedVersion,
        ...(importWarnings.length > 0 ? { warnings: importWarnings } : {}),
      },
      201,
    );
  }

  // POST /api/packages/import-bundle — import a multi-package .afps-bundle
  // (or a raw .afps, promoted to a bundle-of-one via the catalog).
  router.post("/import-bundle", rateLimit(10), requireAnyPackageWrite, async (c) => {
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      throw invalidRequest("Request must be multipart/form-data with a file field", "file");
    }
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      throw invalidRequest("File is required", "file");
    }
    const ext = file.name.toLowerCase();
    if (!ext.endsWith(".afps-bundle") && !ext.endsWith(".afps") && !ext.endsWith(".zip")) {
      throw invalidRequest("Only .afps-bundle, .afps, and .zip files are accepted", "file");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const orgId = c.get("orgId");
    const spaceId = c.get("spaceId");
    const userId = c.get("user").id;

    let result: Awaited<ReturnType<typeof handleImportBundle>>;
    try {
      result = await handleImportBundle(
        bytes,
        { orgId, spaceId },
        userId,
        (bundle) => authorizeBundlePackages(c, bundle),
        // A root that already lives in another space is placed here by the same
        // rule as any activation: the offer, when this caller may make one.
        (packageId) => holdsPackageShareAuthority(c, packageId),
      );
    } catch (err) {
      // Typed errors (ApiError — conflicts, invalid request) propagate as-is.
      // A raw post-install/version-creation failure becomes the same clean 4xx
      // as the single-import route rather than a 500.
      if (err instanceof ApiError) throw err;
      const message = getErrorMessage(err);
      logger.error("Bundle import post-install failed", { orgId, error: message });
      throw new ApiError({
        status: 400,
        code: "post_install_failed",
        title: "Post-Install Failed",
        detail: message,
      });
    }
    // One audit event per package version actually written — "reused"
    // entries changed no state. `recordAudit*` never throws.
    for (const audit of bundleImportAuditRecords(result, { via: "import:bundle" })) {
      await recordAuditFromContext(c, {
        action: "package.version_created",
        resourceType: "package",
        resourceId: audit.resourceId,
        after: audit.after,
      });
    }
    return c.json(result, 201);
  });

  // POST /api/packages/import — import any package type from ZIP
  router.post("/import", rateLimit(10), requireAnyPackageWrite, async (c) => {
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      throw invalidRequest("Request must be multipart/form-data with a file field", "file");
    }
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      throw invalidRequest("No file provided");
    }
    if (!file.name.endsWith(".afps") && !file.name.endsWith(".zip")) {
      throw invalidRequest("Only .afps and .zip files are accepted");
    }

    const upload = Buffer.from(await file.arrayBuffer());

    const { parsed, artifact } = await parseZipWithSkillFallback(upload, c.get("orgSlug"));

    return handleImport(c, parsed, artifact, c.req.query("force") === "true", "zip");
  });

  // POST /api/packages/import-github — import a package from a GitHub URL
  router.post("/import-github", rateLimit(10), requireAnyPackageWrite, async (c) => {
    const data = await readJsonBody(c, githubImportSchema, { param: "url" });

    let zipBytes: Uint8Array;
    try {
      zipBytes = await fetchGithubDirectory(data.url);
    } catch (err) {
      if (err instanceof GithubImportError) {
        throw new ApiError({
          status: 400,
          code: err.code,
          title: "Import Failed",
          detail: err.message,
        });
      }
      throw err;
    }

    const { parsed, artifact } = await parseZipWithSkillFallback(
      Buffer.from(zipBytes),
      c.get("orgSlug"),
    );

    return handleImport(c, parsed, artifact, false, "github");
  });

  // --- File explorer (read-only) ---
  // (see the ordering note at the head of this family)
  // Registered BEFORE `/:version/download` so the literal `files` segment can
  // never be captured as a version spec.

  // GET /api/packages/:scope/:name/files — flat index of the artifact's files
  router.get(`/${SCOPED_PACKAGE_ROUTE}/files`, rateLimit(50), async (c) => {
    const { version: requested } = parseFileQuery(c, fileIndexQuerySchema);
    // Visibility + `<type>:read` are both settled inside this call, BEFORE any
    // validator is resolved — nothing below can answer an unauthorized caller.
    const pkg = await loadFileExplorerPackage(c);
    // WHICH definition, and whether an explicit `draft` is this caller's to
    // ask for. Above the ETag short-circuit for the same reason the permission
    // check is: a 304 answered before the refusal would confirm the draft's
    // content to someone the refusal exists to keep out.
    const version = await resolveFileExplorerVersion(c, pkg, requested);
    const inm = c.req.header("if-none-match");

    // Resolve the validator FIRST. A published version's snapshot id comes
    // straight from the `integrity` column, so a hit here answers the request
    // for one query — no storage GET, no unzip, no SRI pass.
    const validator = await resolvePackageFileValidator(pkg, version);
    if (validator.snapshotId !== null) {
      const etag = indexEtag(validator.snapshotId);
      if (ifNoneMatchSatisfied(inm, etag)) {
        return new Response(null, {
          status: 304,
          headers: fileCacheHeaders(etag, validator.yanked),
        });
      }
    }

    const snapshot = await readPackageSnapshot(pkg, validator);
    const etag = indexEtag(snapshot.snapshotId);
    const headers = fileCacheHeaders(etag, validator.yanked);
    if (ifNoneMatchSatisfied(inm, etag)) {
      return new Response(null, { status: 304, headers });
    }
    return c.json({ entries: buildFileIndex(snapshot) }, 200, headers);
  });

  // GET /api/packages/:scope/:name/files/content — raw bytes of ONE file.
  // Serves preview AND download: a small text file that fell past the index's
  // inline budget stays previewable through here.
  router.get(`/${SCOPED_PACKAGE_ROUTE}/files/content`, rateLimit(50), async (c) => {
    const { version: requested, path } = parseFileQuery(c, fileContentQuerySchema);
    // Must stay ABOVE the validator: the 304 short-circuit below answers
    // without reading the artifact, so a permission check placed after it
    // would turn `If-None-Match` into a file-existence oracle. The definition
    // selector rides in the same window, for the same reason.
    const pkg = await loadFileExplorerPackage(c);
    const version = await resolveFileExplorerVersion(c, pkg, requested);
    const inm = c.req.header("if-none-match");

    // Same short-circuit as the index, but the tag folds in the PATH: a
    // matching tag proves the client previously got a 200 for THIS file, which
    // is what makes answering before the read sound. `*` is refused here — it
    // says nothing about which path, so it cannot establish that the file
    // exists.
    const validator = await resolvePackageFileValidator(pkg, version);
    if (validator.snapshotId !== null) {
      const etag = fileEtag(validator.snapshotId, path);
      if (ifNoneMatchSatisfied(inm, etag, { allowWildcard: false })) {
        return new Response(null, {
          status: 304,
          headers: fileCacheHeaders(etag, validator.yanked),
        });
      }
    }

    const snapshot = await readPackageSnapshot(pkg, validator);

    // Plain own-key lookup on the already-sanitized map — no filesystem, no
    // `..` resolution. `Object.hasOwn` keeps a `__proto__`/`toString` probe
    // from resolving to something off the prototype chain.
    if (!Object.hasOwn(snapshot.files, path)) {
      throw notFound("File not found");
    }
    const bytes = snapshot.files[path]!;

    const etag = fileEtag(snapshot.snapshotId, path);
    const headers = fileCacheHeaders(etag, validator.yanked);
    // Existence is established, so `*` is now a legitimate match.
    if (ifNoneMatchSatisfied(inm, etag)) {
      return new Response(null, { status: 304, headers });
    }

    // Always octet-stream + nosniff + attachment: package bytes are
    // author-controlled, so no response from here may be something a browser
    // decides to execute or render in this origin. `Referrer-Policy` +
    // `Cross-Origin-Resource-Policy` mirror what `routes/files.ts` applies
    // to comparable authenticated tenant bytes.
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Disposition": attachmentDisposition(path.slice(path.lastIndexOf("/") + 1)),
        "Content-Length": String(bytes.byteLength),
      },
    });
  });

  // GET /api/packages/:scope/:name/:version/download — download a versioned package ZIP
  router.get(`/${SCOPED_PACKAGE_ROUTE}/:version/download`, rateLimit(50), async (c) => {
    const packageId = getItemId(c);
    const orgId = c.get("orgId");
    const spaceId = c.get("spaceId");
    const versionSpec = c.req.param("version")!;

    // Visibility first — "system package, offered to THIS space, or homed
    // here", the same gate the rest of the package read surface applies.
    // Without it this route served the artifact bytes of packages that are
    // merely owned by the org and placed nowhere the caller can reach.
    if (!(await isPackageReadableInSpace(spaceId, packageId))) {
      throw notFound("Package not found");
    }

    // Verify org ownership (or system package). Ephemeral shadows are hidden.
    const [pkg] = await db
      .select({
        id: packages.id,
        type: packages.type,
        source: packages.source,
        homeSpaceId: packages.homeSpaceId,
      })
      .from(packages)
      .where(and(eq(packages.id, packageId), orgOrSystemFilter(orgId), notEphemeralFilter()))
      .limit(1);
    if (!pkg) {
      throw notFound("Package not found");
    }

    // The ZIP carries the manifest and every authored file, so it is at least
    // as sensitive as the detail route — it needs the same `<type>:read`.
    await requirePackageReadPermission(c, pkg.type);

    // …and, when the organization restricts copying (plan decision 12), the
    // source's `<type>:share`. This is the route the archive leaves through,
    // so reading it and taking it away are two different permissions there.
    // Skills and system packages are exempt inside the helper: the CLI's
    // skills sync is this route's other consumer and its copies are local by
    // design, and a shipped system package has no owning space to protect.
    await assertPackageCopyAllowed(
      c,
      { ...pkg, type: pkg.type as PackageType },
      { orgId, accessible: await packageAccessSpaces(c) },
    );

    const ver = await getVersionForDownload(packageId, versionSpec);
    if (!ver) {
      throw notFound("Version not found");
    }

    let data: Buffer | null;
    try {
      data = await downloadVersionZip(packageId, ver.version, ver.integrity);
    } catch {
      throw internalError();
    }
    if (!data) {
      throw notFound("Artifact not found in storage");
    }

    const downloadHeaders = buildDownloadHeaders({
      integrity: ver.integrity,
      yanked: ver.yanked,
      scope: c.req.param("scope")!,
      name: c.req.param("name")!,
      version: ver.version,
    });
    return new Response(new Uint8Array(data), { status: 200, headers: downloadHeaders });
  });

  return router;
}
