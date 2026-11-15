// SPDX-License-Identifier: Apache-2.0

/**
 * MCP Bundle (MCPB) projection of a `local` integration — AFPS §7.1.1.
 *
 * A `.mcpb` is a local MCP server plus the configuration a host asks its user for
 * (`user_config`). A `local` integration carries the same two things: its inline server
 * (`source.server`) and the credentials its auth method delivers to it (`delivery.env`). The two
 * functions here map one manifest onto the other; the payload files are copied verbatim by the
 * caller, so nothing here touches an archive.
 *
 * Both directions refuse what they cannot carry faithfully rather than dropping it: a credential
 * delivered over HTTP or as a file, a second auth method, connection variables (export); a
 * credential anywhere but a top-level `mcp_config.env` value, a setting with no place to live, a
 * placeholder nothing expands, a non-Linux bundle (import).
 *
 * The runner derives the launch from `server.type` + `entry_point` only: `mcp_config.command` /
 * `args` and `platform_overrides` are carried for MCPB interoperability and never executed, and
 * `mcp_config.env` values are literal strings (no placeholder is expanded in them).
 */

import { AFPS_SCHEMA_VERSION } from "./validation.ts";
import { getLocalServer, type IntegrationManifest } from "./integration.ts";

/** Why a projection was refused; `message` names the field at fault. */
export class McpbProjectionError extends Error {
  constructor(
    readonly code: McpbProjectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpbProjectionError";
  }
}

export type McpbProjectionErrorCode =
  | "mcpb_not_local"
  | "mcpb_unsupported_auth"
  | "mcpb_unsupported_variables"
  | "mcpb_invalid_manifest"
  | "mcpb_unsupported_user_config"
  | "mcpb_unsupported_placeholder"
  | "mcpb_unsupported_platform";

/** The strict MCPB `manifest.json` fields this projection reads or writes. */
export interface McpbManifest {
  manifest_version: "0.3" | "0.4";
  name: string;
  display_name?: string;
  version: string;
  description: string;
  author: McpbAuthor;
  license?: string;
  keywords?: string[];
  icon?: string;
  server: {
    type: string;
    entry_point: string;
    mcp_config: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      platform_overrides?: Record<string, McpbRun>;
    };
  };
  tools?: { name: string; description?: string }[];
  user_config?: Record<string, McpbUserConfigEntry>;
}

export interface McpbAuthor {
  name: string;
  email?: string;
  url?: string;
}

/** The launch fields shared by `mcp_config` and each `platform_overrides` entry. */
export interface McpbRun {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpbUserConfigEntry {
  type: "string" | "number" | "boolean" | "directory" | "file";
  title: string;
  description: string;
  required?: boolean;
  sensitive?: boolean;
  default?: unknown;
  multiple?: boolean;
}

/** What the reader keeps of a bundle. `manifest_version` is a plain string: see `readMcpb`. */
interface McpbRead {
  manifest_version?: string;
  name: string;
  display_name?: string;
  version: string;
  description: string;
  author: McpbAuthor;
  license?: string;
  keywords?: string[];
  server: {
    type: string;
    entry_point: string;
    mcp_config: McpbRun & { command: string; platform_overrides?: Record<string, McpbRun> };
  };
  tools?: { name: string; description?: string }[];
  user_config?: Record<
    string,
    Omit<McpbUserConfigEntry, "type" | "description"> & { type?: string; description?: string }
  >;
  compatibility?: { platforms?: string[] };
}

const USER_CONFIG_REF = /\$\{user_config\.([^}]+)\}/g;
const CREDENTIAL_REF = /\{\$credential\.([A-Za-z0-9_]+)\}/g;
const CREDENTIAL_FIELD = /^[A-Za-z0-9_]+$/;
/** Any `${…}` placeholder (`${__dirname}`, `${HOME}`, `${/}`, …). */
const PLACEHOLDER = /\$\{[^}]*\}/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** `@scope/name` → `name`. */
function bareName(packageId: string): string {
  const slash = packageId.indexOf("/");
  return slash === -1 ? packageId : packageId.slice(slash + 1);
}

