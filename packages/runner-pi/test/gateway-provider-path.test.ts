// SPDX-License-Identifier: Apache-2.0

/**
 * A gateway model (no Pi provider — `openai-compatible`, `anthropic-compatible`)
 * falls back to `deriveProviderFromApi`, which may name a Pi builtin that does
 * not serve the model's api: `openai` streams Responses only. A run must still
 * reach its api shape's endpoint — `openai-completions` POSTed `/responses`
 * instead of `/chat/completions`, and the sidecar refused it with a 404.
 */

import { describe, expect, it } from "bun:test";
import { LLM_PROXY_ROUTES } from "../src/llm-proxy-routes.ts";
import { runAgainstStub, stubGatewayModel } from "./helpers.ts";

/** The path of every request a run makes against a gateway model of `apiShape`. */
async function requestPaths(apiShape: keyof typeof LLM_PROXY_ROUTES): Promise<string[]> {
  const { requests } = await runAgainstStub({ model: stubGatewayModel(apiShape) });
  return requests.map((request) => request.path);
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
