// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Built-in conformance cases. Each case is self-contained: it builds
 * its own fixtures, calls the adapter, and returns a structured
 * pass/fail result. Cases MUST NOT reach into implementation
 * internals — they only touch the {@link ConformanceAdapter} surface.
 */

import { zipSync } from "fflate";
import {
  integrationManifestSchema,
  mcpServerManifestSchema,
  metaSchema,
  agentManifestSchema,
} from "@afps-spec/schema";
import {
  canonicalBundleDigest,
  generateKeyPair,
  signBundle,
  signChildKey,
  type TrustRoot,
} from "../bundle/signing.ts";
import type { Bundle } from "../bundle/types.ts";
import type { RunEvent } from "@afps-spec/types";
import type { ConformanceAdapter } from "./adapter.ts";

function rootManifestOf(bundle: Bundle): Record<string, unknown> {
  const rootPkg = bundle.packages.get(bundle.root);
  if (!rootPkg) throw new Error(`bundle root ${bundle.root} not present in packages map`);
  return rootPkg.manifest as Record<string, unknown>;
}

function rootPromptOf(bundle: Bundle): string {
  const rootPkg = bundle.packages.get(bundle.root);
  const bytes = rootPkg?.files.get("prompt.md");
  return bytes ? new TextDecoder().decode(bytes) : "";
}

export type ConformanceLevel = "L1" | "L2" | "L3" | "L4";

export interface CaseResult {
  status: "pass" | "fail" | "skipped";
  detail?: string;
}

export interface ConformanceCase {
  id: string;
  level: ConformanceLevel;
  title: string;
  run: (adapter: ConformanceAdapter) => Promise<CaseResult> | CaseResult;
}

// ─── shared fixtures ──────────────────────────────────────────────

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const REFERENCE_MANIFEST = {
  name: "@afps/conformance-ref",
  version: "1.0.0",
  type: "agent",
  schema_version: "2.0",
  display_name: "Conformance Reference Agent",
  author: "AFPS",
};

function buildReferenceBundle(prompt = "Hello {{input.name}}."): Uint8Array {
  return zipSync({
    "manifest.json": enc(JSON.stringify(REFERENCE_MANIFEST)),
    "prompt.md": enc(prompt),
  });
}

function pass(): CaseResult {
  return { status: "pass" };
}
function fail(detail: string): CaseResult {
  return { status: "fail", detail };
}
function skipped(detail: string): CaseResult {
  return { status: "skipped", detail };
}

function expectThrow(fn: () => unknown, matcher: RegExp | null, label: string): CaseResult {
  try {
    fn();
    return fail(`${label}: expected throw, got success`);
  } catch (err) {
    if (matcher) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!matcher.test(msg)) {
        return fail(`${label}: threw with wrong message: ${msg}`);
      }
    }
    return pass();
  }
}

// ─── L1 — Loader ──────────────────────────────────────────────────

const L1_LOAD_MINIMAL: ConformanceCase = {
  id: "L1.1",
  level: "L1",
  title: "loads a well-formed agent bundle",
  run: (adapter) => {
    const bundle = adapter.loadBundle(buildReferenceBundle());
    const manifest = rootManifestOf(bundle);
    if (manifest["name"] !== REFERENCE_MANIFEST.name) {
      return fail(`manifest.name mismatch: ${String(manifest["name"])}`);
    }
    const prompt = rootPromptOf(bundle);
    if (prompt.length === 0) {
      return fail("prompt must be a non-empty string");
    }
    return pass();
  },
};

const L1_REJECT_NON_ZIP: ConformanceCase = {
  id: "L1.2",
  level: "L1",
  title: "rejects a non-ZIP buffer",
  run: (adapter) =>
    expectThrow(() => adapter.loadBundle(enc("not a zip")), null, "loadBundle(non-ZIP)"),
};

const L1_REJECT_MISSING_MANIFEST: ConformanceCase = {
  id: "L1.3",
  level: "L1",
  title: "rejects a bundle missing manifest.json",
  run: (adapter) => {
    const bytes = zipSync({ "prompt.md": enc("p") });
    return expectThrow(() => adapter.loadBundle(bytes), /manifest/i, "missing manifest.json");
  },
};

