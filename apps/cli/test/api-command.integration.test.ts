// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `commands/api.ts` against a real `Bun.serve()`
 * fixture. Covers behaviors that can't be faithfully verified with a
 * stubbed `globalThis.fetch`:
 *
 *   - SSE per-chunk delivery (are we ourselves buffering?)
 *   - Multipart round-trip (boundary parses server-side, file bytes match)
 *   - Binary byte-exact download via -o
 *   - Cross-origin redirect Authorization strip (WHATWG fetch spec)
 *   - SIGINT mid-stream → exit 130, no unhandled rejection
 *   - --max-time → exit 28
 *
 * Pattern: drive `apiCommand()` directly with a captured-IO adapter.
 * No subprocess spawn; the two Bun.serve() instances + the CLI all run
 * in-process so tests are fast and deterministic.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import {
  _setKeyringFactoryForTesting,
  saveTokens,
  type KeyringHandle,
} from "../src/lib/keyring.ts";
import { setProfile } from "../src/lib/config.ts";
import { apiCommand, type ApiCommandIO, type ApiCommandOptions } from "../src/commands/api.ts";
import { startTestServer, type TestServerHandle } from "./fixtures/test-server.ts";

// ─── Scaffolding (re-uses the same idioms as api-command.test.ts) ──

class FakeKeyring implements KeyringHandle {
  static store = new Map<string, string>();
  constructor(private profile: string) {}
  setPassword(v: string): void {
    FakeKeyring.store.set(this.profile, v);
  }
  getPassword(): string | null {
    return FakeKeyring.store.get(this.profile) ?? null;
  }
  deletePassword(): void {
    FakeKeyring.store.delete(this.profile);
  }
}

let tmpDir: string;
let originalXdg: string | undefined;
let primary: TestServerHandle;
let peer: TestServerHandle;

beforeAll(() => {
  originalXdg = process.env.XDG_CONFIG_HOME;
});
afterAll(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "appstrate-cli-apiint-"));
  process.env.XDG_CONFIG_HOME = tmpDir;
  FakeKeyring.store.clear();
  _setKeyringFactoryForTesting((p) => new FakeKeyring(p));

  // Peer first so the primary can reference its URL for cross-origin redirects.
  peer = await startTestServer();
  primary = await startTestServer({ redirectTargetUrl: () => peer.url });

  await setProfile("default", {
    instance: primary.url,
    userId: "u_1",
    email: "a@example.com",
  });
  await saveTokens("default", {
    accessToken: "real-access",
    expiresAt: Date.now() + 5 * 60 * 1000,
    refreshToken: "r",
    refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
});
afterEach(async () => {
  _setKeyringFactoryForTesting(null);
  await primary.close();
  await peer.close();
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── IO capture ────────────────────────────────────────────────────

interface CapturedIO {
  io: ApiCommandIO;
  stdout: Uint8Array[];
  stderr: Uint8Array[];
  /** Per-chunk arrival timestamps on stdout — used to assert non-batching for SSE. */
  stdoutArrivals: number[];
  exitCode: { value: number | null };
  /** Expose the SIGINT callback so tests can fire it synthetically. */
  triggerSigint: () => void;
}

class ExitSentinel extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
    this.name = "ExitSentinel";
  }
}

function makeIO(overrides?: { stdinStream?: ApiCommandIO["stdinStream"] }): CapturedIO {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const stdoutArrivals: number[] = [];
  const exitCode = { value: null as number | null };
  const toBytes = (c: Uint8Array | string) =>
    typeof c === "string" ? new TextEncoder().encode(c) : c;
  let sigintCb: (() => void) | null = null;
  const io: ApiCommandIO = {
    stdout: {
      write(c) {
        stdout.push(toBytes(c));
        stdoutArrivals.push(performance.now());
      },
    },
    stderr: { write: (c) => void stderr.push(toBytes(c)) },
    exit: (code) => {
      exitCode.value = code;
      throw new ExitSentinel(code);
    },
    onSigint: (cb) => {
      sigintCb = cb;
    },
    stdinStream: overrides?.stdinStream,
  };
  return {
    io,
    stdout,
    stderr,
    stdoutArrivals,
    exitCode,
    triggerSigint: () => sigintCb?.(),
  };
}

