// SPDX-License-Identifier: Apache-2.0

import type { ModelGenerationSettings } from "@appstrate/core/model-generation";
import type { RunWithOptionsSubmit } from "../components/run-with-options-modal";
import { integrationIdOfField, type MissingIntegrationFieldError } from "./connection-choice";

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
   * Per-integration connection sets for THIS run (cascade layer 3), validated in
   * `apps/api/src/lib/launch-schemas.ts`. Set by the run-with-options modal
   * and, on a retry, by the connection-recovery modal (`retryLaunch`).
   */
  connectionOverrides?: Record<string, string[]>;
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
 * already carried for the same one; picks for other integrations are kept —
 * except one refused as `override_outranked`, which the admin's lock forbids
 * re-picking, so replaying it would only be refused again.
 */
export function retryLaunch(
  launch: RunLaunch,
  picks: Record<string, string[]>,
  errors: readonly MissingIntegrationFieldError[],
): RunLaunch {
  const outranked = new Set(
    errors.filter((e) => e.code === "override_outranked").map((e) => integrationIdOfField(e.field)),
  );
  const kept = Object.entries(launch.connectionOverrides ?? {}).filter(
    ([id]) => !outranked.has(id),
  );
  return { ...launch, connectionOverrides: { ...Object.fromEntries(kept), ...picks } };
}

/**
 * The launch "Lancer avec options…" sends. An option rides only when set — an
 * empty input or dependency map and an unset override are left out, so the
 * server applies what plain "Lancer" gets. `version` is always an explicit pick
 * (the modal seeds it with that same default). Overrides are already wire
 * values (a proxy pick of "none" means no proxy) and pass through as-is.
 */
export function launchFromOptions({
  input,
  version,
  overrides,
  dependencyOverrides,
}: RunWithOptionsSubmit): RunLaunch {
  const {
    model_id_override: modelId,
    generation_config_override: generation,
    proxy_id_override: proxyId,
    connection_overrides: connectionOverrides,
  } = overrides;
  return {
    ...(Object.keys(input).length > 0 ? { input } : {}),
    version,
    ...(modelId ? { modelId } : {}),
    ...(generation ? { generation } : {}),
    ...(proxyId ? { proxyId } : {}),
    ...(connectionOverrides ? { connectionOverrides } : {}),
    ...(Object.keys(dependencyOverrides).length > 0 ? { dependencyOverrides } : {}),
  };
}