const L1_REJECT_MISSING_PROMPT: ConformanceCase = {
  id: "L1.4",
  level: "L1",
  title: "rejects a bundle missing prompt.md",
  run: (adapter) => {
    const bytes = zipSync({ "manifest.json": enc(JSON.stringify(REFERENCE_MANIFEST)) });
    return expectThrow(() => adapter.loadBundle(bytes), /prompt/i, "missing prompt.md");
  },
};

const L1_STRIP_WRAPPER: ConformanceCase = {
  id: "L1.5",
  level: "L1",
  title: "strips a single wrapper folder transparently",
  run: (adapter) => {
    const bytes = zipSync({
      "wrap/manifest.json": enc(JSON.stringify(REFERENCE_MANIFEST)),
      "wrap/prompt.md": enc("inside wrap"),
    });
    const bundle = adapter.loadBundle(bytes);
    const prompt = rootPromptOf(bundle);
    if (prompt !== "inside wrap") {
      return fail(`wrapper not stripped: prompt=${prompt}`);
    }
    return pass();
  },
};

// ─── L2 — Render ─────────────────────────────────────────────────

const L2_INTERPOLATION: ConformanceCase = {
  id: "L2.1",
  level: "L2",
  title: "renders {{input.*}} interpolations",
  run: async (adapter) => {
    const out = await adapter.renderPrompt(
      "Hello {{input.name}}!",
      { runId: "r", input: { name: "world" } },
      {},
    );
    if (!out.includes("Hello world!")) return fail(`got: ${out}`);
    return pass();
  },
};

const L2_SECTIONS: ConformanceCase = {
  id: "L2.2",
  level: "L2",
  title: "renders {{#memories}}…{{/memories}} sections",
  run: async (adapter) => {
    const out = await adapter.renderPrompt(
      "{{#memories}}- {{content}}\n{{/memories}}",
      { runId: "r", input: {} },
      {
        memories: [
          { content: "one", createdAt: 1 },
          { content: "two", createdAt: 2 },
        ],
      },
    );
    if (!out.includes("- one") || !out.includes("- two")) {
      return fail(`sections not expanded: ${out}`);
    }
    return pass();
  },
};

const L2_INVERTED: ConformanceCase = {
  id: "L2.3",
  level: "L2",
  title: "renders {{^memories}}…{{/memories}} inverted sections on empty",
  run: async (adapter) => {
    const out = await adapter.renderPrompt(
      "{{^memories}}none{{/memories}}",
      { runId: "r", input: {} },
      {},
    );
    if (!out.includes("none")) return fail(`inverted section not rendered: ${out}`);
    return pass();
  },
};

const L2_FUNCTION_SANITIZE: ConformanceCase = {
  id: "L2.4",
  level: "L2",
  title: "strips function-valued context fields",
  run: async (adapter) => {
    const out = await adapter.renderPrompt(
      "evil={{input.evil}}|safe={{input.safe}}",
      { runId: "r", input: { evil: () => "PWNED", safe: "ok" } },
      {},
    );
    if (out.includes("PWNED")) {
      return fail(`function invoked / leaked into output: ${out}`);
    }
    if (!out.includes("safe=ok")) {
      return fail(`sibling field dropped: ${out}`);
    }
    return pass();
  },
};

const L2_RUN_ID: ConformanceCase = {
  id: "L2.5",
  level: "L2",
  title: "exposes runId to the template",
  run: async (adapter) => {
    const out = await adapter.renderPrompt("run={{runId}}", { runId: "run_abc", input: {} }, {});
    if (!out.includes("run=run_abc")) return fail(`runId not interpolated: ${out}`);
    return pass();
  },
};

// ─── L3 — Signing ────────────────────────────────────────────────

