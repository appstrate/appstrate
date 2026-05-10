// SPDX-License-Identifier: Apache-2.0

/**
 * Compatibility check: the AFPS manifests for the OAuth model
 * provider built-ins (Codex + Claude Code) must align with the runtime
 * registry on the fields that gate execution:
 *
 *   - `name` ↔ registry key (the `packageId` lookup hinges on this)
 *   - `definition.authMode === "oauth2"` (the platform refuses non-oauth manifests)
 *   - `definition.oauth2.tokenUrl` ↔ token-resolver's PROVIDER_TOKEN_URL
 *     (refresh would silently 404 against the wrong host)
 *   - `definition.oauth2.defaultScopes` ⊆ registry `scopes`
 *
 * The manifests are loaded from disk so a future PR cannot drift them
 * out of sync without breaking this test.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OAUTH_MODEL_PROVIDERS } from "../../../src/services/oauth-model-providers/registry.ts";

interface ProviderManifest {
  name: string;
  type: string;
  definition: {
    authMode: string;
    oauth2?: {
      authorizationUrl: string;
      tokenUrl: string;
      defaultScopes?: string[];
      pkceEnabled?: boolean;
    };
  };
}

const MANIFEST_PATHS: Record<string, string> = {
  "@appstrate/provider-codex": "scripts/system-packages/provider-codex-1.0.0/manifest.json",
  "@appstrate/provider-claude-code":
    "scripts/system-packages/provider-claude-code-1.0.0/manifest.json",
};

const REPO_ROOT = join(import.meta.dir, "../../../../../..");

function loadManifest(packageId: string): ProviderManifest {
  const path = join(REPO_ROOT, "appstrate", MANIFEST_PATHS[packageId]!);
  return JSON.parse(readFileSync(path, "utf-8")) as ProviderManifest;
}

const TOKEN_URL_BY_PACKAGE_ID: Record<string, string> = {
  "@appstrate/provider-codex": "https://auth.openai.com/oauth/token",
  "@appstrate/provider-claude-code": "https://platform.claude.com/v1/oauth/token",
};

describe("OAuth model provider AFPS manifests", () => {
  for (const packageId of Object.keys(MANIFEST_PATHS)) {
    describe(packageId, () => {
      const manifest = loadManifest(packageId);

      it("has matching name in the manifest", () => {
        expect(manifest.name).toBe(packageId);
      });

      it("declares type=provider with authMode=oauth2", () => {
        expect(manifest.type).toBe("provider");
        expect(manifest.definition.authMode).toBe("oauth2");
      });

      it("has oauth2 endpoints with PKCE enabled", () => {
        expect(manifest.definition.oauth2).toBeDefined();
        expect(manifest.definition.oauth2!.pkceEnabled).toBe(true);
      });

      it("tokenUrl matches the runtime token-resolver registration", () => {
        expect(manifest.definition.oauth2!.tokenUrl).toBe(TOKEN_URL_BY_PACKAGE_ID[packageId]!);
      });

      it("manifest defaultScopes are a subset of the runtime registry scopes", () => {
        const cfg = OAUTH_MODEL_PROVIDERS[packageId]!;
        const manifestScopes = manifest.definition.oauth2!.defaultScopes ?? [];
        const registryScopes = new Set<string>(cfg.scopes);
        for (const scope of manifestScopes) {
          expect(registryScopes.has(scope)).toBe(true);
        }
      });
    });
  }
});
