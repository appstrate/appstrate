// SPDX-License-Identifier: Apache-2.0

/**
 * pi-ai's module-private OAuth constants, read from its shipped source for the
 * model-provider parity tests: connect-helper logs in through pi-ai, and a
 * refresh under another `client_id` or token endpoint is rejected upstream.
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

/** pi-ai's OAuth config from `auth/oauth/<providerFile>`, shaped as `modelProviders()[].oauth`. */
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
