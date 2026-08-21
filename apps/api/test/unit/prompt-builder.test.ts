// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { buildPlatformSystemPrompt } from "../../src/services/run-launcher/prompt-builder.ts";
import type {
  AppstrateRunPlan,
  FileReference,
  ToolMeta,
} from "../../src/services/run-launcher/types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import type { Bundle, BundlePackage, PackageIdentity } from "@appstrate/afps-runtime/bundle";
import { _resetCacheForTesting } from "@appstrate/env";
import { defaultTestAgentResources } from "../helpers/run-resources.ts";

interface TestSchemas {
  input?: import("@appstrate/core/form").JSONSchemaObject;
  output?: import("@appstrate/core/form").JSONSchemaObject;
}

function makeTestBundle(opts: {
  rawPrompt?: string;
  schemaVersion?: string;
  schemas?: TestSchemas;
  timeout?: number;
  integrations?: ToolMeta[];
  mcpServers?: ToolMeta[];
  skills?: ToolMeta[];
  /**
   * Per-dependency doc-companion content, keyed by package id. Written to
   * the package's type-specific companion file (`SKILL.md` / `INTEGRATION.md`
   * / `README.md`) so the bundle mirrors what `buildBundleFromCatalog`
   * produces in production.
   */
  packageDocs?: Array<{ id: string; content: string }>;
  runtimeTools?: string[];
}): Bundle {
  const rootManifest: Record<string, unknown> = {
    name: "@test/agent",
    version: "1.0.0",
    type: "agent",
    ...(opts.runtimeTools ? { runtime_tools: opts.runtimeTools } : {}),
    ...(opts.schemaVersion ? { schema_version: opts.schemaVersion } : {}),
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    ...(opts.schemas?.input ? { input: { schema: opts.schemas.input } } : {}),
    ...(opts.schemas?.output ? { output: { schema: opts.schemas.output } } : {}),
  };
  const rootFiles = new Map<string, Uint8Array>();
  rootFiles.set("manifest.json", new TextEncoder().encode(JSON.stringify(rootManifest)));
  rootFiles.set("prompt.md", new TextEncoder().encode(opts.rawPrompt ?? ""));
  const rootIdentity: PackageIdentity = "@test/agent@1.0.0";
  const packages = new Map<PackageIdentity, BundlePackage>();
  packages.set(rootIdentity, {
    identity: rootIdentity,
    manifest: rootManifest,
    files: rootFiles,
    integrity: "sha256-stub",
  });

  const docsById = new Map((opts.packageDocs ?? []).map((d) => [d.id, d.content]));
  // Each AFPS dependency type carries its own doc companion at the
  // archive root: skill→SKILL.md, integration→INTEGRATION.md,
  // mcp-server→README.md (the convention used across the codebase).
  const addPackage = (meta: ToolMeta, type: string, docFile: string): void => {
    const identity = `${meta.id}@1.0.0` as PackageIdentity;
    const manifest = { name: meta.name, type, description: meta.description };
    const files = new Map<string, Uint8Array>();
    files.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
    const doc = docsById.get(meta.id);
    if (doc) files.set(docFile, new TextEncoder().encode(doc));
    packages.set(identity, { identity, manifest, files, integrity: "sha256-stub" });
  };
  for (const i of opts.integrations ?? []) addPackage(i, "integration", "INTEGRATION.md");
  for (const m of opts.mcpServers ?? []) addPackage(m, "mcp-server", "README.md");
  for (const s of opts.skills ?? []) addPackage(s, "skill", "SKILL.md");

  return {
    bundleFormatVersion: "1.0",
    root: rootIdentity,
    packages,
    integrity: "sha256-stub",
  };
}

/**
 * Test-local shape that mirrors the legacy `PromptContext` — tests keep
 * a flat override surface while the production signature is
 * `buildEnrichedPrompt(context, plan)`. The shim below splits it.
 */
interface PromptContext {
  rawPrompt: string;
  schemaVersion?: string;
  runId?: string;
  previousCheckpoint: Record<string, unknown> | null;
  runToken?: string;
  input: Record<string, unknown>;
  files?: FileReference[];
  schemas: TestSchemas;
  memories?: Array<{ id: number; content: string; createdAt: string | null }>;
  llmModel: string;
  llmConfig: AppstrateRunPlan["llmConfig"];
  proxyUrl?: string | null;
  timeout?: number;
  /**
   * Legacy no-op surface: the prompt no longer renders any tool list
   * (every tool is advertised via MCP `tools/list`), so these entries
   * never reach the bundle. Kept so existing negative assertions ("tool
   * X never appears in the prompt") can still pass an input.
   */
  availableTools?: ToolMeta[];
  availableSkills?: ToolMeta[];
  availableIntegrations?: ToolMeta[];
  availableMcpServers?: ToolMeta[];
  packageDocs?: Array<{ id: string; content: string }>;
  runtimeTools?: string[];
  resources?: AppstrateRunPlan["resources"];
}

