// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * npm vendoring resolver — resolves an `_meta["dev.appstrate/vendor"]` npm
 * source into a self-contained `./server/` tree runnable under `node`.
 *
 * The resolver is the only piece of the bundler that talks to the
 * network and to the filesystem at the same time. We isolate both
 * boundaries behind injectable functions so unit tests can run
 * deterministically without npm, without a sandbox, and without race
 * conditions:
 *
 *   - `fetchRegistry(url)` returns the parsed JSON for an npm registry
 *     URL (https://registry.npmjs.org/<pkg>/<version>). The default
 *     implementation uses `fetch` — tests inject a mock.
 *   - `installPackage(spec, targetDir)` runs `npm install --omit=dev
 *     --no-package-lock --prefix <targetDir> <spec>`. The default uses
 *     `Bun.spawn` — tests inject a no-op that materialises a fixture
 *     tree on disk.
 *
 * The resolver returns a `VendorResult` that the bundler then folds
 * into the distributed manifest. Network failures, invalid registry
 * responses, missing entry points, and install failures all surface
 * as `BundlerError` instances so the CLI can give a meaningful
 * message instead of a stack trace.
 */

import { mkdtemp, readFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, relative, sep } from "node:path";

import type { SourceResolution, VendorResult } from "./types.ts";

export class BundlerError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "BundlerError";
  }
}

const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/**
 * Minimal slice of the npm registry packument shape that we depend on.
 * Many more fields exist; we ignore them so we don't get tripped up by
 * registry-side changes.
 */
export interface NpmRegistryVersion {
  name: string;
  version: string;
  bin?: string | Record<string, string>;
  main?: string;
  dist?: {
    tarball?: string;
    integrity?: string;
  };
}

export interface NpmInstallSpec {
  /** Bare package name (e.g. `@modelcontextprotocol/server-filesystem`). */
  identifier: string;
  /** Resolved exact version (e.g. `1.4.2`). */
  version: string;
  /** Target directory containing a `package.json` and `node_modules/`. */
  targetDir: string;
  /** Registry base URL (defaults to npmjs.org). */
  registryBaseUrl?: string;
}

export type FetchRegistryFn = (url: string) => Promise<unknown>;
export type InstallPackageFn = (spec: NpmInstallSpec) => Promise<void>;

export interface NpmVendorDeps {
  fetchRegistry?: FetchRegistryFn;
  installPackage?: InstallPackageFn;
  /** Override the work directory root. Defaults to `os.tmpdir()`. */
  workRoot?: string;
  /** When true, the workDir is preserved after success (debug). */
  keepWorkDir?: boolean;
  /** Override the current wall-clock; used for deterministic tests. */
  now?: () => Date;
}

export interface NpmVendorInput {
  identifier: string;
  versionRange: string;
  registryBaseUrl?: string;
}

const defaultFetchRegistry: FetchRegistryFn = async (url) => {
  const res = await fetch(url, {
    headers: { accept: "application/vnd.npm.install-v1+json, application/json" },
  });
  if (!res.ok) {
    throw new BundlerError(`npm registry returned HTTP ${res.status} for ${url}`, "REGISTRY_HTTP");
  }
  return (await res.json()) as unknown;
};

