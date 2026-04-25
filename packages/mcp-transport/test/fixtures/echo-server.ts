// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal stdio MCP-server fixture — reads newline-delimited JSON-RPC
 * envelopes from stdin, replies on stdout. Used by SubprocessTransport
 * tests; not shipped to production.
 *
 * Behaviour:
 * - `initialize` → returns a fake server-info envelope.
 * - `tools/list` → returns a single `echo` tool.
 * - `tools/call` with `name: "echo"` → echoes the `msg` argument.
 * - `crash` (custom test method) → process.exit(1) immediately.
 * - `flood-stderr` → spam stderr to test the rate limiter.
 * - `unknown method` → JSON-RPC `-32601` MethodNotFound.
 */

const STDIN = process.stdin;
const STDOUT = process.stdout;
STDIN.setEncoding("utf8");

let buffer = "";
STDIN.on("data", (chunk: string) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf("\n");
    if (idx === -1) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.length === 0) continue;
    handleLine(line);
  }
});

interface Req {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

function handleLine(line: string): void {
  let req: Req;
  try {
    req = JSON.parse(line) as Req;
  } catch {
    return;
  }

  if (req.method === "crash") {
    process.exit(1);
  }
  if (req.method === "flood-stderr") {
    for (let i = 0; i < 1000; i += 1) {
      process.stderr.write(`flood line ${i}\n`);
    }
    reply(req.id, { ok: true });
    return;
  }
  if (req.method === "initialize") {
    reply(req.id, {
      protocolVersion: "2025-06-18",
      serverInfo: { name: "echo-server", version: "0.0.0" },
      capabilities: { tools: { listChanged: false } },
    });
    return;
  }
  if (req.method === "notifications/initialized") {
    return;
  }
  if (req.method === "tools/list") {
    reply(req.id, {
      tools: [
        {
          name: "echo",
          description: "echoes input",
          inputSchema: {
            type: "object",
            properties: { msg: { type: "string" } },
            required: ["msg"],
          },
        },
      ],
    });
    return;
  }
  if (req.method === "tools/call") {
    const params = req.params as { name: string; arguments?: { msg?: string } };
    if (params?.name === "echo") {
      reply(req.id, {
        content: [{ type: "text", text: String(params.arguments?.msg ?? "") }],
      });
      return;
    }
    error(req.id, -32601, `tool not found: ${params?.name}`);
    return;
  }
  error(req.id, -32601, `method not found: ${req.method}`);
}

function reply(id: Req["id"], result: unknown): void {
  STDOUT.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function error(id: Req["id"], code: number, message: string): void {
  STDOUT.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
