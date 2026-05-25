// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * pypi vendoring resolver — resolves an `_meta["dev.appstrate/vendor"]` pypi
 * source into a self-contained `./server/` tree runnable as a `binary`.
 *
 * Mirrors the structure of `npm-vendor.ts` — see that file's header
 * for the design rationale (injected I/O, BundlerError surface, etc.).
 * The pypi-specific differences:
 *
 *   - Resolution uses the pypi JSON API
 *     (`https://pypi.org/pypi/<pkg>/<version>/json`). We capture the
 *     `sdist` integrity hash (sha256 base64) when present, falling
 *     back to the first wheel's hash.
 *   - Installation uses `uv pip install --target <dir>` by default,
 *     which avoids the user's site-packages and produces a flat layout
 *     under `./server/lib/`. Operators can swap in `pip install
 *     --target` via the injectable `installPackage` boundary.
 *   - The entry point is discovered from each package's
 *     `*.dist-info/entry_points.txt`. We look for a `console_scripts`
 *     entry; if absent, we fall back to `python -m <module>` style and
 *     surface a clear error if neither is available.
 */

import { mkdtemp, readFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, relative, sep } from "node:path";

import { BundlerError } from "./npm-vendor.ts";
import type { SourceResolution, VendorResult } from "./types.ts";

const DEFAULT_PYPI_REGISTRY = "https://pypi.org/pypi";

/**
 * Minimal slice of the pypi JSON-API response we depend on. The full
 * response is much larger; we only narrow what's load-bearing.
 */
export interface PypiRegistryResponse {
  info: {
    name: string;
    version: string;
    entry_points?: { console_scripts?: Record<string, string> };
  };
  urls: Array<{
    packagetype: string;
    digests?: { sha256?: string };
    filename: string;
  }>;
}

export interface PypiInstallSpec {
  identifier: string;
  version: string;
  targetDir: string;
  registryBaseUrl?: string;
}

export type FetchPypiFn = (url: string) => Promise<unknown>;
export type InstallPypiFn = (spec: PypiInstallSpec) => Promise<void>;

export interface PypiVendorDeps {
  fetchRegistry?: FetchPypiFn;
  installPackage?: InstallPypiFn;
  workRoot?: string;
  keepWorkDir?: boolean;
  now?: () => Date;
}

export interface PypiVendorInput {
  identifier: string;
  versionRange: string;
  registryBaseUrl?: string;
}

const defaultFetchRegistry: FetchPypiFn = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new BundlerError(`pypi registry returned HTTP ${res.status} for ${url}`, "REGISTRY_HTTP");
  }
  return (await res.json()) as unknown;
};

