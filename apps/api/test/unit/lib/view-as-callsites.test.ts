// SPDX-License-Identifier: Apache-2.0

/**
 * Static sweeps over the SOURCE for "view as role" (RBAC spec §6.7): no app, no
 * DB, no fixtures — the enforcement itself lives in
 * `test/integration/routes/view-as.test.ts`.
 */

import { describe, expect, it } from "bun:test";

describe("persona-sensitive call sites", () => {
  /**
   * Three greps, one rule: every site that answers "what does this caller
   * reach" must go through a persona-aware accessor, and every site that does
   * NOT is pinned here with why. A new call site fails this test on purpose —
   * it has to be reviewed against the preview before it ships.
   *
   * `.get("orgRole")` — the real role, which a preview deliberately leaves
   * untouched ({@link callerOrgRole} is the previewed one).
   * `loadSpaceMember(` / `loadSpaceMemberships(` — the caller's own rows,
   * which a preview replaces with its overlay (`callerSpaceMember*`).
   * `orgPermissions(` — a role's org grants, which a preview intersects
   * (`orgHalfFor`).
   */
  interface Sweep {
    what: string;
    pattern: RegExp;
    control: string;
    allowlist: ReadonlyArray<[string, string]>;
  }

  const SWEEPS: Sweep[] = [
    {
      what: '`.get("orgRole")`',
      // Whitespace- and alias-tolerant: prettier may wrap the call, and
      // `space-context.ts` reaches the context through a `ctx` alias.
      pattern: /\.get\(\s*"orgRole"\s*\)/,
      control: "apps/api/src/lib/auth-pipeline.ts",
      allowlist: [
        [
          "apps/api/src/lib/auth-pipeline.ts",
          "resolves the REAL role the persona's eligibility is judged against",
        ],
        [
          "apps/api/src/lib/package-access.ts",
          "distinguishes an end-user (no org role at all) from a member",
        ],
        [
          "apps/api/src/lib/permission-audit.ts",
          "a denial trail must name the real role, persona or not",
        ],
        ["apps/api/src/lib/view-as.ts", "defines what real and previewed mean"],
        [
          "apps/api/src/middleware/org-path-context.ts",
          "membership existence, which a preview never changes",
        ],
        [
          "apps/api/src/middleware/space-context.ts",
          "membership existence gate before the persona is applied",
        ],
        [
          "apps/api/src/routes/organizations.ts",
          "two membership-existence gates; the who-manages-whom policy reads `callerOrgRole`",
        ],
        [
          "packages/module-chat/src/chat-stream.ts",
          "the fallback under the persona's role, which is what the turn is answered as",
        ],
        [
          "packages/module-chat/src/prompt.ts",
          "the fallback behind the persona's role in the caller-context block",
        ],
      ],
    },
    {
      what: "`loadSpaceMember(` / `loadSpaceMemberships(`",
      pattern: /loadSpaceMember(?:ships)?\(/,
      control: "apps/api/src/lib/view-as.ts",
      allowlist: [
        ["apps/api/src/lib/space-role.ts", "defines them"],
        ["apps/api/src/lib/view-as.ts", "the persona-aware accessors every other site uses"],
        [
          "apps/api/src/routes/realtime.ts",
          'SSE runs outside the pipeline and has no `c.get("user")`; it overlays explicitly',
        ],
        [
          "apps/api/src/routes/spaces.ts",
          "reads the TARGET member's row to report what access it leaves behind, not the caller's",
        ],
        [
          "apps/api/src/services/scheduler.ts",
          "background fires revalidate the saved actor's live grants; no request persona survives into a schedule",
        ],
        [
          "apps/api/src/services/space-members.ts",
          "reads the TARGET member's row inside the write transaction, not the caller's",
        ],
        [
          "apps/api/src/services/spaces.ts",
          "the listing's own load, bypassed by the overlay `listSpacesForPrincipal` takes",
        ],
      ],
    },
    {
      what: "`orgPermissions(`",
      pattern: /[^a-zA-Z]orgPermissions\(/,
      control: "apps/api/src/lib/view-as.ts",
      allowlist: [
        ["apps/api/src/lib/permissions.ts", "defines it"],
        ["apps/api/src/lib/view-as.ts", "`orgHalfFor`, the one site that applies a persona to it"],
        [
          "apps/api/src/modules/oidc/auth/claims.ts",
          "mints a token's scope CEILING from the subject's role; a preview narrows per request, under it",
        ],
      ],
    },
  ];

  /**
   * Comments name these helpers freely, and only real call sites are the
   * subject. Whole comment lines are blanked rather than parsed out: a
   * regex-based comment stripper eats code the moment a string literal holds
   * `/*` (`app.on([...], "/api/auth/*", …)` does), and a line of code never
   * begins with `*`, `//` or `/*`. Newlines survive, so a call prettier
   * wrapped across lines still matches.
   */
  const stripCommentLines = (source: string): string =>
    source
      .split("\n")
      .map((line) => {
        const t = line.trimStart();
        return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") ? "" : line;
      })
      .join("\n");

  it.each(SWEEPS)("$what is read only where the allowlist says", async (sweep: Sweep) => {
    const root = `${import.meta.dir}/../../../../..`;
    const found: string[] = [];
    for (const area of ["apps/api/src", "packages"]) {
      const glob = area === "packages" ? "*/src/**/*.ts" : "**/*.ts";
      for await (const relative of new Bun.Glob(glob).scan({ cwd: `${root}/${area}` })) {
        // Tests are not production call sites — the oidc module keeps its own
        // under `src/`, so they have to be excluded by path.
        if (relative.includes("/test/") || relative.endsWith(".test.ts")) continue;
        const path = `${area}/${relative}`;
        const source = stripCommentLines(await Bun.file(`${root}/${path}`).text());
        if (sweep.pattern.test(source)) found.push(path);
      }
    }
    // Positive control: a pattern that matched nothing would pass an empty
    // allowlist just as happily.
    expect(found).toContain(sweep.control);
    expect(found.sort()).toEqual(sweep.allowlist.map(([file]) => file).sort());
  });
});
