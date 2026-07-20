// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
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

async function reserveDebuggingPort(): Promise<number> {
  const server = createServer();
  server.unref();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a local Chrome debugging port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForDebuggingPort(port: number): Promise<void> {
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Chrome has not started listening yet.
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
  const debuggingPort = await reserveDebuggingPort();
  const userDataDir = await mkdtemp(join(tmpdir(), "appstrate-browser-"));
  const processHandle = Bun.spawn(
    [
      executable,
      `--user-data-dir=${userDataDir}`,
      // Port zero makes Chromium expose navigator.webdriver=true even in a
      // user-driven, headful session. Reserve a random non-zero loopback port
      // so WebDriver state accurately reflects that no automation driver is
      // controlling the interactive login.
      `--remote-debugging-port=${debuggingPort}`,
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
    await waitForDebuggingPort(debuggingPort);
    return {
      debuggingOrigin: `http://127.0.0.1:${debuggingPort}`,
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
