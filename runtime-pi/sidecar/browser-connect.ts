// SPDX-License-Identifier: Apache-2.0

import { resolveAfpsHttpDelivery, type AfpsHttpDelivery } from "@appstrate/connect/afps-delivery";
import type { BrowserAcquisitionResult } from "@appstrate/connect/connect";
import type { BrowserConnectSpec, BrowserExecutionSpec } from "@appstrate/core/sidecar-types";

import type { BrowserHandle } from "./browser-provider.ts";
import type { IntegrationCredentialsSource } from "./integration-credentials-source.ts";
import type { McpHost } from "./mcp-host.ts";

const MAX_BROWSER_RESULT_BYTES = 1024 * 1024;
const SAFE_BROWSER_ERROR_CODES = new Set([
  "BROWSER_UNAVAILABLE",
  "BROWSER_UNSUPPORTED_REVISION",
  "BROWSER_POLICY_DENIED",
  "BROWSER_PROXY_UNAVAILABLE",
  "BROWSER_NAVIGATION_TIMEOUT",
  "BROWSER_CRASHED",
  "BROWSER_AUTH_REQUIRED",
  "BROWSER_INTERACTION_REQUIRED",
  "BROWSER_STATE_CONFLICT",
  "BROWSER_SESSION_BUSY",
  "BROWSER_RESOURCE_LIMIT",
]);

/** Return a metadata-only browser error; arbitrary driver text may contain secrets. */
export function browserSafeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const candidate = message.match(/\bBROWSER_[A-Z_]+\b/)?.[0];
  return candidate && SAFE_BROWSER_ERROR_CODES.has(candidate) ? candidate : "BROWSER_UNAVAILABLE";
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`browser-connect: '${field}' must be a string map`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 256) {
    throw new Error(`browser-connect: '${field}' contains too many values`);
  }
  let totalBytes = 0;
  for (const [key, entry] of entries) {
    if (
      key.length === 0 ||
      key.length > 128 ||
      typeof entry !== "string" ||
      entry.length > 1_048_576
    ) {
      throw new Error(`browser-connect: '${field}.${key}' is not a bounded string`);
    }
    totalBytes += Buffer.byteLength(key) + Buffer.byteLength(entry);
    if (totalBytes > MAX_BROWSER_RESULT_BYTES) {
      throw new Error(`browser-connect: '${field}' exceeds the result size limit`);
    }
  }
  // Object.fromEntries defines `__proto__` as an own property instead of
  // invoking Object.prototype's legacy setter on untrusted driver output.
  return Object.fromEntries(entries) as Record<string, string>;
}

