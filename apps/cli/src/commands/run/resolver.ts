// SPDX-License-Identifier: Apache-2.0

/**
 * Build the {@link IntegrationApiCallResolver} used by `appstrate run`.
 *
 * Serverless `apiCall` integrations (the unified integration
 * surface) are exposed to the agent as `{ns}__api_call` tools. Three
 * modes, one per semantic:
 *
 *   - `remote` — default. Delegates every `api_call` through the pinned
 *     Appstrate instance's `/api/credential-proxy/proxy` endpoint, with
 *     the integration id as the `X-Integration` scope marker. Credentials
 *     stay server-side; the CLI sends only scope markers. Accepts either:
 *       * an `ask_…` API key (headless CI / GitHub Action) with the
 *         `credential-proxy:call` scope, or
 *       * a device-flow JWT access token from `appstrate login`
 *         (interactive CLI) whose user role grants the same permission.
 *     Either way the credential flows as a single `Authorization:
 *     Bearer <token>` header — see `apps/cli/src/commands/run.ts` for
 *     the resolution priority.
 *
 *   - `local`  — reads a local JSON creds file (integration-keyed) for
 *     offline runs. Credentials are plaintext on disk; the CLI never
 *     refreshes OAuth tokens here. Intended for air-gapped development.
 *
 *   - `none`   — returns an empty tool list. For agents that declare
 *     no integration dependencies.
 */

import type { IntegrationApiCallResolver } from "@appstrate/afps-runtime/resolvers";
import {
  LocalIntegrationResolver,
  RemoteAppstrateIntegrationResolver,
} from "@appstrate/afps-runtime/resolvers";

export type IntegrationMode = "remote" | "local" | "none";

export interface RemoteResolverInputs {
  instance: string;
  /**
   * Bearer token used to authenticate against the Appstrate instance.
   * Either an `ask_…` API key (headless) or a device-flow JWT access
   * token (interactive CLI). The afps-runtime resolver treats both
   * identically — it forwards the value as-is in the `Authorization:
   * Bearer …` header and lets the platform decide.
   */
  bearerToken: string;
  applicationId: string;
  /**
   * Org id pinned on the profile (interactive) or passed via
   * `APPSTRATE_ORG_ID` (headless). Required for JWT auth on routes that
   * `deferOrgResolution` (e.g. `/api/llm-proxy/*`). Optional for API-key
   * auth — those pre-resolve the org inline.
   */
  orgId?: string;
  endUserId?: string;
  /**
   * Extra headers attached to every credential-proxy call (e.g.
   * `X-Run-Id` when `--report` is active). Forwarded verbatim by
   * {@link RemoteAppstrateIntegrationResolver}.
   */
  extraHeaders?: Record<string, string>;
}

export interface LocalResolverInputs {
  credsFilePath: string;
}

export class ResolverConfigError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "ResolverConfigError";
  }
}

/**
 * Build an {@link IntegrationApiCallResolver} matching the requested mode.
 * Serverless `apiCall` integrations (the unified integration
 * shape) get credential-injected HTTP calls; the resolver yields one
 * `{ns}__api_call` tool per integration. Each mode's pre-conditions are
 * checked upfront: we'd rather fail here than surface a confusing resolver
 * error mid-run.
 */
export function buildIntegrationResolver(
  mode: IntegrationMode,
  inputs: RemoteResolverInputs | LocalResolverInputs | null,
): IntegrationApiCallResolver {
  switch (mode) {
    case "none":
      return { resolve: async () => [] };

    case "local": {
      const local = inputs as LocalResolverInputs | null;
      if (!local?.credsFilePath) {
        throw new ResolverConfigError(
          "--integrations=local requires --creds-file <path>",
          "Pass a JSON file with { version: 1, integrations: {…} }",
        );
      }
      return new LocalIntegrationResolver({ creds: local.credsFilePath });
    }

    case "remote": {
      const remote = inputs as RemoteResolverInputs | null;
      if (!remote) {
        throw new ResolverConfigError(
          "--integrations=remote requires a logged-in profile or an API key",
          "Run `appstrate login`, or set APPSTRATE_API_KEY + APPSTRATE_INSTANCE + APPSTRATE_APP_ID",
        );
      }
      if (!remote.instance || !remote.bearerToken || !remote.applicationId) {
        throw new ResolverConfigError(
          "--integrations=remote requires instance + bearerToken + applicationId",
          "Ensure your profile has an applicationId set (run `appstrate app switch`) and a usable session (run `appstrate login`)",
        );
      }
      return new RemoteAppstrateIntegrationResolver({
        instance: remote.instance,
        apiKey: remote.bearerToken,
        applicationId: remote.applicationId,
        ...(remote.orgId ? { orgId: remote.orgId } : {}),
        endUserId: remote.endUserId,
        extraHeaders: remote.extraHeaders,
      });
    }
  }
}

export function parseIntegrationMode(raw: string | undefined): IntegrationMode {
  const value = raw ?? "remote";
  if (value !== "remote" && value !== "local" && value !== "none") {
    throw new ResolverConfigError(
      `Invalid --integrations value "${value}"`,
      "Accepted: remote | local | none",
    );
  }
  return value;
}
