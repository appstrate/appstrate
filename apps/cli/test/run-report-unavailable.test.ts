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
  type Bundle,
} from "@appstrate/afps-runtime/bundle";
import { unavailableIntegrations, withoutIntegrations } from "../src/commands/run/report.ts";

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

function makeBundle(): Bundle {
  const root = "@scope/agent@1.0.0";
  const agent = {
    name: "@scope/agent",
    version: "1.0.0",
    type: "agent",
    schema_version: "0.1",
    dependencies: { integrations: { [GMAIL]: "^1.0.0", [NOTION]: "^1.0.0" } },
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
    ] as never),
  } as unknown as Bundle;
}

const WARNINGS = [
  { field: `integrations.${GMAIL}`, code: "integration_unbound", message: "not connected" },
  { field: "run", code: "something_else", message: "ignored" },
];

/** Tool names the bridge registers for `bundle`, one resolved tool per requested ref. */
async function exposedTools(bundle: Bundle): Promise<string[]> {
  const factories = await buildApiCallExtensionFactory({
    bundle,
    integrationResolver: {
      resolve: async (refs) =>
        refs.map((ref) => ({
          name: `${ref.name}__api_call`,
          description: ref.name,
          parameters: { type: "object" },
          execute: async () => ({ content: [] }),
        })),
    },
    runId: "run_test",
    workspace: "/tmp",
    emitEvent: () => {},
  });
  const names: string[] = [];
  for (const factory of factories) {
    factory({ registerTool: (t: { name: string }) => names.push(t.name) } as never);
  }
  return names;
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
      { id: NOTION, reason: "it is switched off in this space" },
    ]);
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