async function run(
  opts: Partial<ApiCommandOptions> & { method: string; path: string },
  captured: CapturedIO,
): Promise<void> {
  const full: ApiCommandOptions = {
    method: opts.method,
    path: opts.path,
    header: opts.header ?? [],
    form: opts.form ?? [],
    query: opts.query ?? [],
    data: opts.data,
    dataRaw: opts.dataRaw,
    dataBinary: opts.dataBinary,
    request: opts.request,
    output: opts.output,
    include: opts.include,
    head: opts.head,
    silent: opts.silent,
    fail: opts.fail,
    location: opts.location,
    insecure: opts.insecure,
    maxTime: opts.maxTime,
    profile: opts.profile,
  };
  try {
    await apiCommand(full, captured.io);
  } catch (err) {
    if (err instanceof ExitSentinel) return;
    throw err;
  }
}

function decode(buf: Uint8Array[]): string {
  return new TextDecoder().decode(Buffer.concat(buf.map((c) => Buffer.from(c))));
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function allBytes(buf: Uint8Array[]): Uint8Array {
  const total = buf.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of buf) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("apiCommand integration — basic happy path", () => {
  it("GET /json with a real server works end-to-end", async () => {
    const captured = makeIO();
    await run({ method: "GET", path: "/json" }, captured);
    expect(captured.exitCode.value).toBe(0);
    expect(decode(captured.stdout)).toContain('"ok":true');
    // Server observed our Authorization header.
    const call = primary.calls.find((c) => c.path === "/json")!;
    expect(call.headers.authorization).toBe("Bearer real-access");
  });
});

describe("apiCommand integration — SSE", () => {
  it("streams 3 frames with per-chunk stdout writes (not batched)", async () => {
    const captured = makeIO();
    await run({ method: "GET", path: "/sse" }, captured);
    expect(captured.exitCode.value).toBe(0);
    const text = decode(captured.stdout);
    expect(text).toContain("data: 0");
    expect(text).toContain("data: 1");
    expect(text).toContain("data: 2");
    // At least 2 distinct arrival times (3 server-flushed frames with
    // 20ms gaps should produce more than one stdout write on the
    // client). On a heavily loaded CI runner this can drop to 1 in
    // rare cases, so we assert a soft lower bound instead of exactly 3.
    expect(captured.stdoutArrivals.length).toBeGreaterThanOrEqual(2);
  });
});

describe("apiCommand integration — multipart upload", () => {
  it("POST -F file=@path round-trips bytes and filename", async () => {
    const fpath = join(tmpDir, "pkg.zip");
    const bytes = new Uint8Array(2048);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) & 0xff;
    await writeFile(fpath, bytes);
    const expectedHash = sha256(bytes);

    const captured = makeIO();
    await run(
      {
        method: "POST",
        path: "/multipart",
        form: [`file=@${fpath};type=application/zip`, "name=test"],
      },
      captured,
    );
    expect(captured.exitCode.value).toBe(0);

    const call = primary.calls.find((c) => c.path === "/multipart")!;
    expect(call.formFields).toBeTruthy();
    const fileField = call.formFields!.file as {
      name?: string;
      size: number;
      type: string;
      sha256: string;
    };
    expect(fileField.name).toBe("pkg.zip");
    expect(fileField.size).toBe(bytes.length);
    expect(fileField.type).toBe("application/zip");
    expect(fileField.sha256).toBe(expectedHash);
    expect(call.formFields!.name).toBe("test");
  });
});

describe("apiCommand integration — stdin upload", () => {
  it("POST -d @- sends a ReadableStream body the server receives intact", async () => {
    const payload = "streamed-from-stdin-" + "x".repeat(100_000);
    const stdinStream: ApiCommandIO["stdinStream"] = () => {
      const enc = new TextEncoder();
      const bytes = enc.encode(payload);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    };
    const captured = makeIO({ stdinStream });
    await run({ method: "POST", path: "/echo", data: "@-" }, captured);
    expect(captured.exitCode.value).toBe(0);
    // Server echoes the body back verbatim.
    expect(decode(captured.stdout)).toBe(payload);
    const call = primary.calls.find((c) => c.path === "/echo")!;
    expect(call.bodyBytes?.byteLength).toBe(new TextEncoder().encode(payload).byteLength);
  });
});

