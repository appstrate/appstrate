// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { getModuleRegistry, buildModuleInitContext } from "../../../src/lib/modules/registry.ts";

/**
 * `getModuleRegistry` reads `MODULES` through the cached `getEnv()` snapshot
 * (single source for the default — see #513), so every `process.env.MODULES`
 * mutation must be followed by a cache flush to become visible.
 */
function setModulesEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.MODULES;
  else process.env.MODULES = value;
  _resetCacheForTesting();
}

describe("getModuleRegistry", () => {
  const originalValue = process.env.MODULES;

  afterEach(() => {
    setModulesEnv(originalValue);
  });

  it("returns the default OSS modules when MODULES is unset (subscription modules opt-in)", () => {
    setModulesEnv(undefined);
    expect(getModuleRegistry()).toEqual([
      "oidc",
      "webhooks",
      "mcp",
      "core-providers",
      "@appstrate/module-chat",
    ]);
  });

  it("treats the empty string as unset (env getter coalesces — default set)", () => {
    // The env getter coalesces `""` → unset (compose `${VAR:-}` pattern);
    // `MODULES=none` is the only zero-module sentinel.
    setModulesEnv("");
    expect(getModuleRegistry()).toContain("oidc");
  });

  it("returns empty array for the MODULES=none sentinel", () => {
    setModulesEnv("none");
    expect(getModuleRegistry()).toEqual([]);
  });

  it("treats whitespace-padded none as the sentinel", () => {
    setModulesEnv(" none ");
    expect(getModuleRegistry()).toEqual([]);
  });

  it("parses comma-separated specifiers, trims whitespace, drops empty segments", () => {
    setModulesEnv(" @scope/module , @acme/analytics ,,");
    expect(getModuleRegistry()).toEqual(["@scope/module", "@acme/analytics"]);
  });
});

/**
 * The init context a module receives actually carries the storage-limit
 * capability.
 *
 * An out-of-tree module binds this off the LIVE services object the platform
 * injects, not off its pinned `PlatformServices` types, so a member missing
 * here is not a compile error anywhere — it is a `TypeError` on that module's
 * next boot.
 */
describe("buildModuleInitContext().services — storage-limit capability", () => {
  it("exposes setFileStorageLimit", () => {
    const { services } = buildModuleInitContext();
    expect(typeof services.setFileStorageLimit).toBe("function");
  });
});

/**
 * `ModuleInitContext.getSendMail` resolves an ASYNCHRONOUS mailer (#1280): a
 * module can `await` a send and sequence on it (send, then mark sent) instead
 * of firing into the void. Before the contract change the declared return type
 * was `void`, so `await ctx.getSendMail()(…)` awaited nothing and the
 * platform's own call site carried the branch's only
 * `@typescript-eslint/no-misused-promises` suppression.
 *
 * The mailer must also SETTLE rather than reject when mail is unconfigured —
 * a module sequencing on it would otherwise break on every install without
 * SMTP. `isSmtpConfigured()` (app-config.test.ts) covers the gate itself.
 */
describe("buildModuleInitContext().getSendMail", () => {
  const SMTP_KEYS = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of SMTP_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    _resetCacheForTesting();
  });

  afterEach(() => {
    for (const k of SMTP_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetCacheForTesting();
  });

  it("resolves a mailer whose send returns a promise", async () => {
    const send = await buildModuleInitContext().getSendMail();
    expect(typeof send).toBe("function");
    const pending = send("someone@example.com", "Subject", "<p>Body</p>");
    expect(pending).toBeInstanceOf(Promise);
    await pending;
  });

  it("settles instead of rejecting when SMTP is not configured", async () => {
    const send = await buildModuleInitContext().getSendMail();
    // No transport is reached, so this is a pure unit assertion: the await
    // completes and yields undefined.
    await expect(send("someone@example.com", "Subject", "<p>Body</p>")).resolves.toBeUndefined();
  });
});
