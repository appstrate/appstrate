// SPDX-License-Identifier: Apache-2.0

/**
 * Variables that appear in a shipped `.env.example` and deliberately have NO
 * row in `docs/ENV.md`, with the reason each one is out of scope.
 *
 * `docs/ENV.md` documents what the PLATFORM reads. Everything below is read by
 * something else that happens to be configured from the same file — a sibling
 * container's entrypoint, docker compose's own interpolation, or a vendor SDK's
 * private credential chain. Documenting them in the platform's env table would
 * imply `getEnv()` knows about them, and it does not: none of these names
 * appears in `packages/env/src/index.ts` at all.
 *
 * An entry here is a claim that has to stay true, so it carries its consumer.
 * Adding a name to silence a finding — rather than because the platform really
 * does not read it — rebuilds the hole this gate closes.
 */
export const INFRA_ENV_KEYS: Readonly<Record<string, string>> = {
  POSTGRES_USER: "read by the `postgres` container's entrypoint; the platform reads DATABASE_URL",
  POSTGRES_PASSWORD:
    "read by the `postgres` container's entrypoint; the platform reads DATABASE_URL",
  MINIO_ROOT_USER: "read by the `minio` container's entrypoint; the platform reads S3_*",
  MINIO_ROOT_PASSWORD: "read by the `minio` container's entrypoint; the platform reads S3_*",
  AWS_ACCESS_KEY_ID:
    "consumed by the AWS SDK's own credential-provider chain inside @appstrate/core/storage-s3; never named by platform code",
  AWS_SECRET_ACCESS_KEY:
    "consumed by the AWS SDK's own credential-provider chain inside @appstrate/core/storage-s3; never named by platform code",
  APPSTRATE_VERSION:
    "compose-level image-tag interpolation, never read by the platform process; kept current by `bun run verify:release-version`",
  DOCKER_GID:
    "compose-level: the host gid the container joins to reach the docker socket. Appears only in compose files",
  APPSTRATE_RUNNER_SOCKET_DIR:
    "compose-level bind-mount path for the appstrate-runner UDS, written by `appstrate install`. The platform reads FIRECRACKER_RUNNER_URL, not this",
};

/** Namespaces of keys the platform reads that belong to the runtime (`NODE_ENV`) and to git (`GIT_SHA`). */
export const FOREIGN_ENV_NAMESPACES: ReadonlySet<string> = new Set(["NODE", "GIT"]);

/**
 * The namespaces the platform owns: a present key under one of them that nothing
 * reads is reported. Declared, not derived from the keys read today, so removing
 * the last key of a namespace does not silence an operator who still sets it.
 *
 * Adding a key whose namespace is not listed fails `env-key-inventory.test.ts`:
 * declare the namespace here, and never delete one because its keys went away.
 */
export const PLATFORM_ENV_NAMESPACES: ReadonlySet<string> = new Set([
  "AFPS",
  "API",
  "APP",
  "APPSTRATE",
  "AUTH",
  "BETTER",
  "CONNECT",
  "CONNECTION",
  "COOKIE",
  "CREDENTIAL",
  "DATABASE",
  "DOCKER",
  "EGRESS",
  "FILE",
  "FS",
  "GITHUB",
  "GOOGLE",
  "INLINE",
  "INTEGRATION",
  "LEGAL",
  "LLM",
  "LOG",
  "MIGRATIONS",
  "MODEL",
  "MODULE",
  "MODULES",
  "OAUTH",
  "OIDC",
  "ORG",
  "PGLITE",
  "PI",
  "PLATFORM",
  "PORT",
  "PROXY",
  "REDIS",
  "REMOTE",
  "RUN",
  "RUNNER",
  "RUNTIME",
  "S3",
  "SIDECAR",
  "SMTP",
  "STORAGE",
  "SYSTEM",
  "TOOL",
  "TRUST",
  "TRUSTED",
  "UPLOAD",
  "USERCONTENT",
  "WEBHOOK",
  "WORKSPACE",
]);

/** The namespace of a variable: the text before its first `_`, or the whole name. */
export function envNamespace(key: string): string {
  const underscore = key.indexOf("_");
  return underscore === -1 ? key : key.slice(0, underscore);
}

/**
 * The environment keys that are present but never read by the platform, sorted
 * and deduplicated.
 *
 * `read` is every key the platform itself consumes (schema keys, sidecar operator
 * keys). A present key is reported only when its namespace is in
 * `PLATFORM_ENV_NAMESPACES` and the key is neither read nor in `INFRA_ENV_KEYS`.
 * Infra keys never define a namespace: a deployment that injects one env into
 * every container sets `POSTGRES_DB` or `AWS_REGION` beside them, and those are
 * not the platform's to report.
 */
export function findUnreadEnvKeys(present: Iterable<string>, read: ReadonlySet<string>): string[] {
  const unread = new Set<string>();
  for (const key of present) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    if (read.has(key) || key in INFRA_ENV_KEYS || !PLATFORM_ENV_NAMESPACES.has(envNamespace(key)))
      continue;
    unread.add(key);
  }
  return [...unread].sort();
}
