// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
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
import { installPackage, hasPackageAccess } from "../services/application-packages.ts";
import { resolveIntegrationActivations } from "../services/integration-connections.ts";
import { parseManifestFromFiles } from "../lib/manifest-parser.ts";
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
  createOrgItem,
  updateOrgItem,
  deleteOrgItem,
  PackageAlreadyExistsError,
} from "../services/package-items/crud.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { uploadPackageFiles, downloadPackageFiles } from "../services/package-items/storage.ts";
import { CONFIG_BY_TYPE, type PackageTypeConfig } from "../services/package-items/config.ts";
import { validateManifest, type PackageType } from "@appstrate/core/validation";
import { SLUG_REGEX, attachmentDisposition } from "@appstrate/core/naming";
import { ifNoneMatchSatisfied } from "../lib/if-none-match.ts";
import { unzipPackageArchive } from "../services/package-archive.ts";
import { isValidVersion } from "@appstrate/core/semver";
import {
  getVersionDetail,
  getVersionCount,
  getMatchingDistTags,
  listPackageVersions,
  getVersionInfo,
  getLatestVersionCreatedAt,
  computeHasUnpublishedChanges,
  createVersionFromDraft,
  createVersionAndUpload,
  deletePackageVersion,
} from "../services/package-versions.ts";
import { agentDetailHandler, buildAgentDetailDto } from "./agent-detail-handler.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { requirePackageInOrg } from "../middleware/guards.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getRunningRunsForPackage } from "../services/state/runs.ts";
import { logger } from "../lib/logger.ts";
import { asRecord } from "@appstrate/core/safe-json";
import { forkPackage } from "../services/package-fork.ts";
import { tryParseSkillOnlyZip } from "../services/skill-zip.ts";
import { fetchGithubDirectory, GithubImportError } from "../services/github-import.ts";
import { validateAgentIntegrationSelections } from "../services/integration-scope-validation.ts";
import { SCOPED_PACKAGE_ROUTE } from "./scoped-package-route.ts";
import {
  resolvePackageFileValidator,
  readPackageSnapshot,
  resolveDraftContent,
  buildFileIndex,
  indexEtag,
  fileEtag,
  type PackageFileSource,
} from "../services/package-files.ts";
import { PACKAGE_CONTENT_ENTRY } from "@appstrate/core/package-files";
import {
  collectConnectLoginWarnings,
  collectMetaWarnings,
} from "../services/integration-install-warnings.ts";
import { collectAgentInstallWarnings } from "../services/agent-install-warnings.ts";
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
  orgId: string,
  direction: "author" | "stored",
  opts: { requireCallableTools?: boolean } = {},
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

  await assertAgentIntegrationScopesValid(validated, orgId, opts.requireCallableTools);
  return validated;
}

// ═══════════════════════════════════════════════
// Shared helpers for package CRUD routes
// ═══════════════════════════════════════════════

export const githubImportSchema = z.object({
  url: z.url("Missing 'url' field"),
});

export const forkSchema = z.object({
  name: z.string().regex(SLUG_REGEX, "Name must match slug format").optional(),
});

/**
 * JSON-body create/update payloads for the manifest-driven package types
 * (agent). `manifest` is validated structurally here (must be an object) and
 * then deeply by `validateManifest`. Bodies with a wrong-typed `content`
 * (e.g. `content: 1`) are rejected as a 400 instead of blowing up downstream
 * as a 500.
 *
 * Both objects are non-strict, so an unknown key (a client still sending the
 * retired `source_code`, say) is silently stripped rather than rejected.
 */
export const packageJsonCreateSchema = z.object({
  manifest: z.record(z.string(), z.unknown()),
  content: z.string().optional(),
});

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
export const packageJsonCreateWithContentSchema = z.object({
  manifest: z.record(z.string(), z.unknown()),
  content: z.string().refine((v) => v.trim().length > 0, "Content cannot be empty"),
});

export const packageJsonUpdateSchema = z.object({
  manifest: z.record(z.string(), z.unknown()).optional(),
  content: z.string().optional(),
  /**
   * Optimistic-lock token. Mandatory and integral — the value is a row version,
   * never a fraction. This used to be `z.number().optional()` with a hand-rolled
   * `null / typeof !== "number"` check in the handler restating both rules; the
   * schema now carries them, so the spec's `required: ["lock_version"]` and
   * `type: "integer"` have exactly one runtime counterpart.
   */
  lock_version: z.number().int(),
});

/**
 * Body of `POST /api/packages/{type}/{scope}/{name}/versions`. The body itself
 * is optional (`requestBody.required: false`) — the SPA omits it entirely when
 * no override is chosen — so `version` is the only member and it is optional.
 */
export const createVersionBodySchema = z.object({ version: z.string().min(1).optional() });

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
  content: string;
  normalizedFiles?: Record<string, Uint8Array>;
  /** Full parsed manifest.json from the ZIP — stored as-is (like the registry). */
  manifest: Record<string, unknown>;
  /** Original archive bytes, retained for the canonical AFPS preflight. */
  archive: Uint8Array;
}

/**
 * Parse a package item upload from a Hono context (multipart ZIP or JSON body).
 * Throws ApiError on validation errors.
 */