/** An MCPB `name` as an AFPS package name segment: lowercase, `[a-z0-9-]`, no edge hyphen. */
function packageSegment(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

/** Pick the launch fields of an `mcp_config` / override object; MCPB objects admit no other key. */
function pickRun(value: Record<string, unknown>, env?: Record<string, string>): McpbRun {
  const args = stringArray(value.args);
  const effectiveEnv = env ?? stringRecord(value.env);
  return {
    ...(typeof value.command === "string" ? { command: value.command } : {}),
    ...(args ? { args } : {}),
    ...(Object.keys(effectiveEnv).length > 0 ? { env: effectiveEnv } : {}),
  };
}

/**
 * Integration → strict MCPB `manifest.json` (AFPS §7.1.1, export). `files` is the set of paths
 * the archive carries, to keep `icon` only when it names a PNG shipped with the bundle.
 */
export function mcpbFromIntegration(
  manifest: IntegrationManifest,
  files: ReadonlySet<string> = new Set(),
): McpbManifest {
  const server = getLocalServer(manifest);
  if (!server) {
    throw new McpbProjectionError(
      "mcpb_not_local",
      "Only an integration whose source.kind is local, with a source.server declaring mcp_config.command, has an MCPB form",
    );
  }
  const record = manifest as unknown as Record<string, unknown>;
  if (record.variables !== undefined) {
    throw new McpbProjectionError(
      "mcpb_unsupported_variables",
      "An integration with connection variables has no faithful MCPB form",
    );
  }
  const auths = isRecord(record.auths) ? Object.entries(record.auths) : [];
  if (auths.length > 1) {
    throw new McpbProjectionError(
      "mcpb_unsupported_auth",
      "An integration with more than one auth method has no faithful MCPB form",
    );
  }

  const config = server.mcp_config as unknown as Record<string, unknown>;
  const env: Record<string, string> = { ...stringRecord(config.env) };
  const userConfig: Record<string, McpbUserConfigEntry> = {};
  const [auth] = auths;
  if (auth) {
    const [authKey, method] = auth;
    const delivery = isRecord(method) && isRecord(method.delivery) ? method.delivery : {};
    if (delivery.http !== undefined || delivery.files !== undefined) {
      throw new McpbProjectionError(
        "mcpb_unsupported_auth",
        `auths.${authKey} delivers its credential over HTTP or as a file, which MCPB cannot carry`,
      );
    }
    const properties = credentialProperties(method);
    // Each credential field a value references becomes ONE user_config entry, named after the
    // field, so two variables fed the same credential ask the host for it once. It is always
    // sensitive: a credential is a secret whatever the delivery entry's own flag says, and the
    // import refuses a non-sensitive entry it cannot store.
    for (const [variable, entry] of Object.entries(isRecord(delivery.env) ? delivery.env : {})) {
      if (!isRecord(entry) || typeof entry.value !== "string") continue;
      env[variable] = entry.value.replace(CREDENTIAL_REF, (_, field: string) => {
        const property = properties[field];
        const title = typeof property?.title === "string" ? property.title : field;
        userConfig[field] = {
          type: "string",
          title,
          description: typeof property?.description === "string" ? property.description : title,
          sensitive: true,
          required: true,
        };
        return `\${user_config.${field}}`;
      });
    }
  }

  // Picked field by field: MCPB objects are `additionalProperties: false`, AFPS ones are loose.
  const overrides = isRecord(config.platform_overrides)
    ? Object.fromEntries(
        Object.entries(config.platform_overrides)
          .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
          .map(([platform, override]) => [platform, pickRun(override)]),
      )
    : undefined;
  const mcpConfig: McpbManifest["server"]["mcp_config"] = {
    ...pickRun(config, env),
    command: server.mcp_config.command,
    ...(overrides && Object.keys(overrides).length > 0 ? { platform_overrides: overrides } : {}),
  };
  const tools = server.tools;
  const displayName = typeof record.display_name === "string" ? record.display_name : undefined;
  const description =
    typeof record.description === "string" && record.description.length > 0
      ? record.description
      : (displayName ?? manifest.name);
  const icon =
    typeof record.icon === "string" && record.icon.endsWith(".png") && files.has(record.icon)
      ? record.icon
      : undefined;

  return {
    manifest_version: server.type === "uv" ? "0.4" : "0.3",
    name: bareName(manifest.name),
    ...(displayName ? { display_name: displayName } : {}),
    version: manifest.version,
    description,
    author: exportAuthor(record),
    ...(typeof record.license === "string" ? { license: record.license } : {}),
    ...(Array.isArray(record.keywords)
      ? { keywords: record.keywords.filter((k): k is string => typeof k === "string") }
      : {}),
    ...(icon ? { icon } : {}),
    server: { type: server.type, entry_point: server.entry_point, mcp_config: mcpConfig },
    ...(tools && tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
          })),
        }
      : {}),
    ...(Object.keys(userConfig).length > 0 ? { user_config: userConfig } : {}),
  };
}

