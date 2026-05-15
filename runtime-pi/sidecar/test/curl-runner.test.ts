// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `curl-runner.ts`. Coverage:
 *
 *   - GET happy path returns a real `Response` with parsed status,
 *     headers, and body (round-trip).
 *   - POST with headers + body passes argv flags and writes body to
 *     stdin via the `--data-binary @-` convention.
 *   - Redirects follow only when `redirect: "follow"` is explicit.
 *   - Timeout (exit 28) → 504. DNS/connect (exit 6/7) → 502. SSL
 *     handshake (exit 35) → 502.
 *   - Header round-trip: arbitrary upstream headers reach the
 *     returned `Response`.
 *   - CR/LF in caller headers refused with 400 (header-splitting).
 *   - Non-HTTPS URL refused with 502 (no plaintext downgrade).
 *
 * Mocking strategy: `curlFetch` accepts an optional `spawnFn`
 * parameter so we never touch the real `Bun.spawn` from a unit
 * test. The fake spawn returns scripted stdout / stderr / exit code
 * and asserts on the argv passed in.
 */

import { describe, it, expect } from "bun:test";
import { curlFetch, selectTlsClient } from "../curl-runner.ts";

interface FakeSpawnOptions {
  cmd: string[];
  stdin?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

/**
 * Minimal fake of `Bun.spawn`'s subprocess shape. Only the surface
 * actually consumed by `curlFetch` is implemented — exposing more
 * would let bugs in the production wiring slip through.
 */
function makeFakeSpawn(opts: {
  stdout: Uint8Array | string;
  stderr?: Uint8Array | string;
  exitCode?: number;
  captureStdin?: (bytes: Uint8Array) => void;
  captureCmd?: (cmd: string[]) => void;
}): typeof Bun.spawn {
  const stdoutBytes =
    typeof opts.stdout === "string" ? new TextEncoder().encode(opts.stdout) : opts.stdout;
  const stderrBytes =
    typeof opts.stderr === "string"
      ? new TextEncoder().encode(opts.stderr)
      : (opts.stderr ?? new Uint8Array());

  const stub = ((options: FakeSpawnOptions) => {
    opts.captureCmd?.(options.cmd);

    const stdinWrites: Uint8Array[] = [];
    const stdin =
      options.stdin === "pipe"
        ? {
            write(data: Uint8Array): void {
              stdinWrites.push(data);
            },
            end(): void {
              if (opts.captureStdin) {
                const total = stdinWrites.reduce((n, c) => n + c.byteLength, 0);
                const merged = new Uint8Array(total);
                let off = 0;
                for (const c of stdinWrites) {
                  merged.set(c, off);
                  off += c.byteLength;
                }
                opts.captureStdin(merged);
              }
            },
          }
        : undefined;

    return {
      stdin,
      stdout: bytesToStream(stdoutBytes),
      stderr: bytesToStream(stderrBytes),
      exited: Promise.resolve(opts.exitCode ?? 0),
    };
    // The real `Bun.spawn` returns a richer object; the cast is the
    // intentional seam — we only mock what we consume.
  }) as unknown as typeof Bun.spawn;

  return stub;
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Build a textbook curl `--include` output: `HTTP/1.1 …\r\n` header
 * lines, blank line, body. Matches what real curl emits and lets the
 * tests pin the parser independently of curl's actual format.
 */
function makeIncludedOutput(opts: {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
}): Uint8Array {
  const lines: string[] = [`HTTP/1.1 ${opts.status} ${opts.statusText ?? ""}`];
  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    lines.push(`${name}: ${value}`);
  }
  const head = lines.join("\r\n") + "\r\n\r\n";
  const body = opts.body ?? "";
  return new TextEncoder().encode(head + body);
}

describe("curlFetch — happy paths", () => {
  it("returns a Response with parsed status, headers, and body for GET", async () => {
    let captured: string[] = [];
    const spawn = makeFakeSpawn({
      stdout: makeIncludedOutput({
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "application/json", "X-Custom": "yes" },
        body: '{"data":42}',
      }),
      exitCode: 0,
      captureCmd: (cmd) => {
        captured = cmd;
      },
    });

    const res = await curlFetch(
      "https://api.example.com/messages",
      { method: "GET", headers: { Authorization: "Bearer tok-123" } },
      spawn,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-custom")).toBe("yes");
    expect(await res.text()).toBe('{"data":42}');

    expect(captured[0]).toBe("curl");
    expect(captured).toContain("-X");
    expect(captured).toContain("GET");
    expect(captured).toContain("--silent");
    expect(captured).toContain("-H");
    expect(captured).toContain("Authorization: Bearer tok-123");
    expect(captured).toContain("--proto");
    expect(captured).toContain("=https");
    // URL is positioned after `--` so it can't be parsed as an option.
    const dashDashIdx = captured.indexOf("--");
    expect(dashDashIdx).toBeGreaterThan(-1);
    expect(captured[dashDashIdx + 1]).toBe("https://api.example.com/messages");
  });

  it("forwards POST body via stdin (--data-binary @-)", async () => {
    let stdinBytes: Uint8Array | undefined;
    let captured: string[] = [];
    const spawn = makeFakeSpawn({
      stdout: makeIncludedOutput({ status: 201, body: '{"id":"x"}' }),
      captureStdin: (b) => {
        stdinBytes = b;
      },
      captureCmd: (cmd) => {
        captured = cmd;
      },
    });

    const res = await curlFetch(
      "https://api.example.com/create",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"name":"alice"}',
      },
      spawn,
    );
    expect(res.status).toBe(201);
    expect(captured).toContain("--data-binary");
    expect(captured).toContain("@-");
    expect(new TextDecoder().decode(stdinBytes!)).toBe('{"name":"alice"}');
  });

