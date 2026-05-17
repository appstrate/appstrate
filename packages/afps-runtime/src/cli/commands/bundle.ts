// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `afps bundle <manifest.json>` — produce a runnable `.afps` integration
 * archive from an author-time manifest (proposal §5.3, Phase 1.05).
 *
 * The actual bundling pipeline lives in `@appstrate/core/integration-
 * bundle` (which depends on Zod + the integration schema). To keep
 * `@appstrate/afps-runtime` free of an `@appstrate/core` dep, we
 * dynamic-import the bundler at run-time and degrade gracefully when
 * it is missing — the typical npx user gets a one-line install hint
 * rather than a stack trace.
 */

import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { CliIO } from "../index.ts";

const HELP = `afps bundle — vendor an integration's deps into a runnable .afps

Usage:
  afps bundle <manifest.json> [options]

Options:
  -i, --input <path>            Source manifest path (alias of positional)
  -o, --output <path>           Output .afps file. Default: <name>@<version>.afps in CWD
  -d, --doc <path>              Include this Markdown file as INTEGRATION.md
  -s, --server-dir <path>       Use a pre-vendored ./server/ tree (skips npm/pypi).
                                The directory is embedded as-is under server/.
      --bun-probe               Run the Bun compat probe after vendoring
      --probe-timeout <ms>      Bun probe wall-clock budget (default 10000)
      --dry-run                 Run all steps but don't write the output file
      --print-manifest          Print the rewritten manifest to stdout (post-bundle)
  -h, --help                    Show this help

The bundler resolves \`server.type: "npx" | "uvx"\` with \`server.package\`
against npm or pypi, vendors the resolved tree into \`./server/\`, and
rewrites the manifest to a runnable form (\`type: "node" | "uv"\`).
\`docker\` and \`http\` manifests are packaged verbatim.

Sandbox recommendation
  Vendoring shells out to \`npm install\` / \`uv pip install\`. Postinstall
  scripts can execute arbitrary code under the invoking user. Run the
  bundler inside a constrained Docker container whose egress is
  restricted to \`registry.npmjs.org\` and \`pypi.org\` (e.g. squid +
  iptables, or a Cilium NetworkPolicy in CI). The bundler honours the
  standard \`HTTPS_PROXY\` / \`NO_PROXY\` env vars; \`npm\` honours them
  via \`https-proxy\` config or \`HTTP_PROXY\`. For maximum isolation use
  \`--server-dir\` and pre-vendor outside the bundler entirely.
`;

const INSTALL_HINT = `afps bundle: @appstrate/core is not installed in this environment.
Install it as a dev dependency to use this command:

  bun add -D @appstrate/core

Or run the bundler from inside the appstrate monorepo where it ships as
a workspace package.
`;

interface BundleModule {
  bundleIntegration: (input: {
    manifest: unknown;
    extraFiles?: Record<string, Uint8Array>;
    prebuiltServerFiles?: Record<string, Uint8Array>;
    bunProbe?: { timeoutMs?: number } | true;
  }) => Promise<{
    afps: Uint8Array;
    manifest: unknown;
    suggestedFileName: string;
    bunCompat?: { ok: boolean; reason?: string; toolCount?: number; durationMs?: number };
  }>;
  BundlerError: new (msg: string, code: string) => Error;
}

async function loadBundler(io: CliIO): Promise<BundleModule | null> {
  try {
    // Optional peer; resolved at runtime when @appstrate/core is on the
    // path (always true inside the appstrate monorepo, opt-in for npm
    // consumers via `bun add -D @appstrate/core`).
    return (await import("@appstrate/core/integration-bundle")) as BundleModule;
  } catch {
    io.stderr(INSTALL_HINT);
    return null;
  }
}

