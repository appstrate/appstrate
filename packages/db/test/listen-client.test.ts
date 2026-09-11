// SPDX-License-Identifier: Apache-2.0

/**
 * `createListenClient` guards a postgres.js private: a rejected LISTEN leaves
 * its channel registered (src/index.js:165-195), so a bare retry stacks a
 * second handler onto the dead entry and re-awaits the same rejection. This
 * runs against a real server (PGlite has no such registration to leak), and
 * asserts on that private on purpose — it exists to notice the day a postgres.js
 * upgrade moves it.
 *
 * The failing channel carries a NUL byte: the server rejects the LISTEN
 * ("insufficient data left in message") while the connection stays usable, so
 * no other suite sharing the database is affected.
 */

import { describe, it, expect, afterAll } from "bun:test";
import postgres from "postgres";
import { createListenClient } from "../src/listen-client.ts";

const describeRequiresPostgres = describe.skipIf(!process.env.DATABASE_URL);

describeRequiresPostgres("createListenClient (postgres.js stale LISTEN registration)", () => {
  const conn = postgres(process.env.DATABASE_URL!, { max: 1, idle_timeout: 0, max_lifetime: 0 });
  const channels = () =>
    (conn.listen as unknown as { channels?: Record<string, { listeners: unknown[] }> }).channels;

  afterAll(async () => {
    await conn.end();
  });

  it("clears the registration a rejected LISTEN leaves behind, so a retry does not stack handlers", async () => {
    const channel = "stale\0listen";
    const client = createListenClient(conn);

    await expect(client.listen(channel, () => {})).rejects.toThrow();
    expect(channels()?.[channel]).toBeUndefined();

    // Second attempt re-issues LISTEN with one handler, not two on a dead entry.
    await expect(client.listen(channel, () => {})).rejects.toThrow();
    expect(channels()?.[channel]).toBeUndefined();

    // Negative control: the bare postgres.js call keeps the entry and stacks.
    await expect(conn.listen(channel, () => {})).rejects.toThrow();
    await expect(conn.listen(channel, () => {})).rejects.toThrow();
    expect(channels()?.[channel]?.listeners).toHaveLength(2);
    delete channels()![channel];

    // The connection survived the rejections.
    await client.listen("stale_listen_ok", () => {});
    expect(channels()?.["stale_listen_ok"]?.listeners).toHaveLength(1);
  });
});