const L3_VERIFY_DIRECT: ConformanceCase = {
  id: "L3.1",
  level: "L3",
  title: "verifies a direct-trust Ed25519 signature",
  run: (adapter) => {
    const kp = generateKeyPair();
    const bundleBytes = buildReferenceBundle();
    const loaded = adapter.loadBundle(bundleBytes);
    const canonical = canonicalBundleDigest(loaded);
    const sig = signBundle(canonical, { privateKey: kp.privateKey, keyId: kp.keyId });
    const trust: TrustRoot = { keys: [{ keyId: kp.keyId, publicKey: kp.publicKey }] };
    const r = adapter.verifySignature(canonical, sig, trust);
    if (!r.ok) return fail(`verify failed: ${r.reason}`);
    return pass();
  },
};

const L3_DETECT_TAMPER: ConformanceCase = {
  id: "L3.2",
  level: "L3",
  title: "detects tampering in the canonical digest",
  run: (adapter) => {
    const kp = generateKeyPair();
    const loaded = adapter.loadBundle(buildReferenceBundle());
    const canonical = canonicalBundleDigest(loaded);
    const sig = signBundle(canonical, { privateKey: kp.privateKey, keyId: kp.keyId });
    const tampered = new Uint8Array(canonical);
    tampered[0] = tampered[0]! ^ 0xff;
    const trust: TrustRoot = { keys: [{ keyId: kp.keyId, publicKey: kp.publicKey }] };
    const r = adapter.verifySignature(tampered, sig, trust);
    if (r.ok) return fail("verify accepted tampered bytes");
    if (r.reason !== "signature_invalid") {
      return fail(`unexpected failure reason: ${r.reason}`);
    }
    return pass();
  },
};

const L3_UNKNOWN_KEY: ConformanceCase = {
  id: "L3.3",
  level: "L3",
  title: "rejects a signer absent from the trust root (no chain)",
  run: (adapter) => {
    const signer = generateKeyPair();
    const other = generateKeyPair();
    const loaded = adapter.loadBundle(buildReferenceBundle());
    const canonical = canonicalBundleDigest(loaded);
    const sig = signBundle(canonical, { privateKey: signer.privateKey, keyId: signer.keyId });
    const trust: TrustRoot = { keys: [{ keyId: other.keyId, publicKey: other.publicKey }] };
    const r = adapter.verifySignature(canonical, sig, trust);
    if (r.ok) return fail("verify accepted unknown key");
    if (r.reason !== "chain_missing") {
      return fail(`unexpected reason: ${r.reason}`);
    }
    return pass();
  },
};

const L3_CHAIN_ACCEPTED: ConformanceCase = {
  id: "L3.4",
  level: "L3",
  title: "verifies a one-hop trust chain (root → publisher)",
  run: (adapter) => {
    const root = generateKeyPair();
    const publisher = generateKeyPair();
    const chain = [
      signChildKey({
        childKeyId: publisher.keyId,
        childPublicKey: publisher.publicKey,
        parentPrivateKey: root.privateKey,
        parentKeyId: root.keyId,
      }),
    ];
    const loaded = adapter.loadBundle(buildReferenceBundle());
    const canonical = canonicalBundleDigest(loaded);
    const sig = signBundle(canonical, {
      privateKey: publisher.privateKey,
      keyId: publisher.keyId,
      chain,
    });
    const trust: TrustRoot = { keys: [{ keyId: root.keyId, publicKey: root.publicKey }] };
    const r = adapter.verifySignature(canonical, sig, trust);
    if (!r.ok) return fail(`chain verify failed: ${r.reason}`);
    return pass();
  },
};

