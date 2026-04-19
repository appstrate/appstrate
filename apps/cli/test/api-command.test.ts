// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `commands/api.ts` — `appstrate api` curl-like passthrough.
 *
 * Scope: stubbed `globalThis.fetch`. Verifies flag parsing, header /
 * body / method / query construction, exit-code decisions, streaming
 * output, and error classification. End-to-end streaming fidelity
 * (SSE per-frame flush, multipart round-trip, cross-origin redirect
 * Authorization strip) is covered by the integration suite in
 * `api-command.integration.test.ts` against a real Bun.serve().
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _setKeyringFactoryForTesting,
  saveTokens,
  type KeyringHandle,
} from "../src/lib/keyring.ts";
import { setProfile } from "../src/lib/config.ts";
import { apiCommand, type ApiCommandIO, type ApiCommandOptions } from "../src/commands/api.ts";
import {
  classifyNetworkError,
  EXIT_DNS,
  EXIT_CONNECT,
  EXIT_TIMEOUT,
  EXIT_TLS,
} from "../src/lib/http-classify.ts";

// ─── Test infrastructure ────────────────────────────────────────────

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

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  init: Record<string, unknown>;
};

let tmpDir: string;
let originalXdg: string | undefined;
const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[];

function installFetch(responder: (call: FetchCall) => Promise<Response> | Response): void {
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) headers[k] = v;
    const call: FetchCall = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: init?.body,
      init: (init ?? {}) as Record<string, unknown>,
    };
    fetchCalls.push(call);
    return responder(call);
  };
  globalThis.fetch = stub as unknown as typeof fetch;
}

