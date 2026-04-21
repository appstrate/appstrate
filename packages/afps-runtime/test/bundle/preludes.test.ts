// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Prelude resolution + render-time composition (AFPS 1.2+).
 *
 * Exercises:
 *   - resolver contract (null ⇒ error, empty refs ⇒ empty string)
 *   - ordering (manifest order is render order)
 *   - MapPreludeResolver happy path
 *   - renderPrompt integration: preludes + agent share one view, one
 *     render pass, one Mustache context
 *   - policy on missing resolver with non-empty refs
 */

import { describe, it, expect } from "bun:test";
import {
  MapPreludeResolver,
  PreludeResolutionError,
  resolvePreludes,
  type PreludeRef,
  type PreludeResolver,
} from "../../src/bundle/preludes.ts";
import { renderPrompt } from "../../src/bundle/prompt-renderer.ts";
import { NoopContextProvider } from "../../src/providers/context/noop-provider.ts";
import type { ExecutionContext } from "../../src/types/execution-context.ts";

function ctx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return { runId: "r_pre", input: { topic: "parity" }, ...overrides };
}

describe("resolvePreludes", () => {
  it("returns empty string when refs is undefined", async () => {
    const out = await resolvePreludes(undefined, undefined);
    expect(out).toBe("");
  });

  it("returns empty string when refs is empty", async () => {
    const out = await resolvePreludes([], undefined);
    expect(out).toBe("");
  });

  it("throws PreludeResolutionError when refs is non-empty but resolver is missing", async () => {
    const refs: PreludeRef[] = [{ name: "@acme/env", version: "^1.0" }];
    await expect(resolvePreludes(refs, undefined)).rejects.toBeInstanceOf(PreludeResolutionError);
  });

  it("throws when a resolver returns null for a ref", async () => {
    const resolver: PreludeResolver = {
      async resolve() {
        return null;
      },
    };
    const refs: PreludeRef[] = [{ name: "@acme/env", version: "^1.0" }];
    await expect(resolvePreludes(refs, resolver)).rejects.toBeInstanceOf(PreludeResolutionError);
  });

  it("concatenates prelude prompts in manifest order with \\n\\n separator", async () => {
    const resolver = new MapPreludeResolver(
      new Map([
        ["@acme/a@^1", "# Part A"],
        ["@acme/b@^1", "# Part B"],
        ["@acme/c@^1", "# Part C"],
      ]),
    );
    const out = await resolvePreludes(
      [
        { name: "@acme/a", version: "^1" },
        { name: "@acme/b", version: "^1" },
        { name: "@acme/c", version: "^1" },
      ],
      resolver,
    );
    expect(out).toBe("# Part A\n\n# Part B\n\n# Part C");
  });

  it("honours a custom separator", async () => {
    const resolver = new MapPreludeResolver(
      new Map([
        ["@acme/a@^1", "A"],
        ["@acme/b@^1", "B"],
      ]),
    );
    const out = await resolvePreludes(
      [
        { name: "@acme/a", version: "^1" },
        { name: "@acme/b", version: "^1" },
      ],
      resolver,
      { separator: "\n---\n" },
    );
    expect(out).toBe("A\n---\nB");
  });
});

describe("renderPrompt with preludes", () => {
  it("prepends prelude(s) to the agent template in declared order", async () => {
    const resolver = new MapPreludeResolver(
      new Map([
        ["@acme/env@^1", "Environment: sandboxed."],
        ["@acme/obs@^1", "Observability: metrics on."],
      ]),
    );

    const out = await renderPrompt({
      template: "Agent: respond to {{input.topic}}",
      context: ctx(),
      provider: new NoopContextProvider(),
      preludes: [
        { name: "@acme/env", version: "^1" },
        { name: "@acme/obs", version: "^1" },
      ],
      preludeResolver: resolver,
    });

    expect(out).toBe(
      "Environment: sandboxed.\n\nObservability: metrics on.\n\nAgent: respond to parity",
    );
  });

  it("renders preludes + agent against ONE shared PromptView", async () => {
    const resolver = new MapPreludeResolver(
      new Map([["@acme/env@^1", "Run {{runId}} started (topic={{input.topic}})."]]),
    );

    const out = await renderPrompt({
      template: "Work on {{input.topic}}",
      context: ctx({ runId: "r_xyz", input: { topic: "alpha" } }),
      provider: new NoopContextProvider(),
      preludes: [{ name: "@acme/env", version: "^1" }],
      preludeResolver: resolver,
    });

    expect(out).toBe("Run r_xyz started (topic=alpha).\n\nWork on alpha");
  });

  it("surfaces providers / timeout / uploads / platform on the view to preludes", async () => {
    const prelude = [
      "Timeout: {{timeout}}s",
      "{{#providers}}- {{displayName}}{{/providers}}",
      "{{#uploads}}doc: {{name}}{{/uploads}}",
      "Platform: {{platform.name}}",
    ].join("\n");

    const resolver = new MapPreludeResolver(new Map([["@acme/env@^1", prelude]]));

    const out = await renderPrompt({
      template: "Do the thing.",
      context: ctx(),
      provider: new NoopContextProvider(),
      preludes: [{ name: "@acme/env", version: "^1" }],
      preludeResolver: resolver,
      providers: [{ id: "p1", displayName: "Gmail" }],
      uploads: [{ name: "brief.pdf", path: "./documents/brief.pdf", size: 1024 }],
      timeout: 300,
      platform: { name: "appstrate" },
    });

    expect(out).toContain("Timeout: 300s");
    expect(out).toContain("- Gmail");
    expect(out).toContain("doc: brief.pdf");
    expect(out).toContain("Platform: appstrate");
    expect(out.endsWith("Do the thing.")).toBe(true);
  });

  it("leaves rendering unchanged when no preludes declared", async () => {
    const out = await renderPrompt({
      template: "Bare prompt {{runId}}",
      context: ctx({ runId: "r_bare" }),
      provider: new NoopContextProvider(),
    });
    expect(out).toBe("Bare prompt r_bare");
  });

  it("throws PreludeResolutionError when a prelude cannot be resolved", async () => {
    const resolver = new MapPreludeResolver(new Map());
    await expect(
      renderPrompt({
        template: "...",
        context: ctx(),
        provider: new NoopContextProvider(),
        preludes: [{ name: "@acme/missing", version: "^1" }],
        preludeResolver: resolver,
      }),
    ).rejects.toBeInstanceOf(PreludeResolutionError);
  });
});