const L3_UNTRUSTED_ROOT: ConformanceCase = {
  id: "L3.5",
  level: "L3",
  title: "rejects a chain whose root is not in the trust root",
  run: (adapter) => {
    const foreignRoot = generateKeyPair();
    const publisher = generateKeyPair();
    const rootedElsewhere = generateKeyPair();
    const chain = [
      signChildKey({
        childKeyId: publisher.keyId,
        childPublicKey: publisher.publicKey,
        parentPrivateKey: foreignRoot.privateKey,
        parentKeyId: foreignRoot.keyId,
      }),
    ];
    const loaded = adapter.loadBundle(buildReferenceBundle());
    const canonical = canonicalBundleDigest(loaded);
    const sig = signBundle(canonical, {
      privateKey: publisher.privateKey,
      keyId: publisher.keyId,
      chain,
    });
    const trust: TrustRoot = {
      keys: [{ keyId: rootedElsewhere.keyId, publicKey: rootedElsewhere.publicKey }],
    };
    const r = adapter.verifySignature(canonical, sig, trust);
    if (r.ok) return fail("verify accepted untrusted chain root");
    if (r.reason !== "chain_untrusted") {
      return fail(`unexpected reason: ${r.reason}`);
    }
    return pass();
  },
};

// ─── L4 — Execution (event stream contract) ──────────────────────

function scriptEvent(type: string, extra: Record<string, unknown>): RunEvent {
  return { type, timestamp: 0, runId: "run_L4", ...extra };
}

const SAMPLE_SCRIPT: RunEvent[] = [
  scriptEvent("log.written", { level: "info", message: "starting" }),
  scriptEvent("memory.added", { content: "first" }),
  scriptEvent("memory.added", { content: "second" }),
  scriptEvent("pinned.set", { key: "checkpoint", content: { counter: 1 } }),
  scriptEvent("pinned.set", { key: "checkpoint", content: { counter: 2 } }),
  scriptEvent("output.emitted", { data: { answer: 0, partial: true } }),
  scriptEvent("output.emitted", { data: { answer: 42, partial: false, extra: "done" } }),
];

async function withScript(
  adapter: ConformanceAdapter,
  events: readonly RunEvent[] = SAMPLE_SCRIPT,
): Promise<
  | { skipped: true }
  | { skipped: false; output: Awaited<ReturnType<NonNullable<ConformanceAdapter["runScripted"]>>> }
> {
  if (!adapter.runScripted) return { skipped: true };
  const bundle = adapter.loadBundle(buildReferenceBundle());
  const out = await adapter.runScripted(bundle, { runId: "run_L4", input: {} }, events);
  return { skipped: false, output: out };
}

const L4_ORDERED_EMISSION: ConformanceCase = {
  id: "L4.1",
  level: "L4",
  title: "emits every scripted event in arrival order with a stable runId",
  run: async (adapter) => {
    const res = await withScript(adapter);
    if (res.skipped) return skipped("adapter does not implement runScripted");
    const { emitted } = res.output;
    if (emitted.length !== SAMPLE_SCRIPT.length) {
      return fail(`emitted ${emitted.length} events, expected ${SAMPLE_SCRIPT.length}`);
    }
    const EXPECTED_TYPES = [
      "log.written",
      "memory.added",
      "memory.added",
      "pinned.set",
      "pinned.set",
      "output.emitted",
      "output.emitted",
    ];
    for (let i = 0; i < emitted.length; i++) {
      if (emitted[i]!.type !== EXPECTED_TYPES[i]) {
        return fail(`event ${i} has type ${emitted[i]!.type}, expected ${EXPECTED_TYPES[i]}`);
      }
      if (emitted[i]!.runId !== "run_L4") {
        return fail(`event ${i} has runId ${emitted[i]!.runId}, expected run_L4`);
      }
    }
    return pass();
  },
};

const L4_FINALIZE_EXACTLY_ONCE: ConformanceCase = {
  id: "L4.2",
  level: "L4",
  title: "calls sink.finalize() exactly once per run",
  run: async (adapter) => {
    const res = await withScript(adapter);
    if (res.skipped) return skipped("adapter does not implement runScripted");
    if (res.output.finalizeCalls !== 1) {
      return fail(`finalize called ${res.output.finalizeCalls} times, expected 1`);
    }
    return pass();
  },
};