async function parsePackageUpload(
  c: Context<AppEnv>,
  opts: {
    /** Required file inside the ZIP (e.g. "SKILL.md") — null to skip check */
    requiredFile: string | null;
    /** Find the content file by extension (e.g. ".ts") — null to use requiredFile */
    contentFileExt: string | null;
  },
): Promise<ParsedUpload> {
  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      throw invalidRequest("File is required", "file");
    }

    if (!file.name.endsWith(".afps") && !file.name.endsWith(".zip")) {
      throw invalidRequest("Only .afps and .zip files are accepted", "file");
    }

    const id = file.name.replace(/\.(afps|zip)$/i, "");
    if (!SLUG_REGEX.test(id)) {
      throw invalidRequest("Invalid file name (kebab-case slug required)", "file");
    }

    const archive = new Uint8Array(await file.arrayBuffer());
    let normalizedFiles: Record<string, Uint8Array>;
    try {
      normalizedFiles = unzipPackageArchive(archive);
    } catch {
      throw invalidRequest("Invalid ZIP file", "file");
    }

    // Find the content file
    let contentFile: string | undefined;
    if (opts.requiredFile) {
      if (!normalizedFiles[opts.requiredFile]) {
        throw invalidRequest(`ZIP must contain ${opts.requiredFile}`, "file");
      }
      contentFile = opts.requiredFile;
    }
    if (opts.contentFileExt) {
      contentFile = Object.keys(normalizedFiles).find((p) => p.endsWith(opts.contentFileExt!));
      if (!contentFile) {
        throw invalidRequest(`ZIP must contain a ${opts.contentFileExt} file`, "file");
      }
    }

    // No content file is looked up when both `parseOpts` are null (mcp-server,
    // whose payload is the manifest) — such a package has no primary content.
    const contentBytes = contentFile ? normalizedFiles[contentFile] : undefined;
    const content = contentBytes ? new TextDecoder().decode(contentBytes) : "";

    // manifest.json is mandatory: it is the only part of the archive the AFPS
    // schema validates, and tolerating its absence let an unvalidated stub
    // manifest reach the immutable `package_versions` row (issue #987).
    if (!normalizedFiles["manifest.json"]) {
      throw invalidRequest("ZIP must contain manifest.json", "file");
    }
    let manifest: Record<string, unknown>;
    try {
      manifest = parseManifestFromFiles(normalizedFiles);
    } catch (err) {
      throw invalidRequest(getErrorMessage(err), "file");
    }

    // Display fields default to the manifest (not stored back into it)
    let name = typeof manifest.display_name === "string" ? manifest.display_name : undefined;
    let description = typeof manifest.description === "string" ? manifest.description : undefined;

    // Allow overriding name/description from form fields
    const formName = formData.get("name") as string | null;
    const formDesc = formData.get("description") as string | null;
    if (formName) name = formName;
    if (formDesc) description = formDesc;

    return { id, name, description, content, normalizedFiles, manifest, archive };
  }

  // Executable MCP packages are self-contained archives. A JSON manifest can
  // describe an entry point but cannot carry it; synthesising a fake `content`
  // file here created packages that validated, versioned and auto-installed,
  // then failed only when the sidecar tried to boot the missing entry point.
  throw new ApiError({
    status: 415,
    code: "archive_required",
    title: "Archive Required",
    detail: "MCP-server packages must be uploaded as a multipart .afps or .zip archive.",
  });
}

/** Create a version snapshot from files + manifest (non-fatal on error).
 *  All package types are zipped as-is.
 *
 *  SNAPSHOT ONLY WHAT WOULD SURVIVE A PUBLISH. Both create routes call this
 *  right after `createOrgItem`, and a version is immutable — so without the
 *  `requireCallableTools` gate here, `POST /api/packages/agents` froze exactly
 *  the artifact the publish route refuses. The create routes themselves must
 *  stay ungated (they validate `direction: "author"`, and the editor's flow
 *  legitimately passes through the empty state), which is why the gate belongs
 *  on the snapshot rather than on the request.
 *
 *  Skipping is an already-supported outcome, not a new one: the missing/invalid
 *  `version` branch below has always returned without a snapshot. The draft is
 *  created either way and the author fixes it, then publishes. */
