#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate` — official Appstrate CLI entry point.
 *
 * Commands:
 *   - `appstrate install`: install Appstrate locally or bring up Docker.
 *   - `appstrate login`:   RFC 8628 device-flow against an instance.
 *   - `appstrate logout`:  revoke the session + wipe local storage.
 *   - `appstrate whoami`:  server-authoritative identity check.
 *   - `appstrate token`:   print access + refresh token metadata (debug).
 *   - `appstrate org`:     manage the pinned organization (`X-Org-Id`).
 *   - `appstrate app`:     manage the pinned application (`X-App-Id`).
 *   - `appstrate api`:     authenticated HTTP passthrough for coding agents.
 *
 * Global flags:
 *   - `--profile <name>` selects which profile (keyring entry + TOML
 *     section) the command operates on. Falls back to
 *     `APPSTRATE_PROFILE` / `defaultProfile` / `"default"`. See
 *     `lib/config.ts::resolveProfileName`.
 *
 * Top-level error handling: any unhandled rejection ends the process
 * via `formatError` so DeviceFlowError / ApiError / AuthError render
 * with user-actionable text rather than raw stack traces.
 */

import { Command, InvalidArgumentError } from "commander";
import { installCommand } from "./commands/install.ts";
import { loginCommand } from "./commands/login.ts";
import { logoutCommand } from "./commands/logout.ts";
import { whoamiCommand } from "./commands/whoami.ts";
import { tokenCommand } from "./commands/token.ts";
import { apiCommand, isHttpMethod } from "./commands/api.ts";
import {
  orgListCommand,
  orgSwitchCommand,
  orgCurrentCommand,
  orgCreateCommand,
} from "./commands/org.ts";
import {
  appListCommand,
  appSwitchCommand,
  appCurrentCommand,
  appCreateCommand,
} from "./commands/app.ts";
import { modelsListCommand } from "./commands/models.ts";
import { registerOpenapiCommand } from "./commands/openapi.ts";
import { runCommand } from "./commands/run.ts";
import { exitWithError } from "./lib/ui.ts";
import { CLI_VERSION } from "./lib/version.ts";

// Defense in depth: restore cooked mode on exit. `@clack/prompts`
// sets raw mode via `process.stdin.setRawMode(true)` and relies on its
// own listeners to flip it back — if the process dies while a prompt
// is open (crash, SIGINT, the Bun macOS keypress regression in #199)
// the terminal is left unusable and only `reset` fixes it. Registering
// a cooked-mode restore on every exit path is cheap and catches the
// edge cases clack's own cleanup misses. Must be registered BEFORE the
// error handlers below so a synchronous crash in startup still runs it.
const restoreCookedMode = (): void => {
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
  } catch {
    // Intentional swallow: restoration is best-effort. If stdin was
    // already detached (exec into another process, stream closed) the
    // call throws — but we're already on the exit path, so nothing we
    // do here matters except not masking the real exit code.
  }
};
process.on("exit", restoreCookedMode);
process.on("SIGINT", () => {
  restoreCookedMode();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restoreCookedMode();
  process.exit(143);
});
process.on("SIGHUP", () => {
  restoreCookedMode();
  process.exit(129);
});

/**
 * Commander's idiomatic "collect repeated option into array" — needed
 * for `-H`, `-F`, `-q` on `appstrate api` where users repeat the flag
 * (curl-compatible).
 */
function collect(val: string, prev: string[]): string[] {
  return [...prev, val];
}

// Catch stray unhandled rejections + uncaughts before Bun's default
// stack-trace dump kicks in — commands are async and may throw after
// commander's callback completes.
process.on("unhandledRejection", (err) => exitWithError(err));
process.on("uncaughtException", (err) => exitWithError(err));

const program = new Command();

program
  .name("appstrate")
  .description("Official CLI for the Appstrate platform")
  .version(CLI_VERSION)
  .option(
    "-p, --profile <name>",
    "Profile to use (overrides APPSTRATE_PROFILE / defaultProfile / 'default').",
  )
  .option(
    "--insecure",
    "Allow connecting to a non-HTTPS, non-loopback instance. Your bearer token will be transmitted in plaintext — only use on a trusted network. Equivalent to APPSTRATE_INSECURE=1.",
  )
  .hook("preAction", () => {
    // Hoist `--insecure` into the env so every downstream module that
    // reads it (instance-url.ts::isInsecureOptIn) sees a single source
    // of truth — no need to thread the flag through every command.
    if (program.opts<{ insecure?: boolean }>().insecure) {
      process.env.APPSTRATE_INSECURE = "1";
    }
  });

