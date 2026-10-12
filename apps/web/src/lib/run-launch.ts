// SPDX-License-Identifier: Apache-2.0

import type { ModelGenerationSettings } from "@appstrate/core/model-generation";
import type { RunWithOptionsSubmit } from "../components/run-with-options-modal";
import { ApiError } from "../api/errors";
import { withDeclaredConnections } from "./connection-set";
import {
  integrationIdOfField,
  missingConnectionErrors,
  type MissingIntegrationFieldError,
} from "./connection-choice";

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
   * `apps/api/src/lib/launch-schemas.ts`. Set by the run-with-options modal.
   */
  connectionOverrides?: Record<string, string[]>;
  /** Per-run model id override (wire `modelId`). From the run-with-options modal. */
  modelId?: string;
  /** Per-run proxy id override (wire `proxyId`). From the run-with-options modal. */
  proxyId?: string;
  /** Per-run temperature/reasoning override (wire `generation`). */
  generation?: ModelGenerationSettings;
  /**
   * Per-run dependency version overrides — `{ "@scope/skill": "draft"
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

/**
 * The replay of a launch a `409 missing_integration_connection` refused.
 * Everything the user chose rides along — the input typed in the run modal
 * above all — except the launch's own connection pick for each integration the
 * 409 refused: that integration then resolves as the recovery modal's row shows
 * it, so what the user answers there is what runs. A pick for an integration
 * the 409 does not name is kept.
 */
export function retryLaunch(
  launch: RunLaunch,
  errors: readonly MissingIntegrationFieldError[],
): RunLaunch {
  const { connectionOverrides: own, ...rest } = launch;
  if (!own) return launch;
  const refused = new Set(errors.map((e) => integrationIdOfField(e.field)));
  const kept = Object.entries(own).filter(([id]) => !refused.has(id));
  return kept.length > 0 ? { ...rest, connectionOverrides: Object.fromEntries(kept) } : rest;
}

/** A launch's 409 and the version it judged: the recovery modal reads that version's readiness. */
export interface LaunchRefusal {
  errors: MissingIntegrationFieldError[];
  /** The 409's `version_ref` — an omitted `?version=` launches what readiness would not read. */
  version: string | undefined;
}

/** The `409 missing_integration_connection` of a launch; `null` for any other error. */
export function launchRefusal(err: unknown): LaunchRefusal | null {
  const errors = missingConnectionErrors(err);
  if (!errors || !(err instanceof ApiError)) return null;
  const version = err.details?.version_ref;
  return { errors, version: typeof version === "string" ? version : undefined };
}

/**
 * The launch "Lancer avec options…" sends. An option rides only when set — an
 * empty input or dependency map and an unset override are left out, so the
 * server applies what plain "Lancer" gets. `version` is always an explicit pick
 * (the modal seeds it with that same default). Overrides are already wire
 * values (a proxy pick of "none" means no proxy) and pass through as-is, the
 * connection picks narrowed to `declaredIntegrations`. While those are unknown
 * every pick rides: dropped, the run could bind another account, whereas the
 * server refuses an undeclared key out loud (400).
 */
export function launchFromOptions({
  input,
  version,
  overrides,
  declaredIntegrations,
  dependencyOverrides,
}: RunWithOptionsSubmit): RunLaunch {
  const {
    model_id_override: modelId,
    generation_config_override: generation,
    proxy_id_override: proxyId,
    connection_overrides: connectionOverrides,
  } = withDeclaredConnections(overrides, declaredIntegrations);
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
