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
// CLI and test blocks below re-declare `no-restricted-syntax` for subsets of
// the same files — flat config replaces (not merges) a rule's options across
// blocks, so a later block that forgot these would silently switch the Zod
// guard off for `apps/cli/src/**` and `apps/cli/test/**`.
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

// Message for both halves of the `process.*.write` ban below (stdout and
// stderr). Declared once so the two selectors can never disagree about what
// the rule is for.
const PROCESS_STREAM_MESSAGE =
  "Write through the command's `CommandIO` (`io.stdout.write` / `io.stderr.write`), never " +
  "`process.stdout.write` / `process.stderr.write`. The process-global streams are invisible " +
  "to an injected sink, so the output cannot be asserted on without capturing globals — the " +
  "coupling issue #1180 is about. If this command genuinely owns a different output contract " +
  "(a run's passthrough, a pre-sink host command), add it to this block's `ignores` with the " +
  "reason, next to the ones already there.";

const CLACK_FUNNEL_MESSAGE =
  "Render through a `lib/ui.ts` wrapper (intro / outro / note / logInfo / logWarn / spinner / withSpinner / select / confirm / askText / cancel / exitWithError), never `clack.*` directly. Only `ui.ts` hands clack an `output`, so a direct call writes to the process-global stdout and is invisible to an injected CommandIO — the coupling issue #1180 is about. `clack.spinner()` additionally leaks its paint interval when the body throws; use `withSpinner`, or `spinner()` + a `finally` for a conditional start.";

// `@clack/prompts` funnel (issue #1180). Every byte the CLI renders through
// clack must go through a `lib/ui.ts` wrapper, because that is the only layer
// that hands clack an `output` — the seam a test injects a `CommandIO` into
// instead of swapping the process-global streams. A direct `clack.note(...)` /
// `clack.intro(...)` / `clack.log.warn(...)` writes to the real stdout by name
// and is invisible to any injected sink.
//
// The original form of this rule banned `clack.spinner` alone, which was the
// acute case: a spinner paints from a `setInterval` that only `stop()` clears,
// so a `start()` whose body throws leaks a writer for the rest of the process —
// invisible in the shipped CLI (the error exits it), fatal under `bun test`,
// where one process runs every suite and the frames land in someone else's
// capture. `withSpinner` owns the start/stop pair. The other 29 call sites had
// the same destination problem without the leak, and a guard naming one of
// thirty reads as coverage it does not have.
//
// Two selectors: `clack.x(...)` and `clack.log.x(...)` (`clack.log` is a
// namespace object, so the direct-member selector cannot see through it).
// `clack.isCancel(...)` is allow-listed — it is a type predicate over a
// returned symbol, renders nothing, and has no sink to route through.
// Bare MEMBER REFERENCES (`typeof clack.select`, `deps.note ?? clack.note`)
// are deliberately out of scope: `commands/install.ts` uses them as the
// production default of its own prompt-DI seams, and a call through such a
// local is not a call on `clack`.
const CLACK_FUNNEL_BANS = [
  {
    selector: "CallExpression[callee.object.name='clack']:not([callee.property.name='isCancel'])",
    message: CLACK_FUNNEL_MESSAGE,
  },
  {
    selector: "CallExpression[callee.object.object.name='clack']",
    message: CLACK_FUNNEL_MESSAGE,
  },
];

// The third door out of the command sink, and the most direct one. `2d71e0297`
// was titled "put every command's output behind the sink, AND ENFORCE IT" and
// enforced `console.*` (via no-console) and `clack.*` (above) — leaving the
// literal `process.stdout.write("…")` a new command could reach for, which
// passes `bun run check` untouched and is invisible to an injected CommandIO
// exactly like the other two.
const PROCESS_STREAM_BANS = [
  {
    selector:
      "CallExpression[callee.property.name='write'][callee.object.object.name='process'][callee.object.property.name='stdout']",
    message: PROCESS_STREAM_MESSAGE,
  },
  {
    selector:
      "CallExpression[callee.property.name='write'][callee.object.object.name='process'][callee.object.property.name='stderr']",
    message: PROCESS_STREAM_MESSAGE,
  },
];

// Who may call `clack.*` directly. `lib/ui.ts` is the funnel itself;
// `lib/io.ts` owns `DEFAULT_IO.cancel`, which is wired to `clack.cancel` there
// on purpose so the dependency arrow stays `ui.ts → io.ts` and never the
// reverse.
//
// `commands/install.ts` is on this list TEMPORARILY: it predates the sink and
// still carries `deps.select ?? clack.select` prompt-DI seams as the production
// defaults of its own installer prompts. It comes off the moment those seams
// are replaced by `lib/ui.ts` wrappers over an injected `CommandIO` — that one
// change is the whole condition, nothing else about the file matters here.
const CLACK_FUNNEL_EXEMPT = [
  "apps/cli/src/lib/ui.ts",
  "apps/cli/src/lib/io.ts",
  "apps/cli/src/commands/install.ts",
];