function splitLegacy(ctx: PromptContext): {
  context: ExecutionContext;
  plan: AppstrateRunPlan;
} {
  const context: ExecutionContext = {
    runId: ctx.runId ?? "test_run",
    input: ctx.input,
    memories: (ctx.memories ?? []).map((m) => ({
      content: m.content,
      createdAt: m.createdAt ? new Date(m.createdAt).getTime() : 0,
    })),
    ...(ctx.previousCheckpoint !== null ? { checkpoint: ctx.previousCheckpoint } : {}),
  };
  const bundle = makeTestBundle({
    rawPrompt: ctx.rawPrompt,
    ...(ctx.schemaVersion !== undefined ? { schemaVersion: ctx.schemaVersion } : {}),
    schemas: ctx.schemas,
    ...(ctx.timeout !== undefined ? { timeout: ctx.timeout } : {}),
    ...(ctx.availableSkills ? { skills: ctx.availableSkills } : {}),
    ...(ctx.availableIntegrations ? { integrations: ctx.availableIntegrations } : {}),
    ...(ctx.availableMcpServers ? { mcpServers: ctx.availableMcpServers } : {}),
    ...(ctx.packageDocs ? { packageDocs: ctx.packageDocs } : {}),
    ...(ctx.runtimeTools ? { runtimeTools: ctx.runtimeTools } : {}),
  });
  const plan: AppstrateRunPlan = {
    bundle,
    rawPrompt: ctx.rawPrompt,
    ...(ctx.schemas.output ? { outputSchema: ctx.schemas.output } : {}),
    llmConfig: ctx.llmConfig,
    runToken: ctx.runToken ?? "test-run-token",
    proxyUrl: ctx.proxyUrl,
    timeout: ctx.timeout ?? 0,
    resources: ctx.resources ?? defaultTestAgentResources(),
    files: ctx.files,
  };
  return { context, plan };
}

function buildEnrichedPrompt(ctx: PromptContext): Promise<string> {
  const { context, plan } = splitLegacy(ctx);
  return buildPlatformSystemPrompt(context, plan);
}

function baseContext(overrides?: Partial<PromptContext>): PromptContext {
  return {
    rawPrompt: "Do the task.",
    previousCheckpoint: null,
    input: {},
    schemas: {},
    llmModel: "test-model",
    llmConfig: {
      providerId: "anthropic",
      apiShape: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      modelId: "test-model",
      apiKey: "sk-test",
      label: "Test Model",
      isSystemModel: false,
      aliased: false,
      aliasId: "test-model",
    },
    ...overrides,
  };
}

/** Render a prompt under a given backend + tmpfs cap, then restore the env. */
async function promptWithEnv(
  adapter: string,
  tmpfsMb?: string,
  overrides?: Partial<PromptContext>,
): Promise<string> {
  const prevAdapter = process.env.RUN_ADAPTER;
  const prevTmpfs = process.env.WORKSPACE_TMPFS_SIZE_MB;
  process.env.RUN_ADAPTER = adapter;
  if (tmpfsMb === undefined) delete process.env.WORKSPACE_TMPFS_SIZE_MB;
  else process.env.WORKSPACE_TMPFS_SIZE_MB = tmpfsMb;
  _resetCacheForTesting();
  try {
    return await buildEnrichedPrompt(baseContext(overrides));
  } finally {
    if (prevAdapter === undefined) delete process.env.RUN_ADAPTER;
    else process.env.RUN_ADAPTER = prevAdapter;
    if (prevTmpfs === undefined) delete process.env.WORKSPACE_TMPFS_SIZE_MB;
    else process.env.WORKSPACE_TMPFS_SIZE_MB = prevTmpfs;
    _resetCacheForTesting();
  }
}