const L4_REDUCER_SEMANTICS: ConformanceCase = {
  id: "L4.3",
  level: "L4",
  title: "reduces events with canonical semantics",
  run: async (adapter) => {
    const res = await withScript(adapter);
    if (res.skipped) return skipped("adapter does not implement runScripted");
    const r = res.output.result;
    if (r.memories.length !== 2) return fail(`memories=${r.memories.length}, expected 2`);
    if (r.memories[0]!.content !== "first" || r.memories[1]!.content !== "second") {
      return fail("memory order / content mismatch");
    }
    const checkpoint = r.pinned?.checkpoint?.content as { counter?: number } | undefined;
    if (!checkpoint || checkpoint.counter !== 2) {
      return fail(`checkpoint should be last-write-wins, got ${JSON.stringify(checkpoint)}`);
    }
    const out = r.output as { answer?: number; partial?: boolean; extra?: string } | null;
    if (!out || out.answer !== 42 || out.partial !== false || out.extra !== "done") {
      return fail(`output replace-on-emit failed: ${JSON.stringify(out)}`);
    }
    if (r.logs.length !== 1 || r.logs[0]!.message !== "starting") {
      return fail(`log entries malformed: ${JSON.stringify(r.logs)}`);
    }
    return pass();
  },
};

const L4_EMPTY_SCRIPT: ConformanceCase = {
  id: "L4.4",
  level: "L4",
  title: "handles an empty event list without emitting or crashing",
  run: async (adapter) => {
    const res = await withScript(adapter, []);
    if (res.skipped) return skipped("adapter does not implement runScripted");
    if (res.output.emitted.length !== 0) {
      return fail(`emitted ${res.output.emitted.length} events on empty script`);
    }
    if (res.output.finalizeCalls !== 1) {
      return fail(`finalize should still be called once, got ${res.output.finalizeCalls}`);
    }
    const r = res.output.result;
    if (
      r.memories.length !== 0 ||
      r.logs.length !== 0 ||
      r.pinned !== undefined ||
      r.output !== null
    ) {
      return fail(`RunResult should be empty baseline, got ${JSON.stringify(r)}`);
    }
    return pass();
  },
};

