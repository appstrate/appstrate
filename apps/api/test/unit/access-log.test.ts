// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import type { Logger } from "@appstrate/core/logger";
import type { AppEnv } from "../../src/types/index.ts";
import { requestId } from "../../src/middleware/request-id.ts";
import { accessLog } from "../../src/middleware/access-log.ts";
import { errorHandler } from "../../src/middleware/error-handler.ts";
import { notFound } from "../../src/lib/errors.ts";

type Line = { level: keyof Logger; msg: string; data?: Record<string, unknown> };

function recordingLogger(): { lines: Line[]; logger: Logger } {
  const lines: Line[] = [];
  const at =
    (level: keyof Logger) =>
    (msg: string, data?: Record<string, unknown>): void => {
      lines.push({ level, msg, data });
    };
  return {
    lines,
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
  };
}

function createApp(sink: Logger) {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => errorHandler(err, c, sink));
  app.use("*", requestId());
  app.use("*", accessLog(sink));
  app.get("/ok", (c) => c.json({ ok: true }));
  app.post("/missing", () => {
    throw notFound("nope");
  });
  return app;
}

describe("accessLog middleware", () => {
  it("writes one debug line carrying the Request-Id the client received", async () => {
    const { lines, logger } = recordingLogger();
    const res = await createApp(logger).request("/ok?token=SECRET_IN_QUERY");

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect([line!.level, line!.msg]).toEqual(["debug", "request"]);
    expect(line!.data).toMatchObject({
      requestId: res.headers.get("Request-Id"),
      method: "GET",
      path: "/ok",
      status: 200,
    });
    expect(typeof line!.data!.durationMs).toBe("number");
    expect(JSON.stringify(line)).not.toContain("SECRET_IN_QUERY");
  });

  it("records the status of a request the error handler answered", async () => {
    const { lines, logger } = recordingLogger();
    const res = await createApp(logger).request("/missing", { method: "POST" });

    expect(res.status).toBe(404);
    expect(lines.map((l) => [l.level, l.data?.method, l.data?.status])).toEqual([
      ["debug", "POST", 404],
    ]);
  });
});