/** Context with all system tools available (mimics backward compat behavior). */
function contextWithSystemTools(overrides?: Partial<PromptContext>): PromptContext {
  return baseContext({
    availableTools: [
      { id: "@appstrate/log", name: "Log", description: "Send progress messages" },
      { id: "@appstrate/output", name: "Output", description: "Return run result" },
      {
        id: "@appstrate/pin",
        name: "Pin",
        description: "Upsert a pinned slot",
      },
      { id: "@appstrate/note", name: "Note", description: "Append an archive memory" },
    ],
    ...overrides,
  });
}

// ─── Core structure ─────────────────────────────────────────

describe("buildEnrichedPrompt — core structure", () => {
  it("includes system identity section", async () => {
    const prompt = await buildEnrichedPrompt(baseContext());
    expect(prompt).toContain("## System");
    expect(prompt).toContain("Appstrate platform");
    expect(prompt).toContain("ephemeral container");
  });

  it("appends raw prompt at the end after separator", async () => {
    const ctx = baseContext({ rawPrompt: "My custom task instruction." });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).toContain("---\n\nMy custom task instruction.");
    // Raw prompt should be at the very end
    expect(prompt.endsWith("My custom task instruction.")).toBe(true);
  });

  it("includes timeout when specified", async () => {
    const ctx = baseContext({ timeout: 120 });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).toContain("120 seconds");
  });

  it("omits timeout when not specified", async () => {
    const ctx = baseContext({ timeout: undefined });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("**Timeout**");
  });
});

// ─── Workspace disk cap (issue #1019) ──────────────────────

describe("buildEnrichedPrompt — workspace disk cap", () => {
  it("states the cap and points bulky work at /tmp on the docker backend", async () => {
    // The docker backend mounts the workspace as tmpfs, so an agent that
    // installs dependencies into it dies with ENOSPC unless the prompt says so.
    const prompt = await promptWithEnv("docker");
    expect(prompt).toContain("**Disk**: the workspace is a RAM-backed tmpfs capped at 512 MB");
    expect(prompt).toContain("`/tmp`");
  });

  it("interpolates the operator's WORKSPACE_TMPFS_SIZE_MB, not a hardcoded default", async () => {
    const prompt = await promptWithEnv("docker", "2048");
    expect(prompt).toContain("capped at 2048 MB");
    expect(prompt).not.toContain("512 MB");
  });

  it("stays silent when the docker workspace cap does not apply", async () => {
    // WORKSPACE_TMPFS_SIZE_MB=0 disables the tmpfs even under docker, while
    // process and undeclared backends have no core-owned tmpfs contract. A
    // module id alone is never enough: the plan must carry the capability.
    expect(await promptWithEnv("docker", "0")).not.toContain("**Disk**");
    expect(await promptWithEnv("process")).not.toContain("**Disk**");
    expect(await promptWithEnv("module-backend")).not.toContain("**Disk**");
    expect(await promptWithEnv("firecracker")).not.toContain("**Disk**");
  });

  it("states a backend-declared writable-root budget without suggesting /tmp as an escape", async () => {
    const prompt = await promptWithEnv("module-backend", undefined, {
      resources: {
        ...defaultTestAgentResources(),
        semantics: "sizing",
        writableRootTmpfsPercent: 50,
      },
    });
    const diskLine = prompt.split("\n").find((line) => line.startsWith("- **Disk**"));
    expect(diskLine).toBe(
      "- **Disk**: the writable root, including the workspace, is a RAM-backed tmpfs capped at 50% of guest RAM. " +
        "All writes consume guest RAM shared with the agent, system, and sidecar. " +
        "Keep installations, clones, and verification artifacts lean; " +
        "write user deliverables under `./outputs/`.",
    );
    expect(diskLine).not.toContain("/tmp");
  });
});

// ─── Effective agent resources ─────────────────────────────

