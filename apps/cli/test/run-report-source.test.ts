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
import {
  ReportStartError,
  startReportSession,
  type ReportSession,
  type ReportSource,
} from "../src/commands/run/report.ts";
import { announceLaunch } from "../src/commands/run/launch-warnings.ts";
import type { Bundle } from "@appstrate/afps-runtime/bundle";

const REPORT_CTX = {
  instance: "https://app.example.com",
  bearerToken: "ask_test",
  spaceId: "spc_1",
  orgId: "org_1",
};

const SNAPSHOT = {
  os: "darwin arm64",
  cliVersion: "0.0.0-test",
  bundle: { name: "@scope/agent", version: "1.0.0" },
};

const SUCCESS_BODY = {
  id: "run_test_1234567890",
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

// #1830: a non-required integration with nothing to bind starts the run and
// comes back as a warning; a refused registration reads as its items.
describe("startReportSession — integration readiness", () => {
  const SOURCE: ReportSource = { kind: "inline", bundle: makeBundle() };
  const WARNING = {
    field: "integrations.@appstrate/gmail",
    code: "not_connected" as const,
    message: "Integration '@appstrate/gmail' is not connected",
  };
  let stub: ReturnType<typeof installStubFetch>;

  afterEach(() => stub.restore());

  it("returns the registration's warnings", async () => {
    stub = installStubFetch(() => ok({ ...SUCCESS_BODY, warnings: [WARNING] }));
    const session = await startReportSession(
      SOURCE,
      REPORT_CTX,
      { mode: "true", fallback: "abort" },
      SNAPSHOT,
    );
    expect(session.warnings).toEqual([WARNING]);
  });

  /** What `appstrate run --report` prints for this session, per stream. */
  function announce(session: ReportSession | null, json: boolean) {
    const out = { stdout: "", stderr: "" };
    announceLaunch({
      type: "appstrate.report.started",
      json,
      bundleLabel: "@scope/agent@1.0.0",
      instance: REPORT_CTX.instance,
      run: session,
      writeStdout: (chunk) => (out.stdout += chunk),
      writeStderr: (chunk) => (out.stderr += chunk),
    });
    return out;
  }

  const session = () =>
    startReportSession(SOURCE, REPORT_CTX, { mode: "true", fallback: "abort" }, SNAPSHOT);

  it("announces the run with its warnings under --json", async () => {
    stub = installStubFetch(() => ok({ ...SUCCESS_BODY, warnings: [WARNING] }));
    const out = announce(await session(), true);
    expect(out.stderr).toBe("");
    expect(out.stdout.endsWith("\n")).toBe(true);
    expect(JSON.parse(out.stdout)).toEqual({
      type: "appstrate.report.started",
      runId: SUCCESS_BODY.id,
      instance: REPORT_CTX.instance,
      warnings: [WARNING],
    });
  });

  it("announces the run without a warnings key when there are none", async () => {
    stub = installStubFetch(() => ok());
    const out = announce(await session(), true);
    expect(JSON.parse(out.stdout)).toEqual({
      type: "appstrate.report.started",
      runId: SUCCESS_BODY.id,
      instance: REPORT_CTX.instance,
    });
  });

  it("prints one ⚠ line per warning after the preamble in human mode", async () => {
    stub = installStubFetch(() => ok({ ...SUCCESS_BODY, warnings: [WARNING] }));
    const out = announce(await session(), false);
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe(
      `→ running @scope/agent@1.0.0 (reporting to ${REPORT_CTX.instance} as ${SUCCESS_BODY.id})\n` +
        "⚠ @appstrate/gmail: Integration '@appstrate/gmail' is not connected (not_connected)\n",
    );
  });

  it("names the layer that chose no connection, and drops items outside the warning contract", async () => {
    const chosenNone = {
      field: "integrations.@appstrate/notion",
      code: "integration_unbound" as const,
      source: "member_pin" as const,
      message: "Integration '@appstrate/notion' is bound to no connection by your pin",
    };
    const stray = [
      { field: "integrations.@appstrate/slack", code: "something_else", message: "x" },
      { field: "integrations.@appstrate/slack", code: "not_connected", source: "nowhere" },
      { code: "not_connected", message: "no field" },
      "not an item",
    ];
    stub = installStubFetch(() =>
      ok({ ...SUCCESS_BODY, warnings: [WARNING, chosenNone, ...stray] }),
    );
    const live = await session();
    expect(live.warnings).toEqual([WARNING, chosenNone]);
    expect(announce(live, false).stderr).toContain(
      "⚠ @appstrate/notion: Integration '@appstrate/notion' is bound to no connection by your pin (integration_unbound via member_pin)\n",
    );
  });

  it("announces nothing on stdout for an unreported local run under --json", () => {
    stub = installStubFetch(() => ok());
    expect(announce(null, true)).toEqual({ stdout: "", stderr: "" });
    expect(announce(null, false).stderr).toBe("→ running @scope/agent@1.0.0\n");
  });

  it("summarises a 409 missing_integration_connection by item", async () => {
    stub = installStubFetch(
      () =>
        new Response(
          JSON.stringify({
            status: 409,
            code: "missing_integration_connection",
            errors: [
              { ...WARNING, code: "required_integration_unbound" },
              { field: "integrations.@appstrate/clickup", code: "must_choose_connection" },
            ],
          }),
          { status: 409, headers: { "Content-Type": "application/problem+json" } },
        ),
    );
    const err = await startReportSession(
      SOURCE,
      REPORT_CTX,
      { mode: "true", fallback: "abort" },
      SNAPSHOT,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReportStartError);
    expect((err as ReportStartError).responseSnippet).toBe(
      "@appstrate/gmail: Integration '@appstrate/gmail' is not connected (required_integration_unbound)" +
        "\n    @appstrate/clickup: must_choose_connection (must_choose_connection)",
    );
  });

  it("summarises a refusal body longer than the raw-display cut", async () => {
    const body = JSON.stringify({
      type: "https://docs.appstrate.dev/errors/missing-integration-connection",
      title: "Missing integration connection",
      status: 409,
      detail: "The run cannot start: 2 integrations have no usable connection.",
      instance: "/api/runs/remote",
      code: "missing_integration_connection",
      request_id: "req_0123456789abcdef0123456789abcdef",
      errors: [
        {
          field: "integrations.@appstrate/gmail",
          code: "required_integration_unbound",
          message: "Integration '@appstrate/gmail' is required and bound to no connection",
          auth_key: "oauth",
          required_scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          connect_url: "https://app.example.com/connect/cnx_offer_0123456789abcdef0123456789",
        },
        {
          field: "integrations.@appstrate/clickup",
          code: "must_choose_connection",
          message: "Integration '@appstrate/clickup' has 2 usable connections; choose one",
        },
      ],
    });
    expect(body.length).toBeGreaterThan(512);
    stub = installStubFetch(
      () =>
        new Response(body, {
          status: 409,
          headers: { "Content-Type": "application/problem+json" },
        }),
    );
    const err = await session().catch((e: unknown) => e);
    expect((err as ReportStartError).responseSnippet).toBe(
      "@appstrate/gmail: Integration '@appstrate/gmail' is required and bound to no connection (required_integration_unbound)" +
        "\n    @appstrate/clickup: Integration '@appstrate/clickup' has 2 usable connections; choose one (must_choose_connection)",
    );
  });

  it("cuts a long non-refusal body for raw display", async () => {
    stub = installStubFetch(() => new Response("x".repeat(600), { status: 500 }));
    const err = await session().catch((e: unknown) => e);
    expect((err as ReportStartError).responseSnippet).toBe(`${"x".repeat(512)}…`);
  });
});
