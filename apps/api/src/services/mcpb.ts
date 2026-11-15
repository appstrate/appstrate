// SPDX-License-Identifier: Apache-2.0

/**
 * MCPB (`.mcpb`) archive adapters — AFPS §7.1.1.
 *
 * Import turns a raw MCP Bundle into the archive of a `local` integration (the manifest is
 * replaced, the payload kept verbatim) BEFORE the normal import paths see it, so every write-path
 * rule applies to the result. Export does the reverse for a published local integration.
 * The manifest mapping itself lives in `@appstrate/core/mcpb`.
 */

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizations } from "@appstrate/db/schema";
import {
  integrationFromMcpb,
  isMcpbManifest,
  mcpbFromIntegration,
  McpbProjectionError,
} from "@appstrate/core/mcpb";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { unzipArtifact, zipArtifact } from "@appstrate/core/zip";
import { ApiError } from "../lib/errors.ts";

const MANIFEST = "manifest.json";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Extensions an import accepts for a raw MCP Bundle. */
export const MCPB_EXTENSION = ".mcpb";

/** A projection refusal as a problem+json answer: 400 on import, 422 on export. */
export function mcpbProblem(err: McpbProjectionError, status: 400 | 422): ApiError {
  return new ApiError({
    status,
    code: err.code,
    title: "MCPB Projection Refused",
    detail: err.message,
  });
}

/** Parse the root `manifest.json` of an archive; `null` when it is not a readable ZIP or JSON. */
function readRootManifest(
  bytes: Uint8Array,
): { files: Record<string, Uint8Array>; raw: unknown } | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipArtifact(bytes);
  } catch {
    return null;
  }
  const manifest = files[MANIFEST];
  if (!manifest) return null;
  try {
    return { files, raw: JSON.parse(decoder.decode(manifest)) };
  } catch {
    return null;
  }
}

/** Whether the archive's root `manifest.json` is an MCPB manifest. */
export function isMcpbArchive(bytes: Uint8Array): boolean {
  const root = readRootManifest(bytes);
  return root !== null && isMcpbManifest(root.raw);
}

async function orgSlugOf(orgId: string): Promise<string> {
  const [row] = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row)
    throw new ApiError({
      status: 404,
      code: "not_found",
      title: "Not Found",
      detail: "Organization not found",
    });
  return row.slug;
}

/**
 * An MCPB archive → the archive of the integration it projects to, named `@<org scope>/<mcpb name>`.
 * Anything that is not an MCPB archive comes back untouched (same bytes), so every import path can
 * call this first. `org` is the importing organization's slug, or its id when the slug is not at hand.
 */
export async function convertMcpbArchive(
  bytes: Uint8Array,
  org: { slug: string } | { id: string },
): Promise<Uint8Array> {
  const root = readRootManifest(bytes);
  if (!root || !isMcpbManifest(root.raw)) return bytes;
  const scope = "slug" in org ? org.slug : await orgSlugOf(org.id);
  let manifest: IntegrationManifest;
  try {
    manifest = integrationFromMcpb(root.raw, scope);
  } catch (err) {
    if (err instanceof McpbProjectionError) throw mcpbProblem(err, 400);
    throw err;
  }
  return zipArtifact({
    ...root.files,
    [MANIFEST]: encoder.encode(JSON.stringify(manifest, null, 2)),
  });
}

/**
 * The entries of a local integration's archive → the `.mcpb` bytes: the strict MCPB manifest plus
 * every entry but the integration's `manifest.json` and `INTEGRATION.md` (MCPB has neither).
 * Throws {@link McpbProjectionError} for what has no faithful MCPB form.
 */
export function buildMcpbArchive(files: Record<string, Uint8Array>): {
  archive: Uint8Array;
  manifest: IntegrationManifest;
} {
  const raw = files[MANIFEST];
  if (!raw) throw new McpbProjectionError("mcpb_not_local", "The archive carries no manifest.json");
  const manifest = JSON.parse(decoder.decode(raw)) as IntegrationManifest;
  const mcpb = mcpbFromIntegration(manifest, new Set(Object.keys(files)));
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    if (path === MANIFEST || path === "INTEGRATION.md") continue;
    entries[path] = content;
  }
  entries[MANIFEST] = encoder.encode(JSON.stringify(mcpb, null, 2));
  return { archive: zipArtifact(entries), manifest };
}