beforeAll(() => {
  originalXdg = process.env.XDG_CONFIG_HOME;
});
afterAll(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "appstrate-cli-apicmd-"));
  process.env.XDG_CONFIG_HOME = tmpDir;
  FakeKeyring.store.clear();
  _setKeyringFactoryForTesting((p) => new FakeKeyring(p));
  fetchCalls = [];
});
afterEach(async () => {
  _setKeyringFactoryForTesting(null);
  globalThis.fetch = originalFetch;
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────

async function seedLoggedIn(profileName: string, overrides?: { orgId?: string }): Promise<void> {
  await setProfile(profileName, {
    instance: "https://app.example.com",
    userId: "u_1",
    email: "a@example.com",
    orgId: overrides?.orgId,
  });
  await saveTokens(profileName, {
    accessToken: "access-1",
    expiresAt: Date.now() + 5 * 60 * 1000, // fresh, no proactive refresh
    refreshToken: "refresh-1",
    refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
}

function makeIO(): {
  io: ApiCommandIO;
  stdout: Uint8Array[];
  stderr: Uint8Array[];
  exitCode: { value: number | null };
} {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const exitCode = { value: null as number | null };
  const toBytes = (c: Uint8Array | string) =>
    typeof c === "string" ? new TextEncoder().encode(c) : c;
  const io: ApiCommandIO = {
    stdout: { write: (c) => void stdout.push(toBytes(c)) },
    stderr: { write: (c) => void stderr.push(toBytes(c)) },
    exit: (code) => {
      exitCode.value = code;
      // Mimic `never` without terminating the runner — throw a sentinel
      // that the test can catch / ignore. apiCommand flow is always
      // `return io.exit(…)`, so throwing short-circuits cleanly.
      throw new ExitSentinel(code);
    },
    onSigint: () => {},
  };
  return { io, stdout, stderr, exitCode };
}

class ExitSentinel extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
    this.name = "ExitSentinel";
  }
}

async function runCommand(
  opts: Partial<ApiCommandOptions> & { path: string },
  io: ApiCommandIO,
): Promise<void> {
  const full: ApiCommandOptions = {
    profile: opts.profile,
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
    showError: opts.showError,
    fail: opts.fail,
    location: opts.location,
    insecure: opts.insecure,
    maxTime: opts.maxTime,
    verbose: opts.verbose,
    get: opts.get,
    writeOut: opts.writeOut,
    uploadFile: opts.uploadFile,
    connectTimeout: opts.connectTimeout,
  };
  try {
    await apiCommand(full, io);
  } catch (err) {
    if (err instanceof ExitSentinel) return;
    throw err;
  }
}

function stdoutText(buf: Uint8Array[]): string {
  return new TextDecoder().decode(Buffer.concat(buf.map((c) => Buffer.from(c))));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("apiCommand — auth headers", () => {
  it("injects Authorization + User-Agent from the active profile", async () => {
    await seedLoggedIn("default");
    installFetch(() => jsonResponse(200, { ok: true }));

    const { io, stdout, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/api/foo" }, io);

    expect(exitCode.value).toBe(0);
    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0]!;
    expect(call.url).toBe("https://app.example.com/api/foo");
    expect(call.headers.Authorization).toBe("Bearer access-1");
    expect(call.headers["User-Agent"]).toMatch(/^appstrate-cli\//);
    expect(stdoutText(stdout)).toContain('"ok":true');
  });

  it("injects X-Org-Id from profile.orgId when set", async () => {
    await seedLoggedIn("default", { orgId: "org_42" });
    installFetch(() => jsonResponse(200, {}));
    const { io } = makeIO();
    await runCommand({ method: "GET", path: "/api/foo" }, io);
    expect(fetchCalls[0]!.headers["X-Org-Id"]).toBe("org_42");
  });

  it("omits X-Org-Id when profile.orgId is missing", async () => {
    await seedLoggedIn("default");
    installFetch(() => jsonResponse(200, {}));
    const { io } = makeIO();
    await runCommand({ method: "GET", path: "/api/foo" }, io);
    expect(fetchCalls[0]!.headers["X-Org-Id"]).toBeUndefined();
  });

  it("-H overrides profile X-Org-Id (user header wins)", async () => {
    await seedLoggedIn("default", { orgId: "org_default" });
    installFetch(() => jsonResponse(200, {}));
    const { io } = makeIO();
    await runCommand({ method: "GET", path: "/api/foo", header: ["X-Org-Id: org_custom"] }, io);
    expect(fetchCalls[0]!.headers["X-Org-Id"]).toBe("org_custom");
  });

  it("-H merges with defaults (passthrough Accept, etc.)", async () => {
    await seedLoggedIn("default");
    installFetch(() => jsonResponse(200, {}));
    const { io } = makeIO();
    await runCommand(
      { method: "GET", path: "/api/foo", header: ["Accept: text/event-stream"] },
      io,
    );
    expect(fetchCalls[0]!.headers.Accept).toBe("text/event-stream");
    expect(fetchCalls[0]!.headers.Authorization).toBe("Bearer access-1");
  });

  it("silently ignores malformed -H entries (no colon)", async () => {
    await seedLoggedIn("default");
    installFetch(() => jsonResponse(200, {}));
    const { io, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/api/foo", header: ["malformed"] }, io);
    expect(exitCode.value).toBe(0);
    expect(fetchCalls[0]!.headers.malformed).toBeUndefined();
  });
});

describe("apiCommand — method defaulting", () => {
  beforeEach(async () => {
    await seedLoggedIn("default");
    installFetch(() => jsonResponse(200, {}));
  });

  it("no body → GET", async () => {
    const { io } = makeIO();
    await runCommand({ method: "GET", path: "/p" }, io);
    expect(fetchCalls[0]!.method).toBe("GET");
  });

  it("body present → POST when method unset via -X", async () => {
    // Positional method is required but let's simulate an agent
    // passing it as implicit default by omitting -X.
    const { io } = makeIO();
    // If positional says "POST" we just honor it.
    await runCommand({ method: "POST", path: "/p", data: "{}" }, io);
    expect(fetchCalls[0]!.method).toBe("POST");
  });

  it("no positional method + body → POST (hasBody fallback)", async () => {
    // Exercises the `hasBody ? "POST" : "GET"` default branch in
    // pickMethod — positional method empty, no -X, body present.
    const { io } = makeIO();
    await runCommand({ method: "", path: "/p", data: "{}" }, io);
    expect(fetchCalls[0]!.method).toBe("POST");
  });

  it("no positional method + no body → GET", async () => {
    const { io } = makeIO();
    await runCommand({ method: "", path: "/p" }, io);
    expect(fetchCalls[0]!.method).toBe("GET");
  });

  it("-I strips body even when -d is provided", async () => {
    const { io } = makeIO();
    await runCommand({ method: "GET", path: "/p", head: true, data: "ignored" }, io);
    expect(fetchCalls[0]!.method).toBe("HEAD");
    expect(fetchCalls[0]!.body).toBeUndefined();
  });

  it("-X PUT wins over positional", async () => {
    const { io } = makeIO();
    await runCommand({ method: "GET", path: "/p", request: "PUT" }, io);
    expect(fetchCalls[0]!.method).toBe("PUT");
  });

  it("--head / -I overrides everything and sets HEAD", async () => {
    const { io } = makeIO();
    await runCommand({ method: "GET", path: "/p", head: true, request: "PUT" }, io);
    expect(fetchCalls[0]!.method).toBe("HEAD");
  });
});

describe("apiCommand — query params", () => {
  beforeEach(async () => {
    await seedLoggedIn("default");
    installFetch(() => jsonResponse(200, {}));
  });

  it("-q k=v appends to URLSearchParams", async () => {
    const { io } = makeIO();
    await runCommand({ method: "GET", path: "/p", query: ["a=1", "b=two"] }, io);
    expect(fetchCalls[0]!.url).toBe("https://app.example.com/p?a=1&b=two");
  });

  it("-q preserves pre-existing query string on path", async () => {
    const { io } = makeIO();
    await runCommand({ method: "GET", path: "/p?existing=1", query: ["added=2"] }, io);
    const u = new URL(fetchCalls[0]!.url);
    expect(u.searchParams.get("existing")).toBe("1");
    expect(u.searchParams.get("added")).toBe("2");
  });

  it("-q without '=' sends bare flag", async () => {
    const { io } = makeIO();
    await runCommand({ method: "GET", path: "/p", query: ["flag"] }, io);
    expect(fetchCalls[0]!.url).toContain("flag=");
  });
});

describe("apiCommand — body modes", () => {
  beforeEach(async () => {
    await seedLoggedIn("default");
    installFetch(() => jsonResponse(200, {}));
  });

  it("-d <literal> sends the string and strips ONE trailing \\n", async () => {
    const { io } = makeIO();
    await runCommand({ method: "POST", path: "/p", data: "hello\n" }, io);
    expect(fetchCalls[0]!.body).toBe("hello");
  });

  it("--data-raw preserves @ and trailing newline", async () => {
    const { io } = makeIO();
    await runCommand({ method: "POST", path: "/p", dataRaw: "@literal\n" }, io);
    expect(fetchCalls[0]!.body).toBe("@literal\n");
  });

  it("--data-binary preserves trailing newline", async () => {
    const { io } = makeIO();
    await runCommand({ method: "POST", path: "/p", dataBinary: "bin\n" }, io);
    expect(fetchCalls[0]!.body).toBe("bin\n");
  });

  it("-d @file uses Bun.file for streaming upload", async () => {
    const fpath = join(tmpDir, "body.json");
    await writeFile(fpath, '{"k":"v"}');
    const { io } = makeIO();
    await runCommand({ method: "POST", path: "/p", data: `@${fpath}` }, io);
    // Bun.file returns a Blob-like — the stub captures it as-is.
    const body = fetchCalls[0]!.body as { size?: number; arrayBuffer?: () => Promise<ArrayBuffer> };
    expect(typeof body.arrayBuffer).toBe("function");
  });

  it("-d @- uses stdin stream with duplex: 'half'", async () => {
    const stdinBytes = new TextEncoder().encode("streamed-payload");
    const stdinStream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(stdinBytes);
          controller.close();
        },
      });
    const { io } = makeIO();
    io.stdinStream = stdinStream;
    await runCommand({ method: "POST", path: "/p", data: "@-" }, io);
    const call = fetchCalls[0]!;
    expect(call.body).toBeInstanceOf(ReadableStream);
    expect(call.init.duplex).toBe("half");
  });

  it("-F k=v builds FormData with string fields", async () => {
    const { io } = makeIO();
    await runCommand({ method: "POST", path: "/p", form: ["name=Alice", "age=30"] }, io);
    const body = fetchCalls[0]!.body;
    expect(body).toBeInstanceOf(FormData);
    const fd = body as FormData;
    expect(fd.get("name")).toBe("Alice");
    expect(fd.get("age")).toBe("30");
  });

  it("-F file=@path appends a Blob with the basename as filename", async () => {
    const fpath = join(tmpDir, "pkg.zip");
    await writeFile(fpath, "PK\x03\x04fake-zip-bytes");
    const { io } = makeIO();
    await runCommand({ method: "POST", path: "/p", form: [`file=@${fpath}`] }, io);
    const fd = fetchCalls[0]!.body as FormData;
    const entry = fd.get("file") as unknown as Blob & { name?: string };
    expect(entry).toBeTruthy();
    // FormData's File entry carries a `name` property.
    expect((entry as File).name).toBe("pkg.zip");
  });

  it("-F file=@path;type=application/pdf applies the mime override", async () => {
    const fpath = join(tmpDir, "x.bin");
    await writeFile(fpath, "x");
    const { io } = makeIO();
    await runCommand(
      { method: "POST", path: "/p", form: [`doc=@${fpath};type=application/pdf`] },
      io,
    );
    const fd = fetchCalls[0]!.body as FormData;
    const entry = fd.get("doc") as unknown as Blob;
    expect(entry.type).toBe("application/pdf");
  });
});

describe("apiCommand — output", () => {
  beforeEach(async () => {
    await seedLoggedIn("default");
  });

  it("-i prints status line + headers before body", async () => {
    installFetch(() => jsonResponse(200, { ok: true }));
    const { io, stdout } = makeIO();
    await runCommand({ method: "GET", path: "/p", include: true }, io);
    const out = stdoutText(stdout);
    expect(out).toMatch(/^HTTP\/1\.1 200 /);
    expect(out).toMatch(/content-type: application\/json/i);
    expect(out).toContain('"ok":true');
  });

  it("-I sends HEAD and omits body", async () => {
    installFetch(() => new Response("should-not-appear", { status: 204 }));
    const { io, stdout } = makeIO();
    await runCommand({ method: "GET", path: "/p", head: true }, io);
    const out = stdoutText(stdout);
    expect(out).toMatch(/^HTTP\/1\.1 204 /);
    expect(out).not.toContain("should-not-appear");
    expect(fetchCalls[0]!.method).toBe("HEAD");
  });

  it("-o writes body to file byte-exact", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    installFetch(() => new Response(payload, { status: 200 }));
    const outPath = join(tmpDir, "out.bin");
    const { io } = makeIO();
    await runCommand({ method: "GET", path: "/p", output: outPath }, io);
    const written = await readFile(outPath);
    expect(new Uint8Array(written)).toEqual(payload);
  });
});

describe("apiCommand — --fail", () => {
  beforeEach(async () => {
    await seedLoggedIn("default");
  });

  it("200 under --fail → body to stdout, exit 0", async () => {
    installFetch(() => jsonResponse(200, { ok: true }));
    const { io, stdout, stderr, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p", fail: true }, io);
    expect(exitCode.value).toBe(0);
    expect(stdoutText(stdout)).toContain("ok");
    expect(stdoutText(stderr)).toBe("");
  });

  it("404 under --fail → body to stderr, exit 22", async () => {
    installFetch(() => new Response("not found", { status: 404 }));
    const { io, stdout, stderr, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p", fail: true }, io);
    expect(exitCode.value).toBe(22);
    expect(stdoutText(stderr)).toContain("not found");
    expect(stdoutText(stdout)).toBe("");
  });

  it("500 under --fail → body to stderr, exit 25", async () => {
    installFetch(() => new Response("boom", { status: 500 }));
    const { io, stderr, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p", fail: true }, io);
    expect(exitCode.value).toBe(25);
    expect(stdoutText(stderr)).toContain("boom");
  });

  it("without --fail, non-2xx still goes to stdout with exit 0", async () => {
    installFetch(() => new Response("nope", { status: 404 }));
    const { io, stdout, stderr, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p" }, io);
    expect(exitCode.value).toBe(0);
    expect(stdoutText(stdout)).toContain("nope");
    // 401-specific hint only on 401; 404 should not print it.
    expect(stdoutText(stderr)).toBe("");
  });
});

describe("apiCommand — 401 UX", () => {
  beforeEach(async () => {
    await seedLoggedIn("default");
  });

  it("401 → body on stdout, stderr re-login hint (default)", async () => {
    installFetch(() => new Response("unauthorized", { status: 401 }));
    const { io, stdout, stderr, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p" }, io);
    expect(exitCode.value).toBe(0);
    expect(stdoutText(stdout)).toContain("unauthorized");
    expect(stdoutText(stderr)).toMatch(/appstrate login/);
  });

  it("-s suppresses the 401 hint", async () => {
    installFetch(() => new Response("unauthorized", { status: 401 }));
    const { io, stderr } = makeIO();
    await runCommand({ method: "GET", path: "/p", silent: true }, io);
    expect(stdoutText(stderr)).toBe("");
  });
});

describe("apiCommand — redirect + TLS flags", () => {
  beforeEach(async () => {
    await seedLoggedIn("default");
    installFetch(() => jsonResponse(200, {}));
  });

  it("default: redirect: 'manual'", async () => {
    const { io } = makeIO();
    await runCommand({ method: "GET", path: "/p" }, io);
    expect(fetchCalls[0]!.init.redirect).toBe("manual");
  });

  it("-L sets redirect: 'follow'", async () => {
    const { io } = makeIO();
    await runCommand({ method: "GET", path: "/p", location: true }, io);
    expect(fetchCalls[0]!.init.redirect).toBe("follow");
  });

  it("-k sets NODE_TLS_REJECT_UNAUTHORIZED=0 for the fetch and restores after", async () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    globalThis.fetch = (async (_u: string, _i?: RequestInit) => {
      // Observed only at fetch call time.
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;

    const { io } = makeIO();
    await runCommand({ method: "GET", path: "/p", insecure: true }, io);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    // Restore whatever env we found at the top of the test.
    if (before !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
  });

  it("-k still restores NODE_TLS_REJECT_UNAUTHORIZED when fetch throws", async () => {
    // The cleanup() funnel is supposed to run on every exit path —
    // including network errors. If we leak "0" into the process env on
    // failure, subsequent fetches in the same process would silently
    // skip TLS verification.
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "previous";
    globalThis.fetch = (async () => {
      throw Object.assign(new Error("boom"), { code: "ECONNREFUSED" });
    }) as unknown as typeof fetch;

    const { io, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p", insecure: true }, io);
    expect(exitCode.value).toBe(EXIT_CONNECT);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("previous");

    if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
  });

  it("-k restores NODE_TLS_REJECT_UNAUTHORIZED when the output phase throws synchronously", async () => {
    // Regression guard for the top-level try/finally: if writing to
    // stdout blows up (closed pipe, disk full, …) after fetch resolves,
    // cleanup() must still run or the TLS skip leaks into the rest of
    // the process. This is the scenario a per-phase try/catch can't
    // cover — the explicit `cleanup(); io.exit(…)` path never fires.
    await seedLoggedIn("default");
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "previous";
    installFetch(() => jsonResponse(200, { ok: true }));

    class BrokenPipe extends Error {
      constructor() {
        super("EPIPE");
        this.name = "BrokenPipe";
      }
    }

    const io: ApiCommandIO = {
      stdout: {
        write: () => {
          throw new BrokenPipe();
        },
      },
      stderr: { write: () => {} },
      exit: () => {
        throw new Error("should not reach exit — sync throw must bypass io.exit");
      },
      onSigint: () => {},
    };

    // `-i` triggers the header-write path, which is OUTSIDE any inner
    // try/catch — that's exactly the window a per-phase try/catch
    // cannot cover and the top-level finally must.
    const full: ApiCommandOptions = {
      method: "GET",
      path: "/p",
      header: [],
      form: [],
      query: [],
      insecure: true,
      include: true,
    };

    let caught: unknown;
    try {
      await apiCommand(full, io);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BrokenPipe);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("previous");

    if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
  });
});

describe("apiCommand — missing credentials", () => {
  it("unconfigured profile → exit 1, error on stderr, no fetch", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io, stderr, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p", profile: "missing" }, io);
    expect(exitCode.value).toBe(1);
    expect(stdoutText(stderr)).toMatch(/appstrate login/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("configured profile but no tokens → exit 1", async () => {
    await setProfile("default", {
      instance: "https://app.example.com",
      userId: "u_1",
      email: "a@example.com",
    });
    installFetch(() => jsonResponse(200, {}));
    const { io, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p" }, io);
    expect(exitCode.value).toBe(1);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("apiCommand — proactive refresh smoke", () => {
  it("expired access + valid refresh → rotates before the request", async () => {
    await setProfile("default", {
      instance: "https://app.example.com",
      userId: "u_1",
      email: "a@example.com",
    });
    await saveTokens("default", {
      accessToken: "old-access",
      expiresAt: Date.now() - 1000, // expired
      refreshToken: "valid-refresh",
      refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });

    installFetch((call) => {
      if (call.url.endsWith("/api/auth/cli/token")) {
        return jsonResponse(200, {
          access_token: "rotated",
          refresh_token: "rotated-refresh",
          token_type: "Bearer",
          expires_in: 900,
          refresh_expires_in: 2_592_000,
          scope: "",
        });
      }
      return jsonResponse(200, { ok: true });
    });

    const { io, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/api/data" }, io);
    expect(exitCode.value).toBe(0);
    // Rotate came first, then the real request with the fresh bearer.
    expect(fetchCalls[0]!.url).toBe("https://app.example.com/api/auth/cli/token");
    expect(fetchCalls[1]!.url).toBe("https://app.example.com/api/data");
    expect(fetchCalls[1]!.headers.Authorization).toBe("Bearer rotated");
  });
});

describe("http-classify — network error → curl exit code", () => {
  it("ENOTFOUND → 6", () => {
    expect(classifyNetworkError(Object.assign(new Error("x"), { code: "ENOTFOUND" }))).toBe(
      EXIT_DNS,
    );
  });
  it("ECONNREFUSED → 7", () => {
    expect(classifyNetworkError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(
      EXIT_CONNECT,
    );
  });
  it("AbortError with TimeoutError cause → 28", () => {
    const err = Object.assign(new Error("Abort"), { name: "TimeoutError" });
    expect(classifyNetworkError(err)).toBe(EXIT_TIMEOUT);
  });
  it("nested cause chain is walked", () => {
    const inner = Object.assign(new Error("dns"), { code: "ENOTFOUND" });
    const outer = Object.assign(new Error("fetch failed"), { cause: inner });
    expect(classifyNetworkError(outer)).toBe(EXIT_DNS);
  });
  it("self-signed → 35 via text fallback", () => {
    expect(classifyNetworkError(new Error("unable to verify the first certificate"))).toBe(
      EXIT_TLS,
    );
  });
  it("unknown error → 1", () => {
    expect(classifyNetworkError(new Error("mystery"))).toBe(1);
  });
});

describe("apiCommand — network errors map to curl exit codes", () => {
  beforeEach(async () => {
    await seedLoggedIn("default");
  });

  it("DNS failure → exit 6", async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    }) as unknown as typeof fetch;
    const { io, stderr, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p" }, io);
    expect(exitCode.value).toBe(6);
    expect(stdoutText(stderr)).toMatch(/resolve/i);
  });

  it("--max-time abort → exit 28", async () => {
    // Install a fetch that never resolves; --max-time triggers abort.
    globalThis.fetch = ((_u: string, init?: RequestInit): Promise<Response> =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const reason = (init.signal as AbortSignal & { reason?: unknown }).reason;
          reject(
            reason instanceof Error
              ? Object.assign(new Error("aborted"), { name: "AbortError", cause: reason })
              : Object.assign(new Error("aborted"), { name: "AbortError" }),
          );
        });
      })) as unknown as typeof fetch;

    const { io, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p", maxTime: 0.05 }, io);
    expect(exitCode.value).toBe(28);
  });
});

// ─── P1 — Curl parity: method inference + absolute URL validation ─

describe("apiCommand — method inference (no explicit method)", () => {
  beforeEach(async () => {
    await seedLoggedIn("default");
  });

  it("no method + no body → GET", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io, exitCode } = makeIO();
    await runCommand({ path: "/p" }, io);
    expect(exitCode.value).toBe(0);
    expect(fetchCalls[0]!.method).toBe("GET");
  });

  it("no method + -d body → POST (curl default)", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io } = makeIO();
    await runCommand({ path: "/p", data: "hello" }, io);
    expect(fetchCalls[0]!.method).toBe("POST");
  });

  it("explicit positional method wins over body inference", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io } = makeIO();
    await runCommand({ method: "PUT", path: "/p", data: "hello" }, io);
    expect(fetchCalls[0]!.method).toBe("PUT");
  });

  it("-X overrides positional method", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io } = makeIO();
    await runCommand({ method: "GET", path: "/p", request: "patch" }, io);
    expect(fetchCalls[0]!.method).toBe("PATCH");
  });

  it("-I forces HEAD regardless of -X/positional", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io } = makeIO();
    await runCommand({ method: "GET", path: "/p", head: true, request: "POST" }, io);
    expect(fetchCalls[0]!.method).toBe("HEAD");
  });
});

describe("apiCommand — absolute URL / host validation", () => {
  beforeEach(async () => {
    await seedLoggedIn("default");
  });

  it("accepts absolute URL matching the profile's origin", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "https://app.example.com/api/foo" }, io);
    expect(exitCode.value).toBe(0);
    expect(fetchCalls[0]!.url).toBe("https://app.example.com/api/foo");
    expect(fetchCalls[0]!.headers.Authorization).toBe("Bearer access-1");
  });

  it("rejects absolute URL with a different host (exit 2, no fetch)", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io, stderr, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "https://evil.example.org/api/foo" }, io);
    expect(exitCode.value).toBe(2);
    expect(fetchCalls).toHaveLength(0);
    expect(stdoutText(stderr)).toContain("refusing to send bearer");
    expect(stdoutText(stderr)).toContain("https://app.example.com");
    expect(stdoutText(stderr)).toContain("https://evil.example.org");
  });

  it("rejects same host but different port (port is part of origin)", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "https://app.example.com:8443/x" }, io);
    expect(exitCode.value).toBe(2);
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects same origin but different scheme (http vs https)", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "http://app.example.com/x" }, io);
    expect(exitCode.value).toBe(2);
  });

  it("relative path continues to work (regression guard)", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/api/foo" }, io);
    expect(exitCode.value).toBe(0);
    expect(fetchCalls[0]!.url).toBe("https://app.example.com/api/foo");
  });
});

