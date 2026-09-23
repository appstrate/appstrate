// SPDX-License-Identifier: Apache-2.0

/**
 * Report the upstream's verdict on the run's model API key so a revoked BYOK
 * key is flagged `needs_reconnection`. Every 401 is reported (the streak needs
 * each one); a 2xx only when it can reset a streak (first of the run, first
 * after a rejection). Fire-and-forget.
 */

import { logger } from "./logger.ts";

export function createLlmKeyOutcomeReporter(opts: {
  platformApiUrl: string;
  runToken: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}): (upstreamStatus: number) => void {
  const fetchFn = opts.fetchFn ?? fetch;
  const keySha256 = new Bun.CryptoHasher("sha256").update(opts.apiKey).digest("hex");
  let resetPending = true;

  const report = (outcome: "rejected" | "accepted"): void => {
    fetchFn(`${opts.platformApiUrl}/internal/model-credential/outcome`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.runToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ outcome, key_sha256: keySha256 }),
    }).then(
      (res) => {
        if (!res.ok) logger.warn("llm key outcome report refused", { outcome, status: res.status });
      },
      (err: unknown) =>
        logger.warn("llm key outcome report failed", {
          outcome,
          error: err instanceof Error ? err.message : String(err),
        }),
    );
  };

  return (status) => {
    if (status === 401) {
      resetPending = true;
      report("rejected");
    } else if (status >= 200 && status < 300 && resetPending) {
      resetPending = false;
      report("accepted");
    }
  };
}
