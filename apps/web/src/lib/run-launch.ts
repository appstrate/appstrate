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

export interface RunLaunch {
  input?: Record<string, unknown>;
  /** Replay a prior run's persisted input instead of supplying `input`. */
  rerun_from?: string;
  /** Forwarded as `?version=`; omitted = the API's published-when-exists default. `"draft"` needs `home_writable` (`defaultRunVersion`). */
  version?: string;
  /** Per-integration connection sets for THIS run (cascade layer 3). */
  connectionOverrides?: Record<string, string[]>;
  modelId?: string;
  proxyId?: string;
  generation?: ModelGenerationSettings;
  /** `{ "@scope/skill": "draft" | "<semver|dist-tag>" }`; "draft" runs the working copy, else replaces the manifest pin. */
  dependencyOverrides?: Record<string, string>;
}

/** Lets one launch through at a time: a mutation's `isPending` is render state, so two clicks in one frame both read it `false`. */
export function launchFlight(onBusyChange: (busy: boolean) => void): {
  /** A call while one is in flight is dropped. */
  run: (
    start: () => Promise<unknown>,
    handlers: { onSuccess?: () => void; onError?: (error: Error) => void },
  ) => void;
  /** Stops reporting the launch in flight; it keeps the slot until it settles. */
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

/** Replay of a launch a `409 missing_integration_connection` refused, minus the refused integrations' picks (the recovery modal's answer wins). */
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
 * The launch "Lancer avec options…" sends: an option rides only when set. Connection
 * picks are narrowed to `declaredIntegrations`; while unknown every pick rides (dropped,
 * the run could bind another account, whereas the server refuses an undeclared key, 400).
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

/** What a launch with no override resolves to: the agent's setting, else the org default (also past a gone or unusable setting, as the server does). */
export function inheritedEntry<T extends { id: string }>(
  entries: readonly T[] | undefined,
  agentSettingId: string | null,
  orgDefault: T | undefined,
  usable: (entry: T) => boolean,
): T | undefined {
  const setting = entries?.find((entry) => entry.id === agentSettingId);
  return setting && usable(setting) ? setting : orgDefault;
}
