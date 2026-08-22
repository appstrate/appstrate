import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import react from "eslint-plugin-react";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

// Shared web import-ban patterns (single source of truth). The general web
// block bans both; the seam exemption (hooks/use-auth.ts) re-uses
// API_BARREL_BAN alone. Defined here so the api.ts regex can never drift
// between the two blocks — ESLint flat config replaces (not merges) a rule
// across blocks, so the exemption must re-declare it.
const API_BARREL_BAN = {
  // Matches "./api", "../api" (any depth) and "@/api" — but not the
  // typed-client modules ("./api/client", "@/api/errors", …). gitignore-style
  // `group` can't re-include children of an excluded directory, so use a regex.
  regex: "^(?:(?:\\.{1,2}/)+|@/)api$",
  message:
    "Use the typed OpenAPI client from src/api/client.ts ($api / client) — the legacy fetch helpers are gone.",
};
// Zod 4 string-format bans (single source of truth). Declared here because the
// CLI-test block below re-declares `no-restricted-syntax` for a subset of the
// same files — flat config replaces (not merges) a rule's options across
// blocks, so a later block that forgot these would silently switch the Zod
// guard off for `apps/cli/test/**`.
const ZOD4_STRING_FORMAT_BANS = [
  {
    selector:
      "CallExpression[callee.property.name='email'][callee.object.callee.object.name='z'][callee.object.callee.property.name='string']",
    message: "Zod 4: use z.email() instead of z.string().email().",
  },
  {
    selector:
      "CallExpression[callee.property.name='url'][callee.object.callee.object.name='z'][callee.object.callee.property.name='string']",
    message: "Zod 4: use z.url() instead of z.string().url().",
  },
  {
    selector:
      "CallExpression[callee.property.name='uuid'][callee.object.callee.object.name='z'][callee.object.callee.property.name='string']",
    message: "Zod 4: use z.uuid() instead of z.string().uuid().",
  },
];

// Global-stream capture, banned in CLI tests. Two shapes are matched:
// assigning over `process.stdout.write` / `process.stderr.write` /
// `process.exit`, and `spyOn`-ing the two stream writes (which reaches the
// same global through a different door — the rule would be theatre without
// it). All three assignment selectors match through casts: the pattern this
// replaces wrote `(process as unknown as { exit: … }).exit = original`, so
// anchoring on `left.object.name === 'process'` would miss the exact code that
// caused the bug. They anchor on a `process` Identifier *descendant* of the
// assignment target instead, which the cast cannot hide.
//
// NOT covered, and deliberately so — each would need a selector broad enough
// to fire on innocent code, or type information ESLint's AST pass does not
// have. They are documented so nobody reads a green lint as proof of absence:
//   - aliasing:            `const p = process; p.stdout.write = fn`
//   - computed access:     `process["stdout"].write = fn`
//   - destructuring:       `const { stdout } = process; stdout.write = fn`
//   - defineProperty:      `Object.defineProperty(process, "exit", …)`
//   - a cast on the spy target: `spyOn(process.stdout as any, "write")`
// `spyOn(process, "exit")` is also intentionally allowed: install.test.ts uses
// it with a `finally` restore for the installer's terminal paths, which is a
// different problem from capturing output.
const globalIoBan = (target, selector) => ({
  selector,
  message: `CLI tests must not take over the global ${target} (by assignment or \`spyOn\`). \`bun test\` runs every package in one process, so a global capture buffer also collects what other suites, libraries and the runner write — the assertion then fails non-deterministically and names an innocent test (issue #1180). Pass the command an injected CommandIO instead: createMemoryIO() from test/helpers/memory-io.ts.`,
});

const AUTH_CLIENT_BAN = {
  // Matches "../lib/auth-client", "../../lib/auth-client" and
  // "@/lib/auth-client". Only hooks/use-auth.ts (the seam) may import it.
  regex: "(?:^|/)lib/auth-client$",
  message:
    "Auth flows must go through useAuth() (hooks/use-auth.ts) — the single seam that routes login/recovery/account actions through the OIDC hosted-login redirect when configured. Never import auth-client directly.",
};