describe("apiCommand — silent / show-error semantics", () => {
  beforeEach(async () => {
    await seedLoggedIn("default");
  });

  it("-s alone suppresses network error message on stderr", async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error("nope"), { code: "ECONNREFUSED" });
    }) as unknown as typeof fetch;
    const { io, stderr, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p", silent: true }, io);
    expect(exitCode.value).toBe(EXIT_CONNECT);
    expect(stderr).toHaveLength(0);
  });

  it("-sS restores error message while keeping exit code", async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error("nope"), { code: "ECONNREFUSED" });
    }) as unknown as typeof fetch;
    const { io, stderr, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p", silent: true, showError: true }, io);
    expect(exitCode.value).toBe(EXIT_CONNECT);
    expect(stdoutText(stderr)).toContain("Could not connect");
  });

  it("no-flag (default) writes error message to stderr", async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error("nope"), { code: "ECONNREFUSED" });
    }) as unknown as typeof fetch;
    const { io, stderr, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p" }, io);
    expect(exitCode.value).toBe(EXIT_CONNECT);
    expect(stdoutText(stderr)).toContain("Could not connect");
  });

  it("-s silences host-mismatch error too (usage error is still an error)", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io, stderr, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "https://evil.example.org/x", silent: true }, io);
    expect(exitCode.value).toBe(2);
    expect(stderr).toHaveLength(0);
  });

  it("401 hint is narrower than -s — ignores -S restore", async () => {
    installFetch(() => new Response("no", { status: 401 }));
    const { io, stderr } = makeIO();
    await runCommand({ method: "GET", path: "/p", silent: true, showError: true }, io);
    // -s hides the hint regardless of -S. The hint is a UX prompt,
    // not an error line.
    expect(stderr.filter((b) => stdoutText([b]).includes("Session may be expired"))).toHaveLength(
      0,
    );
  });
});

