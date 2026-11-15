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
 * credential referenced from `mcp_config.args`, a non-sensitive setting with no default (import).
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
  | "mcpb_unsupported_user_config";

/** The strict MCPB `manifest.json` fields this projection reads or writes. */
export interface McpbManifest {
  manifest_version: "0.3" | "0.4";
  name: string;
  display_name?: string;
  version: string;
  description: string;
  author: { name: string; email?: string; url?: string };
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
      platform_overrides?: Record<string, unknown>;
    };
  };
  tools?: { name: string; description?: string }[];
  user_config?: Record<string, McpbUserConfigEntry>;
}

export interface McpbUserConfigEntry {
  type: "string" | "number" | "boolean" | "directory" | "file";
  title: string;
  description: string;
  required?: boolean;
  sensitive?: boolean;
  default?: unknown;
}

const USER_CONFIG_REF = /\$\{user_config\.([^}]+)\}/g;
const CREDENTIAL_REF = /\{\$credential\.([A-Za-z0-9_]+)\}/g;
const CREDENTIAL_FIELD = /^[A-Za-z0-9_]+$/;

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
      "Only an integration whose source.kind is local has an MCPB form",
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

  const env: Record<string, string> = { ...stringRecord(server.mcp_config.env) };
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
    // field, so two variables fed the same credential ask the host for it once.
    for (const [variable, entry] of Object.entries(isRecord(delivery.env) ? delivery.env : {})) {
      if (!isRecord(entry) || typeof entry.value !== "string") continue;
      env[variable] = entry.value.replace(CREDENTIAL_REF, (_, field: string) => {
        const property = properties[field];
        const title = typeof property?.title === "string" ? property.title : field;
        const sensitive = entry.sensitive === true || userConfig[field]?.sensitive === true;
        userConfig[field] = {
          type: "string",
          title,
          description: typeof property?.description === "string" ? property.description : title,
          sensitive,
          required: true,
        };
        return `\${user_config.${field}}`;
      });
    }
  }

  const mcpConfig = { ...server.mcp_config };
  if (Object.keys(env).length > 0) mcpConfig.env = env;
  else delete mcpConfig.env;
  const { tools, ...run } = server;
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
    author: { name: authorName(record) },
    ...(typeof record.license === "string" ? { license: record.license } : {}),
    ...(Array.isArray(record.keywords)
      ? { keywords: record.keywords.filter((k): k is string => typeof k === "string") }
      : {}),
    ...(icon ? { icon } : {}),
    server: { ...run, mcp_config: mcpConfig },
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

function authorName(record: Record<string, unknown>): string {
  if (typeof record.author === "string" && record.author.length > 0) return record.author;
  const meta = isRecord(record._meta) ? record._meta["dev.appstrate/package"] : undefined;
  if (isRecord(meta) && typeof meta.author === "string" && meta.author.length > 0) {
    return meta.author;
  }
  return typeof record.name === "string" ? (record.name.split("/")[0] ?? record.name) : "unknown";
}

/**
 * Strict MCPB `manifest.json` → integration manifest (AFPS §7.1.1, import). The integration is
 * named `@<scope>/<mcpb name>`; sensitive `user_config` entries become one `custom` auth method's
 * credentials, delivered to the server through `delivery.env`.
 */