program
  .command("install")
  .description("Install Appstrate locally (Tier 0) or bring up the Docker stack (Tiers 1/2/3)")
  .option(
    "-t, --tier <0|1|2|3>",
    "Skip the interactive tier prompt (0 = hobby / Bun, 1/2/3 = Docker stacks).",
  )
  .option("-d, --dir <path>", "Install directory (default: ~/appstrate).")
  .option(
    "--port <port>",
    "Host port the Appstrate platform binds to (default: 3000). Also honored via APPSTRATE_PORT.",
  )
  .option(
    "--minio-console-port <port>",
    "Host port the MinIO console binds to on Tier 3 (default: 9001). Also honored via APPSTRATE_MINIO_CONSOLE_PORT.",
  )
  .option(
    "--force",
    "Bypass the 'another Compose project is already running under this name' preflight. Only use if you have already backed up the other install's data.",
  )
  .option(
    "-y, --yes",
    "Skip all prompts and accept smart defaults (Docker-aware tier from #180, default directory, auto-start dev server). Required for curl|bash, CI, Dockerfile RUN, cloud-init. Equivalent to APPSTRATE_YES=1. Per-field flags (--tier, --dir, --port) still override the defaults.",
  )
  .action(async (opts) => {
    // Env var fallback mirrors Homebrew's NONINTERACTIVE=1 / rustup-init's
    // RUSTUP_INIT_SKIP_PATH_CHECK pattern — useful for Dockerfile `ENV` and
    // cloud-init `environment:` blocks where appending argv is awkward.
    const autoConfirm = opts.yes === true || process.env.APPSTRATE_YES === "1";
    await installCommand({
      tier: typeof opts.tier === "string" ? opts.tier : undefined,
      dir: typeof opts.dir === "string" ? opts.dir : undefined,
      port: typeof opts.port === "string" ? opts.port : undefined,
      minioConsolePort:
        typeof opts.minioConsolePort === "string" ? opts.minioConsolePort : undefined,
      force: opts.force === true,
      autoConfirm,
    });
  });

program
  .command("login")
  .description("Sign in to an Appstrate instance via the device-flow grant")
  .option("--instance <url>", "Instance URL (skips the interactive prompt).")
  .option(
    "--org <id-or-slug>",
    "Pin this organization on the profile after login (non-interactive). Fails if no match.",
  )
  .option(
    "--create-org <name>",
    "Create a new organization with this name after login and pin it (non-interactive). A default application and hello-world agent are provisioned server-side.",
  )
  .option(
    "--no-org",
    "Skip the post-login org-pinning step entirely. Subsequent calls must pass `-H X-Org-Id: …` or pin later via `appstrate org switch`.",
  )
  .option(
    "--app <id>",
    "Pin this application on the profile after login (non-interactive). Fails if no match.",
  )
  .option(
    "--create-app <name>",
    "Create a new application with this name after login and pin it (non-interactive).",
  )
  .option(
    "--no-app",
    "Skip the post-login app-pinning step entirely. Subsequent calls must pass `-H X-App-Id: …` or pin later via `appstrate app switch`.",
  )
  .action(async (opts) => {
    const globalOpts = program.opts<{ profile?: string }>();
    await loginCommand({
      profile: globalOpts.profile,
      instance: typeof opts.instance === "string" ? opts.instance : undefined,
      org: typeof opts.org === "string" ? opts.org : undefined,
      createOrg: typeof opts.createOrg === "string" ? opts.createOrg : undefined,
      // Commander maps `--no-org` to `opts.org === false` (verified against
      // commander 14). `--org <value>` sets it to a string, neither leaves
      // it undefined — so `opts.org === false` is the unambiguous skip signal.
      noOrg: opts.org === false,
      app: typeof opts.app === "string" ? opts.app : undefined,
      createApp: typeof opts.createApp === "string" ? opts.createApp : undefined,
      noApp: opts.app === false,
    });
  });

program
  .command("logout")
  .description("Revoke the active session and wipe local credentials")
  .action(async () => {
    const globalOpts = program.opts<{ profile?: string }>();
    await logoutCommand({ profile: globalOpts.profile });
  });

