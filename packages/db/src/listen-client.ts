// SPDX-License-Identifier: Apache-2.0

import type { Sql } from "postgres";

export interface ListenClient {
  listen(channel: string, handler: (payload: string) => void): Promise<void>;
}

/**
 * Wrap a postgres.js connection's `listen` so a rejected LISTEN can be retried.
 *
 * postgres.js 3.4.9 registers the channel BEFORE awaiting the LISTEN
 * acknowledgement (src/index.js:165-195) and keeps the memoised rejected
 * promise, so a retry would push a second handler onto that dead entry and
 * re-await the same rejection. The wrapper drops the entry so the retry
 * re-issues LISTEN with exactly one handler. (The `unlisten` postgres.js
 * returns is only handed back on success, so it cannot clean this up.)
 *
 * The cleanup reaches into a private field. If a postgres.js upgrade moves it,
 * the rejection is rethrown with that fact attached: the boot log then says
 * the retries are stacking handlers instead of silently doing so.
 */
export function createListenClient(conn: Sql): ListenClient {
  return {
    listen: async (channel, handler) => {
      try {
        await conn.listen(channel, handler);
      } catch (err) {
        const channels = (conn.listen as unknown as { channels?: Record<string, unknown> })
          .channels;
        if (!channels) {
          throw new Error(
            `LISTEN "${channel}" failed and postgres.js no longer exposes listen.channels: ` +
              "the stale registration cannot be cleared, a retry would stack handlers",
            { cause: err },
          );
        }
        delete channels[channel];
        throw err;
      }
    },
  };
}
