// SPDX-License-Identifier: Apache-2.0

/**
 * A `--report` run executed locally starts without the integrations the platform bound to none,
 * as the platform does: the agent is told, and their api_call tools are not exposed.
 */

import { describe, it, expect } from "bun:test";
import { buildApiCallExtensionFactory } from "@appstrate/runner-pi";
import {
  buildPlatformPromptInputs,
  renderPlatformPrompt,
  UNAVAILABLE_INTEGRATION_REASONS,
  type Bundle,
} from "@appstrate/afps-runtime/bundle";
import { CONNECTION_RESOLUTION_WARNING_CODES } from "@appstrate/core/integration";
import { parseLaunchItems } from "../src/commands/run/launch-warnings.ts";
import { unavailableIntegrations, withoutIntegrations } from "../src/commands/run/report.ts";
import { cliPromptInputs } from "../src/commands/run.ts";
import { buildIntegrationResolver } from "../src/commands/run/resolver.ts";
import type { IntegrationApiCallResolver } from "@appstrate/afps-runtime/resolvers";

const GMAIL = "@appstrate/gmail";
const NOTION = "@appstrate/notion";

const apiCallIntegration = (name: string) => ({
  name,
  version: "1.0.0",
  schema_version: "0.1",
  type: "integration",
  source: { kind: "none" },
  _meta: { "dev.appstrate/api": { auths: { main: {} } } },
  auths: {
    main: {
      type: "api_key",
      authorized_uris: ["https://api.example.com/**"],
      credentials: { schema: {} },
      delivery: { http: { in: "header", name: "X-Api-Key", value: "{$credential.api_key}" } },
    },
  },
});

const MCP_ONLY = "@appstrate/mcp-only";

function makeBundle(withMcpOnly = false): Bundle {
  const root = "@scope/agent@1.0.0";
  const agent = {
    name: "@scope/agent",
    version: "1.0.0",
    type: "agent",
    schema_version: "0.1",
    dependencies: {
      integrations: {
        [GMAIL]: "^1.0.0",
        [NOTION]: "^1.0.0",
        ...(withMcpOnly ? { [MCP_ONLY]: "^1.0.0" } : {}),
      },
    },
    integrations_configuration: {
      [GMAIL]: { tools: ["api_call"] },
      [NOTION]: { tools: ["api_call"] },
    },
  };
  const pkg = (identity: string, manifest: Record<string, unknown>, files = new Map()) => [
    identity,
    { identity, manifest, files, integrity: "" },
  ];
  return {
    version: "1.0",
    root,
    integrity: "sha256-test",
    packages: new Map([
      pkg(root, agent, new Map([["prompt.md", new TextEncoder().encode("Do it.")]])),
      pkg(`${GMAIL}@1.0.0`, apiCallIntegration(GMAIL)),
      pkg(`${NOTION}@1.0.0`, apiCallIntegration(NOTION)),
      ...(withMcpOnly
        ? [
            pkg(`${MCP_ONLY}@1.0.0`, {
              name: MCP_ONLY,
              version: "1.0.0",
              schema_version: "0.1",
              type: "integration",
              source: { kind: "remote", url: "https://mcp.example.com/mcp" },
            }),
          ]
        : []),
    ] as never),
  } as unknown as Bundle;
}

const WARNINGS = parseLaunchItems([
  { field: `integrations.${GMAIL}`, code: "not_connected", message: "not connected" },
  { field: "run", code: "something_else", message: "ignored" },
]);

const fakeResolver: IntegrationApiCallResolver = {
  resolve: async (refs) =>
    refs.map((ref) => ({
      name: `${ref.name}__api_call`,
      description: ref.name,
      parameters: { type: "object" },
      execute: async () => ({ content: [] }),
    })),
};

/** Factories the bridge builds for `bundle`, one resolved tool per requested ref. */
function bridge(bundle: Bundle, integrationResolver: IntegrationApiCallResolver) {
  return buildApiCallExtensionFactory({
    bundle,
    integrationResolver,
    runId: "run_test",
    workspace: "/tmp",
    emitEvent: () => {},
  });
}

/** Tool names the bridge registers for `bundle`. */
async function exposedTools(bundle: Bundle): Promise<string[]> {
  const names: string[] = [];
  for (const factory of (await bridge(bundle, fakeResolver)).factories) {
    factory({ registerTool: (t: { name: string }) => names.push(t.name) } as never);
  }
  return names;
}