describe("buildEnrichedPrompt — effective agent resources", () => {
  it("interpolates effective hard limits, never requested or default values", async () => {
    const prompt = await buildEnrichedPrompt(
      baseContext({
        resources: {
          requested: { memoryMb: 8192, cpu: 8 },
          effective: { memoryMb: 2048, cpu: 3 },
          memoryCapped: true,
          cpuCapped: true,
          semantics: "limits",
          workload: { memoryBytes: 2_147_483_648, nanoCpus: 3_000_000_000 },
        },
      }),
    );

    expect(prompt).toContain("hard container limits: 2048 MiB RAM and 3 vCPU quota");
    expect(prompt).not.toContain("8192 MiB");
    expect(prompt).not.toContain("8 vCPU");
    expect(prompt).not.toContain("1536 MiB");
  });

  it("interpolates the effective microVM sizing budget", async () => {
    const prompt = await promptWithEnv("module-backend", undefined, {
      resources: {
        requested: { memoryMb: 8192, cpu: 8 },
        effective: { memoryMb: 4096, cpu: 7 },
        memoryCapped: true,
        cpuCapped: true,
        semantics: "sizing",
        writableRootTmpfsPercent: 50,
        workload: { memoryBytes: 4_294_967_296, nanoCpus: 7_000_000_000 },
      },
    });

    expect(prompt).toContain("agent sizing budget: 4096 MiB RAM and 7 vCPU");
    expect(prompt).toContain("capped at 50% of guest RAM");
    expect(prompt).not.toContain("hard container limits");
    expect(prompt).not.toContain("workspace counts toward this container RAM limit");
    expect(prompt).not.toContain("8192 MiB");
    expect(prompt).not.toContain("8 vCPU");
  });

  it("stays silent when the resolved plan has no resource semantics", async () => {
    const prompt = await buildEnrichedPrompt(
      baseContext({
        resources: {
          requested: { memoryMb: 3072, cpu: 5 },
          effective: { memoryMb: 3072, cpu: 5 },
          memoryCapped: false,
          cpuCapped: false,
          workload: { memoryBytes: 3_221_225_472, nanoCpus: 5_000_000_000 },
        },
      }),
    );

    expect(prompt).not.toContain("**Compute**");
    expect(prompt).not.toContain("3072 MiB");
    expect(prompt).not.toContain("5 vCPU");
  });
});

// ─── Dependency doc companions ─────────────────────────────

describe("buildEnrichedPrompt — dependency doc companions", () => {
  // AFPS dependencies carry a doc companion at their archive root:
  // skill→SKILL.md, integration→INTEGRATION.md, mcp-server→README.md.
  // None of these are rendered into the platform prompt — integrations
  // and mcp-servers self-document via MCP `tools/list`, and a skill's
  // SKILL.md is loaded only when the skill is activated in-container.
  it("never renders INTEGRATION.md content in the prompt", async () => {
    const ctx = baseContext({
      availableIntegrations: [
        { id: "@org/github-mcp", name: "GitHub", description: "GitHub integration" },
      ],
      packageDocs: [
        { id: "@org/github-mcp", content: "## GitHub API\n\nCall `list_issues` to fetch issues." },
      ],
    });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## GitHub API");
    expect(prompt).not.toContain("Call `list_issues` to fetch issues.");
  });

  it("never renders mcp-server README.md content in the prompt", async () => {
    const ctx = baseContext({
      availableMcpServers: [
        { id: "@org/scraper", name: "Scraper", description: "Web scraper MCP server" },
      ],
      packageDocs: [{ id: "@org/scraper", content: "## Usage\n\nInvoke the `scrape` tool." }],
    });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Usage");
    expect(prompt).not.toContain("Invoke the `scrape` tool.");
  });

  it("never renders skill SKILL.md body content in the prompt", async () => {
    const ctx = baseContext({
      availableSkills: [
        { id: "@org/research", name: "Research", description: "Deep research capability" },
      ],
      packageDocs: [
        { id: "@org/research", content: "## Research procedure\n\nStep 1: gather sources." },
      ],
    });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Research procedure");
    expect(prompt).not.toContain("Step 1: gather sources.");
  });
});

// ─── User input ─────────────────────────────────────────────

describe("buildEnrichedPrompt — user input", () => {
  it("includes user input values", async () => {
    const ctx = baseContext({
      input: { topic: "AI safety", depth: "detailed" },
    });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## User Input");
    expect(prompt).toContain("topic");
    expect(prompt).toContain("AI safety");
    expect(prompt).toContain("depth");
    expect(prompt).toContain("detailed");
  });

  it("includes schema descriptions for input fields", async () => {
    const ctx = baseContext({
      input: { topic: "AI" },
      schemas: {
        input: {
          type: "object",
          properties: {
            topic: { type: "string", description: "Main research topic" },
          },
          required: ["topic"],
        },
      },
    });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).toContain("Main research topic");
    expect(prompt).toContain("required");
  });

  it("omits input section when no input provided", async () => {
    const ctx = baseContext({ input: {} });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## User Input");
  });

  it("excludes file-type input fields from user input section", async () => {
    const ctx = baseContext({
      input: { text: "hello", document: "file-ref" },
      schemas: {
        input: {
          type: "object",
          properties: {
            text: { type: "string" },
            document: {
              type: "string",
              format: "uri",
              contentMediaType: "application/octet-stream",
            },
          },
        },
      },
    });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).toContain("text");
    // file type should be excluded from User Input
  });
});

