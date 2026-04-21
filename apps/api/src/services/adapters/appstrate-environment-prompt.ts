// SPDX-License-Identifier: Apache-2.0

/**
 * `@appstrate/environment` — the platform-identity prelude.
 *
 * This module holds the source-of-truth Mustache template for what every
 * agent running on Appstrate receives in front of its own prompt. It is
 * served to the runtime by {@link AppstrateEnvironmentPreludeResolver}
 * when an agent's manifest declares `systemPreludes` referencing
 * `@appstrate/environment@…`.
 *
 * The template is logic-less Mustache (Mustache v5 / mustache.js spec).
 * Section semantics used here:
 *
 *   - `{{#foo}}…{{/foo}}`  — renders block if `foo` is truthy; iterates
 *     if `foo` is an array (block is rendered once per element, with
 *     the element as context).
 *   - `{{^foo}}…{{/foo}}`  — renders block if `foo` is falsy/empty.
 *
 * Because Mustache does not evaluate `array.length`, we pass explicit
 * boolean flags (`hasProviders`, `hasUploads`, `hasTimeout`) alongside
 * the raw arrays. Flags come from the prompt-view adapter in apps/api;
 * they are Appstrate-specific derived fields, not part of the runtime's
 * canonical {@link PromptView}.
 */

/**
 * Version currently shipped with this Appstrate build. Bump when the
 * prose changes in a way that agents would observe. The resolver is
 * tolerant of any semver range that matches — platforms can pin or
 * track `^1`.
 */
export const APPSTRATE_ENVIRONMENT_VERSION = "1.0.0";
export const APPSTRATE_ENVIRONMENT_NAME = "@appstrate/environment";

/**
 * Mustache template rendered against the full {@link PromptView} plus
 * Appstrate-specific derived flags (see {@link AppstratePreludeFlags}).
 *
 * Bytes here are intentionally aligned with what `buildEnrichedPrompt`
 * produced before the prelude migration so the model sees the same
 * environment description and behaviour stays stable across the cut-over.
 */
export const APPSTRATE_ENVIRONMENT_PROMPT = `## System

You are an AI agent running on the Appstrate platform.
You execute a specific task inside an isolated, ephemeral container.

### Environment
- **Ephemeral container**: This container is destroyed when your run ends. Any files you create, modifications you make, or data you store on the filesystem will be permanently lost. Do NOT rely on the filesystem for persistence.
- **Network access**: Outbound HTTP/HTTPS is available. Use \`curl\`, \`fetch\`, or any HTTP client to call public APIs and websites directly. Only authenticated requests to connected providers require the sidecar credential proxy (\`$SIDECAR_URL/proxy\`) — see **Authenticated Provider API** below.
{{#platform.hasTimeout}}- **Timeout**: You have {{timeout}} seconds to complete this task. Work efficiently and output your result promptly.
{{/platform.hasTimeout}}- **Workspace**: Your current working directory is the agent workspace. Uploaded documents are available under \`./documents/\` (relative to cwd). You may use the filesystem for temporary processing during this run only.

{{#platform.hasProviders}}## Authenticated Provider API

The sidecar credential proxy at \`$SIDECAR_URL/proxy\` injects the user's credentials into requests to connected provider APIs. You never see or handle raw tokens.

**Use this proxy ONLY for requests to connected providers listed below.** For public endpoints (no authentication required), call them directly with \`curl\` or \`fetch\` — do not route them through the sidecar.

Required headers:
- \`X-Provider\`: the provider ID (see list below)
- \`X-Target\`: the target URL (must match the provider's authorized URLs)
- All other headers and the body are forwarded as-is to the target
- Use \`{{variable}}\` placeholders in \`X-Target\` and headers — they are replaced with real credentials at request time
- Add \`X-Substitute-Body: true\` if the request body also contains \`{{variable}}\` placeholders

The proxy returns the upstream response as-is. Truncation (>50 KB) is signaled via \`X-Truncated: true\`. Sidecar-specific errors return JSON \`{ "error": "..." }\` with a 4xx/5xx status. The proxy maintains a cookie jar per provider — \`Set-Cookie\` headers are stored automatically.

### Connected Providers

{{/platform.hasProviders}}{{#providers}}- **{{displayName}}** (provider ID: \`{{id}}\`){{#authMode}} — auth mode: {{.}}{{/authMode}}
{{/providers}}
{{#platform.hasUploads}}## Documents

The following documents have been uploaded and are available on the local filesystem:

{{/platform.hasUploads}}{{#uploads}}- **{{name}}**{{#type}} ({{.}}){{/type}} → \`{{path}}\`
{{/uploads}}{{#platform.hasUploads}}
Read the documents directly from the filesystem (paths are relative to cwd).

{{/platform.hasUploads}}`;

/**
 * Appstrate-specific flags injected into the PromptView's `platform`
 * bag so the environment prelude can gate section headers with
 * logic-less Mustache. Kept separate from the runtime's canonical
 * PromptView so external runners are not forced to populate them.
 */
export interface AppstratePreludeFlags {
  hasTimeout: boolean;
  hasProviders: boolean;
  hasUploads: boolean;
  hasConfig: boolean;
  hasMemories: boolean;
  hasState: boolean;
}

export function buildAppstratePreludeFlags(view: {
  providers?: readonly unknown[];
  uploads?: readonly unknown[];
  timeout?: number;
  config?: Record<string, unknown>;
  memories?: readonly unknown[];
  state?: unknown;
}): AppstratePreludeFlags {
  return {
    hasTimeout: view.timeout !== undefined,
    hasProviders: !!view.providers && view.providers.length > 0,
    hasUploads: !!view.uploads && view.uploads.length > 0,
    hasConfig: !!view.config && Object.keys(view.config).length > 0,
    hasMemories: !!view.memories && view.memories.length > 0,
    hasState: view.state !== null && view.state !== undefined,
  };
}