  it("follows redirects only when redirect=follow is explicit", async () => {
    let capturedWith: string[] = [];
    const spawnWith = makeFakeSpawn({
      stdout: makeIncludedOutput({ status: 200, body: "ok" }),
      captureCmd: (cmd) => {
        capturedWith = cmd;
      },
    });
    await curlFetch("https://api.example.com/x", { redirect: "follow" }, spawnWith);
    expect(capturedWith).toContain("-L");
    expect(capturedWith).toContain("--max-redirs");

    let capturedWithout: string[] = [];
    const spawnWithout = makeFakeSpawn({
      stdout: makeIncludedOutput({ status: 200, body: "ok" }),
      captureCmd: (cmd) => {
        capturedWithout = cmd;
      },
    });
    await curlFetch("https://api.example.com/x", {}, spawnWithout);
    expect(capturedWithout).not.toContain("-L");
  });

  it("passes proxyUrl via -x", async () => {
    let captured: string[] = [];
    const spawn = makeFakeSpawn({
      stdout: makeIncludedOutput({ status: 200 }),
      captureCmd: (cmd) => {
        captured = cmd;
      },
    });
    await curlFetch("https://api.example.com/x", { proxyUrl: "http://proxy.internal:3128" }, spawn);
    const xIdx = captured.indexOf("-x");
    expect(xIdx).toBeGreaterThan(-1);
    expect(captured[xIdx + 1]).toBe("http://proxy.internal:3128");
  });
});

describe("curlFetch — exit code mapping", () => {
  it("maps exit 28 (timeout) to 504", async () => {
    const spawn = makeFakeSpawn({
      stdout: "",
      stderr: "curl: (28) Operation timed out",
      exitCode: 28,
    });
    const res = await curlFetch("https://api.example.com/x", {}, spawn);
    expect(res.status).toBe(504);
  });

  it("maps exit 6 (DNS) to 502", async () => {
    const spawn = makeFakeSpawn({ stdout: "", exitCode: 6 });
    const res = await curlFetch("https://api.example.com/x", {}, spawn);
    expect(res.status).toBe(502);
  });

  it("maps exit 7 (connect refused) to 502", async () => {
    const spawn = makeFakeSpawn({ stdout: "", exitCode: 7 });
    const res = await curlFetch("https://api.example.com/x", {}, spawn);
    expect(res.status).toBe(502);
  });

  it("maps exit 35 (SSL handshake) to 502", async () => {
    const spawn = makeFakeSpawn({ stdout: "", exitCode: 35 });
    const res = await curlFetch("https://api.example.com/x", {}, spawn);
    expect(res.status).toBe(502);
  });

  it("maps unknown exit codes to 502 (defensive)", async () => {
    const spawn = makeFakeSpawn({ stdout: "", exitCode: 99 });
    const res = await curlFetch("https://api.example.com/x", {}, spawn);
    expect(res.status).toBe(502);
  });

  it("never leaks stderr into the response body", async () => {
    const spawn = makeFakeSpawn({
      stdout: "",
      stderr: "secret-internal-trace: token=xyz",
      exitCode: 7,
    });
    const res = await curlFetch("https://api.example.com/x", {}, spawn);
    const body = await res.text();
    expect(body).not.toContain("secret-internal-trace");
    expect(body).not.toContain("token=xyz");
  });
});

