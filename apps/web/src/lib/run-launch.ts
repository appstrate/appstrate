// SPDX-License-Identifier: Apache-2.0

import type { MissingIntegrationConnectionCode } from "@appstrate/core/integration";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";
import type { RunWithOptionsSubmit } from "../components/run-with-options-modal";
import { integrationIdOfField, type MissingIntegrationFieldError } from "./connection-choice";
import { VERSION_PUBLISHED } from "./version-selector";

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
 * Lets one launch through at a time. A mutation's `isPending` cannot: it is
 * render state, so two clicks in one frame both read it `false`. The slot
 * follows the request's promise, so it is freed whatever became of its
 * listeners, and `onBusyChange` is the launcher's pending flag.
 */
export function launchFlight(onBusyChange: (busy: boolean) => void): {
  /** Starts the launch; a call while one is in flight is dropped. */
  run: (
    start: () => Promise<unknown>,
    handlers: { onSuccess?: () => void; onError?: (error: Error) => void },
  ) => void;
  /** Stops reporting the launch in flight. It keeps the slot until it settles. */
  forget: () => void;
} {
  let busy = false;
  let reported: object | null = null;
  return {
    run: (start, handlers) => {
      if (busy) return;
      busy = true;
      onBusyChange(true);
      const flight = {};
      reported = flight;
      void start()
        .then(
          () => {
            if (reported === flight) handlers.onSuccess?.();
          },
          (error: Error) => {
            if (reported === flight) handlers.onError?.(error);
          },
        )
        .finally(() => {
          busy = false;
          onBusyChange(false);
        });
    },
    forget: () => {
      reported = null;
    },
  };
}

/** Codes refusing the launch's own pick itself: replayed, it would be refused again. */
const OWN_PICK_REFUSALS: ReadonlySet<string> = new Set([
  "override_outranked",
  "override_connection_unavailable",
] satisfies MissingIntegrationConnectionCode[]);

/**
 * The launch a `409 missing_integration_connection` refused, replayed with the
 * recovery modal's picks. Everything else the user chose rides along — the
 * input typed in the run modal above all (#1539). The launch's own pick for an
 * integration is dropped only when the 409 refuses that pick itself
 * (`OWN_PICK_REFUSALS`, or `auth_serves_no_selected_tool` naming a connection
 * of it). Under any other code — a connection to repair, above all — the pick
 * is kept: dropping it could let the retry bind another account.
 */
export function retryLaunch(
  launch: RunLaunch,
  picks: Record<string, string[]>,
  errors: readonly MissingIntegrationFieldError[],
): RunLaunch {
  const own = launch.connectionOverrides ?? {};
  const refused = new Set(
    errors.flatMap((e) => {
      const id = integrationIdOfField(e.field);
      const refusesPick =
        OWN_PICK_REFUSALS.has(e.code) ||
        (e.code === "auth_serves_no_selected_tool" &&
          e.connection_id !== undefined &&
          (own[id] ?? []).includes(e.connection_id));
      return refusesPick ? [id] : [];
    }),
  );
  const kept = Object.entries(own).filter(([id]) => !refused.has(id));
  return { ...launch, connectionOverrides: { ...Object.fromEntries(kept), ...picks } };
}

/**
 * The version a launch runs, spelled out: an omitted `?version=` runs the latest published,
 * while readiness reads it as the draft for a caller who can write the agent.
 */
export function launchedVersion(launch: RunLaunch): string {
  return launch.version ?? VERSION_PUBLISHED;
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

/**
 * What a launch with no override resolves to: the agent's own setting, else the
 * org default — also past a setting that is gone or not `usable`, as the server does.
 */
export function inheritedEntry<T extends { id: string }>(
  entries: readonly T[] | undefined,
  agentSettingId: string | null,
  orgDefault: T | undefined,
  usable: (entry: T) => boolean,
): T | undefined {
  const setting = entries?.find((entry) => entry.id === agentSettingId);
  return setting && usable(setting) ? setting : orgDefault;
}
