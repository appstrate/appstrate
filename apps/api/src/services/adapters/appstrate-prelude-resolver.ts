// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-backed {@link PreludeResolver}.
 *
 * Knows about one prelude today: `@appstrate/environment`, the
 * platform-identity template that every Appstrate agent renders in
 * front of its own `prompt.md`. The resolver returns the static prose
 * shipped with this Appstrate build — there is no remote fetch for
 * first-party preludes, because the content is part of the platform
 * binary itself.
 *
 * When an agent declares a different scope (e.g. `@acme/environment`)
 * this resolver returns `null`, letting the runtime throw
 * {@link PreludeResolutionError}. A future extension may chain this
 * resolver with a registry-backed one that resolves third-party
 * preludes via `package_versions` + S3 storage.
 */

import type { PreludeRef, PreludeResolver } from "@appstrate/afps-runtime/bundle";
import { satisfiesRange } from "@appstrate/core/semver";
import {
  APPSTRATE_ENVIRONMENT_NAME,
  APPSTRATE_ENVIRONMENT_PROMPT,
  APPSTRATE_ENVIRONMENT_VERSION,
} from "./appstrate-environment-prompt.ts";

export class AppstratePreludeResolver implements PreludeResolver {
  async resolve(ref: PreludeRef): Promise<string | null> {
    if (ref.name !== APPSTRATE_ENVIRONMENT_NAME) return null;
    if (!satisfiesRange(APPSTRATE_ENVIRONMENT_VERSION, ref.version)) {
      return null;
    }
    return APPSTRATE_ENVIRONMENT_PROMPT;
  }
}
