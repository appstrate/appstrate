// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate models list` against a `GET /api/models` body spelled exactly as
 * the server serializes it (`listOrgModels` → `projectAliasedModel`).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { modelsListCommand } from "../src/commands/models.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";

const configHome = useTempConfigHome("appstrate-cli-models-cmd-");
let keyring: FakeKeyringInstall;
const originalFetch = globalThis.fetch;

const modelsBody = {
  object: "list",
  data: [
    {
      id: "gpt-default",
      label: "GPT Default",
      apiShape: "openai-completions",
      providerId: "openai",
      enabled: true,
      is_default: true,
      needs_reconnection: false,
      source: "built-in",
    },
    {
      id: "gpt-other",
      label: "GPT Other",
      apiShape: "openai-completions",
      providerId: "openai",
      enabled: true,
      is_default: false,
      needs_reconnection: false,
      source: "custom",
    },
    {
      id: "my-alias",
      label: "My Alias",
      apiShape: null,
      providerId: null,
      enabled: true,
      is_default: false,
      needs_reconnection: false,
      source: "built-in",
    },
  ],
};

beforeEach(async () => {
  await configHome.setup();
  keyring = installFakeKeyring();
  await seedLoggedInProfile("default", { email: "alice@example.com", orgId: "org_1" });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/models")) return Response.json(modelsBody);
    return new Response("not mocked: " + url, { status: 501 });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  keyring.restore();
  globalThis.fetch = originalFetch;
  await configHome.teardown();
});

describe("models list", () => {
  it("tags only the org default, read from the wire's `is_default`", async () => {
    const { io, stdout } = createMemoryIO();
    await modelsListCommand({ profile: "default" }, io);
    const lines = stdout().split("\n");
    expect(lines.find((l) => l.includes("gpt-default"))).toContain("[default]");
    expect(lines.find((l) => l.includes("gpt-other"))).not.toContain("default");
  });

  it("lists an aliased preset (nulled apiShape) as proxy-unsupported instead of crashing", async () => {
    const { io, stdout } = createMemoryIO();
    await modelsListCommand({ profile: "default" }, io);
    const aliasLine = stdout()
      .split("\n")
      .find((l) => l.includes("my-alias"));
    expect(aliasLine).toContain("(alias)");
    expect(aliasLine).toContain("proxy-unsupported");
  });
});