// Who owns a different output contract than the command sink. This list lives
// HERE rather than only in `lib/io.ts`'s docstring — a list a linter cannot
// read is documentation, not a rule. Each entry's reason is spelled out in that
// docstring: `run.ts` + `run/**` stream a run's own stdout/stderr through,
// `runner.ts` and `lifecycle.ts` are host-level commands that run before any
// command sink exists, `install.ts` predates the sink and keeps its own
// prompt-DI seams, and `cli.ts` is the top-level error handler that must still
// print when everything else has failed.
//
// It is a superset of `CLACK_FUNNEL_EXEMPT` and must not be confused with it:
// owning your own stream contract says nothing about rendering prompts and
// spinners outside `lib/ui.ts`, which is why the two config objects below
// exist.
const PROCESS_STREAM_EXEMPT = [
  "apps/cli/src/lib/ui.ts",
  "apps/cli/src/lib/io.ts",
  "apps/cli/src/cli.ts",
  "apps/cli/src/commands/run.ts",
  "apps/cli/src/commands/run/**/*.ts",
  "apps/cli/src/commands/runner.ts",
  "apps/cli/src/commands/lifecycle.ts",
  "apps/cli/src/commands/install.ts",
  // `lib/keyring.ts` emits ONE lifetime warning when the OS keyring is
  // unavailable, from a module with no command context and therefore no sink to
  // inject. The one exemption the io.ts docstring did not account for; named
  // here so it is a decision rather than an oversight.
  "apps/cli/src/lib/keyring.ts",
];

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
    // The general TS config. `scripts/**/*.ts` and the root-level `*.ts` config
    // files (knip.config.ts, commitlint.config.ts) are in here deliberately, and
    // on the SAME rule set as application source rather than a relaxed one:
    //   - They are ordinary TypeScript run by Bun, not a different dialect, and
    //     several of them (verify-openapi, detect-breaking-changes,
    //     check-consumer-versions, verify-module-contract) ARE the CI gates —
    //     a gate that is itself unchecked is the weakest link in the chain.
    //   - Before this, `turbo.json` claimed `scripts/**/*.ts` and `knip.config.ts`
    //     as `//#lint` inputs while eslint answered "File ignored because no
    //     matching configuration was supplied" for every one of them: the gate
    //     was honest in intent and inert in fact.
    //   - `*.ts` (no slash) matches root-level files only, so this does not
    //     silently pull in arbitrary nested config files.
    // Note on `console.*`: `no-console` is NOT set here. It is enabled in its
    // own block below, over application source only — deliberately not over
    // `scripts/**` or `**/test/**`, which this block does cover. See that block
    // for why.
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: [
      "**/src/**/*.{ts,tsx}",
      "**/test/**/*.ts",
      "**/scripts/**/*.ts",
      "e2e/**/*.ts",
      "runtime-pi/**/*.ts",
      "*.ts",
    ],
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
    // `console.*` ban — application source only (CLAUDE.md: "No `console.*`:
    // use `@appstrate/core/logger`", and in `apps/cli` the `CommandIO` sink in
    // `src/lib/io.ts`). Until now that rule was enforced by review alone:
    // `no-console` is not part of `js.configs.recommended` and was set nowhere
    // in this file, so the convention had no gate behind it.
    //
    // Why application source and not everything eslint covers:
    //   - `scripts/**` (and the root `*.ts` config files) are report-printing
    //     CLI utilities — `verify-openapi`, `detect-breaking-changes`,
    //     `setup`, `check-consumer-versions`. Printing a report to the
    //     developer's terminal IS their output contract; there is no logger to
    //     route through and no sink to inject. They are covered by the general
    //     block above for every other rule, and simply not matched here.
    //   - `**/test/**` prints diagnostics on failure (the OpenAPI response
    //     validators dump their error list before asserting). A test's console
    //     line goes to the person reading the failure, not to a log pipeline.
    //   - `apps/web` and `packages/ui` are in scope: a stray `console.log`
    //     shipped to the browser bundle is exactly the thing worth catching.
    //
    // Two carve-outs inside the scope, both for directories that live under
    // `src/` but are not source:
    //   - `src/**/scripts/**` — dev tooling parked beside the module it
    //     exercises rather than in the root `scripts/` directory
    //     (`apps/api/src/modules/firecracker/scripts/dev/smoke.ts` prints its
    //     `==> boot microVM` / `SMOKE PASS` progress). Same class as
    //     `scripts/**`, same reason, so it gets the same treatment instead of
    //     20 inline disables.
    //   - `src/**/test/**` — a module's tests live inside its `src` tree
    //     (`apps/api/src/modules/*/test/**`), and they are tests like any
    //     other.
    //
    // `runtime-pi/**` (the agent image entrypoint + sidecar) has no `src/`
    // segment, so it used to match none of the general blocks and was linted
    // for the Pi-SDK import guard and nothing else — over the credential-proxy
    // and MITM surface. It is in scope now: the general block above lists it
    // explicitly, which also gives it the TypeScript parser espree lacks, and
    // this block covers it for `no-console`. The migration cost was 10
    // findings, all style, none a defect.
    files: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}", "runtime-pi/**/*.ts"],
    ignores: ["**/src/**/scripts/**", "**/src/**/test/**", "runtime-pi/**/test/**"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // Zod 4 regression guard: string formats are top-level functions
    // (z.email(), z.url(), z.uuid()) — the Zod 3 method forms are deprecated
    // and must not creep back in.
    // Scripts and root config files are in scope too: they parse manifests and
    // API payloads with Zod like everything else. This block stays ABOVE the
    // `**/test/**` and `apps/cli/src/**` blocks that re-declare
    // `no-restricted-syntax`, so those still win (with the bans re-spread) for
    // the files they cover — including `scripts/test/**`.
    files: [
      "**/src/**/*.{ts,tsx}",
      "**/test/**/*.ts",
      "**/scripts/**/*.ts",
      "e2e/**/*.ts",
      "runtime-pi/**/*.ts",
      "*.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...ZOD4_STRING_FORMAT_BANS],
    },
  },
  {
    // Both CLI output guards (issue #1180) — the clack funnel and the
    // `process.*.write` ban — over every `apps/cli/src` file exempt from
    // neither.
    //
    // They are two config objects rather than one, and the split is the whole
    // point: in flat config `ignores` removes a file from the ENTIRE config
    // object, never from a single entry of a single rule. The one object this
    // replaces carried both bans behind the union of the two exemption lists,
    // so all nine `process.*.write` carve-outs were exempt from the clack
    // funnel too — `commands/runner.ts` had its eight direct
    // `clack.select`/`clack.spinner` calls funnelled through `lib/ui.ts` in
    // `d67de45ca`, with nothing left to stop them coming back under a green
    // check.
    //
    // Re-declares `no-restricted-syntax` for a subset of the Zod block above,
    // which fully REPLACES its options here — hence the explicit spread. The
    // same replacement is why the two objects match DISJOINT file sets: both
    // set this one rule id, so a file matched by both would keep only the later
    // object's selectors, which is exactly the hole being closed.
    files: ["apps/cli/src/**/*.ts"],
    // Exempt from either ban. `CLACK_FUNNEL_EXEMPT` is a subset of
    // `PROCESS_STREAM_EXEMPT` today; both are spread so it stays correct if
    // that ever stops being true, and a duplicated glob costs nothing.
    ignores: [...CLACK_FUNNEL_EXEMPT, ...PROCESS_STREAM_EXEMPT],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...ZOD4_STRING_FORMAT_BANS,
        ...CLACK_FUNNEL_BANS,
        ...PROCESS_STREAM_BANS,
      ],
    },
  },
  {
    // The clack funnel alone, for the files that own their own stream contract
    // but are not allowed to render prompts and spinners outside `lib/ui.ts`.
    // Derived from the two lists rather than restated, so an entry added to
    // either one lands in exactly one of these two objects and cannot fall
    // through both.
    files: PROCESS_STREAM_EXEMPT.filter((file) => !CLACK_FUNNEL_EXEMPT.includes(file)),
    rules: {
      "no-restricted-syntax": ["error", ...ZOD4_STRING_FORMAT_BANS, ...CLACK_FUNNEL_BANS],
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
      // Tests may reach the vendor directly. The guard protects the PRODUCTION
      // import graph — routing a test probe through a barrel instead put the
      // vendor's 2.1 MB provider catalog on the container's boot path (see the
      // note in `packages/runner-pi/src/pi-sdk.ts`). `packages/*/test/**` was
      // never in `files`; only runtime-pi's own tests needed exempting.
      "runtime-pi/**/test/**/*.ts",
      // The sidecar image is built from `runtime-pi/sidecar/*.ts` alone, so it
      // cannot reach the agent's barrel one directory up — it needs its own.
      // It carries pi-ai to RE-ORIGINATE an aliased run's inference call
      // against the real backing (`pi-messages-backend.ts`).
      "runtime-pi/sidecar/pi-sdk.ts",
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
