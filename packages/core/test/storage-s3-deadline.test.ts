// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createS3Storage } from "../src/storage-s3.ts";

describe("buffered S3 request deadlines", () => {
  const savedEnv: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"])
      savedEnv[key] = process.env[key];
    process.env.AWS_ACCESS_KEY_ID = "test-access-key";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
    delete process.env.AWS_SESSION_TOKEN;
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  for (const stall of ["upload", "headers", "body"] as const) {
    it(`cancels a stalled ${stall} and permits the next request`, async () => {
      let reached = false;
      let healthy = false;
      let finish = () => {};
      const disconnected = Promise.withResolvers<void>();
      // A real S3 HTTP peer exercises the SDK transport AND response body;
      // resolving response headers alone must not disable the deadline.
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          reached = true;
          await request.arrayBuffer();
          if (healthy) return new Response("OK");
          request.signal.addEventListener("abort", () => disconnected.resolve(), { once: true });
          if (stall === "body")
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("partial"));
                  finish = () => {
                    try {
                      controller.close();
                    } catch {
                      /* Request already aborted. */
                    }
                  };
                },
              }),
            );
          return new Promise<Response>((resolve) => {
            finish = () => resolve(new Response("OK"));
          });
        },
      });
      const storage = createS3Storage({
        bucket: "test",
        region: "us-east-1",
        endpoint: `http://127.0.0.1:${server.port}`,
        requestTimeoutMs: 1_000,
      });
      const operation =
        stall === "upload"
          ? storage.uploadFile("packages", "a.zip", new Uint8Array([1, 2, 3]))
          : storage.downloadFile("packages", "a.zip");
      try {
        const outcome = await Promise.race([
          operation.then(
            () => "success",
            () => "aborted",
          ),
          Bun.sleep(3_000).then(() => "still pending"),
        ]);
        expect(reached).toBe(true);
        expect(outcome).toBe("aborted");
        expect(
          await Promise.race([
            disconnected.promise.then(() => "disconnected"),
            Bun.sleep(1_000).then(() => "still connected"),
          ]),
        ).toBe("disconnected");
        healthy = true;
        expect(new TextDecoder().decode((await storage.downloadFile("packages", "a.zip"))!)).toBe(
          "OK",
        );
      } finally {
        finish();
        await operation.catch(() => {});
        await server.stop(true);
      }
    });
  }
});
