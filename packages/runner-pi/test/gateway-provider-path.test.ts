// SPDX-License-Identifier: Apache-2.0

/**
 * A gateway model (no Pi provider — `openai-compatible`, `anthropic-compatible`)
 * falls back to `deriveProviderFromApi`, which may name a Pi builtin that does
 * not serve the model's api: `openai` streams Responses only. A run must still
 * reach its api shape's endpoint — `openai-completions` POSTed `/responses`
 * instead of `/chat/completions`, and the sidecar refused it with a 404.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRunner } from "../src/index.ts";
import { buildPiModel } from "../src/pi-model.ts";
import { LLM_PROXY_ROUTES } from "../src/llm-proxy-routes.ts";
import { createCaptureSink, makeBundlePackage, makeContext, makeTestBundle } from "./helpers.ts";

const TEST_BUNDLE = makeTestBundle(
  makeBundlePackage("@test/gateway-provider-path", "0.0.0", "agent", {}),
);

/** The path of every request a run makes against a gateway model of `apiShape`. */
async function requestPaths(apiShape: keyof typeof LLM_PROXY_ROUTES): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "runner-pi-gateway-"));
  const agentDir = join(root, "agent");
  const paths: string[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    await mkdir(agentDir, { recursive: true });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        paths.push(new URL(request.url).pathname);
        // Non-retryable: the path of the first request is all this test reads.
        return new Response("stop", { status: 400 });
      },
    });
    const route = LLM_PROXY_ROUTES[apiShape];
    const runner = new PiRunner({
      model: buildPiModel({
        id: "gateway-model",
        apiShape,
        piProvider: null,
        baseUrl: `${server.url.origin}${route.baseSuffix}`,
      }),
      apiKey: "gateway-key",
      systemPrompt: "Answer briefly.",
      startMessage: "Say done.",
      cwd: root,
      agentDir,
      authStoragePath: join(root, "auth.json"),
    });
    await runner.run({
      bundle: TEST_BUNDLE,
      context: makeContext(),
      eventSink: createCaptureSink(),
    });
    return paths;
  } finally {
    if (server) await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

describe("PiRunner on a gateway model", () => {
  for (const apiShape of Object.keys(LLM_PROXY_ROUTES) as (keyof typeof LLM_PROXY_ROUTES)[]) {
    it(`reaches the ${apiShape} endpoint`, async () => {
      const { baseSuffix, sdkPath } = LLM_PROXY_ROUTES[apiShape];
      const paths = await requestPaths(apiShape);
      expect(paths.length).toBeGreaterThan(0);
      expect(new Set(paths)).toEqual(new Set([`${baseSuffix}${sdkPath}`]));
    });
  }
});
