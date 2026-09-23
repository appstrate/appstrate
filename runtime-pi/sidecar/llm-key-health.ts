// SPDX-License-Identifier: Apache-2.0

/**
 * Report the upstream's verdict on the run's model API key to the platform,
 * so a revoked BYOK key is flagged `needs_reconnection` from runs as it is
 * from the platform LLM proxy (`POST /internal/model-credential/outcome`).
 *
 * Cost on the hot path: every 401 is reported (the streak needs each one), but
 * a 2xx is reported only when a reset can matter — the first of the run (a
 * streak left by an earlier run or chat) and the first after a rejection.
 * A healthy run therefore makes exactly one extra call. Fire-and-forget: the
 * LLM response never waits on it.
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
