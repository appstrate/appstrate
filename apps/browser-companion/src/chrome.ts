// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
] as const;

async function executableExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

export async function findChromeExecutable(): Promise<string> {
  const configured = process.env.APPSTRATE_BROWSER_EXECUTABLE?.trim();
  if (configured) {
    if (!(await executableExists(configured))) throw new Error("Configured Chrome was not found");
    return configured;
  }
  if (process.platform === "darwin") {
    for (const path of MAC_CANDIDATES) if (await executableExists(path)) return path;
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const path = Bun.which(name);
    if (path) return path;
  }
  throw new Error("Google Chrome or Chromium is required");
}

async function waitForDebuggingPort(userDataDir: string): Promise<number> {
  const file = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const [rawPort] = (await readFile(file, "utf8")).split("\n");
      const port = Number(rawPort);
      if (Number.isInteger(port) && port > 0 && port < 65_536) return port;
    } catch {
      // Chrome creates the file after its browser process starts listening.
    }
    await Bun.sleep(100);
  }
  throw new Error("Chrome did not expose its local debugging port");
}

export interface LocalChrome {
  debuggingOrigin: string;
  close(): Promise<void>;
}

export async function launchLocalChrome(
  urls: readonly string[],
  options: { headless?: boolean } = {},
): Promise<LocalChrome> {
  const executable = await findChromeExecutable();
  const userDataDir = await mkdtemp(join(tmpdir(), "appstrate-browser-"));
  const processHandle = Bun.spawn(
    [
      executable,
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      ...(options.headless ? ["--headless=new", "--disable-gpu"] : []),
      ...urls,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  try {
    const port = await waitForDebuggingPort(userDataDir);
    return {
      debuggingOrigin: `http://127.0.0.1:${port}`,
      async close() {
        processHandle.kill();
        await processHandle.exited.catch(() => undefined);
        await rm(userDataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    processHandle.kill();
    await processHandle.exited.catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

export function openExternal(url: string): void {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  void child.exited;
}
