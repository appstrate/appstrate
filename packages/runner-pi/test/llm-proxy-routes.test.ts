// SPDX-License-Identifier: Apache-2.0

/**
 * The table's own invariant, asserted as a property over every entry rather
 * than as three pinned strings.
 *
 * Before this file the table had no direct test at all. Coverage was entirely
 * indirect and entirely literal: `pi-chat-model-binding.test.ts` and the CLI's
 * `run-model.test.ts` each pin the three base URLs by hand, and the API's
 * integration suite requests the three mounted paths by hand. Three suites, in
 * three packages, none of which a fourth table entry would reach — so a new
 * shape could ship with its client base and its server mount disagreeing and
 * nothing would notice until a real caller 404'd.
 */

import { describe, expect, it } from "bun:test";
import {
  LLM_PROXY_ROUTES,
  isProxiedApiShape,
  llmProxyBaseUrl,
  llmProxyUrlPath,
  type ProxiedApiShape,
} from "../src/llm-proxy-routes.ts";

const ORIGIN = "https://api.example.com";
const SHAPES = Object.keys(LLM_PROXY_ROUTES) as ProxiedApiShape[];

describe("llm-proxy route table", () => {
  it("holds at least one shape — an empty table would make every case below vacuous", () => {
    expect(SHAPES.length).toBeGreaterThan(0);
  });

  for (const shape of SHAPES) {
    // THE invariant: what the client is pointed at, plus what the vendor SDK
    // appends, is exactly what the server mounts. `apps/api` mounts
    // `llmProxyUrlPath`, chat and the CLI point their clients at
    // `llmProxyBaseUrl`, and nothing else forces the two to agree.
    //
    // Be precise about what this catches, because it is narrower than it looks:
    // both sides read the same ROW, so no table content can break it. What it
    // pins is the two FUNCTION BODIES against each other — the mount prefix,
    // the segment order, and above all that both spend `baseSuffix` exactly
    // once. Dropping it from `llmProxyUrlPath` fails this case; so does moving
    // the `/api/llm-proxy` mount on one side only. It has teeth only for a row
    // whose `baseSuffix` is non-empty (`openai-completions` today), which is
    // also the only row where the two functions can disagree at all.
    it(`${shape}: client base + sdkPath === server mount`, () => {
      const base = llmProxyBaseUrl(ORIGIN, shape);
      expect(base).not.toBeNull();
      const clientUrl = `${base!}${LLM_PROXY_ROUTES[shape].sdkPath}`;
      expect(clientUrl).toBe(`${ORIGIN}/api/llm-proxy${llmProxyUrlPath(shape)}`);
    });
  }

  it("refuses a shape the table does not carry", () => {
    expect(isProxiedApiShape("openai-codex-responses")).toBe(false);
    expect(llmProxyBaseUrl(ORIGIN, "openai-codex-responses")).toBeNull();
  });

  it("normalises a trailing slash on the origin", () => {
    // The doc says "no trailing slash" but the function did not enforce it, and
    // only one of the two callers trimmed: the CLI did, chat passed
    // `CHAT_SELF_ORIGIN` — an operator-set value — straight through. A
    // precondition documented in three places and honoured in two is a bug
    // waiting on whoever sets the variable with a slash.
    for (const shape of SHAPES) {
      expect(llmProxyBaseUrl(`${ORIGIN}/`, shape)).toBe(llmProxyBaseUrl(ORIGIN, shape));
    }
  });
});
