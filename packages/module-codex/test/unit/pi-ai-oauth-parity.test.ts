// SPDX-License-Identifier: Apache-2.0

/**
 * connect-helper mints the tokens through pi-ai's login flow; this module
 * refreshes them. A refresh under another `client_id` or token endpoint is
 * rejected upstream, so the module's OAuth config must equal what pi-ai logs in
 * with. pi-ai keeps it module-private, so it is read from the shipped source;
 * a pi-ai bump that moves any of it fails here.
 */

import { describe, it, expect } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import codexModule from "../../src/index.ts";

const SOURCE = join(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"))),
  "auth/oauth/openai-codex.js",
);

/** A top-level `const NAME = …` string: literal, `decode("…")` or template. */
function piConst(src: string, name: string): string {
  const m = new RegExp(`^const ${name} = (.+);$`, "m").exec(src);
  if (!m) throw new Error(`pi-ai no longer declares \`const ${name}\` — re-read ${SOURCE}`);
  const expr = m[1]!;
  const decoded = /^decode\("([^"]+)"\)$/.exec(expr);
  if (decoded) return atob(decoded[1]!);
  const literal = /^"([^"]*)"$/.exec(expr);
  if (literal) return literal[1]!;
  const template = /^`([^`]*)`$/.exec(expr);
  if (template) return template[1]!.replace(/\$\{(\w+)\}/g, (_, ref: string) => piConst(src, ref));
  throw new Error(`unrecognised pi-ai expression for ${name}: ${expr}`);
}

describe("codex OAuth config", () => {
  it("matches the config pi-ai logs in with", async () => {
    const src = await Bun.file(SOURCE).text();
    const oauth = codexModule.modelProviders?.()[0]?.oauth;
    expect(oauth).toEqual({
      clientId: piConst(src, "CLIENT_ID"),
      authorizationUrl: piConst(src, "AUTHORIZE_URL"),
      tokenUrl: piConst(src, "TOKEN_URL"),
      refreshUrl: piConst(src, "TOKEN_URL"),
      scopes: piConst(src, "SCOPE").split(" "),
      pkce: "S256",
    });
  });
});