const defaultInstallPackage: InstallPackageFn = async (spec) => {
  const proc = Bun.spawn({
    cmd: [
      "npm",
      "install",
      "--omit=dev",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--prefix",
      spec.targetDir,
      `${spec.identifier}@${spec.version}`,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new BundlerError(
      `npm install failed (exit ${exitCode}) for ${spec.identifier}@${spec.version}: ${stderr.slice(0, 500)}`,
      "NPM_INSTALL",
    );
  }
};

/**
 * Look up the resolved version + integrity for an npm package via the
 * registry packument endpoint. Accepts an exact version, a `dist-tag`
 * (e.g. `latest`), or — best-effort — the literal range. Real semver
 * range solving is intentionally NOT implemented here; the registry
 * already exposes an exact-version endpoint, and ranges-not-yet-
 * resolved are surfaced as a clean error so the author can pin.
 */
export async function resolveNpmVersion(
  input: NpmVendorInput,
  deps: NpmVendorDeps = {},
): Promise<{ version: string; integrity: string; tarball?: string }> {
  const fetchRegistry = deps.fetchRegistry ?? defaultFetchRegistry;
  const base = (input.registryBaseUrl ?? DEFAULT_NPM_REGISTRY).replace(/\/$/, "");
  // Scoped npm names have exactly one `/` (e.g. `@scope/name`), so a
  // single replace is functionally correct — but `replaceAll` is clearer
  // and silences the CodeQL "incomplete string escaping" warning, which
  // catches the broader anti-pattern even when the input shape happens
  // to make it safe.
  const escapedId = input.identifier.startsWith("@")
    ? input.identifier.replaceAll("/", "%2F")
    : input.identifier;
  const url = `${base}/${escapedId}/${encodeURIComponent(input.versionRange)}`;

  const raw = await fetchRegistry(url);
  if (raw === null || typeof raw !== "object") {
    throw new BundlerError(
      `npm registry response is not an object for ${input.identifier}@${input.versionRange}`,
      "REGISTRY_SHAPE",
    );
  }
  const packument = raw as Partial<NpmRegistryVersion>;
  if (!packument.version) {
    throw new BundlerError(
      `npm registry did not return a resolved version for ${input.identifier}@${input.versionRange}`,
      "REGISTRY_NO_VERSION",
    );
  }
  if (!packument.dist?.integrity) {
    throw new BundlerError(
      `npm registry omitted dist.integrity for ${input.identifier}@${packument.version}`,
      "REGISTRY_NO_INTEGRITY",
    );
  }
  return {
    version: packument.version,
    integrity: packument.dist.integrity,
    tarball: packument.dist.tarball,
  };
}

/**
 * Resolve the entrypoint to invoke under `node`. Mirrors npm's own
 * lookup logic in a deliberately narrow way:
 *
 *   1. If `package.json#bin` is a string → use that file directly.
 *   2. If `package.json#bin` is an object — prefer the entry whose key
 *      equals the package name; otherwise the first entry.
 *   3. Fallback to `package.json#main` (or `index.js`).
 *
 * This matches what `npx <pkg>` would have invoked on the same
 * package, modulo the rare case of `package.json#bin` being absent and
 * `index.js` not existing — that throws so the bundler doesn't silently
 * produce a broken bundle.
 */
export function pickNpmEntryPoint(pkg: NpmRegistryVersion): string {
  if (typeof pkg.bin === "string") return pkg.bin;
  if (pkg.bin && typeof pkg.bin === "object") {
    const named = pkg.bin[pkg.name];
    if (named) return named;
    const first = Object.values(pkg.bin)[0];
    if (first) return first;
  }
  return pkg.main ?? "index.js";
}

/**
 * Walk a directory and return every file as `{ relativePosixPath: bytes }`.
 * Skips the `.cache/` directory (build noise) but keeps everything else so
 * vendored packages remain runnable.
 */
async function collectFiles(rootDir: string): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await readdir(dir);
    for (const entry of entries) {
      const abs = join(dir, entry);
      const st = await stat(abs);
      if (st.isDirectory()) {
        // Skip noise that bloats the bundle without affecting runtime.
        if (entry === ".cache") continue;
        stack.push(abs);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(rootDir, abs).split(sep).join(posix.sep);
      out[rel] = new Uint8Array(await readFile(abs));
    }
  }
  return out;
}

/**
 * Run the full npm vendor pass and return the embeddable file tree +
 * the rewritten server section. The caller (the bundler) is
 * responsible for stitching the result into the distributed manifest.
 */
export async function vendorNpmPackage(
  input: NpmVendorInput,
  deps: NpmVendorDeps = {},
): Promise<VendorResult> {
  const fetchRegistry = deps.fetchRegistry ?? defaultFetchRegistry;
  const installPackage = deps.installPackage ?? defaultInstallPackage;
  const now = deps.now ?? (() => new Date());
  const workRoot = deps.workRoot ?? tmpdir();

  const resolved = await resolveNpmVersion(input, { fetchRegistry });

  const workDir = await mkdtemp(join(workRoot, "afps-bundle-npm-"));
  try {
    await installPackage({
      identifier: input.identifier,
      version: resolved.version,
      targetDir: workDir,
      registryBaseUrl: input.registryBaseUrl,
    });

    const installedRoot = join(workDir, "node_modules", input.identifier);
    let manifestRaw: string;
    try {
      manifestRaw = await readFile(join(installedRoot, "package.json"), "utf8");
    } catch {
      throw new BundlerError(
        `npm install did not produce ${input.identifier}/package.json under ${workDir}`,
        "INSTALL_TREE_MISSING",
      );
    }
    let pkgJson: NpmRegistryVersion;
    try {
      pkgJson = JSON.parse(manifestRaw) as NpmRegistryVersion;
    } catch {
      throw new BundlerError(
        `installed package.json for ${input.identifier} is not valid JSON`,
        "INSTALL_TREE_PARSE",
      );
    }
    const binRel = pickNpmEntryPoint(pkgJson);
    const entryAbs = join(installedRoot, binRel);
    try {
      await stat(entryAbs);
    } catch {
      throw new BundlerError(
        `resolved entry point does not exist on disk: ${binRel}`,
        "ENTRY_MISSING",
      );
    }

    // Collect everything under node_modules/ so the vendored bundle is
    // runnable without further install.
    const filesUnderTree = await collectFiles(join(workDir, "node_modules"));
    const files: Record<string, Uint8Array> = {};
    for (const [rel, bytes] of Object.entries(filesUnderTree)) {
      files[`server/node_modules/${rel}`] = bytes;
    }

    const resolution: SourceResolution = {
      registryType: "npm",
      identifier: input.identifier,
      versionRequested: input.versionRange,
      versionResolved: resolved.version,
      integrity: resolved.integrity,
      resolvedAt: now().toISOString(),
    };

    return {
      files,
      rewrittenServerType: "node",
      rewrittenEntryPoint: `./server/node_modules/${input.identifier}/${binRel}`,
      resolution,
    };
  } finally {
    if (!deps.keepWorkDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
