// SPDX-License-Identifier: Apache-2.0

/**
 * Build the {@link ProviderResolver} used by `appstrate run`.
 *
 * Three modes, one per semantic:
 *
 *   - `remote` — default. Delegates every provider call through the
 *     pinned Appstrate instance's `/api/credential-proxy/proxy`
 *     endpoint. Credentials stay server-side; the CLI sends only
 *     scope markers. Accepts either:
 *       * an `ask_…` API key (headless CI / GitHub Action) with the
 *         `credential-proxy:call` scope, or
 *       * a device-flow JWT access token from `appstrate login`
 *         (interactive CLI) whose user role grants the same permission.
 *     Either way the credential flows as a single `Authorization:
 *     Bearer <token>` header — see `apps/cli/src/commands/run.ts` for
 *     the resolution priority.
 *
 *   - `local`  — reads a local JSON creds file for offline runs.
 *     Credentials are plaintext on disk; the CLI never refreshes
 *     OAuth tokens here. Intended for air-gapped development only.
 *
 *   - `none`   — returns an empty tool list. For agents that declare
 *     no provider dependencies.
 */

import type { ProviderResolver } from "@appstrate/afps-runtime/resolvers";
import {
  LocalProviderResolver,
  RemoteAppstrateProviderResolver,
} from "@appstrate/afps-runtime/resolvers";

export type ProviderMode = "remote" | "local" | "none";

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
  appId: string;
  endUserId?: string;
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
 * Build a ProviderResolver matching the requested mode. Each mode's
 * pre-conditions are checked upfront: we'd rather fail here than
 * surface a confusing resolver error mid-run.
 */
export function buildResolver(
  mode: ProviderMode,
  inputs: RemoteResolverInputs | LocalResolverInputs | null,
): ProviderResolver {
  switch (mode) {
    case "none":
      return { resolve: async () => [] };

    case "local": {
      const local = inputs as LocalResolverInputs | null;
      if (!local?.credsFilePath) {
        throw new ResolverConfigError(
          "--providers=local requires --creds-file <path>",
          "Pass a JSON file with { version: 1, providers: {…} }",
        );
      }
      return new LocalProviderResolver({ creds: local.credsFilePath });
    }

    case "remote": {
      const remote = inputs as RemoteResolverInputs | null;
      if (!remote) {
        throw new ResolverConfigError(
          "--providers=remote requires a logged-in profile or an API key",
          "Run `appstrate login`, or set APPSTRATE_API_KEY + APPSTRATE_INSTANCE + APPSTRATE_APP_ID",
        );
      }
      if (!remote.instance || !remote.bearerToken || !remote.appId) {
        throw new ResolverConfigError(
          "--providers=remote requires instance + bearerToken + appId",
          "Ensure your profile has an appId set (run `appstrate app switch`) and a usable session (run `appstrate login`)",
        );
      }
      return new RemoteAppstrateProviderResolver({
        instance: remote.instance,
        apiKey: remote.bearerToken,
        appId: remote.appId,
        endUserId: remote.endUserId,
      });
    }
  }
}

export function parseProviderMode(raw: string | undefined): ProviderMode {
  const value = raw ?? "remote";
  if (value !== "remote" && value !== "local" && value !== "none") {
    throw new ResolverConfigError(
      `Invalid --providers value "${value}"`,
      "Accepted: remote | local | none",
    );
  }
  return value;
}
