// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end smoke test: a real Bun subprocess uses Bun.fetch with
 * HTTPS_PROXY pointing at the MITM listener, NODE_EXTRA_CA_CERTS
 * pointing at the run CA. We verify:
 *
 *   - Bun's fetch routes through the listener CONNECT tunnel
 *   - The listener's per-SNI cert mint is trusted by the subprocess
 *   - The credential injection happens in the listener (the subprocess
 *     never sees the token)
 *
 * The "upstream" is a stub fetch on the listener side that captures the
 * outbound request and returns a canned response — so we exercise
 * everything from the subprocess to the listener's strip/inject layer
 * without needing a real third-party HTTPS server we trust.
 *
 * Skipped when openssl is missing.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { planCaBundle, type HttpDeliveryPlan } from "@appstrate/connect";
import { createOpensslCertGenerator } from "../ca-cert-openssl.ts";
import { createCertMinter } from "../integration-cert-minter.ts";
import {
  createIntegrationMitmListener,
  type MitmCredentialSource,
} from "../integration-mitm-listener.ts";

async function opensslAvailable(): Promise<boolean> {
  try {
    const proc = (
      globalThis as unknown as {
        Bun?: { spawn: (args: string[], opts: object) => { exited: Promise<number> } };
      }
    ).Bun?.spawn(["openssl", "version"], { stdout: "pipe", stderr: "pipe" });
    if (!proc) return false;
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

const HAS_OPENSSL = await opensslAvailable();
if (!HAS_OPENSSL) {
  console.warn("[integration-mitm-e2e] openssl missing — E2E test skipped");
}
const runIfOpenssl: typeof it = HAS_OPENSSL ? it : (it.skip as unknown as typeof it);

describe("MITM listener — subprocess end-to-end", () => {
  runIfOpenssl(
    "Bun.fetch in a child process tunnels through, trusts CA, sees clean response",
    async () => {
      // ─── Per-run CA bundle ───
      const workDir = path.join(tmpdir(), `afps-e2e-${randomUUID()}`);
      await fs.mkdir(workDir, { recursive: true });
      const gen = createOpensslCertGenerator({ workDir });
      const bundle = await planCaBundle({
        runId: "e2e",
        tmpfsRoot: workDir,
        generator: gen,
        serverCommonName: "localhost",
        notAfterSeconds: 3600,
      });

      // Materialise the CA on disk so NODE_EXTRA_CA_CERTS can point at it.
      const caPath = path.join(workDir, "ca.pem");
      await fs.writeFile(caPath, bundle.pems.caCertPem, "utf-8");

      // ─── Listener ───
      const minter = createCertMinter({
        caCertPem: bundle.pems.caCertPem,
        caKeyPem: bundle.pems.caKeyPem,
      });
      const dp: Record<string, HttpDeliveryPlan> = {
        vendor: {
          headerName: "Authorization",
          headerPrefix: "Bearer",
          value: "fresh-token",
          allowServerOverride: false,
        },
      };
      const creds: MitmCredentialSource = {
        current: () => ({
          auths: [
            {
              authKey: "vendor",
              authType: "oauth2",
              fields: Object.freeze({ access_token: "fresh-token" }),
              authorizedUris: Object.freeze(["https://api.e2e.local/**"]),
            },
          ],
          missingRequiredAuthKeys: [],
        }),
        deliveryPlans: () => dp,
      };

      let observedHeader: string | null = null;
      let observedBody = "";
      const stubFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = init?.headers as Headers;
        observedHeader = headers.get("Authorization");
        observedBody = init?.body ? String(init.body) : "";
        return new Response(`{"upstream":"ok"}`, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const listener = createIntegrationMitmListener({
        caBundle: bundle,
        minter,
        credentials: creds,
        fetch: stubFetch,
      });
      await listener.ready;
      const proxyUrl = listener.proxyUrl();

      try {
        // ─── Subprocess: a real bun -e that fetches through the proxy. ───
        // We rely on Bun.fetch honouring HTTPS_PROXY + NODE_EXTRA_CA_CERTS
        // — both documented and required by spec §4.1.4 / D32.
        const script = `
        const r = await fetch("https://api.e2e.local/v1/items", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer SHOULD-BE-STRIPPED" },
          body: JSON.stringify({ hi: "world" }),
        });
        const body = await r.text();
        process.stdout.write(JSON.stringify({ status: r.status, body }));
      `;

        const proc = Bun.spawn(["bun", "-e", script], {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: process.env.PATH ?? "",
            HTTPS_PROXY: proxyUrl,
            https_proxy: proxyUrl,
            NODE_EXTRA_CA_CERTS: caPath,
          },
        });

        const code = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        if (code !== 0) {
          throw new Error(`subprocess exited ${code}: stdout='${stdout}' stderr='${stderr}'`);
        }

        const parsed = JSON.parse(stdout) as { status: number; body: string };
        expect(parsed.status).toBe(200);
        expect(parsed.body).toBe(`{"upstream":"ok"}`);
        // The smuggled `Bearer SHOULD-BE-STRIPPED` MUST NOT reach upstream;
        // the listener replaced it with the planner's fresh token.
        // Cast: TS narrows a `let` assigned only inside a closure back to its
        // initializer type (`null`); the stubFetch above mutates it at runtime.
        expect(observedHeader as string | null).toBe("Bearer fresh-token");
        expect(observedBody).toBe(`{"hi":"world"}`);
      } finally {
        await listener.close();
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});