function credentialProperties(method: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(method) || !isRecord(method.credentials)) return {};
  const schema = method.credentials.schema;
  if (!isRecord(schema) || !isRecord(schema.properties)) return {};
  return Object.fromEntries(
    Object.entries(schema.properties).filter((entry): entry is [string, Record<string, unknown>] =>
      isRecord(entry[1]),
    ),
  );
}

function pickAuthor(value: Record<string, unknown>): McpbAuthor | undefined {
  if (typeof value.name !== "string" || value.name.length === 0) return undefined;
  return {
    name: value.name,
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
  };
}

/** AFPS `author` is a string or `{ name, email?, url? }` (§3.1); MCPB's is always the object. */
function exportAuthor(record: Record<string, unknown>): McpbAuthor {
  if (isRecord(record.author)) {
    const author = pickAuthor(record.author);
    if (author) return author;
  }
  if (typeof record.author === "string" && record.author.length > 0) {
    return { name: record.author };
  }
  const meta = isRecord(record._meta) ? record._meta["dev.appstrate/package"] : undefined;
  if (isRecord(meta) && typeof meta.author === "string" && meta.author.length > 0) {
    return { name: meta.author };
  }
  // The `@scope` of the package name, without its at-sign.
  const scope = typeof record.name === "string" ? record.name.split("/")[0]?.replace(/^@/, "") : "";
  return { name: scope || "unknown" };
}

/**
 * Strict MCPB `manifest.json` → integration manifest (AFPS §7.1.1, import). The integration is
 * named `@<scope>/<mcpb name>`; sensitive `user_config` entries become one `custom` auth method's
 * credentials, delivered to the server through `delivery.env`.
 */
