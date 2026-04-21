// SPDX-License-Identifier: Apache-2.0

/**
 * AppstratePreludeResolver — verifies version-range matching + fan-out
 * to the static environment prompt asset.
 */

import { describe, it, expect } from "bun:test";
import { AppstratePreludeResolver } from "../../src/services/adapters/appstrate-prelude-resolver.ts";
import {
  APPSTRATE_ENVIRONMENT_NAME,
  APPSTRATE_ENVIRONMENT_PROMPT,
  APPSTRATE_ENVIRONMENT_VERSION,
} from "../../src/services/adapters/appstrate-environment-prompt.ts";
import { renderPrompt } from "@appstrate/afps-runtime/bundle";
import { NoopContextProvider } from "@appstrate/afps-runtime/providers";
import { buildAppstratePreludeFlags } from "../../src/services/adapters/appstrate-environment-prompt.ts";

describe("AppstratePreludeResolver", () => {
  const resolver = new AppstratePreludeResolver();

  it("resolves the environment prelude under the current version", async () => {
    const out = await resolver.resolve({
      name: APPSTRATE_ENVIRONMENT_NAME,
      version: `^${APPSTRATE_ENVIRONMENT_VERSION.split(".")[0]!}.0.0`,
    });
    expect(out).toBe(APPSTRATE_ENVIRONMENT_PROMPT);
  });

  it("resolves for an exact version match", async () => {
    const out = await resolver.resolve({
      name: APPSTRATE_ENVIRONMENT_NAME,
      version: APPSTRATE_ENVIRONMENT_VERSION,
    });
    expect(out).toBe(APPSTRATE_ENVIRONMENT_PROMPT);
  });

  it("returns null for an unknown prelude scope", async () => {
    const out = await resolver.resolve({ name: "@acme/environment", version: "^1" });
    expect(out).toBeNull();
  });

  it("returns null when the requested version is not satisfied", async () => {
    const out = await resolver.resolve({
      name: APPSTRATE_ENVIRONMENT_NAME,
      version: "^99.0.0",
    });
    expect(out).toBeNull();
  });

  describe("render integration", () => {
    it("renders the environment section with a provider list + timeout + uploads", async () => {
      const providers = [{ id: "gmail", displayName: "Gmail", authMode: "oauth2" }];
      const uploads = [
        { name: "brief.pdf", path: "./documents/brief.pdf", size: 4096, type: "application/pdf" },
      ];
      const out = await renderPrompt({
        template: "---\nDo the thing.",
        context: { runId: "r1", input: { topic: "x" } },
        provider: new NoopContextProvider(),
        preludes: [{ name: APPSTRATE_ENVIRONMENT_NAME, version: APPSTRATE_ENVIRONMENT_VERSION }],
        preludeResolver: resolver,
        providers,
        uploads,
        timeout: 600,
        platform: buildAppstratePreludeFlags({
          providers,
          uploads,
          timeout: 600,
        }),
      });

      // Environment preamble preserved
      expect(out).toContain("You are an AI agent running on the Appstrate platform.");
      // Timeout gate fired
      expect(out).toContain("You have 600 seconds to complete this task.");
      // Providers section fired + iterated
      expect(out).toContain("### Connected Providers");
      expect(out).toContain("**Gmail** (provider ID: `gmail`) — auth mode: oauth2");
      // Uploads section fired + iterated
      expect(out).toContain("## Documents");
      expect(out).toContain("**brief.pdf** (application/pdf) → `./documents/brief.pdf`");
      // Agent prompt appended after the prelude
      expect(out.trimEnd().endsWith("Do the thing.")).toBe(true);
    });

    it("omits the provider section when no providers are connected", async () => {
      const out = await renderPrompt({
        template: "Agent body",
        context: { runId: "r2", input: {} },
        provider: new NoopContextProvider(),
        preludes: [{ name: APPSTRATE_ENVIRONMENT_NAME, version: APPSTRATE_ENVIRONMENT_VERSION }],
        preludeResolver: resolver,
        platform: buildAppstratePreludeFlags({}),
      });
      expect(out).not.toContain("## Authenticated Provider API");
      expect(out).not.toContain("### Connected Providers");
    });

    it("omits the uploads section when no uploads are attached", async () => {
      const out = await renderPrompt({
        template: "Agent body",
        context: { runId: "r3", input: {} },
        provider: new NoopContextProvider(),
        preludes: [{ name: APPSTRATE_ENVIRONMENT_NAME, version: APPSTRATE_ENVIRONMENT_VERSION }],
        preludeResolver: resolver,
        platform: buildAppstratePreludeFlags({}),
      });
      expect(out).not.toContain("## Documents");
    });
  });
});