async function createVersionSafe(params: {
  packageId: string;
  orgId: string;
  userId: string;
  manifest: Record<string, unknown>;
  normalizedFiles: Record<string, Uint8Array>;
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

    await createVersionAndUpload({
      packageId: params.packageId,
      version,
      createdBy: params.userId,
      zipBuffer,
      manifest: manifestToStore,
    });
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
  parseOpts: {
    requiredFile: string | null;
    contentFileExt: string | null;
  };
  validateContent?: (content: string) => { valid: boolean; errors: string[]; warnings: string[] };
  /**
   * Which storage file this type's editor `content` is written to — a per-type
   * editor-wiring fact.
   *
   * It answers a DIFFERENT question from `PACKAGE_CONTENT_FILE`
   * (`@appstrate/core/package-files`), which names the archive entry
   * `draft_content` mirrors. Both are right where they differ: for
   * `integration` the SPA editor deliberately sends the manifest JSON as
   * `content` (`toWireBody`, `apps/web/src/pages/package-editor.tsx`), so
   * `manifest.json` is exactly where that `content` belongs.
   *
   * Do NOT "reconcile" the two maps. Pointing `integration` at
   * `INTEGRATION.md` would write manifest JSON into the docs file, strand the
   * real `manifest.json` (nothing refreshes it afterwards), and — because
   * `createVersionFromDraft` spreads the stored files into the artifact — mint
   * immutable, integrity-pinned published ZIPs whose `INTEGRATION.md` is
   * manifest JSON. Unfixable once published.
   *
   * Their DISAGREEMENT is load-bearing, not merely tolerated: it is what tells
   * the update / restore handlers that this type's `content` is a manifest
   * copy, so they must not put it in `packages.draft_content` (that column's
   * `INTEGRATION.md` is nobody's editor field) and must rebuild the storage
   * file from the manifest instead of echoing a carried-forward `content`.
   */
  storageFileName: string;
  /** Hook called after a new package is created. */
  afterCreate?: (params: {
    packageId: string;
    orgId: string;
    manifest: Record<string, unknown>;
    applicationId?: string;
  }) => Promise<void>;
  /** Hook called after a package is updated. */
  afterUpdate?: (params: {
    packageId: string;
    orgId: string;
    manifest: Record<string, unknown>;
  }) => Promise<void>;
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

// Every AFPS package type exposes user-facing routes. `Partial` is kept so
// the `ROUTE_CONFIGS[type]?.` lookups stay null-tolerant, but all four types are
// wired. `agent`/`skill`/`integration` have JSON-body editors; only `mcp-server`
// is import-only (no editor — authored externally and lands via ZIP).
const ROUTE_CONFIGS: Partial<Record<PackageType, PackageRouteConfig>> = {
  skill: {
    cfg: CONFIG_BY_TYPE.skill,
    path: "skills",
    parseOpts: { requiredFile: "SKILL.md", contentFileExt: null },
    storageFileName: "SKILL.md",
    jsonBodyCreate: true,
    requireContent: true,
  },
  agent: {
    cfg: CONFIG_BY_TYPE.agent,
    path: "agents",
    parseOpts: { requiredFile: null, contentFileExt: null },
    storageFileName: "prompt.md",
    jsonBodyCreate: true,
    requireContent: true,
    requireMutableForVersionOps: true,
    getHandler: agentDetailHandler,
    // Mutating endpoints echo the full Agent detail (same serializer as the
    // GET). `requireAccess: false` — the caller just wrote this agent in their
    // org, so the app-install gate must not 404 a successful write.
    detailDto: (c, itemId) => buildAgentDetailDto(c, { itemId, requireAccess: false }),
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
    parseOpts: { requiredFile: null, contentFileExt: null },
    storageFileName: "manifest.json",
    jsonBodyCreate: true,
  },
  // AFPS §3.4 — standalone mcp-server packages. Import-only like
  // integrations (no editor): authored externally.
  // AFPS-native manifest carrying MCPB vocabulary fields (server / tools / user_config) verbatim — NOT a strict-MCPB manifest. See AFPS spec §3.4.
  // Listable, viewable, and importable as `.afps` like the other types.
  // Referenced by an integration's `source.kind: "local"`.
  "mcp-server": {
    cfg: CONFIG_BY_TYPE["mcp-server"],
    path: "mcp-servers",
    parseOpts: { requiredFile: null, contentFileExt: null },
    storageFileName: "manifest.json",
    jsonBodyCreate: false,
  },
};

// --- Handler factories ---

function makeListHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const applicationId = c.get("applicationId");
    // `?active=true` narrows to packages active in this app (agent-editor
    // integration picker). For most types "active" means an installed +
    // enabled `application_packages` row (generic SQL narrowing in
    // `listOrgItems`). INTEGRATIONS additionally auto-activate env-backed
    // SYSTEM integrations that have no row — so they resolve through the
    // canonical activation rule (`resolveIntegrationActivations`), the single
    // source of truth shared with the settings list + detail endpoints, rather
    // than the generic SQL filter (which would hide them).
    const wantActive = c.req.query("active") === "true";
    const isIntegration = rcfg.cfg.type === "integration";
    const items = await listOrgItems(orgId, rcfg.cfg, applicationId, {
      activeOnly: wantActive && !isIntegration,
    });
    let visible = items;
    if (wantActive && isIntegration) {
      const activations = await resolveIntegrationActivations(
        items.map((i) => i.id),
        applicationId,
      );
      visible = items.filter((i) => activations.get(i.id)?.active);
    }
    const enriched = await enrichWithCreatorNames(visible);
    return c.json(listResponse(enriched));
  };
}

function makeCreateHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const orgSlug = c.get("orgSlug");
    const user = c.get("user");

    // JSON body create path: { manifest, content?, source? }
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
      const content = body.content ?? "";

      const validatedManifest = await validateManifestForRoute(
        manifest,
        rcfg.cfg.type,
        orgId,
        "author",
      );

      if (rcfg.validateContent) {
        const validation = rcfg.validateContent(content);
        if (!validation.valid) {
          throw validationFailed(
            validation.errors.map((message) => ({
              field: "content",
              code: "invalid_content",
              title: "Invalid Content",
              message,
            })),
          );
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

      const createdItem = await createOrgItem(
        orgId,
        { id: packageId, content, createdBy: user.id },
        rcfg.cfg,
        validatedManifest as Record<string, unknown>,
      ).catch((err: unknown) => {
        // The pre-check above narrows the common case, but a concurrent create
        // can still lose the race — map the persistence-layer collision to 409
        // instead of a 500 (mirrors the ZIP/skill create path below).
        if (err instanceof PackageAlreadyExistsError) {
          throw conflict("name_collision", err.message);
        }
        throw err;
      });

      // After-create hook (optional per-type post-create side-effect)
      if (rcfg.afterCreate) {
        await rcfg.afterCreate({
          packageId,
          orgId,
          manifest: validatedManifest,
          applicationId: c.get("applicationId"),
        });
      }

      // Upload files to S3 storage
      const normalizedFiles: Record<string, Uint8Array> = {
        [rcfg.storageFileName]: new TextEncoder().encode(content),
      };
      await uploadPackageFiles(rcfg.cfg.storageFolder, orgId, packageId, normalizedFiles);

      // Create initial version (non-fatal). Snapshot the STORED draft
      // manifest (not the pre-normalization request body): `createOrgItem`
      // stamps `$schema`/`name`/… and the jsonb round-trip reorders keys, so
      // snapshotting `validatedManifest` produced a version whose bytes could
      // never match a later rebuild from the draft. That byte drift defeated
      // the publish dedup and, before #896, made every create-then-republish
      // silently overwrite the artifact while keeping the stale integrity row.
      const versionCreated = await createVersionSafe({
        packageId,
        orgId,
        userId: user.id,
        manifest: asRecord(createdItem.draftManifest),
        normalizedFiles,
      });

      // Auto-install in the current application (non-fatal)
      const applicationId = c.get("applicationId");
      if (applicationId && versionCreated) {
        await installPackage({ orgId, applicationId }, packageId).catch((e: unknown) =>
          logger.debug("auto-install skipped", { packageId, applicationId, err: String(e) }),
        );
      }

      await recordAuditFromContext(c, {
        action: "package.created",
        resourceType: "package",
        resourceId: packageId,
        after: { type: rcfg.cfg.type, version: validatedManifest.version ?? null },
      });

      // Return the created package resource bare — same DTO/serializer as the
      // GET detail (issue #657). `id` and `lock_version` (the optimistic-lock
      // token of the draft) are part of the resource; no operation envelope.
      const detail = await loadPackageDetailDto(c, rcfg, packageId, orgId);
      if (!detail) {
        logger.error("Created package could not be re-read", { packageId, orgId });
        throw internalError();
      }
      return c.json(detail, 201);
    }

    // Import-only create (mcp-server) — archive-only by construction.
    const parsed = await parsePackageUpload(c, rcfg.parseOpts);

    if (isSystemPackage(parsed.id)) {
      throw forbidden(
        `${rcfg.cfg.label.slice(0, -1)} '${parsed.id}' is a system package and cannot be modified`,
      );
    }

    await validateManifestForRoute(parsed.manifest, rcfg.cfg.type, orgId, "author");

    // Run the canonical AFPS archive parser before the first write. It shares
    // companion-file enforcement with the runtime bundle loader, so a missing
    // `server.entry_point` payload is rejected here rather than at sidecar boot.
    let canonical;
    try {
      canonical = parsePackageZip(parsed.archive);
    } catch (err) {
      if (err instanceof PackageZipError) throw invalidRequest(err.message, "file");
      throw err;
    }
    const expectedPackageId = `@${orgSlug}/${parsed.id}`;
    if (canonical.packageId !== expectedPackageId) {
      throw invalidRequest(
        `Archive manifest name '${canonical.packageId}' must match upload package id '${expectedPackageId}'.`,
        "manifest.name",
      );
    }
    parsed.manifest = canonical.manifest as Record<string, unknown>;
    parsed.content = canonical.content;
    parsed.normalizedFiles = canonical.files;

    if (rcfg.validateContent) {
      const validation = rcfg.validateContent(parsed.content);
      if (!validation.valid) {
        throw validationFailed(
          validation.errors.map((message) => ({
            field: "content",
            code: "invalid_content",
            title: "Invalid Content",
            message,
          })),
        );
      }
    }

    let item;
    try {
      item = await createOrgItem(
        orgId,
        {
          id: `@${orgSlug}/${parsed.id}`,
          name: parsed.name,
          description: parsed.description,
          content: parsed.content,
          createdBy: user.id,
        },
        rcfg.cfg,
        parsed.manifest,
      );
    } catch (err) {
      if (err instanceof PackageAlreadyExistsError) {
        throw conflict("name_collision", err.message);
      }
      throw err;
    }

    if (parsed.normalizedFiles) {
      await uploadPackageFiles(rcfg.cfg.storageFolder, orgId, item.id, parsed.normalizedFiles);
    }

    // After-create hook
    if (rcfg.afterCreate) {
      const finalManifest = asRecord(item.draftManifest);
      await rcfg.afterCreate({
        packageId: item.id,
        orgId,
        manifest: finalManifest,
        applicationId: c.get("applicationId"),
      });
    }

    // Create initial version (non-fatal)
    const finalManifest = asRecord(item.draftManifest);
    const versionCreated = await createVersionSafe({
      packageId: item.id,
      orgId,
      userId: user.id,
      manifest: finalManifest,
      normalizedFiles: parsed.normalizedFiles ?? {},
    });

    // Auto-install in the current application (non-fatal)
    const applicationId = c.get("applicationId");
    if (applicationId && versionCreated) {
      await installPackage({ orgId, applicationId }, item.id).catch((e: unknown) =>
        logger.debug("auto-install skipped", { packageId: item.id, applicationId, err: String(e) }),
      );
    }

    await recordAuditFromContext(c, {
      action: "package.created",
      resourceType: "package",
      resourceId: item.id,
      after: { type: rcfg.cfg.type, version: finalManifest.version ?? null },
    });

    // Return the created package resource bare — same serializer as the GET
    // detail (issue #657). `id` and `lock_version` are part of the resource.
    const detail = await loadPackageDetailDto(c, rcfg, item.id, orgId);
    if (!detail) {
      logger.error("Created package could not be re-read", { packageId: item.id, orgId });
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
 * Build the canonical package detail DTO for skills / integrations / mcp-servers
 * — the exact object the `GET` detail endpoint serializes (`OrgPackageItemDetail`).
 * Org-scoped (no app-install gate): the GET handler applies that gate before
 * calling this, while mutating endpoints (create / update / fork) reuse this
 * directly to echo what the caller just wrote (issue #646). Returns `null` when
 * the package is not found in the org.
 */
async function buildPackageDetailDto(
  rcfg: PackageRouteConfig,
  itemId: string,
  orgId: string,
): Promise<Record<string, unknown> | null> {
  const [item, versionCount, latestVersionDate] = await Promise.all([
    getOrgItem(orgId, itemId, rcfg.cfg),
    getVersionCount(itemId),
    getLatestVersionCreatedAt(itemId),
  ]);

  if (!item) return null;

  return {
    ...item,
    version_count: versionCount,
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
 */
function loadPackageDetailDto(
  c: Context<AppEnv>,
  rcfg: PackageRouteConfig,
  itemId: string,
  orgId: string,
): Promise<Record<string, unknown> | null> {
  return rcfg.detailDto
    ? rcfg.detailDto(c, itemId, orgId)
    : buildPackageDetailDto(rcfg, itemId, orgId);
}

function makeGetHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const applicationId = c.get("applicationId");
    const itemId = getItemId(c);

    // Enforce app-level access: all apps can only access installed packages
    if (!(await hasPackageAccess({ orgId, applicationId }, itemId))) {
      throw notFound(`${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found`);
    }

    const dto = await buildPackageDetailDto(rcfg, itemId, orgId);
    if (!dto) {
      throw notFound(`${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found`);
    }

    return c.json(dto);
  };
}

function makeUpdateHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);
    const label = rcfg.cfg.label.slice(0, -1);

    if (isSystemPackage(itemId)) {
      throw forbidden(`${label} '${itemId}' is a system package and cannot be modified`);
    }

    const existing = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!existing) {
      throw notFound(`${label} '${itemId}' not found`);
    }

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

    // Everything downstream — the persisted row, the after-update hook, the
    // id-immutability check — reads the VALIDATED manifest, never the raw one.
    // The create path already did; this one persisted the raw shape, so the
    // normalisation validation had just performed was thrown away on every
    // save. That is what made the carry-forward case above a permanent no-op
    // instead of a self-healing write, and let a non-SPA client (CLI, MCP,
    // curl) keep a retired id alive in the draft indefinitely.
    const validatedManifest = await validateManifestForRoute(
      manifest,
      rcfg.cfg.type,
      orgId,
      authoredManifest ? "author" : "stored",
    );
    const manifestText = JSON.stringify(validatedManifest, null, 2);

    // Ensure ID immutability (all types)
    const newScopedName = validatedManifest.name;
    if (newScopedName && newScopedName !== itemId) {
      throw invalidRequest("name cannot change", "name");
    }

    // Content required check
    if (rcfg.requireContent && !content.trim()) {
      throw invalidRequest("Content cannot be empty", "content");
    }

    // Content validation
    if (rcfg.validateContent && content) {
      const validation = rcfg.validateContent(content);
      if (!validation.valid) {
        throw validationFailed(
          validation.errors.map((message) => ({
            field: "content",
            code: "invalid_content",
            title: "Invalid Content",
            message,
          })),
        );
      }
    }

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

    // `content` feeds TWO sinks that are the same file for `agent`/`skill` and
    // different files for the manifest-backed types — see `storageFileName`.
    // `resolveDraftContent` guards the column; the storage write below is
    // resolved on its own terms.
    const updated = await updateOrgItem(
      orgId,
      itemId,
      {
        manifest: validatedManifest,
        content: resolveDraftContent(rcfg.cfg.type, existing.content, draftContentInput),
      },
      body.lock_version,
    );

    if (!updated) {
      throw conflict("conflict", `${label} was modified concurrently. Reload and try again.`);
    }

    // Bytes for `rcfg.storageFileName`. When that file is NOT the type's
    // content entry it is the manifest (integration, mcp-server), and it is
    // rebuilt from the VALIDATED manifest rather than echoing `content`: this
    // route accepts a manifest-only PUT, and the `existing.content`
    // carried forward above is `packages.draft_content` — which for an
    // integration is its INTEGRATION.md. Echoing it would overwrite the
    // package's `manifest.json` with its documentation.
    const storageContent =
      PACKAGE_CONTENT_ENTRY[rcfg.cfg.type]?.path === rcfg.storageFileName ? content : manifestText;

    // Update storage files (merge with existing to preserve ancillary files)
    const existingFiles = await downloadPackageFiles(rcfg.cfg.storageFolder, orgId, itemId);
    const updatedFiles: Record<string, Uint8Array> = {
      ...(existingFiles ?? {}),
      [rcfg.storageFileName]: new TextEncoder().encode(storageContent),
    };
    await uploadPackageFiles(rcfg.cfg.storageFolder, orgId, itemId, updatedFiles);

    // After-update hook (e.g. agent junction table sync)
    if (rcfg.afterUpdate) {
      await rcfg.afterUpdate({
        packageId: itemId,
        orgId,
        manifest: validatedManifest,
      });
    }

    await recordAuditFromContext(c, {
      action: "package.updated",
      resourceType: "package",
      resourceId: itemId,
      after: { type: rcfg.cfg.type },
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
 * `(orgId, applicationId)` scoping stay identical across all four.
 */
async function assertNoRunningRuns(
  c: Context<AppEnv>,
  rcfg: PackageRouteConfig,
  itemId: string,
): Promise<void> {
  if (!rcfg.requireMutableForVersionOps) return;
  const running = await getRunningRunsForPackage(
    { orgId: c.get("orgId"), applicationId: c.get("applicationId") },
    itemId,
  );
  if (running > 0) {
    const label = rcfg.cfg.label.slice(0, -1);
    throw conflict(
      "agent_in_use",
      `${running} run(s) still running for this ${label.toLowerCase()}`,
    );
  }
}

function makeDeleteHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const itemId = getItemId(c);
    const label = rcfg.cfg.label.slice(0, -1);

    if (isSystemPackage(itemId)) {
      throw forbidden(`${label} '${itemId}' is a system package and cannot be deleted`);
    }

    await assertNoRunningRuns(c, rcfg, itemId);

    const result = await deleteOrgItem(orgId, itemId, rcfg.cfg);
    if (!result.ok) {
      throw conflict(
        "in_use",
        `${label} '${itemId}' is used by ${result.dependents!.length} package(s)`,
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
    const item = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!item) {
      throw notFound(`${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found`);
    }
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

    const existing = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!existing) {
      throw notFound(`${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found`);
    }

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
    const item = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!item) {
      throw notFound(`${rcfg.cfg.label.slice(0, -1)} '${itemId}' not found`);
    }
    const info = await getVersionInfo(itemId, orgId);
    return c.json(info);
  };
}

