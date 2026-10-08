// SPDX-License-Identifier: Apache-2.0

// Boot refusal while a stored ciphertext names a key id the keyring lacks (#1768). The
// inventory and the known kids are injected, so these run without a database; the live
// inventory is exercised in `../integration/db/keyring-boot-guard-probe.test.ts`.

import { describe, it, expect, spyOn } from "bun:test";
import { encrypt } from "@appstrate/connect";
import type { KidCount } from "@appstrate/db/encrypted-columns";
import { assertKeyringCoversCiphertexts } from "../../src/lib/boot.ts";
import { logger } from "../../src/lib/logger.ts";

const KEYRING = new Set(["k2", "k1"]);

function count(table: string, kid: string | null, n = 1, samples = ["v1:x:unopenable"]): KidCount {
  return { table, column: "credentials_encrypted", kid, count: n, samples };
}

async function refusalOf(inventory: KidCount[]): Promise<string> {
  return assertKeyringCoversCiphertexts(async () => inventory, KEYRING).then(
    () => "booted",
    (err: Error) => err.message,
  );
}

describe("assertKeyringCoversCiphertexts", () => {
  it("boots when every kid is in the keyring, whatever its samples hold", async () => {
    expect(await refusalOf([count("integration_connections", "k1"), count("runs", "k2")])).toBe(
      "booted",
    );
  });

  it("ignores a value that is not a v1 envelope: unreadable data, not a keyring gap", async () => {
    expect(await refusalOf([count("org_proxies", null, 3)])).toBe("booted");
  });

  it("refuses, naming each missing kid, where it is, and the fix", async () => {
    const message = await refusalOf([
      count("integration_connections", "k0", 12),
      count("model_provider_credentials", "k0", 2),
      count("org_proxies", "k1"),
      count("runs", "typo"),
    ]);
    expect(message).toContain(
      "'k0' in integration_connections.credentials_encrypted (12), " +
        "model_provider_credentials.credentials_encrypted (2); 'typo' in runs",
    );
    expect(message).toMatch(/Refusing to boot[\s\S]*CONNECTION_ENCRYPTION_KEYS/);
    expect(message).not.toContain("'k1'");
  });

  it("warns, never refuses, when no sample of a configured kid opens", async () => {
    const sealed = encrypt("secret");
    const active = sealed.split(":")[1]!;
    const warn = spyOn(logger, "warn");
    try {
      const keyring = new Set([active]);
      const corrupt = `v1:${active}:AAAA`;
      const run = (samples: string[]) =>
        assertKeyringCoversCiphertexts(async () => [count("runs", active, 1, samples)], keyring);
      expect(await run([sealed, corrupt])).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      expect(await run([corrupt])).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("propagates a failing inventory instead of assuming the keyring covers it", async () => {
    const boom = new Error("connection terminated");
    await expect(
      assertKeyringCoversCiphertexts(() => Promise.reject(boom), KEYRING),
    ).rejects.toThrow(boom);
  });
});