export function integrationFromMcpb(raw: unknown, scope: string): IntegrationManifest {
  const mcpb = readMcpb(raw);
  const userConfig = mcpb.user_config ?? {};
  const unsupported = (message: string): never => {
    throw new McpbProjectionError("mcpb_unsupported_user_config", message);
  };

  if (mcpb.compatibility?.platforms && !mcpb.compatibility.platforms.includes("linux")) {
    throw new McpbProjectionError(
      "mcpb_unsupported_platform",
      "compatibility.platforms does not include linux: a local server runs in a Linux runner",
    );
  }

  const sensitive = new Set<string>();
  for (const [key, entry] of Object.entries(userConfig)) {
    if (entry.multiple === true) {
      unsupported(`user_config.${key} is multiple: an integration has no list-valued setting`);
    }
    if (entry.sensitive === true) {
      if (entry.type !== "string") {
        unsupported(`user_config.${key} is sensitive but not a string: a credential is a string`);
      }
      if (!CREDENTIAL_FIELD.test(key)) {
        unsupported(
          `user_config.${key}: a credential field name is letters, digits and underscores only`,
        );
      }
      sensitive.add(key);
    } else if (entry.default === undefined) {
      unsupported(
        `user_config.${key} is not sensitive and has no default: an integration has no place to store it`,
      );
    }
  }

  /**
   * Inline the non-sensitive defaults of a value. A sensitive reference is refused unless
   * `credentialAllowed` (an `env` value of the top-level `mcp_config`: a credential reaches the
   * server through its environment only), where it is left for the caller to translate.
   */
  const inline = (value: string, where: string, credentialAllowed: boolean): string =>
    value.replace(USER_CONFIG_REF, (whole, key: string) => {
      const entry = userConfig[key];
      if (!entry) {
        throw new McpbProjectionError(
          "mcpb_invalid_manifest",
          `${where} references user_config.${key}, which the manifest does not declare`,
        );
      }
      if (sensitive.has(key)) {
        if (credentialAllowed) return whole;
        return unsupported(
          `${where} references the sensitive user_config.${key}: a credential reaches the server through its environment only`,
        );
      }
      return String(entry.default);
    });
  /** Env values are literal on the platform: nothing expands a placeholder left in one. */
  const assertLiteral = (value: string, where: string): void => {
    if (PLACEHOLDER.test(value)) {
      throw new McpbProjectionError(
        "mcpb_unsupported_placeholder",
        `${where} holds a placeholder (${PLACEHOLDER.exec(value)![0]}): environment values are literal and nothing expands them`,
      );
    }
  };
  /** `command` / `args` / `env` of one run object; placeholders stay in `command` and `args`. */
  const inlineRun = (run: McpbRun, where: string): McpbRun => {
    const out: McpbRun = {};
    if (run.command !== undefined) out.command = inline(run.command, `${where}.command`, false);
    if (run.args) out.args = run.args.map((arg) => inline(arg, `${where}.args`, false));
    if (run.env) {
      out.env = {};
      for (const [variable, value] of Object.entries(run.env)) {
        const inlined = inline(value, `${where}.env.${variable}`, false);
        assertLiteral(inlined, `${where}.env.${variable}`);
        out.env[variable] = inlined;
      }
    }
    return out;
  };

  const config = mcpb.server.mcp_config;
  const where = "server.mcp_config";
  const env: Record<string, string> = {};
  const deliveryEnv: Record<string, { value: string; sensitive: true }> = {};
  for (const [variable, value] of Object.entries(config.env ?? {})) {
    const at = `${where}.env.${variable}`;
    const inlined = inline(value, at, true);
    const translated = inlined.replace(USER_CONFIG_REF, (_, key: string) => `{$credential.${key}}`);
    assertLiteral(translated, at);
    if (translated !== inlined) deliveryEnv[variable] = { value: translated, sensitive: true };
    else env[variable] = inlined;
  }

  const mcpConfig: Record<string, unknown> = {
    ...inlineRun({ command: config.command, args: config.args }, where),
  };
  if (Object.keys(env).length > 0) mcpConfig.env = env;
  if (config.platform_overrides) {
    mcpConfig.platform_overrides = Object.fromEntries(
      Object.entries(config.platform_overrides).map(([platform, run]) => [
        platform,
        inlineRun(run, `${where}.platform_overrides.${platform}`),
      ]),
    );
  }
  if (mcpConfig.args && (mcpConfig.args as string[]).length === 0) delete mcpConfig.args;

  const name = `@${scope}/${packageSegment(mcpb.name)}`;
  const manifest: Record<string, unknown> = {
    name,
    version: mcpb.version,
    type: "integration",
    schema_version: AFPS_SCHEMA_VERSION,
    display_name: mcpb.display_name ?? mcpb.name,
    description: mcpb.description,
    author: mcpb.author,
    ...(mcpb.license ? { license: mcpb.license } : {}),
    ...(mcpb.keywords ? { keywords: mcpb.keywords } : {}),
    source: {
      kind: "local",
      server: {
        type: mcpb.server.type,
        entry_point: mcpb.server.entry_point,
        mcp_config: mcpConfig,
        ...(mcpb.tools && mcpb.tools.length > 0 ? { tools: mcpb.tools } : {}),
      },
    },
  };

  if (sensitive.size > 0) {
    const required = [...sensitive].filter((key) => userConfig[key]?.required === true);
    manifest.auths = {
      primary: {
        type: "custom",
        // An MCPB declares nothing about the hosts its server reaches: it runs with the network
        // access its host gives it. `allow_all_uris` says exactly that rather than inventing a list.
        allow_all_uris: true,
        credentials: {
          schema: {
            type: "object",
            properties: Object.fromEntries(
              [...sensitive].map((key) => {
                const entry = userConfig[key]!;
                return [
                  key,
                  {
                    type: "string",
                    title: entry.title,
                    ...(entry.description ? { description: entry.description } : {}),
                    writeOnly: true,
                  },
                ];
              }),
            ),
            ...(required.length > 0 ? { required } : {}),
          },
        },
        delivery: { env: deliveryEnv },
      },
    };
  }
  return manifest as unknown as IntegrationManifest;
}

/** Whether a parsed `manifest.json` is an MCPB manifest (it carries `manifest_version`, no AFPS `type`). */
export function isMcpbManifest(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    (typeof raw.manifest_version === "string" || typeof raw.dxt_version === "string") &&
    raw.type === undefined
  );
}

/**
 * Validate and pick the fields the import reads. Lenient on the version: any `manifest_version`
 * / `dxt_version` string is accepted, because the fields read here are stable across MCPB
 * versions; the writer, by contrast, emits exactly "0.3" or "0.4".
 */