function makeCreateVersionHandler(rcfg: PackageRouteConfig) {
  return async (c: Context<AppEnv>) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const itemId = getItemId(c);
    const label = rcfg.cfg.label.slice(0, -1);

    if (isSystemPackage(itemId)) {
      throw forbidden(`${label} '${itemId}' is a system package`);
    }

    await assertNoRunningRuns(c, rcfg, itemId);

    const item = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!item) {
      throw notFound(`${label} '${itemId}' not found`);
    }

    // Re-validate the draft manifest at the publish gate (defense in depth).
    // Save/import already validate, but cutting a version must not trust a
    // draft that became invalid by any path — this rejects e.g. an
    // `integrations_configuration` entry without a matching declared
    // dependency before it is frozen into an immutable version.
    // STORED direction: the draft is already persisted, and a draft written
    // before a runtime tool was retired must stay publishable.
    // `createVersionFromDraft` applies the same drop before freezing the
    // snapshot, so the retired id never reaches the immutable artifact. The
    // integration-scope subset gate the create/update paths apply comes along
    // with it — a draft must not be frozen into an immutable version with an
    // `integrations_configuration` selection outside the integration catalog.
    //
    // `requireCallableTools` is ON here and NOT on the draft writes: this is
    // where the artifact stops being editable, and freezing an empty tool
    // selection produces a version that can only fail at boot.
    await validateManifestForRoute(item.manifest, rcfg.cfg.type, orgId, "stored", {
      requireCallableTools: true,
    });

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
    const label = rcfg.cfg.label.slice(0, -1);

    if (isSystemPackage(itemId)) {
      throw forbidden(`${label} '${itemId}' is a system package`);
    }

    await assertNoRunningRuns(c, rcfg, itemId);

    const versionSpec = c.req.param("version")!;
    const detail = await getVersionDetail(itemId, versionSpec);
    if (!detail) {
      throw notFound(`Version '${versionSpec}' not found`);
    }

    const existing = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!existing || !existing.lock_version) {
      throw notFound(`${label} '${itemId}' not found`);
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
        content = new TextDecoder().decode(fileData);
      }
    }

    const updated = await updateOrgItem(
      orgId,
      itemId,
      { manifest: detail.manifest, content },
      existing.lock_version,
    );

    if (!updated) {
      throw conflict("conflict", "Package was modified concurrently. Reload and try again.");
    }

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

    // Re-upload storage files from the version ZIP
    if (detail.content) {
      await uploadPackageFiles(rcfg.cfg.storageFolder, orgId, itemId, detail.content);
    }

    // After-update hook (e.g. agent junction table sync on restore)
    if (rcfg.afterUpdate) {
      await rcfg.afterUpdate({
        packageId: itemId,
        orgId,
        manifest: detail.manifest,
      });
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
    const label = rcfg.cfg.label.slice(0, -1);

    if (isSystemPackage(itemId)) {
      throw forbidden(`${label} '${itemId}' is a system package`);
    }

    // Verify org ownership before deletion
    const existing = await getOrgItem(orgId, itemId, rcfg.cfg);
    if (!existing) {
      throw notFound(`${label} '${itemId}' not found`);
    }

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
 * - `hasPackageAccess` is VISIBILITY: "is this a system package, or installed
 *   in THIS application?" (it also excludes ephemeral shadows). It says
 *   nothing about what the caller is ALLOWED to do — a credential with
 *   `scopes: []` passes it. Believing otherwise is exactly the mistake #1124
 *   had to undo across the rest of the package surface.
 * - `requirePackageReadPermission` is AUTHORIZATION: the resolved row's
 *   `<type>:read` scope. Both file-explorer routes are registered on the
 *   router ROOT, so the RBAC resource is not knowable from the path — only
 *   from the row — which is why the guard runs here and not as route-level
 *   middleware.
 *
 * The row read in between adds the org boundary (`hasPackageAccess` does not
 * filter `orgId`) and fetches the draft columns the overlay needs.
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
async function loadFileExplorerPackage(c: Context<AppEnv>): Promise<PackageFileSource> {
  const packageId = getItemId(c);
  const orgId = c.get("orgId");
  const applicationId = c.get("applicationId");

  if (!(await hasPackageAccess({ orgId, applicationId }, packageId))) {
    throw notFound("Package not found");
  }

  const [pkg] = await db
    .select({
      id: packages.id,
      type: packages.type,
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
 * One policy for every response on both routes: `private, no-cache`.
 *
 * `private` is mandatory: these are authenticated, tenant-scoped bytes and a
 * shared cache must never hold them. `no-cache` is mandatory for the same
 * reason — it still allows the 304 round-trip, it only forbids serving without
 * one, and that round-trip is what keeps authorization live. Any fresh window,
 * however short, is served by the browser with ZERO server contact: revoke
 * `<type>:read`, remove the member from the org, or uninstall the package from
 * the application, and the cached 200 keeps being handed out until it expires.
 * `Vary` cannot rescue that — revocation changes no request header. Forcing the
 * round-trip re-enters `loadFileExplorerPackage`, so `hasPackageAccess` and
 * `requirePackageReadPermission` run on every hit.
 *
 * The revalidation this costs is nearly free: `resolvePackageFileValidator`
 * answers a version's 304 from one DB read, with no storage GET and no unzip.
 * That is the entire reason it is split out from `readPackageSnapshot`.
 *
 * `Vary` is NOT optional here. The response body depends on `X-Org-Id` /
 * `X-Application-Id` (via `hasPackageAccess`) while the URL does not mention
 * either. Without it, switching applications in the SPA re-issues an identical
 * URL and the browser answers from cache — showing application B an artifact
 * that is only installed in application A.
 */
function fileCacheHeaders(etag: string, yanked: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    ETag: etag,
    "Cache-Control": "private, no-cache",
    Vary: "X-Org-Id, X-Application-Id",
  };
  if (yanked) headers["X-Yanked"] = "true";
  return headers;
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
 * (`/:scope/:name/...`, e.g. `/{version}/download`) does not name a type in
 * its path — the resource is only knowable from the resolved package row.
 * This map is what lets such a route reach the same guard, so downloading a
 * skill's ZIP is gated on `skills:read` exactly like `GET /skills/@scope/name`.
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
    const writeGuard = requirePermission(resource, "write");
    const deleteGuard = requirePermission(resource, "delete");

    // `readGuard` on every GET: the install/system visibility check inside the
    // handlers (`hasPackageAccess`) answers "is this package reachable from
    // this application", never "may this caller read it". Without the guard a
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
      writeGuard,
      makeCreateVersionHandler(rcfg),
    );
    router.post(
      `/${path}/${SCOPED_PACKAGE_ROUTE}/versions/:version/restore`,
      requirePackageInOrg(),
      writeGuard,
      makeRestoreVersionHandler(rcfg),
    );
    router.delete(
      `/${path}/${SCOPED_PACKAGE_ROUTE}/versions/:version`,
      requirePackageInOrg(),
      deleteGuard,
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
      readGuard,
      rcfg.getHandler ?? makeGetHandler(rcfg),
    );
    router.put(
      `/${path}/${SCOPED_PACKAGE_ROUTE}`,
      requirePackageInOrg(),
      writeGuard,
      makeUpdateHandler(rcfg),
    );
    router.delete(
      `/${path}/${SCOPED_PACKAGE_ROUTE}`,
      requirePackageInOrg(),
      deleteGuard,
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

  // --- Fork route ---
  router.post(`/${SCOPED_PACKAGE_ROUTE}/fork`, requirePermission("agents", "write"), async (c) => {
    const packageId = getItemId(c);
    const orgId = c.get("orgId");
    const orgSlug = c.get("orgSlug");
    const user = c.get("user");

    // A missing/empty body is fine (auto-name), but a present-and-invalid
    // `name` must surface as a 400 — `allowEmpty` maps an empty body to `{}`
    // while still 400ing on malformed JSON or a bad-shape `name`.
    const parsed = await readJsonBody(c, forkSchema, { allowEmpty: true });
    const customName = parsed.name;

    const result = await forkPackage(orgId, orgSlug, packageId, user.id, customName);

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

    // Auto-install the forked package in the current application (non-fatal)
    const applicationId = c.get("applicationId");
    if (applicationId) {
      await installPackage({ orgId, applicationId }, result.packageId).catch((e: unknown) =>
        logger.debug("auto-install skipped", {
          packageId: result.packageId,
          applicationId,
          err: String(e),
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
   * WRITE direction — retired/unknown `runtime_tools` ids REJECT. Both routes
   * are author input, not content the platform already holds:
   *
   *   - `/import-github` fetches a directory of hand-written source files from
   *     a repository. That is authored material by definition, and the two
   *     routes share this helper, so consistency pins `/import` to the same
   *     policy.
   *   - The counter-argument for `/import` — the ZIP may be one this platform
   *     produced via `GET /:version/download`, so rejecting makes export→import
   *     one-way — is real but narrow. Unlike a bundle (machine-assembled, N
   *     packages, aborts wholesale) a single uploaded file is locally
   *     repairable: the error names the offending field and value, and the
   *     operator can unzip, edit one line, re-zip. `POST /import-bundle` is the
   *     sanctioned read path for re-ingesting platform-produced artifacts and
   *     it DOES drop.
   *   - The policy is binary: it cannot distinguish a retired id from a typo.
   *     Choosing `"drop"` here would silently swallow `"lgo"` on the primary
   *     hand-authoring inbound route, shipping an agent missing a tool with no
   *     signal — the exact failure the reject default exists to prevent.
   *
   * Passed explicitly rather than left to the default so the choice reads as
   * deliberate at the call site.
   */
  async function parseZipWithSkillFallback(upload: Buffer, orgSlug: string): Promise<ParsedImport> {
    const zipBytes = new Uint8Array(upload);
    try {
      const parsed = parsePackageZip(zipBytes, { retiredRuntimeTools: "reject" });
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
    await assertAgentIntegrationScopesValid(manifest as Record<string, unknown>, orgId, true);

    // Check for existing user package
    const existing = await getPackageById(packageId);

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

      // Update existing package manifest and content
      await db
        .update(packages)
        .set({ draftManifest: manifest, draftContent: content, updatedAt: new Date() })
        .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)));
    } else {
      // New package — insert
      const cfg = ROUTE_CONFIGS[packageType as PackageType]?.cfg;
      if (!cfg) {
        throw invalidRequest(`Unknown package type '${packageType}'`);
      }
      try {
        await createOrgItem(
          orgId,
          { id: packageId, content, createdBy: user.id },
          cfg,
          manifest as Record<string, unknown>,
        );
      } catch (err) {
        if (err instanceof PackageAlreadyExistsError) {
          throw conflict("name_collision", err.message);
        }
        throw err;
      }
    }

    // Per-type post-install (version, package upsert, storage upload)
    try {
      await postInstallPackage({
        packageType,
        packageId,
        orgId,
        userId: user.id,
        content,
        files,
        zipBuffer: artifact,
      });
    } catch (err) {
      const message = getErrorMessage(err);
      logger.error("Post-install failed", { packageId, packageType, error: message });
      throw new ApiError({
        status: 400,
        code: "post_install_failed",
        title: "Post-Install Failed",
        detail: message,
      });
    }

    // After-create hook (e.g. auto-enable provider)
    const rcfg = ROUTE_CONFIGS[packageType as PackageType];
    if (rcfg?.afterCreate) {
      await rcfg.afterCreate({
        packageId,
        orgId,
        manifest: manifest as Record<string, unknown>,
        applicationId: c.get("applicationId"),
      });
    }

    // Auto-install in the current application (non-fatal, skip if already installed)
    const applicationId = c.get("applicationId");
    if (applicationId) {
      await installPackage({ orgId, applicationId }, packageId).catch((e: unknown) =>
        logger.debug("auto-install skipped", { packageId, applicationId, err: String(e) }),
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
    // about unsupported `connect.login` selectors / criteria at install
    // time rather than chasing the runtime LoginError later. Also lift the
    // validator's `_meta` Appendix B regex soft-fail warnings to the same
    // channel so publishers see them on import. Same channel again for an
    // agent values narrowed by deployment policy — the run applies the
    // effective values regardless, and import is the first author-visible seam.
    // No retired-dependency-key warning here, unlike the bundle path: this
    // route parses through `parseZipWithSkillFallback`, which rejects them
    // outright, so such a manifest is a 400 long before this line.
    const installWarnings = [
      ...collectConnectLoginWarnings(manifest),
      ...collectMetaWarnings(manifest),
      ...collectAgentInstallWarnings(manifest),
    ];
    return c.json(
      {
        packageId,
        type: packageType,
        version: importedVersion,
        ...(installWarnings.length > 0 ? { warnings: installWarnings } : {}),
      },
      201,
    );
  }

  // POST /api/packages/import-bundle — import a multi-package .afps-bundle
  // (or a raw .afps, promoted to a bundle-of-one via the catalog).
  router.post("/import-bundle", rateLimit(10), requirePermission("agents", "write"), async (c) => {
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      throw invalidRequest("Request must be multipart/form-data with a file field", "file");
    }
    const file = formData.get("file") ?? formData.get("bundle");
    if (!file || !(file instanceof File)) {
      throw invalidRequest("File is required", "file");
    }
    const ext = file.name.toLowerCase();
    if (!ext.endsWith(".afps-bundle") && !ext.endsWith(".afps") && !ext.endsWith(".zip")) {
      throw invalidRequest("Only .afps-bundle, .afps, and .zip files are accepted", "file");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const orgId = c.get("orgId");
    const applicationId = c.get("applicationId");
    const userId = c.get("user").id;

    let result: Awaited<ReturnType<typeof handleImportBundle>>;
    try {
      result = await handleImportBundle(bytes, { orgId, applicationId }, userId);
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
  router.post("/import", rateLimit(10), requirePermission("agents", "write"), async (c) => {
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
  router.post("/import-github", rateLimit(10), requirePermission("agents", "write"), async (c) => {
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
  // Registered BEFORE `/:version/download` so the literal `files` segment can
  // never be captured as a version spec.

  // GET /api/packages/:scope/:name/files — flat index of the artifact's files
  router.get(`/${SCOPED_PACKAGE_ROUTE}/files`, rateLimit(50), async (c) => {
    const { version } = parseFileQuery(c, fileIndexQuerySchema);
    // Visibility + `<type>:read` are both settled inside this call, BEFORE any
    // validator is resolved — nothing below can answer an unauthorized caller.
    const pkg = await loadFileExplorerPackage(c);
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
    const { version, path } = parseFileQuery(c, fileContentQuerySchema);
    // Must stay ABOVE the validator: the 304 short-circuit below answers
    // without reading the artifact, so a permission check placed after it
    // would turn `If-None-Match` into a file-existence oracle.
    const pkg = await loadFileExplorerPackage(c);
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
    const applicationId = c.get("applicationId");
    const versionSpec = c.req.param("version")!;

    // Visibility first — "system package OR installed in THIS application",
    // the same gate the rest of the package surface applies. Without it this
    // route served the artifact bytes of packages that are merely owned by the
    // org and installed nowhere the caller can reach.
    if (!(await hasPackageAccess({ orgId, applicationId }, packageId))) {
      throw notFound("Package not found");
    }

    // Verify org ownership (or system package). Ephemeral shadows are hidden.
    const [pkg] = await db
      .select({ id: packages.id, type: packages.type })
      .from(packages)
      .where(and(eq(packages.id, packageId), orgOrSystemFilter(orgId), notEphemeralFilter()))
      .limit(1);
    if (!pkg) {
      throw notFound("Package not found");
    }

    // The ZIP carries the manifest and every authored file, so it is at least
    // as sensitive as the detail route — it needs the same `<type>:read`.
    await requirePackageReadPermission(c, pkg.type);

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
