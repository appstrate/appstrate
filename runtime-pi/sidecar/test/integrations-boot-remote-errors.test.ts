// SPDX-License-Identifier: Apache-2.0

/**
 * A remote MCP server's failures as the sidecar reports them. The endpoint's path may itself be
 * a capability, and an HTTP error body or a transport message can quote it, so what reaches the
 * boot report, a thrown error, the logs or a tool call's result is built from the origin, the
 * HTTP status and a cause only. Driven through the real Streamable HTTP client, against fake
 * servers behind a stubbed global `fetch` (the egress guard stays on: the injected resolver
 * answers a public address).
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { handlerFetch, modernMcpHandler } from "@appstrate/mcp-transport/testing";
import {
  bootIntegrations,
  connectRemoteHttpIntegration,
  RemoteMcpError,
} from "../integrations-boot.ts";
import { _setLogSinkForTesting } from "../logger.ts";
import { HERMETIC_PROCESS_ADAPTER_ID } from "./helpers/hermetic-process-adapter.ts";

const SECRET = "c4p4b1l1ty-9f3e2d";
const ORIGIN = "https://mcp.example.com";
const SERVER_URL = `${ORIGIN}/${SECRET}/mcp`;
const PUBLIC_IP = "93.184.216.34";

function spec(): IntegrationSpawnSpec {
  return {
    integrationId: "@vendor/remote",
    namespace: "remote",
    sourceKind: "remote",
    manifest: {
      name: "@vendor/remote",
      version: "1.0.0",
      server: { url: SERVER_URL, transport: "streamable-http" },
    },
    toolAllowlist: ["echo"],
  } as unknown as IntegrationSpawnSpec;
}

const lines: string[] = [];
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  _setLogSinkForTesting(null);
  lines.length = 0;
});

function captureLogs(): void {
  _setLogSinkForTesting((_level, line) => lines.push(line));
}

function serveWith(answer: (request: Request) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    answer(new Request(String(input), init))) as typeof fetch;
}

const notFound = () =>
  new Response(`Cannot POST /${SECRET}/mcp`, {
    status: 404,
    headers: { "content-type": "text/html" },
  });

async function connectFailure(): Promise<unknown> {
  return await connectRemoteHttpIntegration(spec(), null, {
    resolveHost: async () => [PUBLIC_IP],
    connectDeadlineMs: 300,
  }).then(
    () => null,
    (err: unknown) => err,
  );
}

describe("connectRemoteHttpIntegration — a failing remote MCP server", () => {
  it("reports a 404 by origin and status, without its body", async () => {
    captureLogs();
    serveWith(notFound);
    const err = await connectFailure();
    expect(err).toBeInstanceOf(RemoteMcpError);
    expect((err as RemoteMcpError).message).toBe(
      `remote MCP server ${ORIGIN}: http error (HTTP 404)`,
    );
    expect(String(err)).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("reports a 500 whose body quotes the URL, without its body", async () => {
    captureLogs();
    serveWith(() => new Response(`upstream failed for ${SERVER_URL}`, { status: 500 }));
    const err = await connectFailure();
    expect(err).toBeInstanceOf(RemoteMcpError);
    expect((err as RemoteMcpError).status).toBe(500);
    expect(String(err)).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("reports a refused connection without the transport's message", async () => {
    captureLogs();
    serveWith(() => {
      throw Object.assign(new Error(`Unable to connect to ${SERVER_URL}`), {
        name: "ConnectionRefused",
        code: "ConnectionRefused",
        path: SERVER_URL,
      });
    });
    const err = await connectFailure();
    expect(err).toBeInstanceOf(RemoteMcpError);
    expect(String(err)).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(SECRET);
  });
});

describe("bootIntegrations — a failing remote MCP server", () => {
  async function boot() {
    const previous = process.env.INTEGRATION_RUNTIME_ADAPTER;
    process.env.INTEGRATION_RUNTIME_ADAPTER = HERMETIC_PROCESS_ADAPTER_ID;
    try {
      return await bootIntegrations([spec()], {
        platformApiUrl: "http://platform.local",
        runToken: "run-token",
      });
    } finally {
      if (previous === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
      else process.env.INTEGRATION_RUNTIME_ADAPTER = previous;
    }
  }

  it("keeps the endpoint's path out of the boot report and the logs on a 404", async () => {
    captureLogs();
    serveWith(notFound);
    const result = await boot();
    try {
      expect(result.report.ok).toBe(false);
      expect(result.failed[0]?.error).toContain(`remote MCP server ${ORIGIN}: http error`);
      expect(JSON.stringify(result.report)).not.toContain(SECRET);
      expect(lines.join("\n")).not.toContain(SECRET);
    } finally {
      await result.shutdown();
    }
  });

  it("keeps it out of a tool call failing mid-session", async () => {
    const echo: AppstrateToolDefinition = {
      descriptor: { name: "echo", inputSchema: { type: "object" } },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    const serve = handlerFetch(modernMcpHandler({ tools: [echo] }));
    let broken = false;
    serveWith((request) => (broken ? notFound() : serve(request)));
    captureLogs();
    const result = await boot();
    try {
      expect(result.report.ok).toBe(true);
      const tool = result.tools.find((t) => t.descriptor.name.endsWith("echo"))!;
      broken = true;
      const outcome = await Promise.resolve(tool.handler({}, {} as never)).then(
        (value) => JSON.stringify(value),
        (err: unknown) => String(err),
      );
      expect(outcome).toContain(ORIGIN);
      expect(outcome).not.toContain(SECRET);
      expect(lines.join("\n")).not.toContain(SECRET);
    } finally {
      await result.shutdown();
    }
  });
});