export default tseslint.config(
  {
    ignores: [
      "**/dist",
      "**/node_modules",
      ".claude/",
      // Generated OpenAPI types — managed by scripts/generate-api-types.ts
      "apps/web/src/api/schema.d.ts",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/src/**/*.{ts,tsx}", "**/test/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "preserve-caught-error": "off",
    },
  },
  {
    // Zod 4 regression guard: string formats are top-level functions
    // (z.email(), z.url(), z.uuid()) — the Zod 3 method forms are deprecated
    // and must not creep back in.
    files: ["**/src/**/*.{ts,tsx}", "**/test/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...ZOD4_STRING_FORMAT_BANS],
    },
  },
  {
    // Unguarded-spinner guard (issue #1180). A clack spinner paints from a
    // `setInterval` that only `stop()` clears, so a `start()` whose body throws
    // leaks a writer for the rest of the process — invisible in the shipped CLI
    // (the error exits it), fatal under `bun test`, where one process runs every
    // suite and the frames land in someone else's capture. `withSpinner`
    // (src/lib/ui.ts) owns the start/stop pair; `ui.ts` itself is where the one
    // remaining `clack.spinner()` call lives.
    //
    // Re-declares `no-restricted-syntax` for a subset of the Zod block above,
    // which fully REPLACES its options here — hence the explicit spread.
    files: ["apps/cli/src/**/*.ts"],
    ignores: ["apps/cli/src/lib/ui.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...ZOD4_STRING_FORMAT_BANS,
        {
          selector: "CallExpression[callee.object.name='clack'][callee.property.name='spinner']",
          message:
            "Use `withSpinner` from lib/ui.ts — it stops the spinner on every exit path. A raw `clack.spinner()` leaks its paint interval when the body throws (issue #1180). For a conditional start, use `spinner()` from lib/ui.ts and stop it in a `finally`.",
        },
      ],
    },
  },
  {
    // Global-stream capture guard (issue #1180): tests used to assert on output
    // by swapping the *global* `process.stdout.write` / `process.stderr.write`
    // / `process.exit` for the duration of a call. The whole repo runs in one
    // `bun test` process, so that buffer is not owned by the test writing to it
    // — `expect(captured).toBe("")` was a coin flip that blamed whichever
    // command happened to be running, and a reader that parses its capture
    // (the sidecar's JSON log lines) got a hard `SyntaxError` instead.
    //
    // Every package, not just `apps/cli`: they share the one process, so a
    // global capture anywhere is a capture of everything. Inject a sink the
    // test owns — `createMemoryIO()` (apps/cli/test/helpers/memory-io.ts) for
    // CLI commands, `_setLogSinkForTesting()` for the sidecar logger.
    //
    // This re-declares `no-restricted-syntax` for a subset of the block above,
    // which fully REPLACES its options here — hence the explicit spread of the
    // Zod 4 bans, so they keep firing in `**/test/**` too.
    files: ["**/test/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...ZOD4_STRING_FORMAT_BANS,
        globalIoBan(
          "process.stdout.write",
          "AssignmentExpression > MemberExpression.left[property.name='write'] MemberExpression[property.name='stdout'] Identifier[name='process']",
        ),
        globalIoBan(
          "process.stderr.write",
          "AssignmentExpression > MemberExpression.left[property.name='write'] MemberExpression[property.name='stderr'] Identifier[name='process']",
        ),
        globalIoBan(
          "process.exit",
          "AssignmentExpression > MemberExpression.left[property.name='exit'] Identifier[name='process']",
        ),
        globalIoBan(
          "process.stdout.write",
          "CallExpression[callee.name='spyOn'][arguments.0.object.name='process'][arguments.0.property.name='stdout'][arguments.1.value='write']",
        ),
        globalIoBan(
          "process.stderr.write",
          "CallExpression[callee.name='spyOn'][arguments.0.object.name='process'][arguments.0.property.name='stderr'][arguments.1.value='write']",
        ),
      ],
    },
  },
  {
    files: ["**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-extra-non-null-assertion": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "prefer-const": "warn",
    },
  },
  {
    files: ["packages/core/src/**/*.ts", "packages/core/test/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@appstrate/db*",
                "@appstrate/env*",
                "@appstrate/connect*",
                "@appstrate/shared-types*",
                "@appstrate/emails*",
                "@appstrate/api*",
                "@appstrate/web*",
              ],
              message: "core must remain independent — no imports from other workspace packages",
            },
            {
              // Supply-chain guard: core imports the Pi SDK zero times and must
              // stay that way. core has no pi-sdk barrel (nothing to route
              // through), so the ban is absolute here. See docs/architecture/SUPPLY_CHAIN.md
              group: ["@earendil-works/pi-*", "@earendil-works/pi-*/**"],
              message:
                "core must not import the Pi SDK — the agent runner owns that dependency. See docs/architecture/SUPPLY_CHAIN.md",
            },
          ],
        },
      ],
    },
  },
  {
    // Supply-chain guard: the single-vendor Pi SDK (the whole
    // `@earendil-works/pi-*` family: pi-ai, pi-coding-agent, and siblings
    // pi-agent-core / pi-tui) may only be imported through each package's
    // `pi-sdk.ts` barrel, so swapping or forking it is a one-file change.
    // Barrels are exempt via `ignores`. `packages/afps-runtime/src` is
    // SDK-agnostic and imports zero pi-* symbols today, so it has no barrel —
    // the guard simply keeps it that way. Rationale: docs/architecture/SUPPLY_CHAIN.md
    files: [
      "packages/runner-pi/src/**/*.ts",
      "packages/afps-runtime/src/**/*.ts",
      "apps/cli/src/**/*.ts",
      "apps/api/src/**/*.ts",
      "runtime-pi/**/*.ts",
    ],
    ignores: [
      "packages/runner-pi/src/pi-sdk.ts",
      "apps/cli/src/lib/pi-sdk.ts",
      "runtime-pi/pi-sdk.ts",
    ],
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // `**` (not `*`) so deep subpaths like pi-ai/dist/foo are caught.
              group: ["@earendil-works/pi-*", "@earendil-works/pi-*/**"],
              message:
                "Import the Pi SDK only through the package-local pi-sdk barrel (pi-sdk.ts) — see docs/architecture/SUPPLY_CHAIN.md",
            },
          ],
        },
      ],
    },
  },
  {
    // Two web import guards live in one rule on purpose: ESLint flat config
    // does NOT merge the options of the same rule id across blocks — a later
    // block setting `no-restricted-imports` for the same files fully replaces
    // this one. So both patterns must sit together here, and the seam
    // exemption below re-declares the rule rather than adding to it.
    //
    //   1. Typed-client guard: all web API calls go through the typed OpenAPI
    //      client (src/api/client.ts — `$api`/`client`). The legacy fetch
    //      barrel (src/api.ts) is deleted; this keeps it from coming back
    //      under the old import specifiers (relative or aliased).
    //   2. Auth seam guard: every Better Auth call funnels through the single
    //      seam (hooks/use-auth.ts) so a page can't bypass the OIDC hosted-
    //      login redirect (`HostedAuthGate` / `useHostedAuthRedirect`) by
    //      calling `auth-client` directly — the bug class this exists to kill.
    //      Exempted for the seam file itself in the next block.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [API_BARREL_BAN, AUTH_CLIENT_BAN] }],
    },
  },
  {
    // Seam exemption: hooks/use-auth.ts is the one sanctioned importer of
    // `auth-client`. Re-declare the web ban here WITHOUT the auth-client
    // pattern (the api.ts guard still applies) — a later, narrower flat-config
    // block fully replaces the rule for this file.
    files: ["apps/web/src/hooks/use-auth.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [API_BARREL_BAN] }],
    },
  },
  {
    files: [
      "apps/web/src/**/*.{ts,tsx}",
      "packages/ui/src/**/*.{ts,tsx}",
      // The chat module ships its frontend under `ui/` — gate it with the same
      // React Compiler / hooks rules as the app (its backend `.ts` stays under
      // the general TS config, no browser globals).
      "packages/module-chat/src/ui/**/*.{ts,tsx}",
    ],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      react,
    },
    // Explicit version, NOT "detect": eslint-plugin-react 7.x's version
    // auto-detection crashes under ESLint 10's flat-config context API
    // (resolveBasedir → getFilename is not a function).
    settings: { react: { version: "19.2" } },
    rules: {
      // recommended-latest layers the React Compiler static rules (purity,
      // set-state-in-render/effect, immutability, refs, static-components,
      // preserve-manual-memoization, …) on top of the core hooks rules. These
      // catch the Rules-of-React violations that cause unnecessary re-renders
      // and fragile components — a static cleanliness/robustness gate that
      // runs in `bun run check` (local + CI), no runtime harness needed.
      ...reactHooks.configs["recommended-latest"].rules,
      "react-refresh/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
          // `makeAssistantToolUI(...)` is assistant-ui's documented HOC factory
          // for registering a tool's render UI (chat module, tool-uis.tsx). Its
          // result is a component wrapped by an HOC, not a plain value — declare
          // the factory so Fast Refresh treats those exports as components, the
          // sanctioned mechanism the rule offers for HOC factories.
          extraHOCs: ["makeAssistantToolUI"],
          // Public shadcn-style design-system helpers exported from component
          // entrypoints. Keep the API stable while avoiding Fast Refresh noise.
          allowExportNames: ["badgeVariants", "buttonVariants", "useSidebar"],
        },
      ],
      // Re-render robustness: the React Compiler rules above check Rules-of-React
      // correctness but NOT re-render efficiency. These three catch the structural
      // causes of avoidable re-renders / remounts that a runtime tool (react-scan)
      // would only surface in the browser — caught statically here instead.
      //  - constructed context values: new ref every render → all consumers re-render
      //  - unstable nested components: component defined in render → full remount each render
      //  - object/array literal as default prop: new ref every render
      // (react/no-array-index-key deliberately omitted: in this codebase its hits
      // are all controlled-input lists or append-only logs where an index key is
      // correct — it's a reconciliation lint, not a re-render one, and produced
      // only false positives here.)
      "react/jsx-no-constructed-context-values": "error",
      "react/no-unstable-nested-components": ["error", { allowAsProps: true }],
      "react/no-object-type-as-default-prop": "error",
    },
  },
  {
    // Type-aware guard (web only): flag `x as T` assertions that don't change
    // the type — these are pure noise that also hide where a value's real type
    // silently drifted from what the cast claims. Scoped to the SPA so the
    // type-checked program stays cheap. Only this one type-aware rule is on.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
    },
  },
  eslintConfigPrettier,
);