// ─── P2a — Verbose tracing ──────────────────────────────────────────

describe("apiCommand — -v/--verbose", () => {
  beforeEach(async () => {
    await seedLoggedIn("default", { orgId: "org_42" });
  });

  it("writes request + response trace to stderr with redacted Authorization", async () => {
    installFetch(
      () =>
        new Response("body", {
          status: 200,
          headers: { "Content-Type": "text/plain", "X-Custom": "yes" },
        }),
    );
    const { io, stdout, stderr, exitCode } = makeIO();
    await runCommand({ method: "POST", path: "/api/foo", verbose: true, data: "hello" }, io);
    expect(exitCode.value).toBe(0);
    const trace = stdoutText(stderr);
    expect(trace).toContain("> POST /api/foo HTTP/1.1");
    expect(trace).toContain("> Host: app.example.com");
    expect(trace).toContain("> Authorization: Bearer [REDACTED]");
    expect(trace).toContain("> X-Org-Id: org_42");
    expect(trace).toContain("< HTTP/1.1 200");
    expect(stdoutText(stdout)).toBe("body");
    // Security: raw bearer MUST NOT appear anywhere on stderr
    expect(trace).not.toContain("access-1");
  });

  it("-sv keeps verbose output on stderr (curl behavior)", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io, stderr } = makeIO();
    await runCommand({ method: "GET", path: "/p", silent: true, verbose: true }, io);
    expect(stdoutText(stderr)).toContain("> GET /p HTTP/1.1");
  });

  it("redacts user-supplied Authorization header too", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io, stderr } = makeIO();
    await runCommand(
      {
        method: "GET",
        path: "/p",
        verbose: true,
        header: ["Authorization: Bearer super-secret-override"],
      },
      io,
    );
    const trace = stdoutText(stderr);
    expect(trace).not.toContain("super-secret-override");
    expect(trace).toContain("[REDACTED]");
  });
});

