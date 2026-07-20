// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { planCaBundle, type CertGenerator } from "../src/proxy-ca-planner.ts";

const FAKE_PEM = (kind: "CERTIFICATE" | "PRIVATE KEY" | "RSA PRIVATE KEY") =>
  `-----BEGIN ${kind}-----\nMIIBkTCCATegAwIB...\n-----END ${kind}-----\n`;

const okGenerator: CertGenerator = async (req) => {
  // The contract requires requiresAki to be true.
  expect(req.requiresAki).toBe(true);
  return {
    caCertPem: FAKE_PEM("CERTIFICATE"),
    caKeyPem: FAKE_PEM("PRIVATE KEY"),
    serverCertPem: FAKE_PEM("CERTIFICATE"),
    serverKeyPem: FAKE_PEM("PRIVATE KEY"),
  };
};

describe("planCaBundle", () => {
  it("accepts OpenSSL/LibreSSL PKCS#1 RSA private keys", async () => {
    const bundle = await planCaBundle({
      runId: "rsa-key-run",
      generator: async () => ({
        caCertPem: FAKE_PEM("CERTIFICATE"),
        caKeyPem: FAKE_PEM("RSA PRIVATE KEY"),
        serverCertPem: FAKE_PEM("CERTIFICATE"),
        serverKeyPem: FAKE_PEM("RSA PRIVATE KEY"),
      }),
    });
    expect(bundle.pems.caKeyPem).toContain("BEGIN RSA PRIVATE KEY");
  });

  it("computes paths under the default tmpfs root", async () => {
    const bundle = await planCaBundle({
      runId: "run-abc",
      generator: okGenerator,
      now: () => new Date("2026-05-17T00:00:00Z"),
    });
    expect(bundle.runId).toBe("run-abc");
    expect(bundle.caCertPath).toBe("/run/afps/ca.pem");
    expect(bundle.serverCertPath).toBe("/run/afps/server.crt");
    expect(bundle.serverKeyPath).toBe("/run/afps/server.key");
    expect(bundle.modes.caCert).toBe("0444");
    expect(bundle.modes.serverCert).toBe("0400");
    expect(bundle.modes.serverKey).toBe("0400");
    expect(bundle.generatedAt).toBe("2026-05-17T00:00:00.000Z");
    expect(bundle.notAfter).toBe("2026-05-17T01:00:00.000Z"); // default 3600s window
    expect(bundle.tmpfsRoot).toBe("/run/afps");
  });

  it("honours custom tmpfs root + serverCommonName + notAfterSeconds", async () => {
    const bundle = await planCaBundle({
      runId: "r1",
      tmpfsRoot: "/var/run/proxy/",
      serverCommonName: "proxy.local",
      serverSans: ["127.0.0.1", "::1"],
      notAfterSeconds: 600,
      generator: async (req) => {
        expect(req.serverCommonName).toBe("proxy.local");
        expect(req.serverSans).toEqual(["127.0.0.1", "::1"]);
        expect(req.notAfterSeconds).toBe(600);
        return {
          caCertPem: FAKE_PEM("CERTIFICATE"),
          caKeyPem: FAKE_PEM("PRIVATE KEY"),
          serverCertPem: FAKE_PEM("CERTIFICATE"),
          serverKeyPem: FAKE_PEM("PRIVATE KEY"),
        };
      },
      now: () => new Date("2026-05-17T00:00:00Z"),
    });
    expect(bundle.tmpfsRoot).toBe("/var/run/proxy"); // trailing slash stripped
    expect(bundle.caCertPath).toBe("/var/run/proxy/ca.pem");
    expect(bundle.notAfter).toBe("2026-05-17T00:10:00.000Z");
  });

  it("refuses an empty or path-unsafe runId", async () => {
    await expectThrow(() => planCaBundle({ runId: "", generator: okGenerator }));
    await expectThrow(() => planCaBundle({ runId: "../escape", generator: okGenerator }));
    await expectThrow(() => planCaBundle({ runId: "with space", generator: okGenerator }));
  });

  it("refuses a generator returning a malformed PEM", async () => {
    await expectThrow(() =>
      planCaBundle({
        runId: "r",
        generator: async () => ({
          caCertPem: "not pem",
          caKeyPem: FAKE_PEM("PRIVATE KEY"),
          serverCertPem: FAKE_PEM("CERTIFICATE"),
          serverKeyPem: FAKE_PEM("PRIVATE KEY"),
        }),
      }),
    );
  });

  it("refuses a generator returning an empty field", async () => {
    await expectThrow(() =>
      planCaBundle({
        runId: "r",
        generator: async () => ({
          caCertPem: "",
          caKeyPem: FAKE_PEM("PRIVATE KEY"),
          serverCertPem: FAKE_PEM("CERTIFICATE"),
          serverKeyPem: FAKE_PEM("PRIVATE KEY"),
        }),
      }),
    );
  });
});

async function expectThrow(fn: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
}
