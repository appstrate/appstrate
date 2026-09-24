// SPDX-License-Identifier: Apache-2.0

import type { ModelGenerationSettings } from "@appstrate/core/model-generation";

/** One run launch, as the launch surfaces build it — `useRunAgent` maps it onto the wire. */
export interface RunLaunch {
  input?: Record<string, unknown>;
  /** Replay a prior run's persisted input instead of supplying `input`. */
  rerun_from?: string;
  /**
   * Version selector forwarded as `?version=`: `"draft"`, `"published"`, or
   * a version spec. Omitted selectors use the API's published-when-exists
   * default; callers testing a working copy explicitly pass `"draft"`, which
   * the API grants only to a caller who can write the package in its home
   * space (`403 draft_not_writable`). Launch surfaces derive it from
   * `home_writable` via `defaultRunVersion`.
   */
  version?: string;
  /**
   * Per-integration connection picks for THIS run (#199 mechanism #2).
   * Flat map: `{ "@scope/integration": "<connectionId>" }` — one pick per
   * integration; the chosen connection carries its own `auth_key`. Wire
   * format validated by `input-parser.ts`. Set by the run-with-options modal
   * and, on a retry, by the connection-recovery modal (`retryLaunch`).
   */
  connectionOverrides?: Record<string, string>;
  /** Per-run model id override (wire `modelId`). From the run-with-options modal. */
  modelId?: string;
  /** Per-run proxy id override (wire `proxyId`). From the run-with-options modal. */
  proxyId?: string;
  /** Per-run temperature/reasoning override (wire `generation`). */
  generation?: ModelGenerationSettings;
  /**
   * Per-run dependency version overrides (#666) — `{ "@scope/skill": "draft"
   * | "<semver|dist-tag>" }`. From the run-with-options modal. "draft" runs a
   * dependency's working copy; any other value replaces the manifest pin.
   */
  dependencyOverrides?: Record<string, string>;
}

/**
 * The launch a `409 missing_integration_connection` refused, replayed with the
 * recovery modal's picks. Everything else the user chose rides along — the
 * input typed in the run modal above all (#1539). The picks answer the
 * integrations the 409 named, so they win over a per-run pick the launch
 * already carried for the same one; picks for other integrations are kept.
 */
export function retryLaunch(launch: RunLaunch, picks: Record<string, string>): RunLaunch {
  return { ...launch, connectionOverrides: { ...launch.connectionOverrides, ...picks } };
}