// ─── P2c — -G/--get ────────────────────────────────────────────────

describe("apiCommand — -G/--get", () => {
  beforeEach(async () => {
    await seedLoggedIn("default");
  });

  it("projects -d values into query string and forces GET", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io } = makeIO();
    await runCommand({ path: "/search", get: true, data: "q=foo&sort=date" }, io);
    expect(fetchCalls[0]!.method).toBe("GET");
    expect(fetchCalls[0]!.url).toContain("q=foo");
    expect(fetchCalls[0]!.url).toContain("sort=date");
    expect(fetchCalls[0]!.body).toBeUndefined();
  });

  it("encodes spaces via URL.searchParams", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io } = makeIO();
    await runCommand({ path: "/search", get: true, data: "q=foo bar" }, io);
    expect(fetchCalls[0]!.url).toContain("q=foo+bar");
  });

  it("-G combined with -F exits 2 with error, no fetch", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io, stderr, exitCode } = makeIO();
    await runCommand({ path: "/search", get: true, form: ["file=@x"] }, io);
    expect(exitCode.value).toBe(2);
    expect(fetchCalls).toHaveLength(0);
    expect(stdoutText(stderr)).toContain("cannot combine");
  });

  it("-G -X POST keeps POST but still drops body (curl behavior)", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io } = makeIO();
    await runCommand({ path: "/search", get: true, request: "POST", data: "q=foo" }, io);
    expect(fetchCalls[0]!.method).toBe("POST");
    expect(fetchCalls[0]!.url).toContain("q=foo");
    expect(fetchCalls[0]!.body).toBeUndefined();
  });

  it("merges -G data with existing -q query params", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io } = makeIO();
    await runCommand({ path: "/search", get: true, data: "q=foo", query: ["lang=fr"] }, io);
    expect(fetchCalls[0]!.url).toContain("q=foo");
    expect(fetchCalls[0]!.url).toContain("lang=fr");
  });

  it("-G -d @file reads query string from file", async () => {
    const tmpFile = join(tmpDir, "qs.txt");
    await writeFile(tmpFile, "q=from-file&n=1");
    installFetch(() => jsonResponse(200, {}));
    const { io } = makeIO();
    await runCommand({ path: "/search", get: true, data: `@${tmpFile}` }, io);
    expect(fetchCalls[0]!.url).toContain("q=from-file");
    expect(fetchCalls[0]!.url).toContain("n=1");
  });
});

