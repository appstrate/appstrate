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

async function runBatch(
  lines: unknown[] | string,
  opts: Partial<ApiCommandOptions> = {},
): Promise<{ code: number | null; out: string; err: string; results: Record<string, unknown>[] }> {
  const file = join(configHome.dir(), "batch.jsonl");
  await writeFile(
    file,
    typeof lines === "string" ? lines : lines.map((l) => JSON.stringify(l)).join("\n"),
  );
  let out = "";
  let err = "";
  let code: number | null = null;
  const text = (c: Uint8Array | string) =>
    typeof c === "string" ? c : new TextDecoder().decode(c);
  const io: ApiCommandIO = {
    stdout: { write: (c) => void (out += text(c)) },
    stderr: { write: (c) => void (err += text(c)) },
    exit: (c) => {
      code = c;
      throw new ExitSentinel(c);
    },
    cancel: () => {},
    onSigint: () => {},
  };
  try {
    await apiCommand({ path: "", header: [], form: [], query: [], batch: file, ...opts }, io);
  } catch (e) {
    if (!(e instanceof ExitSentinel)) throw e;
  }
  const results = out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { code, out, err, results };
}

describe("appstrate api --batch", () => {
  it("sends every line with the profile credential and answers in input order", async () => {
    installFetch(async (call) => {
      // Answer the first request last: the output must still follow the input.
      if (call.url.endsWith("/a")) await Bun.sleep(20);
      return new Response(JSON.stringify({ url: call.url, method: call.method }), { status: 200 });
    });

    const { code, results } = await runBatch(
      [
        { id: "first", path: "/api/a" },
        { path: "/api/b", body: '{"x":1}', headers: { "Content-Type": "application/json" } },
        { method: "delete", path: "/api/c" },
      ],
      { header: ["X-Extra: 1"] },
    );

    expect(code).toBe(0);
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["first", 200],
      ["2", 200],
      ["3", 200],
    ]);
    expect(JSON.parse(results[1]!.body as string)).toEqual({
      url: "https://app.example.com/api/b",
      method: "POST",
    });
    expect(fetchCalls.map((c) => c.method).sort()).toEqual(["DELETE", "GET", "POST"]);
    for (const call of fetchCalls) {
      expect(call.headers.Authorization).toBe("Bearer access-1");
      expect(call.headers["X-Org-Id"]).toBe("org_1");
      expect(call.headers["X-Extra"]).toBe("1");
    }
    const post = fetchCalls.find((c) => c.method === "POST")!;
    expect(post.body).toBe('{"x":1}');
    expect(post.headers["Content-Type"]).toBe("application/json");
  });

  it("keeps at most --parallel requests in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    installFetch(async () => {
      peak = Math.max(peak, ++inFlight);
      await Bun.sleep(5);
      inFlight--;
      return new Response("{}", { status: 200 });
    });

    const { code } = await runBatch(
      Array.from({ length: 12 }, (_, i) => ({ path: `/api/x/${i}` })),
      { parallel: 3 },
    );

    expect(code).toBe(0);
    expect(fetchCalls).toHaveLength(12);
    expect(peak).toBe(3);
  });

  it("refuses the whole batch before sending anything when a line is invalid or off-origin", async () => {
    installFetch(() => new Response("{}", { status: 200 }));

    const invalid = await runBatch('{"path":"/api/a"}\n{"path": 42}\n');
    expect(invalid.code).toBe(2);
    expect(invalid.err).toContain("line 2");

    const offOrigin = await runBatch([{ path: "/api/a" }, { path: "https://evil.example.org/x" }]);
    expect(offOrigin.code).toBe(2);
    expect(offOrigin.err).toContain("line 2");

    expect(fetchCalls).toHaveLength(0);
  });

  it("refuses single-request flags", async () => {
    installFetch(() => new Response("{}", { status: 200 }));
    const { code, err } = await runBatch([{ path: "/api/a" }], { data: "x", include: true });
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

    const { code, results } = await runBatch([{ path: "/api/a" }], { retry: 2 });

    expect(code).toBe(0);
    expect(calls).toBe(2);
    expect(results[0]!.status).toBe(200);
  });

  it("reports a request that got no response on its own line and exits 1", async () => {
    installFetch((call) => {
      if (call.url.endsWith("/down"))
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      return new Response("{}", { status: 200 });
    });

    const { code, results } = await runBatch([{ path: "/api/ok" }, { path: "/api/down" }]);

    expect(code).toBe(1);
    expect(results[0]!.status).toBe(200);
    expect(typeof results[1]!.error).toBe("string");
  });

  it("writes to -o, base64-encodes binary bodies, and maps --fail to 22", async () => {
    installFetch((call) =>
      call.url.endsWith("/bin")
        ? new Response(new Uint8Array([0xff, 0xfe, 0x00]), { status: 200 })
        : new Response("nope", { status: 404 }),
    );
    const output = join(configHome.dir(), "out.jsonl");

    const { code, out } = await runBatch([{ path: "/api/bin" }, { path: "/api/missing" }], {
      output,
      fail: true,
    });

    expect(code).toBe(22);
    expect(out).toBe("");
    const lines = (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].body_encoding).toBe("base64");
    expect(Buffer.from(lines[0].body, "base64")).toEqual(Buffer.from([0xff, 0xfe, 0x00]));
    expect(lines[1].status).toBe(404);
  });
});