describe("curlFetch — security posture", () => {
  it("refuses non-HTTPS URLs (no plaintext downgrade)", async () => {
    const spawn = makeFakeSpawn({ stdout: "" });
    const res = await curlFetch("http://api.example.com/x", {}, spawn);
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/non-HTTPS/);
  });

  it("refuses CR/LF in caller header values (header splitting)", async () => {
    const spawn = makeFakeSpawn({ stdout: "" });
    const res = await curlFetch(
      "https://api.example.com/x",
      { headers: { "X-Bad": "value\r\nInjected: yes" } },
      spawn,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/CR\/LF/);
  });

  it("refuses CR/LF in caller header names", async () => {
    const spawn = makeFakeSpawn({ stdout: "" });
    const res = await curlFetch(
      "https://api.example.com/x",
      { headers: { "X-Bad\r\nInjected": "v" } },
      spawn,
    );
    expect(res.status).toBe(400);
  });

  it("refuses malformed URLs", async () => {
    const spawn = makeFakeSpawn({ stdout: "" });
    const res = await curlFetch("not a url", {}, spawn);
    expect(res.status).toBe(502);
  });

  it("refuses methods outside the HTTP allowlist (request-line splicing defence)", async () => {
    const spawn = makeFakeSpawn({ stdout: "" });
    const res = await curlFetch("https://api.example.com/x", { method: "GET\r\nX-Bad: 1" }, spawn);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/refused method/);
  });

  it("refuses arbitrary tokens as method (not just CR/LF)", async () => {
    const spawn = makeFakeSpawn({ stdout: "" });
    const res = await curlFetch("https://api.example.com/x", { method: "TRACE" }, spawn);
    expect(res.status).toBe(400);
  });

  it("synthesizes 502 when response exceeds memory cap", async () => {
    // 101 MB of zero bytes — one past the 100 MB cap. The cap drains
    // and discards the partial buffer, so the resulting response body
    // is the synthetic error message, not 101 MB of payload.
    const oversized = new Uint8Array(101 * 1024 * 1024);
    const spawn = makeFakeSpawn({ stdout: oversized, exitCode: 0 });
    const res = await curlFetch("https://api.example.com/x", {}, spawn);
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/size cap/);
  });

  it("aborts the child when the caller's AbortSignal fires", async () => {
    let killed = false;
    // Custom fake spawn — exposes a `kill` method on the child and
    // resolves `exited` only after `kill()` is called, so the test
    // proves the abort actually flows through.
    const spawnFn = ((options: { cmd: string[]; stdin?: unknown }) => {
      let resolveExit: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      return {
        stdin: options.stdin === "pipe" ? { write: () => {}, end: () => {} } : undefined,
        stdout: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        exited,
        kill(): void {
          killed = true;
          resolveExit(0);
        },
      };
    }) as unknown as typeof Bun.spawn;

    const ac = new AbortController();
    const promise = curlFetch("https://api.example.com/x", { signal: ac.signal }, spawnFn);
    // Wait a tick for the listener to attach, then abort.
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    await promise;
    expect(killed).toBe(true);
  });
});

describe("curlFetch — status line parsing", () => {
  it("parses HTTP/2 status lines (no reason phrase)", async () => {
    // Real curl on HTTP/2 emits `HTTP/2 200\r\n` — no trailing space,
    // no reason phrase. Regression guard against a future regex tweak.
    const head = "HTTP/2 200\r\nContent-Type: application/json\r\n\r\n";
    const spawn = makeFakeSpawn({
      stdout: new TextEncoder().encode(head + '{"ok":true}'),
    });
    const res = await curlFetch("https://api.example.com/x", {}, spawn);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });
});

describe("curlFetch — header propagation", () => {
  it("strips Content-Length and Transfer-Encoding from the response (controlled by Response ctor)", async () => {
    const spawn = makeFakeSpawn({
      stdout: makeIncludedOutput({
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": "5",
          "Transfer-Encoding": "chunked",
          "X-Trace-Id": "abc",
        },
        body: "hello",
      }),
    });
    const res = await curlFetch("https://api.example.com/x", {}, spawn);
    expect(res.headers.get("x-trace-id")).toBe("abc");
    // Bun's Response sets these from the body; we never want curl's
    // declared values to confuse downstream consumers.
    expect(res.headers.get("transfer-encoding")).toBeNull();
  });
});

describe("selectTlsClient — pattern matching", () => {
  // Matcher signature mirrors `matchesAuthorizedUri(url, patterns)` from
  // helpers.ts. The unit test uses a trivial prefix matcher so we don't
  // pull the AFPS resolver into a pure unit suite.
  const naiveMatcher = (url: string, patterns: string[]): boolean =>
    patterns.some((p) => {
      const prefix = p.replace(/\*+.*$/, "");
      return url.startsWith(prefix);
    });

  it("returns the client of the first matching pattern", () => {
    const table = [
      { pattern: "https://api.example.com/", client: "curl" as const },
      { pattern: "https://other.example.com/", client: "undici" as const },
    ];
    expect(selectTlsClient("https://api.example.com/x", table, naiveMatcher)).toBe("curl");
    expect(selectTlsClient("https://other.example.com/x", table, naiveMatcher)).toBe("undici");
  });

  it("returns undefined when no pattern matches", () => {
    const table = [{ pattern: "https://api.example.com/", client: "curl" as const }];
    expect(selectTlsClient("https://nope.example.com/", table, naiveMatcher)).toBeUndefined();
  });

  it("returns undefined for empty/missing tables", () => {
    expect(selectTlsClient("https://x.example.com/", undefined, naiveMatcher)).toBeUndefined();
    expect(selectTlsClient("https://x.example.com/", [], naiveMatcher)).toBeUndefined();
  });
});