export function integrationFromMcpb(raw: unknown, scope: string): IntegrationManifest {
  const mcpb = readMcpb(raw);
  const userConfig = mcpb.user_config ?? {};
  const sensitive = new Set(
    Object.entries(userConfig)
      .filter(([, entry]) => entry.sensitive === true)
      .map(([key]) => key),
  );
  for (const key of sensitive) {
    if (!CREDENTIAL_FIELD.test(key)) {
      throw new McpbProjectionError(
        "mcpb_unsupported_user_config",
        `user_config.${key}: a credential field name is letters, digits and underscores only`,
      );
    }
  }
  for (const [key, entry] of Object.entries(userConfig)) {
    if (!sensitive.has(key) && entry.default === undefined) {
      throw new McpbProjectionError(
        "mcpb_unsupported_user_config",
        `user_config.${key} is not sensitive and has no default: an integration has no place to store it`,
      );
    }
  }

  /** Inline a non-sensitive default; a sensitive reference is left for the caller to translate. */
  const inlineDefaults = (value: string): string =>
    value.replace(USER_CONFIG_REF, (whole, key: string) =>
      sensitive.has(key) ? whole : String(userConfig[key]?.default ?? whole),
    );
  const refersToCredential = (value: string): boolean =>
    [...value.matchAll(USER_CONFIG_REF)].some((match) => sensitive.has(match[1]!));

  const args = (mcpb.server.mcp_config.args ?? []).map((arg) => {
    if (refersToCredential(arg)) {
      throw new McpbProjectionError(
        "mcpb_unsupported_user_config",
        "server.mcp_config.args references a sensitive user_config entry: a credential reaches the server through its environment only",
      );
    }
    return inlineDefaults(arg);
  });

  const env: Record<string, string> = {};
  const deliveryEnv: Record<string, { value: string; sensitive: true }> = {};
  for (const [variable, value] of Object.entries(mcpb.server.mcp_config.env ?? {})) {
    const inlined = inlineDefaults(value);
    if (refersToCredential(inlined)) {
      deliveryEnv[variable] = {
        value: inlined.replace(USER_CONFIG_REF, (_, key: string) => `{$credential.${key}}`),
        sensitive: true,
      };
    } else {
      env[variable] = inlined;
    }
  }

  const mcpConfig: Record<string, unknown> = { command: mcpb.server.mcp_config.command };
  if (args.length > 0) mcpConfig.args = args;
  if (Object.keys(env).length > 0) mcpConfig.env = env;
  if (mcpb.server.mcp_config.platform_overrides) {
    mcpConfig.platform_overrides = mcpb.server.mcp_config.platform_overrides;
  }

  const name = `@${scope}/${packageSegment(mcpb.name)}`;
  const manifest: Record<string, unknown> = {
    name,
    version: mcpb.version,
    type: "integration",
    schema_version: AFPS_SCHEMA_VERSION,
    display_name: mcpb.display_name ?? mcpb.name,
    description: mcpb.description,
    author: mcpb.author.name,
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

function readMcpb(raw: unknown): McpbManifest {
  const fail = (field: string, expected: string): never => {
    throw new McpbProjectionError("mcpb_invalid_manifest", `MCPB manifest: ${field} ${expected}`);
  };
  if (!isRecord(raw)) return fail("manifest.json", "must be a JSON object");
  if (typeof raw.name !== "string" || packageSegment(raw.name).length === 0) {
    return fail("name", "must be a non-empty string");
  }
  if (typeof raw.version !== "string") return fail("version", "must be a string");
  if (typeof raw.description !== "string") return fail("description", "must be a string");
  if (!isRecord(raw.author) || typeof raw.author.name !== "string") {
    return fail("author.name", "must be a string");
  }
  const server = raw.server;
  if (!isRecord(server)) return fail("server", "must be an object");
  if (typeof server.type !== "string") return fail("server.type", "must be a string");
  if (typeof server.entry_point !== "string") return fail("server.entry_point", "must be a string");
  if (!isRecord(server.mcp_config) || typeof server.mcp_config.command !== "string") {
    return fail("server.mcp_config.command", "must be a string");
  }
  const args = server.mcp_config.args;
  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) {
    return fail("server.mcp_config.args", "must be an array of strings");
  }
  const userConfig = raw.user_config;
  if (userConfig !== undefined && !isRecord(userConfig)) {
    return fail("user_config", "must be an object");
  }
  for (const [key, entry] of Object.entries(userConfig ?? {})) {
    if (!isRecord(entry) || typeof entry.title !== "string") {
      return fail(`user_config.${key}.title`, "must be a string");
    }
  }
  const tools = raw.tools;
  if (
    tools !== undefined &&
    (!Array.isArray(tools) || tools.some((t) => !isRecord(t) || typeof t.name !== "string"))
  ) {
    return fail("tools", "must be an array of { name, description? }");
  }
  return {
    ...(raw as unknown as McpbManifest),
    tools: (tools as { name: string; description?: unknown }[] | undefined)?.map((tool) => ({
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    })),
    server: {
      type: server.type,
      entry_point: server.entry_point,
      mcp_config: {
        command: server.mcp_config.command,
        ...(args ? { args: args as string[] } : {}),
        env: stringRecord(server.mcp_config.env),
        ...(isRecord(server.mcp_config.platform_overrides)
          ? { platform_overrides: server.mcp_config.platform_overrides }
          : {}),
      },
    },
  };
}
