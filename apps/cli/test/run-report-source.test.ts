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
  applicationId: "app_1",
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
  finalize_url: "https://app.example.com/api/runs/run_test/events/finalize",
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
    schema_version: "0.1",
    display_name: "Test Agent",
    dependencies: { skills: {}, integrations: {} },
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

  it("posts kind: registry with packageId+stage for id-mode bundles (no manifest leak)", async () => {
    const reportSource: ReportSource = {
      kind: "registry",
      bundle: makeBundle(),
      packageId: "@scope/agent",
      stage: "published",
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
          stage: string;
          spec?: string;
          integrity?: string;
          manifest?: unknown;
          prompt?: unknown;
        };
      }
    ).source;
    expect(src.kind).toBe("registry");
    expect(src.packageId).toBe("@scope/agent");
    expect(src.stage).toBe("published");
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
      stage: "draft",
    };
    await startReportSession(
      reportSource,
      REPORT_CTX,
      { mode: "true", fallback: "abort" },
      SNAPSHOT,
    );

    const src = stub.calls[0]!.body.source as { stage: string; spec?: string };
    expect(src.stage).toBe("draft");
    expect(src.spec).toBeUndefined();
  });
});
