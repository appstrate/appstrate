// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate api --batch` — many requests from one process (`commands/api/batch.ts`).
 * Same harness as `api-command.test.ts`: stubbed `globalThis.fetch`, a seeded profile,
 * an in-memory IO whose `exit` throws a sentinel.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";
import { saveTokens } from "../src/lib/keyring.ts";
import { apiCommand, type ApiCommandIO, type ApiCommandOptions } from "../src/commands/api.ts";

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: unknown };

const configHome = useTempConfigHome("appstrate-cli-apibatch-");
let keyring: FakeKeyringInstall;
const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[];

function installFetch(responder: (call: FetchCall) => Promise<Response> | Response): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: typeof input === "string" ? input : input.toString(),
      method: (init?.method ?? "GET").toUpperCase(),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: init?.body,
    };
    fetchCalls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  delete process.env.APPSTRATE_API_KEY;
  delete process.env.APPSTRATE_INSTANCE;
  await configHome.setup();
  keyring = installFakeKeyring();
  fetchCalls = [];
  await seedLoggedInProfile("default", {
    orgId: "org_1",
    tokens: { accessToken: "access-1", expiresAt: Date.now() + 5 * 60 * 1000, refreshToken: "r" },
  });
});
afterEach(async () => {
  keyring.restore();
  globalThis.fetch = originalFetch;
  await configHome.teardown();
});

class ExitSentinel extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
  }
}

interface BatchRun {
  code: number | null;
  out: string;
  err: string;
  /** IO events in order: every stdout write, the flush, the exit. */
  events: string[];
  results: Record<string, any>[];
}

/** Captured stdout so far, for a responder asserting what was written before it ran. */
let liveOut = "";

async function runBatch(
  lines: unknown[] | string,
  opts: Partial<ApiCommandOptions> = {},
  stdin?: string,
): Promise<BatchRun> {
  const file = join(configHome.dir(), "batch.jsonl");
  await writeFile(
    file,
    typeof lines === "string" ? lines : lines.map((l) => JSON.stringify(l)).join("\n"),
  );
  liveOut = "";
  let err = "";
  let code: number | null = null;
  const events: string[] = [];
  const text = (c: Uint8Array | string) =>
    typeof c === "string" ? c : new TextDecoder().decode(c);
  const io: ApiCommandIO = {
    stdout: {
      write: (c) => {
        liveOut += text(c);
        events.push("write");
      },
    },
    stderr: { write: (c) => void (err += text(c)) },
    flush: async () => void events.push("flush"),
    exit: (c) => {
      code = c;
      events.push("exit");
      throw new ExitSentinel(c);
    },
    cancel: () => {},
    onSigint: () => {},
    stdinStream: () => new Response(stdin ?? "").body!,
  };
  try {
    await apiCommand(
      {
        path: "",
        header: [],
        form: [],
        query: [],
        batch: stdin === undefined ? file : "-",
        ...opts,
      },
      io,
    );
  } catch (e) {
    if (!(e instanceof ExitSentinel)) throw e;
  }
  const out = liveOut;
  const results = out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);
  return { code, out, err, events, results };
}

