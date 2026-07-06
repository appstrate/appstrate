// SPDX-License-Identifier: Apache-2.0

/**
 * Injectable seams for every host-mutating side effect the `appstrate
 * runner` commands perform: subprocess execution (systemctl, journalctl,
 * tar, sha256sum), filesystem writes (env file, unit file, binaries), and
 * HTTP (the daemon health probe + binary downloads).
 *
 * Production wires the real Bun/Node implementations; unit tests pass
 * in-memory fakes. This follows the repo's no-`mock.module()` policy — the
 * same DI approach the install/self-update commands use.
 */

import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  access,
  constants as fsConstants,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { runCommand, commandExists, type CommandResult } from "../install/os.ts";

export interface RunnerExec {
  /** Run `cmd args…`; never throws on non-zero (returns `ok:false`). */
  run(
    cmd: string,
    args: string[],
    opts?: { stdio?: "inherit" | "pipe" | "ignore" },
  ): Promise<CommandResult>;
  /** Synchronous PATH lookup. */
  exists(cmd: string): boolean;
}

export interface RunnerFs {
  writeFile(path: string, data: string | Uint8Array, mode?: number): Promise<void>;
  readFile(path: string): Promise<string | null>;
  /** Read raw bytes, or null when the path is absent. */
  readFileBytes(path: string): Promise<Uint8Array | null>;
  mkdirp(dir: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Access with R|W — the KVM device check needs open-permission, not just existence. */
  canReadWrite(path: string): Promise<boolean>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Atomic install of bytes at `dest` (tmp write in the same dir + rename). */
  installAtomic(dest: string, bytes: Uint8Array, mode: number): Promise<void>;
}

export interface RunnerHttp {
  /** GET → bytes (throws on non-2xx). */
  fetchBinary(url: string): Promise<Uint8Array>;
  /** GET → text (throws on non-2xx). */
  fetchText(url: string): Promise<string>;
  /**
   * GET a JSON endpoint with a bearer token. Resolves the parsed body +
   * status; never throws on a non-2xx (the caller reports it). Resolves
   * `{ reachable: false }` on a connection error so `doctor` can print a
   * "daemon not reachable" line instead of crashing.
   */
  getJson(
    url: string,
    token: string,
  ): Promise<
    { reachable: true; status: number; body: unknown } | { reachable: false; error: string }
  >;
}

export const defaultRunnerExec: RunnerExec = {
  run(cmd, args, opts) {
    return runCommand(cmd, args, { stdio: opts?.stdio ?? "pipe" });
  },
  exists(cmd) {
    return commandExists(cmd);
  },
};

export const defaultRunnerFs: RunnerFs = {
  async writeFile(path, data, mode) {
    await writeFile(path, data, mode !== undefined ? { mode } : undefined);
  },
  async readFile(path) {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  async readFileBytes(path) {
    try {
      return new Uint8Array(await readFile(path));
    } catch {
      return null;
    }
  },
  async mkdirp(dir) {
    await mkdir(dir, { recursive: true });
  },
  async chmod(path, mode) {
    await chmod(path, mode);
  },
  async exists(path) {
    return Bun.file(path).exists();
  },
  async canReadWrite(path) {
    // access(), not exists(): /dev/kvm is a character device (exists() is
    // false for non-regular files) and R|W also validates that this uid
    // may actually open it (kvm-group membership) — the exact check the
    // orchestrator does at initialize().
    return access(path, fsConstants.R_OK | fsConstants.W_OK).then(
      () => true,
      () => false,
    );
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async remove(path) {
    await rm(path, { force: true, recursive: true });
  },
  async installAtomic(dest, bytes, mode) {
    await mkdir(dirname(dest), { recursive: true });
    const tmp = join(dirname(dest), `.${dest.split("/").pop()}.tmp-${process.pid}`);
    try {
      await writeFile(tmp, bytes, { mode });
      await chmod(tmp, mode);
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  },
};

export const defaultRunnerHttp: RunnerHttp = {
  async fetchBinary(url) {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  async fetchText(url) {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    return res.text();
  },
  async getJson(url, token) {
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        redirect: "follow",
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { reachable: true, status: res.status, body };
    } catch (err) {
      return { reachable: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