// ─── AFPS 2.0.2 manifest-shape cases ─────────────────────────────
//
// These cases exercise the v2.0.2 spec invariants the bundle-load path does
// NOT enforce on its own: manifest validation, dependency walking, and
// `_meta` namespace hygiene. They run validation against the canonical
// `@afps-spec/schema` (v2) directly so the suite stays portable across
// language runtimes (third-party runners get the same pass/fail by
// re-implementing the same validators).
//
// L1.6 — mcp-server identity at the manifest root (§3.4 / §11.2).
//   AFPS 2.0.2 lifted `type`, `name`, and `schema_version` out of the
//   `_meta["dev.afps/mcp-server"]` block onto the root. Accepting the old
//   shape (identity ONLY in `_meta`) would silently break tools that key
//   off the root discriminant.
const L1_MCP_SERVER_ROOT_IDENTITY: ConformanceCase = {
  id: "L1.6",
  level: "L1",
  title: "mcp-server identity lives at the manifest root (AFPS 2.0.2 §3.4)",
  run: () => {
    const goodManifest = {
      manifest_version: "0.3",
      name: "@afps/conformance-mcp",
      version: "1.0.0",
      type: "mcp-server",
      schema_version: "2.0",
      display_name: "Conformance MCP Server",
      server: {
        type: "node",
        entry_point: "main.js",
        mcp_config: { command: "node", args: ["main.js"] },
      },
    };
    const goodResult = mcpServerManifestSchema.safeParse(goodManifest);
    if (!goodResult.success) {
      return fail(
        `v2.0.2 root-identity manifest rejected: ${goodResult.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }

    // Legacy v2.0.0/v2.0.1 shape — identity ONLY in `_meta`. The root is
    // missing `type`/`name`/`schema_version`, so the lifted-shape schema
    // MUST refuse it.
    const legacyManifest = {
      manifest_version: "0.3",
      version: "1.0.0",
      display_name: "Legacy MCP",
      server: {
        type: "node",
        entry_point: "main.js",
        mcp_config: { command: "node", args: ["main.js"] },
      },
      _meta: {
        "dev.afps/mcp-server": {
          name: "@afps/conformance-mcp",
          type: "mcp-server",
          schema_version: "2.0",
        },
      },
    };
    const legacyResult = mcpServerManifestSchema.safeParse(legacyManifest);
    if (legacyResult.success) {
      return fail("legacy _meta-only mcp-server identity must be rejected post-2.0.2");
    }
    return pass();
  },
};

// L1.7 — integration `delivery.http` mutually exclusive with `delivery.env`
// (AFPS §7.6). The proxy injects the credential header on the way out
// (`http`) OR the integration server reads it from env / file (`env`/`files`);
// declaring both on the same auth is contradictory.
const L1_INTEGRATION_MUTUAL_EXCLUSION: ConformanceCase = {
  id: "L1.7",
  level: "L1",
  title: "integration delivery.http excludes delivery.env on the same auth (§7.6)",
  run: () => {
    function manifest(delivery: Record<string, unknown>): Record<string, unknown> {
      return {
        name: "@afps/conformance-integ",
        version: "1.0.0",
        type: "integration",
        schema_version: "2.0",
        display_name: "Conformance Integration",
        source: { kind: "local", server: { name: "@afps/conformance-integ", version: "^1.0.0" } },
        auths: {
          primary: {
            type: "api_key",
            authorized_uris: ["https://api.example.com/**"],
            credentials: {
              schema: { type: "object", properties: { api_key: { type: "string" } } },
            },
            delivery,
          },
        },
      };
    }

    // (a) http alone — valid.
    const httpOnly = integrationManifestSchema.safeParse(
      manifest({
        http: {
          in: "header",
          name: "Authorization",
          prefix: "Bearer ",
          value: "{$credential.api_key}",
        },
      }),
    );
    if (!httpOnly.success) {
      return fail(
        `http-only delivery rejected: ${httpOnly.error.issues.map((i) => i.message).join("; ")}`,
      );
    }

    // (b) env alone — valid.
    const envOnly = integrationManifestSchema.safeParse(
      manifest({ env: { API_KEY: { value: "{$credential.api_key}" } } }),
    );
    if (!envOnly.success) {
      return fail(
        `env-only delivery rejected: ${envOnly.error.issues.map((i) => i.message).join("; ")}`,
      );
    }

    // (c) http + env on the same auth — MUST reject.
    const both = integrationManifestSchema.safeParse(
      manifest({
        http: {
          in: "header",
          name: "Authorization",
          prefix: "Bearer ",
          value: "{$credential.api_key}",
        },
        env: { API_KEY: { value: "{$credential.api_key}" } },
      }),
    );
    if (both.success) {
      return fail("delivery.http + delivery.env on the same auth must be rejected per §7.6");
    }
    return pass();
  },
};

// L1.8 — polymorphic `dependencies` values (§4.1). A dependency entry MAY
// be a bare semver string OR an object carrying per-dep configuration
// (e.g. integrations declare `scopes`/`auth_key`). The agent schema MUST
// accept both shapes.
const L1_POLYMORPHIC_DEPENDENCIES: ConformanceCase = {
  id: "L1.8",
  level: "L1",
  title: "polymorphic dependencies — bare string AND object form (§4.1)",
  run: () => {
    const manifest = {
      name: "@afps/conformance-agent",
      version: "1.0.0",
      type: "agent",
      schema_version: "2.0",
      display_name: "Conformance Agent",
      author: "AFPS",
      dependencies: {
        skills: {
          "@afps/skill-bare": "^1.0.0",
          "@afps/skill-object": { version: "^1.0.0" },
        },
        integrations: {
          "@afps/integration-bare": "^2.0.0",
          "@afps/integration-object": {
            version: "^2.0.0",
            scopes: ["read", "write"],
            auth_key: "primary",
          },
        },
      },
    };
    const result = agentManifestSchema.safeParse(manifest);
    if (!result.success) {
      return fail(
        `polymorphic dependencies rejected: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const parsed = result.data as {
      dependencies?: {
        integrations?: Record<string, unknown>;
      };
    };
    const integrationsDep = parsed.dependencies?.integrations?.["@afps/integration-object"];
    if (!integrationsDep || typeof integrationsDep !== "object") {
      return fail("object-form integration dep dropped during parse");
    }
    const obj = integrationsDep as { version?: string; scopes?: unknown; auth_key?: string };
    if (obj.version !== "^2.0.0" || obj.auth_key !== "primary" || !Array.isArray(obj.scopes)) {
      return fail(`object-form payload not preserved: ${JSON.stringify(obj)}`);
    }
    return pass();
  },
};

// L1.9 — `tools_policy` drives per-tool policy (§7.10). 2.0.2 renamed the
// legacy `tools` map to `tools_policy` to disambiguate from the
// mcp-server's `tools[]` catalog. Manifests using the new key MUST
// validate; the new key is what platform helpers read.
const L1_TOOLS_POLICY: ConformanceCase = {
  id: "L1.9",
  level: "L1",
  title: "tools_policy drives per-tool policy (AFPS 2.0.2 §7.10)",
  run: () => {
    const manifest = {
      name: "@afps/conformance-tp",
      version: "1.0.0",
      type: "integration",
      schema_version: "2.0",
      display_name: "Conformance Integration",
      source: { kind: "local", server: { name: "@afps/conformance-tp", version: "^1.0.0" } },
      auths: {
        primary: {
          type: "oauth2",
          authorized_uris: ["https://api.example.com/**"],
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          scope_catalog: [
            { value: "read", label: "Read" },
            { value: "write", label: "Write" },
          ],
          default_scopes: ["read"],
          delivery: {
            http: {
              in: "header",
              name: "Authorization",
              prefix: "Bearer ",
              value: "{$credential.access_token}",
            },
          },
        },
      },
      tools_policy: {
        list_things: { required_scopes: ["read"] },
        write_thing: { required_scopes: ["write"] },
      },
    };
    const result = integrationManifestSchema.safeParse(manifest);
    if (!result.success) {
      return fail(
        `tools_policy manifest rejected: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const parsed = result.data as { tools_policy?: Record<string, { required_scopes?: string[] }> };
    if (!parsed.tools_policy || !parsed.tools_policy["list_things"]) {
      return fail("tools_policy not preserved on parsed manifest");
    }
    if (
      !Array.isArray(parsed.tools_policy["list_things"]!.required_scopes) ||
      parsed.tools_policy["list_things"]!.required_scopes![0] !== "read"
    ) {
      return fail("tools_policy.required_scopes payload not preserved");
    }
    return pass();
  },
};

// L2.6 — `_meta` reverse-DNS tolerance (§10.1, Appendix B). Vendor
// reverse-DNS keys (`dev.appstrate/…`) MUST validate as a valid record;
// the upstream-MCP reserved prefixes (`mcp.*`, `modelcontextprotocol.*`)
// are NOT carved out by the AFPS schema itself (the spec defers to
// producers and to platform-specific validators).
//
// The conformance test here is positive-only: the AFPS metaSchema MUST
// accept any reverse-DNS-namespaced key. The producer-side rejection of
// the MCP-reserved prefixes lives in Appstrate-specific validation
// (see `@appstrate/core/validation`) and is exercised by Appstrate's
// own integration tests — keeping the reserved-prefix gate out of the
// portable conformance surface avoids forcing third-party runners to
// implement a producer-side rule the spec marks as "MUST NOT" without
// a corresponding consumer-side "MUST reject".
const L2_META_REVERSE_DNS: ConformanceCase = {
  id: "L2.6",
  level: "L2",
  title: "_meta reverse-DNS namespaces validate (AFPS §10.1, Appendix B)",
  run: () => {
    const appstrateMeta = { "dev.appstrate/anything": { foo: "bar" } };
    const vendorMeta = { "com.example.vendor/payload": { kind: "ext" } };
    const afpsMeta = { "dev.afps/hint": { runtime: "bun" } };

    for (const [label, value] of [
      ["dev.appstrate prefix", appstrateMeta],
      ["third-party reverse-DNS", vendorMeta],
      ["dev.afps blessed prefix", afpsMeta],
    ] as const) {
      const result = metaSchema.safeParse(value);
      if (!result.success) {
        return fail(`${label} rejected: ${result.error.issues.map((i) => i.message).join("; ")}`);
      }
    }

    // Non-object payloads are not valid `_meta` values per §10.1 ("each
    // value MUST be a JSON object"). The schema's record-of-record shape
    // refuses them.
    const stringValue = metaSchema.safeParse({ "dev.appstrate/anything": "string" });
    if (stringValue.success) {
      return fail("_meta values must be objects, not bare strings");
    }
    return pass();
  },
};

// L4.5 — `RunEvent` envelope matches `@afps-spec/types`. The conformance
// suite emits a sample RunEvent and asserts the canonical envelope keys
// (`type`/`timestamp`/`runId`) are present and shaped correctly. Type
// alignment is checked structurally so the suite stays runtime-agnostic.
const L4_RUN_EVENT_ENVELOPE: ConformanceCase = {
  id: "L4.5",
  level: "L4",
  title: "RunEvent CloudEvents envelope matches @afps-spec/types",
  run: async (adapter) => {
    const sample: RunEvent = {
      type: "output.emitted",
      timestamp: 1_700_000_000_000,
      runId: "run_envelope",
      data: { answer: 42 },
    };
    if (!adapter.runScripted) return skipped("adapter does not implement runScripted");
    const bundle = adapter.loadBundle(buildReferenceBundle());
    const out = await adapter.runScripted(bundle, { runId: "run_envelope", input: {} }, [sample]);
    if (out.emitted.length !== 1) {
      return fail(`expected 1 emitted event, got ${out.emitted.length}`);
    }
    const emitted = out.emitted[0]!;
    // Envelope keys MUST be present and stable across @afps-spec/types
    // major versions (only the open-payload index signature is allowed
    // to evolve).
    if (typeof emitted.type !== "string" || emitted.type.length === 0) {
      return fail(`event.type missing or not a string: ${String(emitted.type)}`);
    }
    if (typeof emitted.timestamp !== "number" || !Number.isFinite(emitted.timestamp)) {
      return fail(`event.timestamp missing or not a finite number: ${String(emitted.timestamp)}`);
    }
    if (typeof emitted.runId !== "string" || emitted.runId.length === 0) {
      return fail(`event.runId missing or not a string: ${String(emitted.runId)}`);
    }
    if (emitted.runId !== "run_envelope") {
      return fail(`event.runId not propagated: got ${emitted.runId}`);
    }
    // Payload index signature — `data` MUST flow through verbatim.
    const data = emitted["data"] as { answer?: number } | undefined;
    if (!data || data.answer !== 42) {
      return fail(`payload data dropped: ${JSON.stringify(emitted)}`);
    }
    return pass();
  },
};

export const BUILT_IN_CASES: readonly ConformanceCase[] = Object.freeze([
  L1_LOAD_MINIMAL,
  L1_REJECT_NON_ZIP,
  L1_REJECT_MISSING_MANIFEST,
  L1_REJECT_MISSING_PROMPT,
  L1_STRIP_WRAPPER,
  L1_MCP_SERVER_ROOT_IDENTITY,
  L1_INTEGRATION_MUTUAL_EXCLUSION,
  L1_POLYMORPHIC_DEPENDENCIES,
  L1_TOOLS_POLICY,
  L2_INTERPOLATION,
  L2_SECTIONS,
  L2_INVERTED,
  L2_FUNCTION_SANITIZE,
  L2_RUN_ID,
  L2_META_REVERSE_DNS,
  L3_VERIFY_DIRECT,
  L3_DETECT_TAMPER,
  L3_UNKNOWN_KEY,
  L3_CHAIN_ACCEPTED,
  L3_UNTRUSTED_ROOT,
  L4_ORDERED_EMISSION,
  L4_FINALIZE_EXACTLY_ONCE,
  L4_REDUCER_SEMANTICS,
  L4_EMPTY_SCRIPT,
  L4_RUN_EVENT_ENVELOPE,
]);