export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        input: { type: "string", short: "i" },
        output: { type: "string", short: "o" },
        doc: { type: "string", short: "d" },
        "server-dir": { type: "string", short: "s" },
        "bun-probe": { type: "boolean" },
        "probe-timeout": { type: "string" },
        "dry-run": { type: "boolean" },
        "print-manifest": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`afps bundle: ${(err as Error).message}\n`);
    io.stderr(HELP);
    return 2;
  }
  if (parsed.values.help) {
    io.stdout(HELP);
    return 0;
  }

  const inputPath = parsed.values.input ?? parsed.positionals[0];
  if (!inputPath) {
    io.stderr("afps bundle: missing <manifest.json>\n");
    io.stderr(HELP);
    return 2;
  }

  const bundler = await loadBundler(io);
  if (!bundler) return 1;

  // Read + parse the source manifest.
  let manifest: unknown;
  try {
    const raw = await readFile(inputPath, "utf8");
    manifest = JSON.parse(raw);
  } catch (err) {
    io.stderr(`afps bundle: failed to read ${inputPath}: ${(err as Error).message}\n`);
    return 1;
  }

  // Optional doc + pre-vendored server dir.
  const extraFiles: Record<string, Uint8Array> = {};
  if (parsed.values.doc) {
    try {
      const docBytes = await readFile(parsed.values.doc);
      extraFiles["INTEGRATION.md"] = new Uint8Array(docBytes);
    } catch (err) {
      io.stderr(
        `afps bundle: failed to read --doc ${parsed.values.doc}: ${(err as Error).message}\n`,
      );
      return 1;
    }
  }

  let prebuiltServerFiles: Record<string, Uint8Array> | undefined;
  if (parsed.values["server-dir"]) {
    try {
      prebuiltServerFiles = await collectServerDir(parsed.values["server-dir"]);
    } catch (err) {
      io.stderr(
        `afps bundle: failed to read --server-dir ${parsed.values["server-dir"]}: ${(err as Error).message}\n`,
      );
      return 1;
    }
  }

  // Probe knobs.
  let bunProbe: { timeoutMs?: number } | true | undefined;
  if (parsed.values["bun-probe"]) {
    const ms = parsed.values["probe-timeout"];
    bunProbe = ms ? { timeoutMs: Number(ms) } : true;
  }

  let result: Awaited<ReturnType<BundleModule["bundleIntegration"]>>;
  try {
    result = await bundler.bundleIntegration({
      manifest,
      extraFiles: Object.keys(extraFiles).length > 0 ? extraFiles : undefined,
      prebuiltServerFiles,
      bunProbe,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`afps bundle: ${msg}\n`);
    return 1;
  }

  const outPath = parsed.values.output ?? result.suggestedFileName;
  if (parsed.values["dry-run"]) {
    io.stdout(`would write ${outPath} (${result.afps.length} bytes)\n`);
  } else {
    await writeFile(outPath, result.afps);
    io.stdout(`wrote ${basename(outPath)} (${result.afps.length} bytes)\n`);
  }

  if (result.bunCompat) {
    if (result.bunCompat.ok) {
      io.stdout(
        `bun probe ok — ${result.bunCompat.toolCount ?? "?"} tools, ${result.bunCompat.durationMs}ms\n`,
      );
    } else {
      io.stderr(`bun probe FAILED: ${result.bunCompat.reason ?? "(no reason)"}\n`);
      io.stderr(
        "manifest tagged _meta.bunCompat = false; consider falling back to server.type: docker.\n",
      );
    }
  }

  if (parsed.values["print-manifest"]) {
    io.stdout(JSON.stringify(result.manifest, null, 2) + "\n");
  }
  return 0;
}

/**
 * Recursively read a directory into a flat `server/...` keyed map.
 * Symlinks are followed via `stat`; hidden `.git` / `node_modules/.cache`
 * trees are skipped to keep bundles lean.
 */
async function collectServerDir(rootDir: string): Promise<Record<string, Uint8Array>> {
  const { readdir, stat, readFile } = await import("node:fs/promises");
  const { join, posix, relative, sep } = await import("node:path");
  const out: Record<string, Uint8Array> = {};
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (entry === ".git" || entry === ".cache") continue;
      const abs = join(dir, entry);
      const st = await stat(abs);
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(rootDir, abs).split(sep).join(posix.sep);
      out[`server/${rel}`] = new Uint8Array(await readFile(abs));
    }
  }
  return out;
}
