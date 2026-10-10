// SPDX-License-Identifier: Apache-2.0

/**
 * The integration boot deadline in `mountMcp` warns only when the boot is
 * still pending after 30 s. A boot that finished in time must not log
 * "exceeded" later — it did on every run that outlived its boot (#1548).
 */

import { describe, it, expect, afterEach, jest, spyOn } from "bun:test";
import { Hono } from "hono";
import { mountMcp } from "../mcp.ts";
import { logger } from "../logger.ts";
import { TokenBudget } from "../token-budget.ts";
import { TEST_EGRESS_ALLOW_INTERNAL_HOSTS } from "./helpers/egress-hosts.ts";

const EXCEEDED =
  "integration boot wait exceeded; tools/list will respond without late integrations";

function mount(integrationBootPromise: Promise<void>): void {
  mountMcp(new Hono(), {
    proxyDeps: {
      config: { platformApiUrl: "http://mock:3000", runToken: "tok", proxyUrl: "" },
      cookieJar: new Map(),
      egressAllowInternalHosts: TEST_EGRESS_ALLOW_INTERNAL_HOSTS,
      fetchFn: fetch,
      reportedAuthFailures: new Set<string>(),
    },
    tokenBudget: new TokenBudget(),
    integrationBootPromise,
  });
}

afterEach(() => {
  jest.useRealTimers();
});

describe("mountMcp integration boot deadline", () => {
  it("stays silent when the boot resolved before the deadline", async () => {
    jest.useFakeTimers();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      mount(Promise.resolve());
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(30_001);
      expect(warn).not.toHaveBeenCalledWith(EXCEEDED, expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it("warns when the boot is still pending at the deadline", () => {
    jest.useFakeTimers();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      mount(new Promise<void>(() => {}));
      jest.advanceTimersByTime(30_001);
      expect(warn).toHaveBeenCalledWith(EXCEEDED, { waitMs: 30_000 });
    } finally {
      warn.mockRestore();
    }
  });
});