// ─── P2b — -w/--write-out ───────────────────────────────────────────

describe("apiCommand — -w/--write-out", () => {
  beforeEach(async () => {
    await seedLoggedIn("default");
  });

  it("writes %{http_code} with trailing newline to stdout after body", async () => {
    installFetch(
      () =>
        new Response("hello", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const { io, stdout, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p", writeOut: "%{http_code}\\n" }, io);
    expect(exitCode.value).toBe(0);
    expect(stdoutText(stdout)).toBe("hello200\n");
  });

  it("interpolates %{size_download} and %{url_effective}", async () => {
    installFetch(() => new Response("abcd", { status: 200 }));
    const { io, stdout } = makeIO();
    await runCommand(
      {
        method: "GET",
        path: "/p",
        writeOut: "size=%{size_download} url=%{url_effective}",
      },
      io,
    );
    const out = stdoutText(stdout);
    expect(out).toContain("size=4");
    expect(out).toContain("url=https://app.example.com/p");
  });

  it("%{header_json} returns valid JSON of response headers", async () => {
    installFetch(
      () =>
        new Response("body", {
          status: 200,
          headers: { "X-Custom": "yes", "Content-Type": "text/plain" },
        }),
    );
    const { io, stdout } = makeIO();
    await runCommand({ method: "GET", path: "/p", writeOut: "%{header_json}" }, io);
    const out = stdoutText(stdout);
    const jsonPart = out.slice("body".length);
    const parsed = JSON.parse(jsonPart);
    expect(parsed["x-custom"]).toBe("yes");
    expect(parsed["content-type"]).toBe("text/plain");
  });

  it("%{exitcode} reflects the final exit code (0 on 200)", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io, stdout, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p", writeOut: "[%{exitcode}]" }, io);
    expect(exitCode.value).toBe(0);
    expect(stdoutText(stdout)).toContain("[0]");
  });

  it("%{exitcode} reflects --fail exit code (22 on 4xx)", async () => {
    installFetch(() => new Response("nope", { status: 404 }));
    const { io, stderr, exitCode } = makeIO();
    // body goes to stderr on failure (current appstrate semantics),
    // -w output still goes to stdout.
    await runCommand({ method: "GET", path: "/p", fail: true, writeOut: "[%{exitcode}]" }, io);
    expect(exitCode.value).toBe(22);
    expect(stdoutText(stderr)).toContain("nope");
  });

  it("%{exitcode} on connect failure (no response)", async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error("nope"), { code: "ECONNREFUSED" });
    }) as unknown as typeof fetch;
    const { io, stdout, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p", writeOut: "%{http_code}|%{exitcode}" }, io);
    expect(exitCode.value).toBe(EXIT_CONNECT);
    expect(stdoutText(stdout)).toBe(`0|${EXIT_CONNECT}`);
  });

  it("unknown variable is passed through verbatim", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io, stdout } = makeIO();
    await runCommand({ method: "GET", path: "/p", writeOut: "%{bogus}!" }, io);
    expect(stdoutText(stdout)).toContain("%{bogus}!");
  });

  it("%{time_total} is non-negative and finite", async () => {
    installFetch(
      () => new Promise<Response>((r) => setTimeout(() => r(jsonResponse(200, {})), 20)),
    );
    const { io, stdout } = makeIO();
    await runCommand({ method: "GET", path: "/p", writeOut: "t=%{time_total}" }, io);
    const out = stdoutText(stdout);
    const match = out.match(/t=([\d.]+)/);
    expect(match).not.toBeNull();
    const t = parseFloat(match![1]!);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(t)).toBe(true);
  });
});

