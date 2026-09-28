// SPDX-License-Identifier: Apache-2.0

/**
 * The run-scoped secrets of the runtime env contract ({@link buildRuntimePiEnv}),
 * and how they reach the process that runs the agent without ever being in its
 * environment.
 *
 * Bun hands a child spawned without an explicit `env` the parent's STARTUP
 * environment, whatever `process.env` says by then — and Pi spawns tools that
 * way. So the runtime entrypoint must never start with these keys: whoever
 * starts it (the runtime launcher in Docker and Firecracker, the process
 * orchestrator in dev) spawns it with {@link splitSecretEnv}'s `env` and
 * writes its `payload` to the entrypoint's stdin, which {@link receiveSecrets}
 * reads back at boot.
 */

export const RUNTIME_SECRET_ENV_KEYS = [
  "APPSTRATE_SINK_SECRET",
  "APPSTRATE_SINK_URL",
  "APPSTRATE_SINK_FINALIZE_URL",
  "SIDECAR_URL",
  "SIDECAR_AUTH_TOKEN",
] as const;

const SECRET_KEYS: ReadonlySet<string> = new Set(RUNTIME_SECRET_ENV_KEYS);

/** Split an environment into the entrypoint's `env` and the stdin `payload`. */
export function splitSecretEnv(source: Record<string, string | undefined>): {
  env: Record<string, string>;
  payload: string;
} {
  const env: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    (SECRET_KEYS.has(key) ? secrets : env)[key] = value;
  }
  return { env, payload: JSON.stringify(secrets) };
}

/**
 * The entrypoint's environment with the handed-over secrets merged in. Throws
 * when a secret is in the startup environment (the process was not started
 * through a handover) or the payload is not the shape {@link splitSecretEnv} writes.
 */
export function receiveSecrets(
  payload: string,
  startupEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const leaked = RUNTIME_SECRET_ENV_KEYS.filter((key) => key in startupEnv);
  if (leaked.length > 0) {
    throw new Error(
      `${leaked.join(", ")} must not be in the runtime's environment — start it through the launcher`,
    );
  }
  const parsed: unknown = JSON.parse(payload);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("secret handover: expected a JSON object");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!SECRET_KEYS.has(key) || typeof value !== "string") {
      throw new Error(`secret handover: unexpected entry "${key}"`);
    }
  }
  return { ...startupEnv, ...(parsed as Record<string, string>) };
}