program
  .command("whoami")
  .description("Print the active profile's identity")
  .action(async () => {
    const globalOpts = program.opts<{ profile?: string }>();
    await whoamiCommand({ profile: globalOpts.profile });
  });

program
  .command("token")
  .description("Print metadata about the stored access + refresh tokens (debug)")
  .action(async () => {
    const globalOpts = program.opts<{ profile?: string }>();
    await tokenCommand({ profile: globalOpts.profile });
  });

// ─── `appstrate org …` — manage the pinned organization (issue #209) ───

const orgGroup = program
  .command("org")
  .description("Manage the pinned organization for the active profile");

orgGroup
  .command("list")
  .description("List organizations the active profile has access to")
  .action(async () => {
    const globalOpts = program.opts<{ profile?: string }>();
    await orgListCommand({ profile: globalOpts.profile });
  });

orgGroup
  .command("current")
  .description("Print the pinned organization id, or exit 1 if none is pinned")
  .action(async () => {
    const globalOpts = program.opts<{ profile?: string }>();
    await orgCurrentCommand({ profile: globalOpts.profile });
  });

orgGroup
  .command("switch [ref]")
  .description(
    "Re-pin the active organization on the profile. With no argument, show an interactive picker.",
  )
  .action(async (ref: string | undefined) => {
    const globalOpts = program.opts<{ profile?: string }>();
    await orgSwitchCommand({
      profile: globalOpts.profile,
      ref: typeof ref === "string" ? ref : undefined,
    });
  });

orgGroup
  .command("create [name]")
  .description(
    "Create a new organization (and pin it on the profile). With no argument, prompt interactively.",
  )
  .option(
    "--slug <slug>",
    "Explicit slug (kebab-case). Defaults to a server-derived slug from the name.",
  )
  .action(async (name: string | undefined, opts) => {
    const globalOpts = program.opts<{ profile?: string }>();
    await orgCreateCommand({
      profile: globalOpts.profile,
      name: typeof name === "string" ? name : undefined,
      slug: typeof opts.slug === "string" ? opts.slug : undefined,
    });
  });

// ─── `appstrate app …` — manage the pinned application (issue #217) ────

const appGroup = program
  .command("app")
  .description("Manage the pinned application for the active profile");

appGroup
  .command("list")
  .description("List applications in the pinned organization")
  .action(async () => {
    const globalOpts = program.opts<{ profile?: string }>();
    await appListCommand({ profile: globalOpts.profile });
  });

appGroup
  .command("current")
  .description("Print the pinned application id, or exit 1 if none is pinned")
  .action(async () => {
    const globalOpts = program.opts<{ profile?: string }>();
    await appCurrentCommand({ profile: globalOpts.profile });
  });

appGroup
  .command("switch [ref]")
  .description(
    "Re-pin the active application on the profile. With no argument, show an interactive picker.",
  )
  .action(async (ref: string | undefined) => {
    const globalOpts = program.opts<{ profile?: string }>();
    await appSwitchCommand({
      profile: globalOpts.profile,
      ref: typeof ref === "string" ? ref : undefined,
    });
  });

appGroup
  .command("create [name]")
  .description(
    "Create a new application (and pin it on the profile). With no argument, prompt interactively.",
  )
  .action(async (name: string | undefined) => {
    const globalOpts = program.opts<{ profile?: string }>();
    await appCreateCommand({
      profile: globalOpts.profile,
      name: typeof name === "string" ? name : undefined,
    });
  });

// ─── `appstrate models …` — discover model presets on the instance ────

const modelsGroup = program
  .command("models")
  .description("Discover model presets exposed by the pinned Appstrate instance");

modelsGroup
  .command("list")
  .description(
    "List model presets. Use `--proxy-only` to filter to presets wired on /api/llm-proxy/*.",
  )
  .option("--json", "Emit machine-readable JSON")
  .option("--proxy-only", "Only show presets that /api/llm-proxy/* can route")
  .action(async (opts: { json?: boolean; proxyOnly?: boolean }) => {
    const globalOpts = program.opts<{ profile?: string }>();
    await modelsListCommand({
      profile: globalOpts.profile,
      json: opts.json,
      proxyOnly: opts.proxyOnly,
    });
  });

