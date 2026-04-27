// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `startReportSession` body assembly — asserts that the
 * CLI posts the correct discriminated `source` shape to
 * `POST /api/runs/remote` for each `ReportSource` variant.
 *
 * The behavioural contract under test:
 *   - `inline`   → `{ kind: "inline", manifest, prompt }` extracted from
 *                  the bundle bytes.
 *   - `registry` → `{ kind: "registry", packageId, source, spec?, integrity? }`
 *                  with no manifest/prompt — server reads its own copy.
 *   - On a 400 from an old server, the CLI falls back to inline once.
 *
 * Stubs `fetch` for this module via `globalThis.fetch` (the report module
 * doesn't accept a fetchImpl injection — that's a deliberate boundary
 * choice, since the runtime fetch is part of the platform contract).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { startReportSession, type ReportSource } from "../src/commands/run/report.ts";
import type { Bundle } from "@appstrate/afps-runtime/bundle";

const REPORT_CTX = {
  instance: "https://app.example.com",
  bearerToken: "ask_test",
  appId: "app_1",
  orgId: "org_1",
};

const SNAPSHOT = {
  os: "darwin arm64",
  cliVersion: "0.0.0-test",
  bundle: { name: "@scope/agent", version: "1.0.0" },
};

const SUCCESS_BODY = {
  runId: "run_test_1234567890",
  url: "https://app.example.com/api/runs/run_test/events",
  finalizeUrl: "https://app.example.com/api/runs/run_test/events/finalize",
  secret: "ZWZmZWN0aXZlbHkgYW55dGhpbmc=",
  expiresAt: "2099-01-01T00:00:00Z",
};

function makeBundle(): Bundle {
  // Minimal Bundle fixture — only what `extractBundleManifest` /
  // `extractBundlePrompt` read on the inline path. Other code paths in
  // `startReportSession` ignore everything else.
  const manifest = {
    name: "@scope/agent",
    version: "1.0.0",
    type: "agent",
    schemaVersion: "1.0",
    dependencies: { skills: {}, tools: {}, providers: {} },
  };
  const files = new Map<string, Uint8Array>([["prompt.md", new TextEncoder().encode("Hello.")]]);
  const root = "@scope/agent@1.0.0";
  return {
    version: "1.0",
    root,
    integrity: "sha256-test",
    packages: new Map([[root, { identity: root, manifest, files, integrity: "" }]]),
  } as unknown as Bundle;
}

interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
}

