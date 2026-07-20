// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import { createBrowserEgressGateway } from "../../../sidecar/browser-egress-gateway.ts";

const target = process.argv[2] ?? "https://www.leboncoin.fr/recherche?text=velo";
const targetOrigin = new URL(target).origin;
const origins = [
  targetOrigin,
  "https://www.leboncoin.fr",
  "https://leboncoin.fr",
  "https://auth.leboncoin.fr",
  "https://api.leboncoin.fr",
  "https://dd.leboncoin.fr",
  "https://static-rav.leboncoin.fr",
  "https://assets.leboncoin.fr",
  "https://www.vinted.fr",
  "https://vinted.fr",
  "https://images1.vinted.net",
  "https://marketplace-web-assets.vinted.com",
  "https://static-assets.vinted.com",
  "https://cdn.cookielaw.org",
  "https://api-js.datadome.co",
  "https://js.datadome.co",
  "https://ct.captcha-delivery.com",
  "https://geo.captcha-delivery.com",
  "https://static.captcha-delivery.com",
].filter((origin, index, all) => all.indexOf(origin) === index);

const gatewayToken = randomBytes(32).toString("base64url");
const workerToken = randomBytes(32).toString("base64url");
const gateway = createBrowserEgressGateway({
  authToken: gatewayToken,
  allowedOrigins: origins,
  host: "127.0.0.1",
});
await gateway.ready;

const worker = Bun.spawn(["bun", "runtime-pi/browser-worker/server.ts"], {
  cwd: new URL("../../../../", import.meta.url).pathname,
  env: {
    ...process.env,
    PORT: "0",
    BROWSER_WORKER_HOST: "127.0.0.1",
    BROWSER_WORKER_TOKEN: workerToken,
    BROWSER_GATEWAY_URL: `http://127.0.0.1:${gateway.address().port}`,
    BROWSER_GATEWAY_TOKEN: gatewayToken,
    BROWSER_ALLOWED_ORIGINS_JSON: JSON.stringify(origins),
    BROWSER_MAX_PAGES: "4",
  },
  stdin: "ignore",
  stdout: "pipe",
  stderr: "inherit",
});

async function readReady(): Promise<{ endpoint: string }> {
  const reader = worker.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) throw new Error("browser worker exited before ready");
      buffer += decoder.decode(next.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const prefix = "APPSTRATE_BROWSER_WORKER_READY:";
        if (line.startsWith(prefix)) return JSON.parse(line.slice(prefix.length));
      }
    }
  } finally {
    reader.releaseLock();
  }
}

try {
  const ready = await Promise.race([
    readReady(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("browser worker startup timed out")), 30_000),
    ),
  ]);
  const localVenvPython = "runtime-pi/runners/browser-use/.venv/bin/python";
  const python =
    process.env.APPSTRATE_BROWSER_USE_PYTHON ??
    ((await Bun.file(localVenvPython).exists()) ? localVenvPython : "python3");
  const smoke = Bun.spawn(
    [
      python,
      "runtime-pi/runners/browser-use/tests/worker_smoke.py",
      ready.endpoint,
      workerToken,
      JSON.stringify(origins),
      target,
    ],
    {
      cwd: new URL("../../../../", import.meta.url).pathname,
      env: {
        ...process.env,
        PYTHONPATH: "runtime-pi/runners/browser-use",
        PYTHONDONTWRITEBYTECODE: "1",
        ANONYMIZED_TELEMETRY: "false",
        BROWSER_USE_DISABLE_EXTENSIONS: "1",
        BROWSER_USE_CONFIG_DIR: "/private/tmp/appstrate-browser-use-smoke",
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exit = await smoke.exited;
  if (exit !== 0) throw new Error(`Browser Use smoke exited ${exit}`);
} finally {
  worker.kill("SIGTERM");
  await Promise.race([worker.exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  await gateway.close();
}