program
  .command("api <target> [extra]")
  .description(
    "Authenticated HTTP passthrough to the Appstrate API. Injects the active profile's bearer token + X-Org-Id + X-App-Id so coding agents (Claude Code, Cursor, Aider, …) can call the API without ever seeing the raw token.\n" +
      "\n" +
      "Invocation forms (all curl-compatible):\n" +
      "  appstrate api GET /api/x             # explicit method + path\n" +
      "  appstrate api /api/x                 # method inferred (GET / POST / PUT)\n" +
      "  appstrate api https://instance/api/x # absolute URL, must match active profile\n" +
      "  appstrate api POST /api/x -d @body   # body via -d / --data-raw / --data-binary / -F",
  )
  .option("-H, --header <kv>", "Request header 'Name: value' (repeatable)", collect, [])
  .option("-d, --data <str>", "Request body — literal, @file, or @- for stdin")
  .option("--data-raw <str>", "Request body — literal, no @ interpretation")
  .option(
    "--data-binary <str>",
    "Request body — literal or @file, no content-type guess, no newline stripping",
  )
  .option(
    "--data-urlencode <data>",
    "URL-encoded body part (repeatable). Forms: 'content' | '=content' | 'name=content' | '@file' | 'name@file'. Combine with -G to build a query string.",
    collect,
    [],
  )
  .option(
    "-F, --form <kv>",
    "Multipart field 'k=v' or 'k=@path[;type=mime]' (repeatable)",
    collect,
    [],
  )
  .option("-q, --query <kv>", "Query parameter 'k=v' (repeatable)", collect, [])
  .option(
    "-G, --get",
    "Convert -d/--data values into query parameters and send a GET (curl -G). Incompatible with -F.",
  )
  .option(
    "-v, --verbose",
    "Trace request + response headers on stderr (curl -v). Authorization header is always [REDACTED].",
  )
  .option(
    "-w, --write-out <fmt>",
    "After the body, write a format string to stdout. Supports %{http_code}, %{size_download}, %{time_total}, %{url_effective}, %{header_json}, %{exitcode}, and escape sequences \\n \\r \\t.",
  )
  .option("-X, --request <method>", "Override method (takes precedence over positional)")
  .option("-o, --output <file>", "Write response body to file (default: stdout)")
  .option("-i, --include", "Include status line + response headers on stdout")
  .option("-I, --head", "Send HEAD and print headers only")
  .option(
    "-s, --silent",
    "Suppress UX hints and error messages on stderr (curl -s). Combine with -S to restore errors.",
  )
  .option("-S, --show-error", "Restore error messages when combined with -s (curl -sS pattern).")
  .option(
    "-f, --fail",
    "Exit 22 (4xx) / 25 (5xx) on non-2xx and suppress the body entirely (curl-aligned).",
  )
  .option(
    "--fail-with-body",
    "Like -f but keep the response body on stdout (curl 7.76+). Use when agents need the error payload for logging.",
  )
  .option(
    "--compressed",
    "Advertise Accept-Encoding gzip/deflate/br (Bun fetch decompresses automatically).",
  )
  .option(
    "-r, --range <spec>",
    "Send a Range: bytes=<spec> header (e.g. '0-1023', '-500', '1000-').",
  )
  .option(
    "-A, --user-agent <ua>",
    "Override the default User-Agent (shortcut for -H 'User-Agent: …'). A later -H still wins.",
  )
  .option("-e, --referer <url>", "Set the Referer header (shortcut for -H 'Referer: …').")
  .option(
    "-b, --cookie <data>",
    "Literal cookie string 'k=v; k2=v2'. Cookie-jar files (curl -b file) are NOT supported.",
  )
  .option(
    "-L, --location",
    "Follow redirects (cross-origin hops strip Authorization per WHATWG fetch)",
  )
  .option(
    "-k, --insecure",
    "Skip TLS verification for THIS request (conflicts with global --insecure)",
  )
  .option(
    "-T, --upload-file <path>",
    "PUT the contents of <path> as the request body. `-T -` streams stdin. Mutually exclusive with -d/-F.",
  )
  .option(
    "--retry <n>",
    "Retry on transient HTTP codes (408/429/500/502/503/504) and DNS/timeout errors (curl --retry). Incompatible with stdin body.",
    (v) => {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new InvalidArgumentError(`expected a non-negative integer, got "${v}"`);
      }
      return n;
    },
  )
  .option(
    "--retry-max-time <sec>",
    "Total wall-clock budget for retries in seconds (0 = unlimited).",
    (v) => {
      const n = parseFloat(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new InvalidArgumentError(`expected a non-negative number, got "${v}"`);
      }
      return n;
    },
  )
  .option(
    "--retry-delay <sec>",
    "Base backoff in seconds between retries (doubled each attempt). Default: 1.",
    (v) => {
      const n = parseFloat(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new InvalidArgumentError(`expected a non-negative number, got "${v}"`);
      }
      return n;
    },
  )
  .option(
    "--retry-connrefused",
    "Treat ECONNREFUSED as a retryable error (off by default; matches curl).",
  )
  .option(
    "--connect-timeout <sec>",
    "Abort if response headers don't arrive in N seconds (curl --connect-timeout → exit 28).",
    (v) => {
      const n = parseFloat(v);
      if (!Number.isFinite(n) || n <= 0) {
        throw new InvalidArgumentError(`expected a positive number, got "${v}"`);
      }
      return n;
    },
  )
  .option("--max-time <sec>", "Abort the request after N seconds (curl exit code 28)", (v) => {
    const n = parseFloat(v);
    if (!Number.isFinite(n) || n <= 0) {
      // Match curl's diagnostic shape so shell scripts porting from
      // `curl --max-time` see the same class of error rather than a
      // silent drop to "no timeout".
      throw new InvalidArgumentError(`expected a positive number of seconds, got "${v}"`);
    }
    return n;
  })
  .action(async (target: string, extra: string | undefined, opts) => {
    // Resolve `<target> [extra]` → {method, path}. Two shapes:
    //   api POST /x   → arg1=HTTP method, arg2=path (curl -X style)
    //   api /x        → method inferred (GET/POST/PUT per flags + body)
    //   api https://…/x → absolute URL (origin validated downstream)
    // If arg2 is present but arg1 isn't a known verb, refuse — the
    // user probably mistyped a method and we'd otherwise silently try
    // to GET the word "fetchh".
    let method: string | undefined;
    let path: string;
    if (extra !== undefined) {
      if (!isHttpMethod(target)) {
        throw new InvalidArgumentError(
          `expected HTTP method as first argument, got "${target}" (did you mean GET/POST/PUT/…?)`,
        );
      }
      method = target.toUpperCase();
      path = extra;
    } else {
      method = undefined; // let apiCommand infer from flags + body
      path = target;
    }
    const globalOpts = program.opts<{ profile?: string }>();
    await apiCommand({
      profile: globalOpts.profile,
      method,
      path,
      header: Array.isArray(opts.header) ? opts.header : [],
      form: Array.isArray(opts.form) ? opts.form : [],
      query: Array.isArray(opts.query) ? opts.query : [],
      data: typeof opts.data === "string" ? opts.data : undefined,
      dataRaw: typeof opts.dataRaw === "string" ? opts.dataRaw : undefined,
      dataBinary: typeof opts.dataBinary === "string" ? opts.dataBinary : undefined,
      dataUrlencode: Array.isArray(opts.dataUrlencode) ? opts.dataUrlencode : undefined,
      request: typeof opts.request === "string" ? opts.request : undefined,
      output: typeof opts.output === "string" ? opts.output : undefined,
      include: opts.include === true,
      head: opts.head === true,
      silent: opts.silent === true,
      showError: opts.showError === true,
      verbose: opts.verbose === true,
      get: opts.get === true,
      writeOut: typeof opts.writeOut === "string" ? opts.writeOut : undefined,
      uploadFile: typeof opts.uploadFile === "string" ? opts.uploadFile : undefined,
      connectTimeout:
        typeof opts.connectTimeout === "number" && !Number.isNaN(opts.connectTimeout)
          ? opts.connectTimeout
          : undefined,
      retry: typeof opts.retry === "number" && !Number.isNaN(opts.retry) ? opts.retry : undefined,
      retryMaxTime:
        typeof opts.retryMaxTime === "number" && !Number.isNaN(opts.retryMaxTime)
          ? opts.retryMaxTime
          : undefined,
      retryDelay:
        typeof opts.retryDelay === "number" && !Number.isNaN(opts.retryDelay)
          ? opts.retryDelay
          : undefined,
      retryConnrefused: opts.retryConnrefused === true,
      compressed: opts.compressed === true,
      range: typeof opts.range === "string" ? opts.range : undefined,
      userAgent: typeof opts.userAgent === "string" ? opts.userAgent : undefined,
      referer: typeof opts.referer === "string" ? opts.referer : undefined,
      cookie: typeof opts.cookie === "string" ? opts.cookie : undefined,
      failWithBody: opts.failWithBody === true,
      fail: opts.fail === true,
      location: opts.location === true,
      insecure: opts.insecure === true,
      maxTime:
        typeof opts.maxTime === "number" && !Number.isNaN(opts.maxTime) ? opts.maxTime : undefined,
    });
  });

