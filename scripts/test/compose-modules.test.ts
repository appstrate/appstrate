// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/lib/compose-modules.ts` — which modules a compose file boots by default.
 *
 * Two gates branch on this answer, and both branch towards LENIENCY when it comes back empty: an
 * example file stops owing a module's keys, and a compose file forwarding none of them stops being
 * checked. So every test below that expects `[]` has a sibling expecting the ids, and the real
 * repository files are asserted at the end — a parser that quietly matched nothing would pass a
 * suite made only of the negative halves.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultModulesValue,
  modulesEnabledByDefault,
  siblingComposeFile,
} from "../lib/compose-modules.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf-8");

describe("defaultModulesValue", () => {
  it("reads the default out of a list entry", () => {
    expect(defaultModulesValue("      - MODULES=${MODULES:-oidc,@appstrate/module-ee}")).toBe(
      "oidc,@appstrate/module-ee",
    );
  });

  it("reads it out of a mapping entry too", () => {
    expect(defaultModulesValue("    MODULES: ${MODULES:-oidc}")).toBe("oidc");
  });

  it("reads a literal pin with no interpolation", () => {
    expect(defaultModulesValue("      - MODULES=oidc,webhooks")).toBe("oidc,webhooks");
  });

  it("returns null for a bare pass-through — the form every other compose file uses", () => {
    expect(defaultModulesValue("      - MODULES")).toBeNull();
  });

  it("returns null for an interpolation with no default", () => {
    expect(defaultModulesValue("      - MODULES=${MODULES}")).toBeNull();
  });

  it("returns null when a value still carries an unresolved interpolation", () => {
    // Half a value would let a gate demand the wrong keys, which is worse than
    // demanding none: the operator is sent to edit a file that was correct.
    expect(defaultModulesValue("      - MODULES=${MODULES:-oidc,${EXTRA}}")).toBeNull();
  });

  it("ignores the name inside a comment", () => {
    // The compose file explains itself at length right above the line that
    // matters; a parser reading prose would answer from the wrong one.
    const content = [
      "      # MODULES: the code default is the OSS set and does NOT name",
      "      # the billing module. MODULES=whatever-a-comment-says",
      "      - MODULES=${MODULES:-oidc}",
    ].join("\n");
    expect(defaultModulesValue(content)).toBe("oidc");
  });
});

describe("modulesEnabledByDefault", () => {
  it("maps a scoped specifier to the packages/module-* id", () => {
    expect(modulesEnabledByDefault("      - MODULES=${MODULES:-@appstrate/module-ee}")).toEqual([
      "ee",
    ]);
  });

  it("keeps a hyphenated id whole", () => {
    expect(
      modulesEnabledByDefault("      - MODULES=${MODULES:-@appstrate/module-claude-code}"),
    ).toEqual(["claude-code"]);
  });

  it("skips built-ins, which have no package behind them", () => {
    expect(modulesEnabledByDefault("      - MODULES=${MODULES:-oidc,webhooks,mcp}")).toEqual([]);
  });

  it("returns the modules out of a mixed list, in order, without duplicates", () => {
    expect(
      modulesEnabledByDefault(
        "      - MODULES=${MODULES:-oidc,@appstrate/module-chat,mcp,@appstrate/module-ee,@appstrate/module-chat}",
      ),
    ).toEqual(["chat", "ee"]);
  });

  it("returns nothing when the file pins no default", () => {
    expect(modulesEnabledByDefault("      - MODULES")).toEqual([]);
  });
});

describe("siblingComposeFile", () => {
  it("pairs an example with the compose in its own directory", () => {
    expect(siblingComposeFile("deploy/.env.example")).toBe("deploy/docker-compose.yml");
  });

  it("pairs the root example with the root compose", () => {
    expect(siblingComposeFile(".env.example")).toBe("docker-compose.yml");
  });
});

describe("against the repository's own compose files", () => {
  // The discriminating half. Everything above is synthetic, so a parser that
  // matched nothing real would still be green.
  it("finds the modules the production deployment boots by default", () => {
    // All four workspace modules, not only the one with an env schema: this
    // function answers "which modules boot", and each caller decides what that
    // obliges. Today only `ee` declares a `src/env.ts`, so only `ee` obliges
    // anything — and the day another one does, it is already discovered.
    expect(modulesEnabledByDefault(read("deploy/docker-compose.yml"))).toEqual([
      "codex",
      "claude-code",
      "chat",
      "ee",
    ]);
  });

  it("finds none in the self-hosting example, which passes MODULES through", () => {
    expect(modulesEnabledByDefault(read("examples/self-hosting/docker-compose.yml"))).toEqual([]);
  });

  it("finds none in the root compose either", () => {
    expect(modulesEnabledByDefault(read("docker-compose.yml"))).toEqual([]);
  });
});