// ─── P2e — -T/--upload-file ─────────────────────────────────────────

describe("apiCommand — -T/--upload-file", () => {
  beforeEach(async () => {
    await seedLoggedIn("default");
  });

  it("infers PUT when -T is set and no method/-X is given", async () => {
    const tmpFile = join(tmpDir, "payload.bin");
    await writeFile(tmpFile, "uploaded-bytes");
    installFetch(() => jsonResponse(200, {}));
    const { io } = makeIO();
    await runCommand({ path: "/files", uploadFile: tmpFile }, io);
    expect(fetchCalls[0]!.method).toBe("PUT");
    expect(fetchCalls[0]!.body).toBeDefined();
  });

  it("-X POST overrides the PUT default", async () => {
    const tmpFile = join(tmpDir, "payload.bin");
    await writeFile(tmpFile, "x");
    installFetch(() => jsonResponse(200, {}));
    const { io } = makeIO();
    await runCommand({ path: "/files", uploadFile: tmpFile, request: "POST" }, io);
    expect(fetchCalls[0]!.method).toBe("POST");
  });

  it("-T combined with -d exits 2, no fetch", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io, exitCode, stderr } = makeIO();
    await runCommand({ path: "/files", uploadFile: "/x", data: "y" }, io);
    expect(exitCode.value).toBe(2);
    expect(fetchCalls).toHaveLength(0);
    expect(stdoutText(stderr)).toContain("cannot combine -T");
  });

  it("-T combined with -F exits 2", async () => {
    installFetch(() => jsonResponse(200, {}));
    const { io, exitCode } = makeIO();
    await runCommand({ path: "/files", uploadFile: "/x", form: ["a=b"] }, io);
    expect(exitCode.value).toBe(2);
  });
});

