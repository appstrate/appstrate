// SPDX-License-Identifier: Apache-2.0

/**
 * pi-ai's OAuth login constants, read from its shipped source. connect-helper
 * mints subscription tokens through that login; the model-provider modules
 * refresh them, and a refresh under another `client_id` or token endpoint is
 * rejected upstream. pi-ai keeps the constants module-private, so each module's
 * parity test reads them here. pi-ai resolves from the repo root, so no module
 * needs it as a dependency.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PI_AI_DIR = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));

/** A top-level `const NAME = …` string: literal, `decode("…")` or template. */
function piConst(src: string, name: string): string {
  const m = new RegExp(`^const ${name} = (.+);$`, "m").exec(src);
  if (!m) throw new Error(`pi-ai no longer declares \`const ${name}\``);
  const expr = m[1]!;
  const decoded = /^decode\("([^"]+)"\)$/.exec(expr);
  if (decoded) return atob(decoded[1]!);
  const literal = /^"([^"]*)"$/.exec(expr);
  if (literal) return literal[1]!;
  const template = /^`([^`]*)`$/.exec(expr);
  if (template) return template[1]!.replace(/\$\{(\w+)\}/g, (_, ref: string) => piConst(src, ref));
  throw new Error(`unrecognised pi-ai expression for ${name}: ${expr}`);
}

/**
 * The OAuth config pi-ai logs in with, from `auth/oauth/<providerFile>`, in the
 * shape a module declares under `modelProviders()[].oauth`.
 */
export async function piAiOAuthConfig(providerFile: string, scopeConst: string) {
  const src = await Bun.file(join(PI_AI_DIR, "auth/oauth", providerFile)).text();
  return {
    clientId: piConst(src, "CLIENT_ID"),
    authorizationUrl: piConst(src, "AUTHORIZE_URL"),
    tokenUrl: piConst(src, "TOKEN_URL"),
    refreshUrl: piConst(src, "TOKEN_URL"),
    scopes: piConst(src, scopeConst).split(" "),
    pkce: "S256",
  };
}
