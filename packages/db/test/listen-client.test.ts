// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createListenClient } from "../src/listen-client.ts";

describe.skipIf(!process.env.DATABASE_URL)("createListenClient", () => {
  it("propagates the server error and sends LISTEN again after a rejection", async () => {
    // A NUL in the channel makes PostgreSQL reject LISTEN without losing the connection.
    const channel = "stale\0listen";
    const attempts: string[] = [];
    const conn = postgres(process.env.DATABASE_URL!, {
      debug: (_connection, query) => {
        if (query.startsWith("listen ")) attempts.push(query);
      },
    });
    try {
      const client = createListenClient(conn);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(client.listen(channel, () => {})).rejects.toBeInstanceOf(
          postgres.PostgresError,
        );
      }
      expect(attempts).toEqual([`listen "${channel}"`, `listen "${channel}"`]);
      await client.listen("stale_listen_ok", () => {});
    } finally {
      await conn.end();
    }
  });
});
