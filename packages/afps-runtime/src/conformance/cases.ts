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
  verifyBundleSignature,
  type BundleSignature,
  type TrustRoot,
} from "../bundle/signing.ts";
import { BundleSignaturePolicyError, verifyBundleWithPolicy } from "../bundle/signature-policy.ts";
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
  schema_version: "0.1",
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

// ─── AFPS manifest-shape cases ─────────────────────────────
//
// These cases exercise the AFPS spec invariants the bundle-load path does
// NOT enforce on its own: manifest validation, dependency walking, and
// `_meta` namespace hygiene. They run validation against the canonical
// `@afps-spec/schema` directly so the suite stays portable across
// language runtimes (third-party runners get the same pass/fail by
// re-implementing the same validators).
//
// L1.6 — mcp-server identity at the manifest root (§3.4 / §11.2).
//   AFPS lifted `type`, `name`, and `schema_version` out of the
//   `_meta["dev.afps/mcp-server"]` block onto the root. Accepting the old
//   shape (identity ONLY in `_meta`) would silently break tools that key
//   off the root discriminant.
const L1_MCP_SERVER_ROOT_IDENTITY: ConformanceCase = {
  id: "L1.6",
  level: "L1",
  title: "mcp-server identity lives at the manifest root (AFPS §3.4)",
  run: () => {
    const goodManifest = {
      manifest_version: "0.3",
      name: "@afps/conformance-mcp",
      version: "1.0.0",
      type: "mcp-server",
      schema_version: "0.1",
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
        `root-identity manifest rejected: ${goodResult.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }

    // Legacy AFPS 1.x shape — identity ONLY in `_meta`. The root is
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
          schema_version: "0.1",
        },
      },
    };
    const legacyResult = mcpServerManifestSchema.safeParse(legacyManifest);
    if (legacyResult.success) {
      return fail("legacy _meta-only mcp-server identity must be rejected");
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
        schema_version: "0.1",
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

// L1.8 — flat `dependencies` maps + `integrations_configuration` (§4.1/§4.4).
// Every dependency value is a bare semver range string; per-integration agent
// configuration (`tools`/`scopes`/`auth_key`) lives in the top-level
// `integrations_configuration` map. The agent schema MUST accept this shape
// and preserve the configuration.
const L1_DEPENDENCIES_AND_CONFIG: ConformanceCase = {
  id: "L1.8",
  level: "L1",
  title: "flat dependencies + integrations_configuration (§4.1/§4.4)",
  run: () => {
    const manifest = {
      name: "@afps/conformance-agent",
      version: "1.0.0",
      type: "agent",
      schema_version: "0.2",
      display_name: "Conformance Agent",
      author: "AFPS",
      dependencies: {
        skills: {
          "@afps/skill-a": "^1.0.0",
          "@afps/skill-b": "~1.2.0",
        },
        integrations: {
          "@afps/integration-bare": "^2.0.0",
          "@afps/integration-configured": "^2.0.0",
        },
      },
      integrations_configuration: {
        "@afps/integration-configured": {
          tools: ["search"],
          scopes: ["read", "write"],
          auth_key: "primary",
        },
      },
    };
    const result = agentManifestSchema.safeParse(manifest);
    if (!result.success) {
      return fail(
        `flat dependencies + integrations_configuration rejected: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const parsed = result.data as {
      integrations_configuration?: Record<string, unknown>;
    };
    const config = parsed.integrations_configuration?.["@afps/integration-configured"];
    if (!config || typeof config !== "object") {
      return fail("integrations_configuration entry dropped during parse");
    }
    const obj = config as { tools?: unknown; scopes?: unknown; auth_key?: string };
    if (obj.auth_key !== "primary" || !Array.isArray(obj.scopes) || !Array.isArray(obj.tools)) {
      return fail(`integrations_configuration payload not preserved: ${JSON.stringify(obj)}`);
    }
    return pass();
  },
};

// L1.9 — `tools_policy` drives per-tool policy (§7.10). AFPS renamed the
// legacy `tools` map to `tools_policy` to disambiguate from the
// mcp-server's `tools[]` catalog. Manifests using the new key MUST
// validate; the new key is what platform helpers read.
const L1_TOOLS_POLICY: ConformanceCase = {
  id: "L1.9",
  level: "L1",
  title: "tools_policy drives per-tool policy (AFPS §7.10)",
  run: () => {
    const manifest = {
      name: "@afps/conformance-tp",
      version: "1.0.0",
      type: "integration",
      schema_version: "0.1",
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
        list_things: { required_scopes: { primary: ["read"] } },
        write_thing: { required_scopes: { primary: ["write"] } },
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
    const parsed = result.data as {
      tools_policy?: Record<string, { required_scopes?: Record<string, string[]> }>;
    };
    if (!parsed.tools_policy || !parsed.tools_policy["list_things"]) {
      return fail("tools_policy not preserved on parsed manifest");
    }
    // `required_scopes` is a per-auth map `{ <auth_key>: scopes[] }`.
    if (parsed.tools_policy["list_things"]!.required_scopes?.["primary"]?.[0] !== "read") {
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

// ─── L1 — §3.3 / §3.4 companion-file invariants ────────────────────
//
// These exercise the runtime bundle loader's companion-file checks (now
// unified with the platform's ZIP-import path via `@appstrate/core/companion-files`):
//
//   - agent     → prompt.md present + non-empty at archive root (§3.2/§3.4)
//   - skill     → SKILL.md present + YAML frontmatter `name` (§3.3)
//   - mcp-server → `server.entry_point` payload present in archive (§3.4)
//
// Each case builds a minimal `.afps` archive with the violation and asserts
// the loader rejects it. The matching positive cases are covered by L1.1 /
// L1.6 (mcp-server) and a positive entry_point case below.
const SKILL_MANIFEST = {
  name: "@afps/conformance-skill",
  version: "1.0.0",
  type: "skill",
  schema_version: "0.1",
};

const MCP_SERVER_MANIFEST = {
  manifest_version: "0.3",
  name: "@afps/conformance-mcp",
  version: "1.0.0",
  type: "mcp-server",
  schema_version: "0.1",
  display_name: "Conformance MCP Server",
  server: {
    type: "node",
    entry_point: "main.js",
    mcp_config: { command: "node", args: ["main.js"] },
  },
};

const L1_SKILL_MISSING_SKILL_MD: ConformanceCase = {
  id: "L1.10",
  level: "L1",
  title: "rejects a skill bundle missing SKILL.md (§3.3)",
  run: (adapter) => {
    const bytes = zipSync({ "manifest.json": enc(JSON.stringify(SKILL_MANIFEST)) });
    return expectThrow(() => adapter.loadBundle(bytes), /SKILL\.md/i, "skill missing SKILL.md");
  },
};

const L1_SKILL_MISSING_FRONTMATTER_NAME: ConformanceCase = {
  id: "L1.11",
  level: "L1",
  title: "rejects a skill bundle whose SKILL.md has no frontmatter name (§3.3)",
  run: (adapter) => {
    const bytes = zipSync({
      "manifest.json": enc(JSON.stringify(SKILL_MANIFEST)),
      // YAML frontmatter present but no `name` key — must reject.
      "SKILL.md": enc("---\ndescription: skill without name\n---\nbody"),
    });
    return expectThrow(
      () => adapter.loadBundle(bytes),
      /name|frontmatter/i,
      "skill missing frontmatter name",
    );
  },
};

const L1_MCP_SERVER_ENTRY_POINT_PRESENT: ConformanceCase = {
  id: "L1.12",
  level: "L1",
  title: "accepts an mcp-server bundle whose server.entry_point file is present (§3.4)",
  run: (adapter) => {
    const bytes = zipSync({
      "manifest.json": enc(JSON.stringify(MCP_SERVER_MANIFEST)),
      "main.js": enc("// server"),
    });
    try {
      const bundle = adapter.loadBundle(bytes);
      const rootPkg = bundle.packages.get(bundle.root);
      if (!rootPkg) return fail("loadBundle returned no root package");
      if (!rootPkg.files.has("main.js")) {
        return fail("loaded bundle missing server.entry_point file");
      }
      return pass();
    } catch (err) {
      return fail(
        `positive mcp-server load rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

const L1_MCP_SERVER_ENTRY_POINT_MISSING: ConformanceCase = {
  id: "L1.13",
  level: "L1",
  title: "rejects an mcp-server bundle whose server.entry_point file is absent (§3.4)",
  run: (adapter) => {
    // entry_point references missing.js, archive contains a stub file at a
    // different path → loader MUST refuse, not defer to spawn-time failure.
    const bytes = zipSync({
      "manifest.json": enc(
        JSON.stringify({
          ...MCP_SERVER_MANIFEST,
          server: { ...MCP_SERVER_MANIFEST.server, entry_point: "missing.js" },
        }),
      ),
      "main.js": enc("// wrong file"),
    });
    return expectThrow(
      () => adapter.loadBundle(bytes),
      /entry_point|missing\.js/i,
      "mcp-server entry_point missing",
    );
  },
};

// ─── L1 — §8.1 archive-processing rejections ───────────────────────
//
// These pin the path-sanitization rules already implemented in
// `archive-utils.sanitizeEntries`. The conformance suite reproduces them so
// third-party runners hit identical pass/fail behaviour.
//
// We construct raw ZIP buffers via fflate and rely on the loader to reject
// the offending entries (either by throwing or by filtering them out so the
// archive looks structurally invalid downstream — both modes count as
// rejection for the purposes of the spec). Where the runtime is fail-closed
// (per `archive-utils.ts` comments) the cases assert a throw; where the
// platform-import path is fail-soft (per `core/zip.ts`) the parity test in
// `packages/core/test/sanitizer-parity.test.ts` handles the dual.
const L1_REJECT_PATH_TRAVERSAL: ConformanceCase = {
  id: "L1.14",
  level: "L1",
  title: "rejects an archive entry containing '..' path traversal (§8.1)",
  run: (adapter) => {
    const bytes = zipSync({
      "manifest.json": enc(JSON.stringify(REFERENCE_MANIFEST)),
      "prompt.md": enc("ok"),
      "../escape.txt": enc("evil"),
    });
    return expectThrow(() => adapter.loadBundle(bytes), /traversal|\.\./, "path traversal entry");
  },
};

const L1_REJECT_ABSOLUTE_PATH: ConformanceCase = {
  id: "L1.15",
  level: "L1",
  title: "rejects an archive entry with an absolute path (§8.1)",
  run: (adapter) => {
    const bytes = zipSync({
      "manifest.json": enc(JSON.stringify(REFERENCE_MANIFEST)),
      "prompt.md": enc("ok"),
      "/etc/passwd": enc("evil"),
    });
    return expectThrow(() => adapter.loadBundle(bytes), /absolute/i, "absolute path entry");
  },
};

const L1_REJECT_BACKSLASH: ConformanceCase = {
  id: "L1.16",
  level: "L1",
  title: "rejects an archive entry containing a backslash (§8.1)",
  run: (adapter) => {
    const bytes = zipSync({
      "manifest.json": enc(JSON.stringify(REFERENCE_MANIFEST)),
      "prompt.md": enc("ok"),
      "win\\path.txt": enc("evil"),
    });
    return expectThrow(() => adapter.loadBundle(bytes), /backslash/i, "backslash entry");
  },
};

const L1_REJECT_NULL_BYTE: ConformanceCase = {
  id: "L1.17",
  level: "L1",
  title: "rejects an archive entry containing a null byte (§8.1)",
  run: (adapter) => {
    const bytes = zipSync({
      "manifest.json": enc(JSON.stringify(REFERENCE_MANIFEST)),
      "prompt.md": enc("ok"),
      "evil\0name.txt": enc("evil"),
    });
    return expectThrow(() => adapter.loadBundle(bytes), /null byte/i, "null byte entry");
  },
};

const L1_FILTER_MACOSX: ConformanceCase = {
  id: "L1.18",
  level: "L1",
  title: "ignores __MACOSX/ metadata entries (§8.1)",
  run: (adapter) => {
    // __MACOSX/* is dropped silently — the rest of the archive MUST still
    // load cleanly. We assert load succeeds AND the macOS noise is absent
    // from the loaded package.
    const bytes = zipSync({
      "manifest.json": enc(JSON.stringify(REFERENCE_MANIFEST)),
      "prompt.md": enc("ok"),
      "__MACOSX/._prompt.md": enc("metadata"),
    });
    try {
      const bundle = adapter.loadBundle(bytes);
      const rootPkg = bundle.packages.get(bundle.root);
      if (!rootPkg) return fail("loadBundle returned no root package");
      for (const key of rootPkg.files.keys()) {
        if (key.startsWith("__MACOSX/")) {
          return fail(`__MACOSX entry leaked into bundle: ${key}`);
        }
      }
      return pass();
    } catch (err) {
      return fail(
        `bundle with __MACOSX noise rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

const L1_REJECT_DEEP_PATH: ConformanceCase = {
  id: "L1.19",
  level: "L1",
  title: "rejects archives whose path depth exceeds the cap (§8.1)",
  run: (adapter) => {
    // Path depth 32 — comfortably beyond any reasonable default cap
    // (the runtime defaults to 16). Any conformant loader MUST refuse
    // rather than risk filesystem-side surprises. This is the cheapest
    // way to exercise the decompression-side limits gate without
    // building a true zip-bomb in memory.
    const deep = Array(32).fill("a").join("/") + "/leaf.txt";
    const bytes = zipSync({
      "manifest.json": enc(JSON.stringify(REFERENCE_MANIFEST)),
      "prompt.md": enc("ok"),
      [deep]: enc("evil"),
    });
    return expectThrow(() => adapter.loadBundle(bytes), /depth|limit|exceeds/i, "deep path");
  },
};

// ─── L3 — extended signing coverage ─────────────────────────────────
//
// Covers gaps surfaced by the AFPS audit: alg_unsupported (alg field
// outside the supported vocabulary), chain_invalid (loop detection), and
// `verifyBundleWithPolicy`'s 3-state gate.

const L3_ALG_UNSUPPORTED: ConformanceCase = {
  id: "L3.6",
  level: "L3",
  title: "rejects a signature document with an unsupported algorithm (§3.4)",
  run: (adapter) => {
    const trust: TrustRoot = { keys: [] };
    const doc: BundleSignature = {
      alg: "rsa" as unknown as "ed25519",
      keyId: "k",
      signature: "AAAA",
    };
    const r = adapter.verifySignature(enc("anything"), doc, trust);
    if (r.ok) return fail("verify accepted unsupported alg");
    if (r.reason !== "alg_unsupported") {
      return fail(`unexpected reason: ${r.reason}`);
    }
    return pass();
  },
};

const L3_CHAIN_INVALID_LOOP: ConformanceCase = {
  id: "L3.7",
  level: "L3",
  title: "rejects a trust chain with a loop (chain_invalid, §3.4)",
  run: (adapter) => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    // a ← b ← a — A and B sign each other, terminating in neither root.
    const aSignedByB = signChildKey({
      childKeyId: a.keyId,
      childPublicKey: a.publicKey,
      parentPrivateKey: b.privateKey,
      parentKeyId: b.keyId,
    });
    const bSignedByA = signChildKey({
      childKeyId: b.keyId,
      childPublicKey: b.publicKey,
      parentPrivateKey: a.privateKey,
      parentKeyId: a.keyId,
    });
    const loaded = adapter.loadBundle(buildReferenceBundle());
    const canonical = canonicalBundleDigest(loaded);
    const sig = signBundle(canonical, {
      privateKey: a.privateKey,
      keyId: a.keyId,
      chain: [aSignedByB, bSignedByA],
    });
    // Trust root is irrelevant — loop detection trips before any trust
    // match is attempted.
    const trust: TrustRoot = { keys: [] };
    const r = adapter.verifySignature(canonical, sig, trust);
    if (r.ok) return fail("verify accepted a chain with a loop");
    if (r.reason !== "chain_invalid") {
      // Some implementations may surface this as chain_missing once the
      // loop exhausts the chain — both are acceptable rejections.
      if (r.reason !== "chain_missing") {
        return fail(`unexpected reason: ${r.reason}`);
      }
    }
    return pass();
  },
};

const L3_POLICY_REQUIRED_UNSIGNED: ConformanceCase = {
  id: "L3.8",
  level: "L3",
  title: "verifyBundleWithPolicy 'required' rejects an unsigned bundle (§8.2)",
  run: (adapter) => {
    const loaded = adapter.loadBundle(buildReferenceBundle());
    const trust: TrustRoot = { keys: [] };
    // policy 'off' short-circuits — must not consult trust root.
    const off = verifyBundleWithPolicy(loaded, { policy: "off" });
    if (off.status !== "off") return fail(`policy=off returned status ${off.status}`);

    // policy 'warn' on an unsigned bundle MUST invoke onWarn('unsigned')
    // and NOT throw.
    const warnings: string[] = [];
    const warn = verifyBundleWithPolicy(loaded, {
      policy: "warn",
      trustRoot: trust,
      onWarn: (reason) => warnings.push(reason),
    });
    if (warn.status !== "unsigned-warned") {
      return fail(`policy=warn returned status ${warn.status}`);
    }
    if (warnings.length !== 1 || warnings[0] !== "unsigned") {
      return fail(`policy=warn warnings unexpected: ${JSON.stringify(warnings)}`);
    }

    // policy 'required' on an unsigned bundle MUST throw
    // BundleSignaturePolicyError with code 'unsigned_required'.
    try {
      verifyBundleWithPolicy(loaded, { policy: "required", trustRoot: trust });
      return fail("policy=required accepted an unsigned bundle");
    } catch (err) {
      if (!(err instanceof BundleSignaturePolicyError)) {
        return fail(`policy=required threw wrong class: ${err}`);
      }
      if (err.code !== "unsigned_required") {
        return fail(`policy=required code wrong: ${err.code}`);
      }
    }
    return pass();
  },
};

// Silence unused-import warning when these symbols are not referenced
// elsewhere in the module.
void verifyBundleSignature;

export const BUILT_IN_CASES: readonly ConformanceCase[] = Object.freeze([
  L1_LOAD_MINIMAL,
  L1_REJECT_NON_ZIP,
  L1_REJECT_MISSING_MANIFEST,
  L1_REJECT_MISSING_PROMPT,
  L1_STRIP_WRAPPER,
  L1_MCP_SERVER_ROOT_IDENTITY,
  L1_INTEGRATION_MUTUAL_EXCLUSION,
  L1_DEPENDENCIES_AND_CONFIG,
  L1_TOOLS_POLICY,
  L1_SKILL_MISSING_SKILL_MD,
  L1_SKILL_MISSING_FRONTMATTER_NAME,
  L1_MCP_SERVER_ENTRY_POINT_PRESENT,
  L1_MCP_SERVER_ENTRY_POINT_MISSING,
  L1_REJECT_PATH_TRAVERSAL,
  L1_REJECT_ABSOLUTE_PATH,
  L1_REJECT_BACKSLASH,
  L1_REJECT_NULL_BYTE,
  L1_FILTER_MACOSX,
  L1_REJECT_DEEP_PATH,
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
  L3_ALG_UNSUPPORTED,
  L3_CHAIN_INVALID_LOOP,
  L3_POLICY_REQUIRED_UNSIGNED,
  L4_ORDERED_EMISSION,
  L4_FINALIZE_EXACTLY_ONCE,
  L4_REDUCER_SEMANTICS,
  L4_EMPTY_SCRIPT,
  L4_RUN_EVENT_ENVELOPE,
]);
