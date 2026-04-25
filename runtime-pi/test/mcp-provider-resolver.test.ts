// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the MCP-backed `ProviderResolver` used by container
 * mode. The resolver is the bridge between AFPS's runner-pi factory
 * (the canonical Pi-tool surface for `provider_call`) and the
 * sidecar's MCP `provider_call` tool — every body shape supported by
 * AFPS (`string` / `{ fromFile }` / `{ fromBytes }` / `{ multipart }`)
 * must transit safely.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInProcessPair,
  wrapClient,
  type AppstrateToolDefinition,
} from "@appstrate/mcp-transport";
import type { Bundle, PackageIdentity } from "@appstrate/afps-runtime/bundle";
import { McpProviderResolver } from "../extensions/mcp-provider-resolver.ts";

function makeBundle(): Bundle {
  const identity = "@test/agent@0.0.0" as PackageIdentity;
  return {
    bundleFormatVersion: "1.0",
    root: identity,
    packages: new Map([
      [
        identity,
        {
          identity,
          manifest: {
            name: "@test/agent",
            version: "0.0.0",
            type: "agent",
            dependencies: { providers: { "@test/echo": "^1.0.0" } },
          },
          files: new Map(),
          integrity: "" as never,
        },
      ],
    ]),
    integrity: "" as never,
  } as Bundle;
}

interface Captured {
  arguments?: Record<string, unknown>;
}

async function makeServer(opts: {
  responseBlock?: { type: "text"; text: string };
  isError?: boolean;
}) {
  const captured: Captured = {};
  const tool: AppstrateToolDefinition = {
    descriptor: {
      name: "provider_call",
      description: "mock",
      inputSchema: { type: "object" },
    },
    handler: (async (args: Record<string, unknown>) => {
      captured.arguments = args;
      const block = opts.responseBlock ?? { type: "text", text: '{"ok":true}' };
      return {
        content: [block],
        ...(opts.isError ? { isError: true } : {}),
      };
    }) as never,
  };
  const pair = await createInProcessPair([tool]);
  const mcp = wrapClient(pair.client, { close: () => Promise.resolve() });
  return { pair, mcp, captured };
}

const ctxBase = (workspace: string) => ({
  runId: "run_test",
  toolCallId: "tc_1",
  workspace,
  signal: new AbortController().signal,
  emit: () => {},
});

describe("McpProviderResolver — body forwarding", () => {
  it("forwards a string body verbatim over MCP", async () => {
    const { pair, mcp, captured } = await makeServer({});
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      await tool!.execute(
        {
          method: "POST",
          target: "https://api.example.com/items",
          body: '{"x":1}',
          headers: { "Content-Type": "application/json" },
        },
        ctxBase(workspace),
      );
      expect(captured.arguments).toMatchObject({
        providerId: "@test/echo",
        method: "POST",
        target: "https://api.example.com/items",
        body: '{"x":1}',
        headers: { "Content-Type": "application/json" },
      });
    } finally {
      await pair.close();
    }
  });

  it("resolves { fromFile } against the workspace and ships bytes as base64", async () => {
    const { pair, mcp, captured } = await makeServer({});
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );

      // Non-UTF-8 binary blob — this is the case the legacy mcp-direct
      // path corrupted (string-only body schema → TextEncoder
      // round-trip → mojibake).
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
      writeFileSync(join(workspace, "image.jpg"), bytes);

      await tool!.execute(
        {
          method: "POST",
          target: "https://api.example.com/upload",
          body: { fromFile: "image.jpg" },
        },
        ctxBase(workspace),
      );

      const arg = captured.arguments as { body?: { fromBytes: string; encoding: string } };
      expect(arg.body).toBeDefined();
      expect(arg.body!.encoding).toBe("base64");
      const decoded = Buffer.from(arg.body!.fromBytes, "base64");
      expect(new Uint8Array(decoded)).toEqual(bytes);
    } finally {
      await pair.close();
    }
  });

  it("forwards { fromBytes } directly without re-encoding", async () => {
    const { pair, mcp, captured } = await makeServer({});
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      const inputBytes = new Uint8Array([0xff, 0x01, 0x02, 0x03]);
      const inputBase64 = Buffer.from(inputBytes).toString("base64");

      await tool!.execute(
        {
          method: "POST",
          target: "https://api.example.com/upload",
          body: { fromBytes: inputBase64, encoding: "base64" },
        },
        ctxBase(workspace),
      );

      const arg = captured.arguments as { body?: { fromBytes: string; encoding: string } };
      expect(arg.body!.encoding).toBe("base64");
      expect(Buffer.from(arg.body!.fromBytes, "base64")).toEqual(Buffer.from(inputBytes));
    } finally {
      await pair.close();
    }
  });

  it("resolves { multipart } and surfaces the multipart Content-Type", async () => {
    const { pair, mcp, captured } = await makeServer({});
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      writeFileSync(join(workspace, "doc.txt"), "the body");

      await tool!.execute(
        {
          method: "POST",
          target: "https://api.example.com/upload",
          body: {
            multipart: [
              { name: "title", value: "demo" },
              { name: "file", fromFile: "doc.txt" },
            ],
          },
        },
        ctxBase(workspace),
      );

      const arg = captured.arguments as {
        headers?: Record<string, string>;
        body?: { fromBytes: string; encoding: string };
      };
      expect(arg.headers!["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
      expect(arg.body!.encoding).toBe("base64");
      const decoded = Buffer.from(arg.body!.fromBytes, "base64").toString("utf-8");
      expect(decoded).toContain('name="title"');
      expect(decoded).toContain("demo");
      expect(decoded).toContain('name="file"; filename="doc.txt"');
      expect(decoded).toContain("the body");
    } finally {
      await pair.close();
    }
  });

  it("rejects { fromFile } resolving outside the workspace (path traversal)", async () => {
    const { pair, mcp, captured } = await makeServer({});
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));

      let threw = false;
      try {
        await tool!.execute(
          {
            method: "POST",
            target: "https://api.example.com/upload",
            body: { fromFile: "../../../etc/passwd" },
          },
          ctxBase(workspace),
        );
      } catch {
        threw = true;
      }
      // The contract is: must NOT have made the upstream call.
      expect(captured.arguments).toBeUndefined();
      // AFPS's resolveSafePath throws for paths that escape the
      // workspace — either way the call is gated client-side.
      expect(threw).toBe(true);
    } finally {
      await pair.close();
    }
  });
});

describe("McpProviderResolver — response handling", () => {
  it("maps an MCP text block to a text-kind ProviderCallResponse", async () => {
    const { pair, mcp } = await makeServer({
      responseBlock: { type: "text", text: '{"hello":"world"}' },
    });
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      const result = await tool!.execute(
        { method: "GET", target: "https://api.example.com/items" },
        ctxBase(workspace),
      );
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.status).toBe(200);
      expect(parsed.body.kind).toBe("text");
      expect(parsed.body.text).toBe('{"hello":"world"}');
    } finally {
      await pair.close();
    }
  });

  it("surfaces a 502 with the MCP isError text concatenated", async () => {
    const { pair, mcp } = await makeServer({
      responseBlock: { type: "text", text: "provider_call: upstream rate-limited" },
      isError: true,
    });
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      const result = await tool!.execute(
        { method: "GET", target: "https://api.example.com/items" },
        ctxBase(workspace),
      );
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.status).toBe(502);
      expect(parsed.body.kind).toBe("text");
      expect(parsed.body.text).toContain("upstream rate-limited");
    } finally {
      await pair.close();
    }
  });
});