describe("apiCommand integration — binary download", () => {
  it("-o writes the 1MB binary payload byte-exact", async () => {
    const outPath = join(tmpDir, "download.bin");
    const captured = makeIO();
    await run({ method: "GET", path: "/binary", output: outPath }, captured);
    expect(captured.exitCode.value).toBe(0);
    const written = new Uint8Array(await readFile(outPath));
    expect(written.byteLength).toBe(primary.binaryPayload.byteLength);
    expect(sha256(written)).toBe(sha256(primary.binaryPayload));
  });

  it("without -o, binary is piped to stdout byte-exact", async () => {
    const captured = makeIO();
    await run({ method: "GET", path: "/binary" }, captured);
    expect(captured.exitCode.value).toBe(0);
    expect(sha256(allBytes(captured.stdout))).toBe(sha256(primary.binaryPayload));
  });
});

describe("apiCommand integration — redirect + Authorization", () => {
  it("cross-origin redirect with -L → peer sees NO Authorization", async () => {
    const captured = makeIO();
    await run({ method: "GET", path: "/redirect/cross", location: true }, captured);
    expect(captured.exitCode.value).toBe(0);
    const parsed = JSON.parse(decode(captured.stdout));
    // Spec (whatwg/fetch#1544) requires the Authorization header to be
    // stripped on cross-origin redirect. Bun's fetch follows that.
    expect(parsed.authorization).toBeNull();
    // Peer server received the hop.
    expect(peer.calls.find((c) => c.path === "/peek-auth")).toBeTruthy();
  });

  it("same-origin redirect with -L → Authorization is preserved on the final hop", async () => {
    const captured = makeIO();
    await run({ method: "GET", path: "/redirect/same", location: true }, captured);
    expect(captured.exitCode.value).toBe(0);
    expect(decode(captured.stdout)).toContain('"ok":true');
    const finalHop = primary.calls.find((c) => c.path === "/json")!;
    expect(finalHop.headers.authorization).toBe("Bearer real-access");
  });

  it("default (no -L) does not follow — 302 surfaces to stdout", async () => {
    const captured = makeIO();
    await run({ method: "GET", path: "/redirect/same", include: true }, captured);
    expect(captured.exitCode.value).toBe(0);
    expect(decode(captured.stdout)).toMatch(/^HTTP\/1\.1 302 /);
    // Exactly one request on the primary — no auto-follow.
    const redirects = primary.calls.filter((c) => c.path === "/redirect/same");
    expect(redirects.length).toBe(1);
    const followed = primary.calls.filter((c) => c.path === "/json");
    expect(followed.length).toBe(0);
  });
});

describe("apiCommand integration — --fail", () => {
  it("--fail on real 404 → exit 22, body on stderr", async () => {
    const captured = makeIO();
    await run({ method: "GET", path: "/404", fail: true }, captured);
    expect(captured.exitCode.value).toBe(22);
    expect(decode(captured.stderr)).toContain("not found");
    expect(decode(captured.stdout)).toBe("");
  });
  it("--fail on real 500 → exit 25", async () => {
    const captured = makeIO();
    await run({ method: "GET", path: "/500", fail: true }, captured);
    expect(captured.exitCode.value).toBe(25);
    expect(decode(captured.stderr)).toContain("boom");
  });
});

describe("apiCommand integration — SIGINT + timeout", () => {
  it("SIGINT during /slow aborts fetch, exits 130", async () => {
    const captured = makeIO();
    // Kick off the command, let the first chunk arrive, then fire SIGINT.
    const run$ = run({ method: "GET", path: "/slow" }, captured);
    // Wait until we've received at least one chunk on stdout.
    const deadline = performance.now() + 1500;
    while (captured.stdoutArrivals.length === 0 && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    captured.triggerSigint();
    await run$;
    expect(captured.exitCode.value).toBe(130);
  });

  it("--max-time N terminates the request with exit 28", async () => {
    const captured = makeIO();
    await run({ method: "GET", path: "/slow", maxTime: 0.1 }, captured);
    expect(captured.exitCode.value).toBe(28);
    expect(decode(captured.stderr)).toMatch(/timed out/i);
  });
});