// ─── Configuration ──────────────────────────────────────────

describe("buildEnrichedPrompt — configuration", () => {
  it("never renders a Configuration section (config folded into input)", async () => {
    const ctx = baseContext({ input: { language: "fr", maxResults: 10 } });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Configuration");
  });
});

// ─── Previous state ─────────────────────────────────────────

describe("buildEnrichedPrompt — checkpoint", () => {
  it("includes checkpoint when set-checkpoint tool is available", async () => {
    const ctx = contextWithSystemTools({
      previousCheckpoint: { cursor: "abc123", processedCount: 42 },
    });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Checkpoint");
    expect(prompt).toContain("```json");
    expect(prompt).toContain('"cursor": "abc123"');
    expect(prompt).toContain('"processedCount": 42');
  });

  it("omits checkpoint when null", async () => {
    const ctx = contextWithSystemTools({ previousCheckpoint: null });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Checkpoint");
  });

  it("includes checkpoint regardless of available tools", async () => {
    const ctx = baseContext({
      previousCheckpoint: { cursor: "abc123" },
      availableTools: [],
    });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Checkpoint");
    expect(prompt).toContain("abc123");
  });
});

// ─── Memories ───────────────────────────────────────────────

describe("buildEnrichedPrompt — memories", () => {
  it("includes memories section when add-memory tool is available", async () => {
    const ctx = contextWithSystemTools({
      memories: [
        { id: 1, content: "Gmail API paginates at 100 results", createdAt: "2025-01-15" },
        { id: 2, content: "Use batch endpoint for efficiency", createdAt: "2025-01-16" },
      ],
    });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("Gmail API paginates at 100 results");
    expect(prompt).toContain("Use batch endpoint for efficiency");
    expect(prompt).toContain("2025-01-15");
  });

  it("omits the Memory section with no memories — recall_memory is discoverable via tools/list", async () => {
    // With no pinned memories the `## Memory` header is suppressed
    // entirely. `recall_memory` is no longer named in the prompt at all:
    // the agent discovers it (and its calling convention) from the MCP
    // tool advertised via `tools/list`, not from any in-prompt listing.
    const ctx = contextWithSystemTools({ memories: [] });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Memory\n");
    expect(prompt).not.toContain("No memories are currently pinned");
    expect(prompt).not.toContain("recall_memory");
  });

  it("includes memories regardless of available tools", async () => {
    const ctx = baseContext({
      memories: [{ id: 1, content: "Some memory", createdAt: "2025-01-15" }],
      availableTools: [],
    });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("Some memory");
  });
});

// ─── Run history (zero-knowledge invariant) ────────────────

describe("buildEnrichedPrompt — run history is tool-wired, never in the prompt", () => {
  // Historical runs used to be documented in a `## Run History` section
  // whose curl snippet exposed `$SIDECAR_URL`. That surface was migrated
  // to a typed `run_history` tool wired by the runtime (runtime-pi
  // Phase D); the prompt MUST NEVER mention the sidecar, regardless of
  // whether a signed `runToken` is present.

  it("does not render a Run History section when runToken is present", async () => {
    const ctx = baseContext({ runToken: "exec_token_123" });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Run History");
    expect(prompt).not.toContain("$SIDECAR_URL");
  });

  it("does not render a Run History section when runToken is absent", async () => {
    const ctx = baseContext({ runToken: undefined });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Run History");
    expect(prompt).not.toContain("$SIDECAR_URL");
  });
});

// ─── No provider prompt dimension ───────────────────────────

describe("buildEnrichedPrompt — provider dimension fully removed", () => {
  it("never emits a Connected Providers section or provider_call instructions", async () => {
    // Outbound API access is surfaced via integration MCP tools
    // (`{ns}__api_call`), self-documented through MCP tools/list — never
    // through the prompt. The provider prompt dimension is fully removed.
    const prompt = await buildEnrichedPrompt(baseContext());
    expect(prompt).not.toContain("## Connected Providers");
    expect(prompt).not.toContain("provider_call");
    expect(prompt).not.toContain("$SIDECAR_URL");
  });
});

// ─── Documents/files ────────────────────────────────────────