function readMcpb(raw: unknown): McpbRead {
  const fail = (field: string, expected: string): never => {
    throw new McpbProjectionError("mcpb_invalid_manifest", `MCPB manifest: ${field} ${expected}`);
  };
  const readEnv = (value: unknown, field: string): Record<string, string> | undefined => {
    if (value === undefined) return undefined;
    if (!isRecord(value) || Object.values(value).some((v) => typeof v !== "string")) {
      return fail(field, "must be an object of strings");
    }
    return value as Record<string, string>;
  };
  const readRun = (value: Record<string, unknown>, field: string): McpbRun => {
    if (value.command !== undefined && typeof value.command !== "string") {
      fail(`${field}.command`, "must be a string");
    }
    if (value.args !== undefined && !stringArray(value.args)) {
      fail(`${field}.args`, "must be an array of strings");
    }
    const env = readEnv(value.env, `${field}.env`);
    return {
      ...(value.command !== undefined ? { command: value.command as string } : {}),
      ...(value.args !== undefined ? { args: value.args as string[] } : {}),
      ...(env ? { env } : {}),
    };
  };

  if (!isRecord(raw)) return fail("manifest.json", "must be a JSON object");
  if (typeof raw.name !== "string" || packageSegment(raw.name).length === 0) {
    return fail("name", "must be a non-empty string");
  }
  if (typeof raw.version !== "string") return fail("version", "must be a string");
  if (typeof raw.description !== "string") return fail("description", "must be a string");
  const author = isRecord(raw.author) ? pickAuthor(raw.author) : undefined;
  if (!author) return fail("author.name", "must be a string");
  const server = raw.server;
  if (!isRecord(server)) return fail("server", "must be an object");
  if (typeof server.type !== "string") return fail("server.type", "must be a string");
  if (typeof server.entry_point !== "string") return fail("server.entry_point", "must be a string");
  if (!isRecord(server.mcp_config) || typeof server.mcp_config.command !== "string") {
    return fail("server.mcp_config.command", "must be a string");
  }
  const run = readRun(server.mcp_config, "server.mcp_config");
  const overrides = server.mcp_config.platform_overrides;
  if (overrides !== undefined && !isRecord(overrides)) {
    return fail("server.mcp_config.platform_overrides", "must be an object");
  }
  const platformOverrides = Object.entries(overrides ?? {}).map(([platform, value]) => {
    const field = `server.mcp_config.platform_overrides.${platform}`;
    if (!isRecord(value)) return fail(field, "must be an object");
    return [platform, readRun(value, field)] as const;
  });

  const userConfig = raw.user_config;
  if (userConfig !== undefined && !isRecord(userConfig)) {
    return fail("user_config", "must be an object");
  }
  const entries = Object.entries(userConfig ?? {}).map(([key, entry]) => {
    if (!isRecord(entry) || typeof entry.title !== "string") {
      return fail(`user_config.${key}.title`, "must be a string");
    }
    return [
      key,
      {
        ...(typeof entry.type === "string" ? { type: entry.type } : {}),
        title: entry.title,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(typeof entry.required === "boolean" ? { required: entry.required } : {}),
        ...(typeof entry.sensitive === "boolean" ? { sensitive: entry.sensitive } : {}),
        ...(typeof entry.multiple === "boolean" ? { multiple: entry.multiple } : {}),
        ...(entry.default !== undefined ? { default: entry.default } : {}),
      },
    ] as const;
  });

  const tools = raw.tools;
  if (
    tools !== undefined &&
    (!Array.isArray(tools) || tools.some((t) => !isRecord(t) || typeof t.name !== "string"))
  ) {
    return fail("tools", "must be an array of { name, description? }");
  }
  const compatibility = raw.compatibility;
  let platforms: string[] | undefined;
  if (isRecord(compatibility) && compatibility.platforms !== undefined) {
    platforms = stringArray(compatibility.platforms);
    if (!platforms) return fail("compatibility.platforms", "must be an array of strings");
  }
  const version =
    typeof raw.manifest_version === "string"
      ? raw.manifest_version
      : typeof raw.dxt_version === "string"
        ? raw.dxt_version
        : undefined;

  return {
    ...(version ? { manifest_version: version } : {}),
    name: raw.name,
    ...(typeof raw.display_name === "string" ? { display_name: raw.display_name } : {}),
    version: raw.version,
    description: raw.description,
    author,
    ...(typeof raw.license === "string" ? { license: raw.license } : {}),
    ...(Array.isArray(raw.keywords)
      ? { keywords: raw.keywords.filter((k): k is string => typeof k === "string") }
      : {}),
    server: {
      type: server.type,
      entry_point: server.entry_point,
      mcp_config: {
        ...run,
        command: server.mcp_config.command,
        ...(platformOverrides.length > 0
          ? { platform_overrides: Object.fromEntries(platformOverrides) }
          : {}),
      },
    },
    ...(tools
      ? {
          tools: (tools as { name: string; description?: unknown }[]).map((tool) => ({
            name: tool.name,
            ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          })),
        }
      : {}),
    ...(entries.length > 0 ? { user_config: Object.fromEntries(entries) } : {}),
    ...(platforms ? { compatibility: { platforms } } : {}),
  };
}