const defaultInstallPackage: InstallPypiFn = async (spec) => {
  // `uv` is the canonical install tool used by `uvx` itself. We fall
  // back to `pip` only if `uv` isn't on PATH so operators without uv
  // installed can still bundle (with a slightly slower install pass).
  const uvProbe = Bun.spawn({ cmd: ["uv", "--version"], stdout: "pipe", stderr: "pipe" });
  const uvExitCode = await uvProbe.exited;
  const useUv = uvExitCode === 0;

  const installCmd = useUv
    ? ["uv", "pip", "install", "--target", spec.targetDir, `${spec.identifier}==${spec.version}`]
    : [
        "python",
        "-m",
        "pip",
        "install",
        "--target",
        spec.targetDir,
        "--no-input",
        `${spec.identifier}==${spec.version}`,
      ];

  const proc = Bun.spawn({ cmd: installCmd, stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new BundlerError(
      `${useUv ? "uv pip" : "pip"} install failed (exit ${exitCode}) for ${spec.identifier}==${spec.version}: ${stderr.slice(0, 500)}`,
      "PIP_INSTALL",
    );
  }
};

export async function resolvePypiVersion(
  input: PypiVendorInput,
  deps: PypiVendorDeps = {},
): Promise<{ version: string; integrity: string }> {
  const fetchRegistry = deps.fetchRegistry ?? defaultFetchRegistry;
  const base = (input.registryBaseUrl ?? DEFAULT_PYPI_REGISTRY).replace(/\/$/, "");
  const url = `${base}/${encodeURIComponent(input.identifier)}/${encodeURIComponent(input.versionRange)}/json`;

  const raw = await fetchRegistry(url);
  if (raw === null || typeof raw !== "object") {
    throw new BundlerError(
      `pypi registry response is not an object for ${input.identifier}@${input.versionRange}`,
      "REGISTRY_SHAPE",
    );
  }
  const r = raw as Partial<PypiRegistryResponse>;
  if (!r.info?.version) {
    throw new BundlerError(
      `pypi registry did not return a resolved version for ${input.identifier}@${input.versionRange}`,
      "REGISTRY_NO_VERSION",
    );
  }
  const urls = r.urls ?? [];
  // Prefer the source distribution (sdist) since it's the most
  // reproducibly-installable; fall back to the first wheel.
  const sdist = urls.find((u) => u.packagetype === "sdist") ?? urls[0];
  const integrity = sdist?.digests?.sha256;
  if (!integrity) {
    throw new BundlerError(
      `pypi registry omitted sha256 integrity for ${input.identifier}@${r.info.version}`,
      "REGISTRY_NO_INTEGRITY",
    );
  }
  return { version: r.info.version, integrity: `sha256-${integrity}` };
}

/**
 * Discover the script entry point from a freshly-installed pypi
 * target tree. Reads any `*.dist-info/entry_points.txt` looking for a
 * `console_scripts` section, and returns the script name (filename
 * under `<targetDir>/bin/`).
 */
export async function pickPypiEntryPoint(targetDir: string, identifier: string): Promise<string> {
  const distInfos = (await readdir(targetDir).catch(() => []))
    .filter((d) => d.endsWith(".dist-info"))
    .map((d) => join(targetDir, d));

  for (const distInfo of distInfos) {
    const epPath = join(distInfo, "entry_points.txt");
    let raw: string;
    try {
      raw = await readFile(epPath, "utf8");
    } catch {
      continue;
    }
    // entry_points.txt is INI-shaped; scan for [console_scripts].
    const lines = raw.split(/\r?\n/);
    let inConsoleScripts = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("[")) {
        inConsoleScripts = trimmed === "[console_scripts]";
        continue;
      }
      if (!inConsoleScripts) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const scriptName = trimmed.slice(0, eq).trim();
      if (scriptName) return scriptName;
    }
  }
  throw new BundlerError(
    `no console_scripts entry point found for ${identifier} in ${targetDir}`,
    "ENTRY_MISSING",
  );
}

async function collectFiles(rootDir: string): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (entry === "__pycache__") continue;
      const abs = join(dir, entry);
      const st = await stat(abs);
      if (st.isDirectory()) {
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

export async function vendorPypiPackage(
  input: PypiVendorInput,
  deps: PypiVendorDeps = {},
): Promise<VendorResult> {
  const installPackage = deps.installPackage ?? defaultInstallPackage;
  const now = deps.now ?? (() => new Date());
  const workRoot = deps.workRoot ?? tmpdir();

  const resolved = await resolvePypiVersion(input, deps);
  const workDir = await mkdtemp(join(workRoot, "afps-bundle-pypi-"));
  try {
    await installPackage({
      identifier: input.identifier,
      version: resolved.version,
      targetDir: workDir,
      registryBaseUrl: input.registryBaseUrl,
    });
    const scriptName = await pickPypiEntryPoint(workDir, input.identifier);

    const tree = await collectFiles(workDir);
    const files: Record<string, Uint8Array> = {};
    for (const [rel, bytes] of Object.entries(tree)) {
      files[`server/${rel}`] = bytes;
    }

    const resolution: SourceResolution = {
      registryType: "pypi",
      identifier: input.identifier,
      versionRequested: input.versionRange,
      versionResolved: resolved.version,
      integrity: resolved.integrity,
      resolvedAt: now().toISOString(),
    };

    return {
      files,
      rewrittenServerType: "binary",
      rewrittenEntryPoint: `./server/bin/${scriptName}`,
      resolution,
    };
  } finally {
    if (!deps.keepWorkDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