function installStubFetch(responder: (call: CapturedCall) => Response): {
  calls: CapturedCall[];
  restore: () => void;
} {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const raw = init?.body ?? "{}";
    const body = JSON.parse(typeof raw === "string" ? raw : "{}") as Record<string, unknown>;
    const call: CapturedCall = { url, body };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function ok(body: Record<string, unknown> = SUCCESS_BODY): Response {
  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

describe("startReportSession — source discrimination", () => {
  let stub: ReturnType<typeof installStubFetch>;

  beforeEach(() => {
    stub = installStubFetch(() => ok());
  });

  afterEach(() => stub.restore());

  it("posts kind: inline with manifest+prompt for path-mode bundles", async () => {
    const reportSource: ReportSource = { kind: "inline", bundle: makeBundle() };
    await startReportSession(
      reportSource,
      REPORT_CTX,
      { mode: "true", fallback: "abort" },
      SNAPSHOT,
    );

    expect(stub.calls).toHaveLength(1);
    const src = (
      stub.calls[0]!.body as { source: { kind: string; manifest?: unknown; prompt?: string } }
    ).source;
    expect(src.kind).toBe("inline");
    expect(src.manifest).toBeDefined();
    expect(src.prompt).toBe("Hello.");
  });

  it("posts kind: registry with packageId+source for id-mode bundles (no manifest leak)", async () => {
    const reportSource: ReportSource = {
      kind: "registry",
      bundle: makeBundle(),
      packageId: "@scope/agent",
      source: "published",
      spec: "1.0.0",
      integrity: "sha256-bundle-hash",
    };
    await startReportSession(
      reportSource,
      REPORT_CTX,
      { mode: "true", fallback: "abort" },
      SNAPSHOT,
    );

    expect(stub.calls).toHaveLength(1);
    const src = (
      stub.calls[0]!.body as {
        source: {
          kind: string;
          packageId: string;
          source: string;
          spec?: string;
          integrity?: string;
          manifest?: unknown;
          prompt?: unknown;
        };
      }
    ).source;
    expect(src.kind).toBe("registry");
    expect(src.packageId).toBe("@scope/agent");
    expect(src.source).toBe("published");
    expect(src.spec).toBe("1.0.0");
    expect(src.integrity).toBe("sha256-bundle-hash");
    // Critical: registry path must NOT leak the bundle's manifest/prompt
    // — that's the whole point of declaring by id.
    expect(src.manifest).toBeUndefined();
    expect(src.prompt).toBeUndefined();
  });

  it("omits spec on draft registry sources", async () => {
    const reportSource: ReportSource = {
      kind: "registry",
      bundle: makeBundle(),
      packageId: "@scope/agent",
      source: "draft",
    };
    await startReportSession(
      reportSource,
      REPORT_CTX,
      { mode: "true", fallback: "abort" },
      SNAPSHOT,
    );

    const src = stub.calls[0]!.body.source as { source: string; spec?: string };
    expect(src.source).toBe("draft");
    expect(src.spec).toBeUndefined();
  });
});

describe("startReportSession — old-server fallback", () => {
  let stub: ReturnType<typeof installStubFetch>;

  afterEach(() => stub.restore());

  it("falls back to inline when an old server rejects kind: registry with 400", async () => {
    let calls = 0;
    stub = installStubFetch((call) => {
      calls++;
      if (calls === 1) {
        const body = (call.body as { source: { kind: string } }).source;
        if (body.kind === "registry") {
          return new Response(
            JSON.stringify({
              code: "invalid_request",
              detail: "Invalid input on field 'source.kind'",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
      }
      return ok();
    });

    const reportSource: ReportSource = {
      kind: "registry",
      bundle: makeBundle(),
      packageId: "@scope/agent",
      source: "published",
      spec: "1.0.0",
    };
    const session = await startReportSession(
      reportSource,
      REPORT_CTX,
      { mode: "true", fallback: "abort" },
      SNAPSHOT,
    );

    expect(session.runId).toBe(SUCCESS_BODY.runId);
    expect(stub.calls).toHaveLength(2);
    // First call was the registry attempt.
    expect((stub.calls[0]!.body as { source: { kind: string } }).source.kind).toBe("registry");
    // Second call retried as inline so the run still gets created.
    const retry = stub.calls[1]!.body as {
      source: { kind: string; manifest?: unknown; prompt?: string };
    };
    expect(retry.source.kind).toBe("inline");
    expect(retry.source.manifest).toBeDefined();
    expect(retry.source.prompt).toBe("Hello.");
  });

  it("does not retry on a 400 that doesn't look like a registry-rejection", async () => {
    stub = installStubFetch(
      () =>
        new Response(
          JSON.stringify({
            code: "rate_limited",
            detail: "Rate limit exceeded",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
    );

    const reportSource: ReportSource = {
      kind: "registry",
      bundle: makeBundle(),
      packageId: "@scope/agent",
      source: "published",
    };
    await expect(
      startReportSession(reportSource, REPORT_CTX, { mode: "true", fallback: "abort" }, SNAPSHOT),
    ).rejects.toMatchObject({ name: "ReportStartError" });

    // Single attempt — no retry because the 400 body didn't match the
    // unknown-discriminator heuristic.
    expect(stub.calls).toHaveLength(1);
  });
});