// ─── P2d — --connect-timeout ────────────────────────────────────────

describe("apiCommand — --connect-timeout", () => {
  beforeEach(async () => {
    await seedLoggedIn("default");
  });

  it("aborts with exit 28 when fetch() doesn't resolve in time", async () => {
    // Pending forever until signal fires
    globalThis.fetch = ((_u: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(
            init.signal!.reason instanceof Error
              ? init.signal!.reason
              : Object.assign(new Error("aborted"), { name: "AbortError" }),
          );
        });
      })) as unknown as typeof fetch;
    const { io, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p", connectTimeout: 0.05 }, io);
    expect(exitCode.value).toBe(28);
  });

  it("doesn't fire once fetch resolves (body streaming ignores it)", async () => {
    // fetch resolves quickly; body streams forever. Connect timeout
    // cleared on fetch resolve, so only --max-time would apply.
    installFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(c) {
              c.enqueue(new TextEncoder().encode("hi"));
              await new Promise((r) => setTimeout(r, 20));
              c.close();
            },
          }),
        ),
    );
    const { io, exitCode } = makeIO();
    await runCommand({ method: "GET", path: "/p", connectTimeout: 0.01 }, io);
    // Short connect-timeout should have been cleared before it
    // could fire, so we get a clean success.
    expect(exitCode.value).toBe(0);
  });
});
