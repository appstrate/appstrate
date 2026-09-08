// SPDX-License-Identifier: Apache-2.0

/**
 * The scope ceiling a self-service (DCR / CIMD) client registers under.
 *
 * `resolveClientRegistrationScopes` upstream persists the UNION of
 * `clientRegistrationDefaultScopes` and `clientRegistrationAllowedScopes`, so a
 * default that is not inside the ceiling silently widens it. The module passes
 * the same array to both; these assertions hold that structure, and hold the
 * ceiling itself at `getSelfServiceScopes()` — identity scopes plus the module
 * scopes marked end-user-grantable, never a core action scope.
 */

import { describe, it, expect } from "bun:test";
import { oidcBetterAuthPlugins } from "../../auth/plugins.ts";
import { getSelfServiceScopes } from "../../auth/scopes.ts";

interface OAuthProviderPlugin {
  id?: string;
  options?: {
    clientRegistrationDefaultScopes?: string[];
    clientRegistrationAllowedScopes?: string[];
  };
}

/** The options `oauthProvider()` was constructed with, off the plugin it returns. */
function oauthProviderOptions(): NonNullable<OAuthProviderPlugin["options"]> {
  const plugins = oidcBetterAuthPlugins() as OAuthProviderPlugin[];
  const provider = plugins.find((plugin) => plugin?.id === "oauth-provider");
  if (!provider?.options) {
    throw new Error("oauth-provider plugin is not in the OIDC plugin list");
  }
  return provider.options;
}

describe("self-service client registration scopes", () => {
  it("registers one array as both the default and the ceiling", () => {
    const options = oauthProviderOptions();
    expect(options.clientRegistrationAllowedScopes).toBeArray();
    expect(options.clientRegistrationDefaultScopes).toEqual(
      options.clientRegistrationAllowedScopes!,
    );
  });

  it("caps that ceiling at the self-service scope set", () => {
    expect(oauthProviderOptions().clientRegistrationAllowedScopes).toEqual(getSelfServiceScopes());
  });
});