registerOpenapiCommand(program, () => program.opts<{ profile?: string }>().profile);

program
  .command("run")
  .description("Execute an AFPS bundle locally via PiRunner (CLI mode — no platform preamble)")
  .argument("<bundle>", "Path to the bundle — .afps (single-package) or .afps-bundle (with deps)")
  .option(
    "--providers <mode>",
    "Provider resolution: remote (default, via Appstrate instance), local (creds file), or none",
  )
  .option("--creds-file <path>", "JSON credentials file for --providers=local")
  .option("--api-key <key>", "Appstrate API key (ask_...) for --providers=remote")
  .option("--input <json>", "Input JSON object passed to the agent")
  .option("--input-file <path>", "Read input JSON from file")
  .option("--config <json>", "Config JSON object passed to the agent")
  .option(
    "--snapshot <path>",
    "JSON file { memories?, history?, state? } seeded onto the ExecutionContext before the run",
  )
  .option(
    "--model-source <mode>",
    "Where the model comes from: env (default, user LLM credentials) or preset (pinned instance routes via /api/llm-proxy/*)",
  )
  .option("--model <id>", "Model ID (env mode) or preset id (preset mode); defaults apply")
  .option("--model-api <api>", "Model API (env mode only; default: anthropic-messages)")
  .option(
    "--llm-api-key <key>",
    "LLM API key (env mode; default: from env — ANTHROPIC_API_KEY etc.)",
  )
  .option("--run-id <id>", "Explicit run id (default: generated)")
  .option("--output <path>", "Write the final RunResult JSON to this path")
  .option("--json", "Emit canonical RunEvents as JSONL on stdout")
  .option(
    "--report <mode>",
    "Stream events to the Appstrate instance: auto (default — on when a profile is present), true (force on), false (off)",
  )
  .option(
    "--report-fallback <mode>",
    "Behavior when `POST /api/runs/remote` fails: abort (default) or console (console-only fallback)",
  )
  .option(
    "--sink-ttl <seconds>",
    "Requested sink lifetime in seconds (server clamps to REMOTE_RUN_SINK_MAX_TTL_SECONDS)",
  )
  .action(async (bundle: string, opts) => {
    const globalOpts = program.opts<{ profile?: string }>();
    await runCommand({
      profile: globalOpts.profile,
      bundle,
      providers: typeof opts.providers === "string" ? opts.providers : undefined,
      credsFile: typeof opts.credsFile === "string" ? opts.credsFile : undefined,
      apiKey: typeof opts.apiKey === "string" ? opts.apiKey : undefined,
      input: typeof opts.input === "string" ? opts.input : undefined,
      inputFile: typeof opts.inputFile === "string" ? opts.inputFile : undefined,
      config: typeof opts.config === "string" ? opts.config : undefined,
      snapshot: typeof opts.snapshot === "string" ? opts.snapshot : undefined,
      model: typeof opts.model === "string" ? opts.model : undefined,
      modelApi: typeof opts.modelApi === "string" ? opts.modelApi : undefined,
      modelSource: typeof opts.modelSource === "string" ? opts.modelSource : undefined,
      llmApiKey: typeof opts.llmApiKey === "string" ? opts.llmApiKey : undefined,
      runId: typeof opts.runId === "string" ? opts.runId : undefined,
      output: typeof opts.output === "string" ? opts.output : undefined,
      json: opts.json === true,
      report: parseReportMode(opts.report),
      reportFallback: parseReportFallback(opts.reportFallback),
      sinkTtl: parseSinkTtl(opts.sinkTtl),
    });
  });

function parseReportMode(raw: unknown): "auto" | "true" | "false" | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw === "auto" || raw === "true" || raw === "false") return raw;
  throw new Error(`Invalid --report value "${raw}" (expected: auto | true | false)`);
}

function parseReportFallback(raw: unknown): "abort" | "console" | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw === "abort" || raw === "console") return raw;
  throw new Error(`Invalid --report-fallback value "${raw}" (expected: abort | console)`);
}

function parseSinkTtl(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid --sink-ttl "${raw}" (expected a positive integer number of seconds)`);
  }
  return n;
}

program.parseAsync(process.argv).catch((err) => exitWithError(err));
