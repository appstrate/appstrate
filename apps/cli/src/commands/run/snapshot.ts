// SPDX-License-Identifier: Apache-2.0

/**
 * Snapshot file parsing for `appstrate run --snapshot <path>`.
 *
 * A snapshot is a small JSON document that seeds the run's
 * {@link ExecutionContext} with prior memories / conversation history
 * / persisted state — the same shape a real platform run would inherit
 * from previous runs. Only the three seedable keys are honoured; extra
 * keys are ignored so the format can evolve without breaking callers.
 *
 * Matches the contract previously exposed by `afps run --snapshot` in
 * `@appstrate/afps-runtime` so agent authors can move their fixtures
 * over unchanged.
 */

import { readFile } from "node:fs/promises";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";

export interface SnapshotFile {
  memories?: ExecutionContext["memories"];
  history?: ExecutionContext["history"];
  state?: unknown;
}

export class SnapshotError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "SnapshotError";
  }
}

/**
 * Load and validate a snapshot file. Returns the parsed object with
 * only the three seedable keys preserved — extra keys are dropped so
 * a typo never silently overrides a context field downstream.
 */
export async function loadSnapshotFile(path: string): Promise<SnapshotFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    throw new SnapshotError(
      `Cannot read --snapshot: ${err instanceof Error ? err.message : String(err)}`,
      `Check the path exists and is readable: ${path}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SnapshotError(
      `--snapshot is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SnapshotError("--snapshot must be a JSON object");
  }
  return pickSeedableKeys(parsed as Record<string, unknown>);
}

/**
 * Merge a snapshot's seedable keys into an ExecutionContext. Snapshot
 * keys win when present; `memories` is replaced wholesale (never
 * concatenated — the caller's intent is a replay seed, not an append).
 *
 * Exported for unit tests; the runner composes via this helper so
 * snapshot semantics stay assertable without booting PiRunner.
 */
export function mergeSnapshotIntoContext(
  context: ExecutionContext,
  snapshot: SnapshotFile,
): ExecutionContext {
  return {
    ...context,
    ...(snapshot.memories !== undefined ? { memories: snapshot.memories } : {}),
    ...(snapshot.history !== undefined ? { history: snapshot.history } : {}),
    ...(snapshot.state !== undefined ? { state: snapshot.state } : {}),
  };
}

function pickSeedableKeys(obj: Record<string, unknown>): SnapshotFile {
  const out: SnapshotFile = {};
  if ("memories" in obj) {
    const m = obj.memories;
    if (m !== undefined && !Array.isArray(m)) {
      throw new SnapshotError("--snapshot.memories must be an array when present");
    }
    if (m !== undefined) out.memories = m as ExecutionContext["memories"];
  }
  if ("history" in obj) {
    const h = obj.history;
    if (h !== undefined && !Array.isArray(h)) {
      throw new SnapshotError("--snapshot.history must be an array when present");
    }
    if (h !== undefined) out.history = h as ExecutionContext["history"];
  }
  if ("state" in obj && obj.state !== undefined) {
    out.state = obj.state;
  }
  return out;
}
