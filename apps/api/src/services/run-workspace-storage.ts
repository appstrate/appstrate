// SPDX-License-Identifier: Apache-2.0

/**
 * Per-run workspace provisioning storage.
 *
 * The agent container self-provisions its workspace: at startup it fetches
 * this archive from the platform (`GET /api/runs/:runId/workspace`) and
 * extracts it into `/workspace`. This replaces the old seed-via-helper-volume
 * mechanism, whose correctness depended on the run volume's driver — a
 * tmpfs-backed `local` volume is NOT shared between the short-lived seed
 * helper and the agent container, so the seeded bundle silently vanished and
 * skills never materialised (see issue #549). Routing delivery through a
 * platform fetch makes the workspace volume pure agent-local scratch, so its
 * backing (disk or tmpfs) is once again a free performance choice.
 *
 * The archive is a deterministic ZIP holding the agent package
 * (`agent-package.afps`) plus any input documents (`documents/<name>`),
 * keyed by runId. It is written before the agent container starts and
 * deleted (best-effort) on run teardown.
 */

import * as storage from "@appstrate/db/storage";
import { zipArtifact } from "@appstrate/core/zip";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../lib/logger.ts";

const BUCKET = "run-workspace";

/** One file destined for the run's `/workspace`. `name` may contain sub-paths. */
export interface RunWorkspaceFile {
  name: string;
  content: Buffer | Uint8Array;
}

function objectPath(runId: string): string {
  return `${runId}.zip`;
}

/**
 * Pack the workspace files into a deterministic ZIP and upload it for the
 * run. Overwrites any existing object (a run id is single-use). No-op when
 * there are no files — the agent treats an absent object as an empty
 * workspace.
 */
export async function uploadRunWorkspace(runId: string, files: RunWorkspaceFile[]): Promise<void> {
  if (files.length === 0) return;
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) {
    entries[f.name] = f.content instanceof Uint8Array ? f.content : new Uint8Array(f.content);
  }
  const zip = zipArtifact(entries);
  await storage.uploadFile(BUCKET, objectPath(runId), Buffer.from(zip));
}

/** Fetch the run's workspace ZIP. Returns null when none was provisioned. */
export async function downloadRunWorkspace(runId: string): Promise<Buffer | null> {
  const data = await storage.downloadFile(BUCKET, objectPath(runId));
  return data ? Buffer.from(data) : null;
}

/** Delete the run's workspace ZIP. Best-effort — never throws. */
export async function deleteRunWorkspace(runId: string): Promise<void> {
  try {
    await storage.deleteFile(BUCKET, objectPath(runId));
  } catch (error) {
    logger.warn("Failed to delete run workspace (best-effort)", {
      runId,
      error: getErrorMessage(error),
    });
  }
}
