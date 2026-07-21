// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Per-run secret redaction for desktop command replies.
 *
 * Credential substitution keeps secret values out of the agent's
 * context on the way IN (the LLM writes `{{password}}`, the platform
 * resolves it after the command leaves the model). This store closes
 * the way OUT: once a value has been substituted for a run, every
 * subsequent desktop reply for that run is scrubbed of it — including
 * replies to LATER commands. Without this, an agent could fill a
 * password field and then simply `browser.evaluate` the input's
 * `.value` to read the secret back into its own context.
 *
 * Process-local, like the client registry: substitution and scrubbing
 * happen on the same instance that dispatched the command.
 */

const MIN_SECRET_LENGTH = 4;

/**
 * How long a run's substituted values are retained after their last
 * use. Generous versus any realistic run duration; the sweep exists so
 * an instance that stays up for months doesn't accumulate entries for
 * long-dead runs.
 */
const RETENTION_MS = 6 * 60 * 60 * 1000;

const REDACTED = "[redacted:substituted-credential]";

interface RunSecrets {
  values: Set<string>;
  touchedAt: number;
}

const secretsByRun = new Map<string, RunSecrets>();

function sweep(now: number): void {
  for (const [runId, entry] of secretsByRun) {
    if (now - entry.touchedAt > RETENTION_MS) secretsByRun.delete(runId);
  }
}

/**
 * Remember the values substituted into a command for this run. Values
 * shorter than {@link MIN_SECRET_LENGTH} are skipped — scrubbing "1"
 * out of every reply would mangle ordinary content for no security
 * gain (a 1-3 char credential is guessable anyway).
 */
export function registerRunSecrets(runId: string, values: Iterable<string>): void {
  const now = Date.now();
  sweep(now);
  let entry = secretsByRun.get(runId);
  if (!entry) {
    entry = { values: new Set(), touchedAt: now };
    secretsByRun.set(runId, entry);
  }
  entry.touchedAt = now;
  for (const value of values) {
    if (value.length >= MIN_SECRET_LENGTH) entry.values.add(value);
  }
}

function scrubString(input: string, values: ReadonlySet<string>): string {
  let out = input;
  for (const value of values) {
    // `split/join` instead of a RegExp — secret values are arbitrary
    // strings and must not be interpreted as patterns.
    if (out.includes(value)) out = out.split(value).join(REDACTED);
  }
  return out;
}

/**
 * Deep-scrub a desktop reply of every value ever substituted for this
 * run. Walks strings, arrays and plain objects; rebuilds plain `{}`
 * objects rather than mutating (no prototype surprises). Cheap no-op
 * when the run never used substitution.
 */
export function scrubRunSecrets(runId: string, value: unknown): unknown {
  const entry = secretsByRun.get(runId);
  if (!entry || entry.values.size === 0) return value;
  entry.touchedAt = Date.now();
  return scrubValue(value, entry.values);
}

function scrubValue(value: unknown, values: ReadonlySet<string>): unknown {
  if (typeof value === "string") return scrubString(value, values);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, values));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, values);
    return out;
  }
  return value;
}

/** Test-only: drop a run's entry so cases don't leak into each other. */
export function clearRunSecrets(runId: string): void {
  secretsByRun.delete(runId);
}