export function parseBrowserAcquisitionResult(
  result: { content?: Array<{ type: string; text?: string }>; isError?: boolean },
  produces: readonly string[],
  sessionMode: BrowserConnectSpec["sessionMode"],
): BrowserAcquisitionResult {
  const first = result.content?.[0];
  if (result.isError) {
    const safeCode =
      first?.type === "text" && typeof first.text === "string"
        ? browserSafeErrorCode(first.text)
        : "BROWSER_UNAVAILABLE";
    throw new Error(safeCode);
  }
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("browser-connect: driver returned an error or no text result");
  }
  if (Buffer.byteLength(first.text) > MAX_BROWSER_RESULT_BYTES) {
    throw new Error("browser-connect: driver result exceeds the size limit");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(first.text);
  } catch {
    throw new Error("browser-connect: driver result is not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("browser-connect: driver result must be an object");
  }
  const object = raw as Record<string, unknown>;
  const allowedFields = new Set([
    "outputs",
    "proof",
    "identity_claims",
    "scopes_granted",
    "expires_at",
  ]);
  const unknownField = Object.keys(object).find((key) => !allowedFields.has(key));
  if (unknownField) {
    throw new Error(`browser-connect: driver result contains unknown field '${unknownField}'`);
  }
  const proof = object.proof as Record<string, unknown> | undefined;
  if (
    !proof ||
    typeof proof !== "object" ||
    Array.isArray(proof) ||
    Object.keys(proof).some((key) => key !== "kind" && key !== "succeeded") ||
    typeof proof.kind !== "string" ||
    proof.kind.length === 0 ||
    proof.kind.length > 128 ||
    proof.succeeded !== true
  ) {
    throw new Error("BROWSER_AUTH_REQUIRED: authenticated proof did not succeed");
  }
  const outputs = stringMap(object.outputs ?? {}, "outputs");
  const allowed = new Set(produces);
  for (const key of Object.keys(outputs)) {
    if (!allowed.has(key)) {
      throw new Error(`browser-connect: driver produced undeclared output '${key}'`);
    }
  }
  if (sessionMode === "exportable" && Object.keys(outputs).length === 0) {
    throw new Error("browser-connect: exportable acquisition returned empty outputs");
  }
  const identityClaims =
    object.identity_claims === undefined
      ? undefined
      : stringMap(object.identity_claims, "identity_claims");
  let scopesGranted: string[] | undefined;
  if (object.scopes_granted !== undefined) {
    if (
      !Array.isArray(object.scopes_granted) ||
      object.scopes_granted.length > 256 ||
      object.scopes_granted.some(
        (scope) => typeof scope !== "string" || scope.length === 0 || scope.length > 256,
      )
    ) {
      throw new Error("browser-connect: 'scopes_granted' must be a bounded string array");
    }
    scopesGranted = object.scopes_granted;
  }
  if (
    object.expires_at !== undefined &&
    typeof object.expires_at !== "string" &&
    object.expires_at !== null
  ) {
    throw new Error("browser-connect: 'expires_at' must be a valid timestamp or null");
  }
  const expiresAt = object.expires_at as string | null | undefined;
  if (typeof expiresAt === "string" && !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error("browser-connect: 'expires_at' must be a valid timestamp or null");
  }
  return {
    outputs,
    proof: { kind: proof.kind, succeeded: true },
    ...(identityClaims ? { identityClaims } : {}),
    ...(scopesGranted ? { scopesGranted } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

export async function runBrowserConnect(options: {
  host: McpHost;
  namespace: string;
  connect: BrowserConnectSpec;
  browserSpec: BrowserExecutionSpec;
  browser: BrowserHandle;
  source?: IntegrationCredentialsSource | null;
  /** Link-time acquisition returns the bundle to the API instead of installing it in-run. */
  installExportedSession?: boolean;
  /** Secret-free stage marker for operator diagnostics. */
  onStage?: (stage: string) => void;
}): Promise<BrowserAcquisitionResult> {
  options.onStage?.("session-driver-call");
  const client = options.host.getUpstreamClient(options.namespace);
  if (!client) throw new Error("browser-connect: trusted driver client is unavailable");
  if (!options.browserSpec.trustedDriver || !options.browserSpec.driverGrantId) {
    throw new Error(
      "browser-connect: resolved driver is not authorized for secret-aware execution",
    );
  }

  // This is a private sidecar→driver invocation. The tool is excluded from the
  // agent-facing host and the endpoint/token/inputs never enter runner env,
  // argv, URLs, logs, or the agent MCP surface in connection-acquisition mode.
  const raw = await client.callTool(
    {
      name: options.connect.toolName,
      arguments: {
        browser_endpoint: options.browser.endpoint,
        browser_token: options.browser.authToken,
        inputs: options.connect.inputs,
        allowed_origins: options.browserSpec.allowedOrigins,
        session_mode: options.connect.sessionMode,
      },
    },
    {},
  );
  options.onStage?.("session-result-parse");
  const result = parseBrowserAcquisitionResult(
    raw,
    options.connect.produces,
    options.connect.sessionMode,
  );

  if (options.connect.sessionMode === "exportable" && options.installExportedSession !== false) {
    options.onStage?.("session-install");
    if (!options.source || !options.connect.deliveryHttp) {
      throw new Error("browser-connect: exportable acquisition has no injectable delivery source");
    }
    const plan = resolveAfpsHttpDelivery(
      options.connect.authType,
      result.outputs,
      options.connect.deliveryHttp as unknown as AfpsHttpDelivery,
    );
    if (!plan) throw new Error("browser-connect: exported session resolved to no delivery plan");
    options.source.setSessionOutputs(
      {
        authKey: options.connect.authKey,
        authType: options.connect.authType,
        fields: result.outputs,
        authorizedUris: [...options.connect.authorizedUris],
        ...(result.identityClaims ? { identityClaims: result.identityClaims } : {}),
        ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
      },
      plan,
    );
  }
  return result;
}