describe("appstrate api --batch", () => {
  it("sends every line with the profile credential and answers in input order", async () => {
    installFetch(async (call) => {
      // Answer the first request last: the output must still follow the input.
      if (call.url.endsWith("/a")) await Bun.sleep(20);
      return Response.json({ url: call.url, method: call.method });
    });

    const { code, results } = await runBatch(
      [
        { custom_id: "first", url: "/api/a" },
        { url: "/api/b", body: "x=1", headers: { "Content-Type": "text/plain" } },
        { method: "delete", url: "/api/c" },
      ],
      { header: ["X-Extra: 1"] },
    );

    expect(code).toBe(0);
    expect(results.map((r) => [r.custom_id, r.response.status_code])).toEqual([
      ["first", 200],
      ["2", 200],
      ["3", 200],
    ]);
    expect(results[1]!.response).toMatchObject({
      body: { url: "https://app.example.com/api/b", method: "POST" },
      body_encoding: "json",
    });
    expect(fetchCalls.map((c) => c.method).sort()).toEqual(["DELETE", "GET", "POST"]);
    for (const call of fetchCalls) {
      expect(call.headers.Authorization).toBe("Bearer access-1");
      expect(call.headers["X-Org-Id"]).toBe("org_1");
      expect(call.headers["X-Extra"]).toBe("1");
    }
    const post = fetchCalls.find((c) => c.method === "POST")!;
    expect(post.body).toBe("x=1");
    expect(post.headers["Content-Type"]).toBe("text/plain");
  });

  it("sends an object body as JSON, with a default Content-Type the line can override", async () => {
    installFetch(() => new Response("", { status: 204 }));

    const { code } = await runBatch([
      { url: "/api/a", body: { x: 1 } },
      { url: "/api/b", body: [1], headers: { "content-type": "application/merge-patch+json" } },
    ]);

    expect(code).toBe(0);
    const [a, b] = fetchCalls;
    expect(a!.body).toBe('{"x":1}');
    expect(a!.headers["Content-Type"]).toBe("application/json");
    expect(b!.body).toBe("[1]");
    expect(b!.headers["content-type"]).toBe("application/merge-patch+json");
    expect(b!.headers["Content-Type"]).toBeUndefined();
  });

  it("reads the requests from stdin with -", async () => {
    installFetch(() => Response.json({ ok: true }));
    const { code, results } = await runBatch([], {}, '{"url":"/api/a"}\n{"url":"/api/b"}\n');
    expect(code).toBe(0);
    expect(results.map((r) => r.custom_id)).toEqual(["1", "2"]);
  });

  it("writes each line as soon as the lines before it are known, and flushes before exiting", async () => {
    let writtenBeforeSecond = "";
    installFetch((call) => {
      if (call.url.endsWith("/b")) writtenBeforeSecond = liveOut;
      return Response.json({});
    });

    const { code, events } = await runBatch([{ url: "/api/a" }, { url: "/api/b" }], {
      parallelMax: 1,
    });

    expect(code).toBe(0);
    expect(JSON.parse(writtenBeforeSecond).custom_id).toBe("1");
    expect(events).toEqual(["write", "write", "flush", "exit"]);
  });

  it("keeps at most --parallel-max requests in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    installFetch(async () => {
      peak = Math.max(peak, ++inFlight);
      await Bun.sleep(5);
      inFlight--;
      return new Response("{}", { status: 200 });
    });

    const { code } = await runBatch(
      Array.from({ length: 12 }, (_, i) => ({ url: `/api/x/${i}` })),
      { parallelMax: 3 },
    );

    expect(code).toBe(0);
    expect(fetchCalls).toHaveLength(12);
    expect(peak).toBe(3);
  });

  it("refuses the whole batch before sending anything when a line is invalid or off-origin", async () => {
    installFetch(() => new Response("{}", { status: 200 }));

    const invalid = await runBatch('{"url":"/api/a"}\n{"url": 42}\n');
    expect(invalid.code).toBe(2);
    expect(invalid.err).toContain("line 2");

    const offOrigin = await runBatch([{ url: "/api/a" }, { url: "https://evil.example.org/x" }]);
    expect(offOrigin.code).toBe(2);
    expect(offOrigin.err).toContain("line 2");

    const bodyOnGet = await runBatch([{ method: "GET", url: "/api/a", body: "x" }]);
    expect(bodyOnGet.code).toBe(2);
    expect(bodyOnGet.err).toContain("carries no");

    const duplicate = await runBatch([
      { custom_id: "a", url: "/api/a" },
      { custom_id: "a", url: "/api/b" },
    ]);
    expect(duplicate.code).toBe(2);
    expect(duplicate.err).toContain('duplicate custom_id "a"');

    expect(fetchCalls).toHaveLength(0);
  });

  it("refuses single-request flags", async () => {
    installFetch(() => new Response("{}", { status: 200 }));
    const { code, err } = await runBatch([{ url: "/api/a" }], { data: "x", include: true });
    expect(code).toBe(2);
    expect(err).toContain("-d, -i");
    expect(fetchCalls).toHaveLength(0);
  });

  it("waits out a 429 with --retry instead of failing", async () => {
    let calls = 0;
    installFetch(() =>
      ++calls === 1
        ? new Response("slow down", { status: 429, headers: { "Retry-After": "0" } })
        : new Response("{}", { status: 200 }),
    );

    const { code, results } = await runBatch([{ url: "/api/a" }], { retry: 2 });

    expect(code).toBe(0);
    expect(calls).toBe(2);
    expect(results[0]!.response.status_code).toBe(200);
  });

  it("refreshes an access token that expires mid-batch and resends the request once", async () => {
    let refreshes = 0;
    installFetch(async (call) => {
      if (call.url.endsWith("/api/auth/cli/token")) {
        refreshes++;
        return Response.json({
          access_token: "access-2",
          refresh_token: "r2",
          expires_in: 900,
        });
      }
      if (call.headers.Authorization === "Bearer access-1") {
        // The token expired while the batch ran.
        await saveTokens("default", {
          accessToken: "access-1",
          expiresAt: Date.now() - 1000,
          refreshToken: "r",
          refreshExpiresAt: Date.now() + 60_000,
        });
        return new Response("expired", { status: 401 });
      }
      return Response.json({ ok: true });
    });

    const { code, err, results } = await runBatch(
      [{ url: "/api/a" }, { url: "/api/b" }, { url: "/api/c" }],
      { parallelMax: 3 },
    );

    expect(code).toBe(0);
    expect(refreshes).toBe(1);
    expect(results.map((r) => r.response.status_code)).toEqual([200, 200, 200]);
    expect(err).not.toContain("Session may be expired");
  });

  it("reports a request that got no response on its own line and exits with its curl code", async () => {
    installFetch((call) => {
      if (call.url.endsWith("/down"))
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      return new Response("{}", { status: 200 });
    });

    const { code, results } = await runBatch([{ url: "/api/ok" }, { url: "/api/down" }]);

    expect(code).toBe(7);
    expect(results[0]!.response.status_code).toBe(200);
    expect(results[1]!.error).toMatchObject({ code: 7 });
    expect(results[1]!.error.message).toContain("refused");
  });

  it("writes to -o, base64-encodes binary bodies, keeps non-JSON text as a string, maps --fail to 22", async () => {
    installFetch((call) =>
      call.url.endsWith("/bin")
        ? new Response(new Uint8Array([0xff, 0xfe, 0x00]), { status: 200 })
        : new Response("nope", { status: 404, headers: { "Content-Type": "application/json" } }),
    );
    const output = join(configHome.dir(), "out.jsonl");

    const { code, out } = await runBatch([{ url: "/api/bin" }, { url: "/api/missing" }], {
      output,
      fail: true,
    });

    expect(code).toBe(22);
    expect(out).toBe("");
    const lines = (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].response.body_encoding).toBe("base64");
    expect(Buffer.from(lines[0].response.body, "base64")).toEqual(Buffer.from([0xff, 0xfe, 0x00]));
    // Claims JSON but is not: handed back verbatim.
    expect(lines[1].response).toMatchObject({
      status_code: 404,
      body: "nope",
      body_encoding: "utf8",
    });
  });
});