describe("buildEnrichedPrompt — documents", () => {
  it("includes documents section when files provided", async () => {
    const ctx = baseContext({
      files: [
        {
          fieldName: "doc",
          name: "report.pdf",
          workspaceName: "report.pdf",
          type: "application/pdf",
          size: 102400,
        },
        // Display name collides with the first — its unique workspace name is
        // what appears in the on-disk path.
        {
          fieldName: "doc2",
          name: "report.pdf",
          workspaceName: "report-2.pdf",
          type: "text/csv",
          size: 5120,
        },
      ],
    });

    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Documents");
    // Neutral wording: an input document can be a sibling run's deliverable
    // mounted by reference, not only a human upload.
    expect(prompt).toContain("The following documents are available on the local filesystem:");
    expect(prompt).not.toContain("have been uploaded");
    expect(prompt).toContain("report.pdf");
    // The colliding display names resolve to distinct on-disk paths.
    expect(prompt).toContain("./documents/report.pdf");
    expect(prompt).toContain("./documents/report-2.pdf");
  });

  // Fan-in by reference: a document mounted through the reserved
  // `_context_documents` field is announced exactly like any other input
  // document. A file mounted but not announced is a file never read.
  it("announces context documents mounted through the reserved field", async () => {
    const ctx = baseContext({
      files: [
        {
          fieldName: "_context_documents",
          name: "research.json",
          workspaceName: "research.json",
          type: "application/json",
          size: 9100,
        },
      ],
    });

    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Documents");
    expect(prompt).toContain("./documents/research.json");
  });

  it("omits documents section when no files", async () => {
    const ctx = baseContext({ files: [] });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Documents");
  });
});

// ─── Tools and skills ───────────────────────────────────────

describe("buildEnrichedPrompt — tools and skills", () => {
  it("never renders a Tools section — tools are advertised via MCP tools/list", async () => {
    // The prompt no longer lists tools (a partial/stale in-prompt list
    // would contradict the live tool set). The agent discovers every tool
    // — bundle, integration, runtime (output/log/note/pin), and the
    // platform-injected run_history/recall_memory — from `tools/list`.
    const ctx = baseContext({
      availableTools: [
        { id: "@org/scraper", name: "Web Scraper", description: "Scrapes web pages" },
      ],
      runtimeTools: ["note"],
    });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("### Tools");
    expect(prompt).not.toContain("Web Scraper");
    expect(prompt).not.toContain("run_history");
  });

  it("includes available skills", async () => {
    const ctx = baseContext({
      availableSkills: [
        { id: "@org/research", name: "Research", description: "Deep research capability" },
      ],
    });

    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).toContain("### Skills");
    expect(prompt).toContain("Research");
    expect(prompt).toContain(".pi/skills/");
  });

  it("omits skills section when no skills", async () => {
    const ctx = baseContext({ availableSkills: [] });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("### Skills");
  });
});

// ─── Output Format engine awareness (issue #824) ───────────

describe("buildEnrichedPrompt — Output Format is engine-aware", () => {
  const outputSchema = {
    type: "object" as const,
    required: ["answer"],
    properties: { answer: { type: "string" as const } },
  };

  it("mandates the terminal `output` tool call (single Pi-engine channel)", async () => {
    const prompt = await buildEnrichedPrompt(baseContext({ schemas: { output: outputSchema } }));
    expect(prompt).toContain("## Output Format");
    expect(prompt).toContain("call the `output` tool");
    expect(prompt).not.toContain("StructuredOutput");
  });

  it("renders no Output Format section when the agent declares no output schema", async () => {
    const prompt = await buildEnrichedPrompt(baseContext());
    expect(prompt).not.toContain("## Output Format");
  });
});

// ─── Raw prompt template ──────────────────────

describe("buildEnrichedPrompt — raw prompt template", () => {
  it("does not interpolate {{…}} even when schemaVersion declares 1.1", async () => {
    const ctx = baseContext({
      schemaVersion: "1.1",
      runId: "run_abc",
      input: { topic: "quantum" },
      rawPrompt: "Investigate {{input.topic}} for {{runId}}.",
    });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).toContain("Investigate {{input.topic}} for {{runId}}.");
    expect(prompt).not.toContain("Investigate quantum for run_abc.");
  });

  it("preserves the enrichment sections before the raw prompt", async () => {
    const ctx = baseContext({
      input: { task: "hello" },
      rawPrompt: "Run: {{input.task}}",
    });
    const prompt = await buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## System");
    expect(prompt).toContain("Appstrate platform");
    expect(prompt).toMatch(/Run: \{\{input\.task\}\}$/);
  });
});
