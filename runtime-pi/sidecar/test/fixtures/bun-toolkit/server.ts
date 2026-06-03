// SPDX-License-Identifier: Apache-2.0

/**
 * Bun Toolkit — reference MCP integration for `server.type: "bun"`.
 *
 * Speaks the MCP JSON-RPC 2.0 stdio dialect directly (one message per line on
 * stdin/stdout), so the bundle ships zero dependencies. The client (the
 * sidecar's integrations-boot MCP client) drives the
 * `initialize` → `tools/list` → `tools/call` cadence.
 *
 * Every tool leans on a Bun-native API on purpose — the whole point is to
 * prove this process runs on the *Bun* runtime, not node (a host subprocess
 * in process mode, the appstrate-mcp-runner-bun container in docker mode):
 *
 *   - kv_*           → `bun:sqlite` in-memory DB (state persists across calls,
 *                       proving a single long-lived subprocess, not stateless)
 *   - hash           → `Bun.CryptoHasher`
 *   - password_*     → `Bun.password` (argon2id / bcrypt)
 *   - uuid           → `crypto.randomUUID`
 *   - system_info    → reports `Bun.version` etc.
 *   - fetch_echo     → GETs https://httpbin.org/anything/<path> (which reflects
 *                       the request back); the sidecar's MITM proxy injects
 *                       `X-Toolkit-Token` so we can report it arrived upstream
 *                       WITHOUT this code ever reading the credential.
 */

import { Database } from "bun:sqlite";

const SERVER_INFO = { name: "appstrate-bun-toolkit", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";

// httpbin reflects the request it received (method, args, headers, …) back as
// JSON. We use it so `fetch_echo` can show the `X-Toolkit-Token` header the
// sidecar's MITM proxy injected — proving end-to-end credential injection from
// a live run, without this server ever reading the secret.
const UPSTREAM_BASE = "https://httpbin.org/anything";
const INJECTED_HEADER = "X-Toolkit-Token";

// ── State: in-memory SQLite, proving a persistent long-lived subprocess ──
const db = new Database(":memory:");
db.run("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

// ─────────────────────────────────────────────
// Tool catalog
// ─────────────────────────────────────────────

const TOOLS = [
  {
    name: "kv_set",
    description: "Store a string value under a key in the in-memory bun:sqlite store.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, value: { type: "string" } },
      required: ["key", "value"],
    },
  },
  {
    name: "kv_get",
    description: "Read the value previously stored under a key (null if absent).",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "kv_list",
    description: "List all keys currently held in the store, with the row count.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hash",
    description: "Hash input text with Bun.CryptoHasher. Returns the hex digest.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string" },
        algorithm: {
          type: "string",
          enum: ["sha256", "sha512", "blake2b256", "md5"],
          default: "sha256",
        },
      },
      required: ["input"],
    },
  },
  {
    name: "password_hash",
    description: "Hash a password with Bun.password (argon2id by default).",
    inputSchema: {
      type: "object",
      properties: {
        password: { type: "string" },
        algorithm: {
          type: "string",
          enum: ["argon2id", "argon2i", "argon2d", "bcrypt"],
          default: "argon2id",
        },
      },
      required: ["password"],
    },
  },
  {
    name: "password_verify",
    description: "Verify a password against a Bun.password hash. Returns { valid }.",
    inputSchema: {
      type: "object",
      properties: { password: { type: "string" }, hash: { type: "string" } },
      required: ["password", "hash"],
    },
  },
  {
    name: "uuid",
    description: "Generate `count` v4 UUIDs via crypto.randomUUID (1-100, default 1).",
    inputSchema: {
      type: "object",
      properties: { count: { type: "integer", minimum: 1, maximum: 100, default: 1 } },
    },
  },
  {
    name: "system_info",
    description: "Report the runtime this server is executing on (Bun version, platform, pid).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fetch_echo",
    description:
      "GET https://httpbin.org/anything/<path>, which reflects the received request back. The sidecar's MITM proxy injects the X-Toolkit-Token credential header on the way out; the result reports whether that header arrived upstream (and its echoed value) — proving credential injection end-to-end without this server ever reading the token.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path segment appended to /anything/." } },
      required: ["path"],
    },
  },
];

// ─────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────