/** The CLI prompt of `bundle` once its api_call tools are wired through `resolver`. */
async function cliPrompt(
  bundle: Bundle,
  resolver: IntegrationApiCallResolver,
  unavailable: ReturnType<typeof unavailableIntegrations> = [],
): Promise<string> {
  const { integrationIds } = await bridge(
    withoutIntegrations(
      bundle,
      unavailable.map((entry) => entry.id),
    ),
    resolver,
  );
  return renderPlatformPrompt(
    cliPromptInputs(
      bundle,
      { runId: "run_test", input: {}, memories: [] },
      unavailable,
      integrationIds,
    ),
  );
}

describe("--report local run — integrations bound to none", () => {
  it("reads one unavailable entry per integration warning, worded as the platform words it", () => {
    expect(
      unavailableIntegrations([
        ...WARNINGS,
        { field: `integrations.${NOTION}`, code: "integration_not_active", message: "off" },
        { field: `integrations.${GMAIL}`, code: "integration_unbound", message: "dup" },
      ]),
    ).toEqual([
      { id: GMAIL, reason: "no connection is bound to this run" },
      { id: NOTION, reason: "it is switched off" },
    ]);
  });

  it("words every warning code: a switched-off integration, else nothing bound", () => {
    const reasons = CONNECTION_RESOLUTION_WARNING_CODES.map(
      (code) =>
        unavailableIntegrations([{ field: `integrations.${GMAIL}`, code, message: code }])[0]
          ?.reason,
    );
    expect(reasons).toEqual(
      CONNECTION_RESOLUTION_WARNING_CODES.map((code) =>
        code === "integration_not_active"
          ? UNAVAILABLE_INTEGRATION_REASONS.not_active
          : UNAVAILABLE_INTEGRATION_REASONS.unbound,
      ),
    );
  });

  it("withholds an integration on a code this CLI does not know, as unbound", () => {
    expect(
      unavailableIntegrations([{ field: `integrations.${GMAIL}`, code: "newer_code" }]),
    ).toEqual([{ id: GMAIL, reason: UNAVAILABLE_INTEGRATION_REASONS.unbound }]);
  });

  it("tells the agent which integrations it runs without", () => {
    const bundle = makeBundle();
    const prompt = renderPlatformPrompt(
      buildPlatformPromptInputs(
        bundle,
        { runId: "run_test", input: {}, memories: [] },
        {
          platformName: "Appstrate CLI",
          unavailableIntegrations: unavailableIntegrations(WARNINGS),
        },
      ),
    );
    expect(prompt).toContain("## Unavailable Integrations");
    expect(prompt).toContain(`- **${GMAIL}**: no connection is bound to this run`);
    expect(prompt).not.toContain(`- **${NOTION}**`);
  });

  it("lists only the available integrations in the catalog", async () => {
    const prompt = await cliPrompt(makeBundle(), fakeResolver, unavailableIntegrations(WARNINGS));
    expect(prompt).toContain(`<name>${NOTION}</name>`);
    expect(prompt).not.toContain(`<name>${GMAIL}</name>`);
    expect(prompt).toContain(`- **${GMAIL}**: no connection is bound to this run`);
  });

  it("does not list an MCP-only integration, which the CLI wires no tool for", async () => {
    const prompt = await cliPrompt(makeBundle(true), fakeResolver);
    expect(prompt).toContain(`<name>${GMAIL}</name>`);
    expect(prompt).toContain(`<name>${NOTION}</name>`);
    expect(prompt).not.toContain(`<name>${MCP_ONLY}</name>`);
  });

  it("renders no catalog under --integrations none", async () => {
    const prompt = await cliPrompt(makeBundle(true), buildIntegrationResolver("none", null));
    expect(prompt).not.toContain("### Integrations");
    expect(prompt).not.toContain("<available_integrations>");
  });

  it("exposes no tool of an integration bound to none", async () => {
    const bundle = makeBundle();
    expect(await exposedTools(bundle)).toEqual([`${GMAIL}__api_call`, `${NOTION}__api_call`]);
    const ids = unavailableIntegrations(WARNINGS).map((entry) => entry.id);
    expect(await exposedTools(withoutIntegrations(bundle, ids))).toEqual([`${NOTION}__api_call`]);
  });

  it("leaves the bundle untouched when nothing is unavailable", () => {
    const bundle = makeBundle();
    expect(withoutIntegrations(bundle, [])).toBe(bundle);
    expect(withoutIntegrations(bundle, ["@appstrate/undeclared"])).toBe(bundle);
  });
});