function ok(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fail(message: string) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "kv_set": {
      const key = String(args.key);
      const value = String(args.value);
      db.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?", [
        key,
        value,
        value,
      ]);
      return ok({ stored: true, key });
    }
    case "kv_get": {
      const row = db.query("SELECT value FROM kv WHERE key = ?").get(String(args.key)) as {
        value: string;
      } | null;
      return ok({ key: String(args.key), value: row ? row.value : null });
    }
    case "kv_list": {
      const rows = db.query("SELECT key FROM kv ORDER BY key").all() as Array<{ key: string }>;
      return ok({ keys: rows.map((r) => r.key), count: rows.length });
    }
    case "hash": {
      const algorithm = typeof args.algorithm === "string" ? args.algorithm : "sha256";
      const hasher = new Bun.CryptoHasher(algorithm as "sha256");
      hasher.update(String(args.input));
      return ok({ algorithm, hex: hasher.digest("hex") });
    }
    case "password_hash": {
      const requested = typeof args.algorithm === "string" ? args.algorithm : "argon2id";
      const algorithm: "argon2id" | "argon2i" | "argon2d" | "bcrypt" =
        requested === "bcrypt" ||
        requested === "argon2i" ||
        requested === "argon2d" ||
        requested === "argon2id"
          ? requested
          : "argon2id";
      const hash = await Bun.password.hash(
        String(args.password),
        algorithm === "bcrypt" ? { algorithm: "bcrypt", cost: 10 } : { algorithm },
      );
      return ok({ algorithm, hash });
    }
    case "password_verify": {
      const valid = await Bun.password.verify(String(args.password), String(args.hash));
      return ok({ valid });
    }
    case "uuid": {
      const count = Math.max(1, Math.min(100, Number(args.count ?? 1)));
      return ok({ uuids: Array.from({ length: count }, () => crypto.randomUUID()) });
    }
    case "system_info": {
      return ok({
        runtime: "bun",
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        versions: process.versions,
      });
    }
    case "fetch_echo": {
      const segment = String(args.path ?? "").replace(/^\/+/, "");
      const url = `${UPSTREAM_BASE}/${segment}`;
      const res = await fetch(url, { method: "GET" });
      const text = await res.text();
      // httpbin echoes the received headers under `.headers`. The MITM proxy
      // should have injected X-Toolkit-Token — surface it (case-insensitively)
      // so the injection is verifiable from the response.
      let echoedHeaders: Record<string, string> | undefined;
      try {
        echoedHeaders = (JSON.parse(text) as { headers?: Record<string, string> }).headers;
      } catch {
        echoedHeaders = undefined;
      }
      const injectedValue = echoedHeaders
        ? echoedHeaders[
            Object.keys(echoedHeaders).find(
              (k) => k.toLowerCase() === INJECTED_HEADER.toLowerCase(),
            ) ?? ""
          ]
        : undefined;
      return ok({
        url,
        status: res.status,
        injectedHeaderName: INJECTED_HEADER,
        injectedHeaderSeenUpstream: injectedValue !== undefined,
        injectedHeaderValue: injectedValue,
        echoedHeaders,
      });
    }
    default:
      return fail(`Unknown tool: ${name}`);
  }
}

// ─────────────────────────────────────────────
// JSON-RPC stdio loop
// ─────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

function reply(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;
  const { method } = req;

  if (method === "initialize") {
    reply({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
    return;
  }
  if (method === "tools/list") {
    reply({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    const params = req.params ?? {};
    try {
      const result = await callTool(params.name ?? "", params.arguments ?? {});
      reply({ jsonrpc: "2.0", id, result });
    } catch (e) {
      reply({
        jsonrpc: "2.0",
        id,
        result: fail(`Tool error: ${e instanceof Error ? e.message : String(e)}`),
      });
    }
    return;
  }
  if (method && method.startsWith("notifications/")) {
    // JSON-RPC notifications carry no `id` and expect no response.
    return;
  }
  reply({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

// Serialize line processing so async tool calls never interleave stdout writes.
let chain: Promise<void> = Promise.resolve();
let buffer = "";

process.stderr.write("[bun-toolkit] ready\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch (e) {
      process.stderr.write(`[bun-toolkit] bad json: ${String(e)}\n`);
      continue;
    }
    chain = chain.then(() => handleRequest(req));
  }
});
