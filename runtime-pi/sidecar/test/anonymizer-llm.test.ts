// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test of the b2.2b wiring: the REAL `/llm/*` reverse-proxy handler
 * (`createApp` → api_key flow → `passUpstream`) with a per-run anonymizer
 * injected. Boundaries are mocked (the platform `/internal/anonymize` endpoint
 * and the upstream LLM), so this exercises the exact critical-path code without
 * Docker / a real model.
 *
 * Asserts the round-trip: the upstream LLM receives a MASKED body (never the
 * real PII) and the agent receives a RESTORED response.
 */
import { describe, it, expect, mock } from "bun:test";
import { createApp, type AppDeps } from "../app.ts";
import { createRunAnonymizer } from "../anonymizer.ts";
import type { CredentialsResponse } from "../helpers.ts";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

/** Stand-in for POST /internal/anonymize: masks a fixed literal, threads the mapping. */
function fakeAnonEndpoint(terms: Record<string, string>): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const parsed = JSON.parse(init.body as string) as {
      body: string;
      mapping: Record<string, string>;
    };
    const map = { ...parsed.mapping };
    let counter = Object.keys(map).length;
    let out = unb64(parsed.body);
    for (const [literal, type] of Object.entries(terms)) {
      if (!out.includes(literal)) continue;
      const existing = Object.entries(map).find(([, v]) => v === literal)?.[0];
      const tok = existing ?? `[${type}_${++counter}]`;
      if (!existing) map[tok] = literal;
      out = out.split(literal).join(tok);
    }
    return new Response(JSON.stringify({ body: b64(out), mapping: map }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function baseDeps(fetchFn: typeof fetch, overrides?: Partial<AppDeps>): AppDeps {
  return {
    config: {
      platformApiUrl: "http://platform.test",
      runToken: "run-tok",
      proxyUrl: "",
      llm: {
        authMode: "api_key",
        baseUrl: "https://api.example.com",
        apiKey: "k",
        placeholder: "ph",
      },
    },
    fetchCredentials: mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "x" },
        authorizedUris: [],
        allowAllUris: false,
        credentialHeaderName: "Authorization",
        credentialHeaderPrefix: "Bearer",
        credentialFieldName: "access_token",
      }),
    ),
    cookieJar: new Map(),
    fetchFn,
    isReady: () => true,
    ...overrides,
  };
}

describe("/llm/* PII anonymization (b2.2b)", () => {
  it("masks the body the upstream LLM sees and restores the agent's response", async () => {
    let upstreamBody = "";
    const fetchFn = mock(async (_url: string, init: RequestInit) => {
      upstreamBody = init.body as string; // what the real LLM would receive
      // The model reasons in tokens, so it echoes the token it was given.
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "C'est noté pour [PERSON_1]." } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const anonymizer = createRunAnonymizer({
      endpointUrl: "http://platform.test/internal/anonymize",
      runToken: "run-tok",
      fetchImpl: fakeAnonEndpoint({ "Benjamin Macé": "PERSON" }),
    });

    const app = createApp(baseDeps(fetchFn, { anonymizer }));
    const res = await app.request("/llm/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mistral-large",
        messages: [{ role: "user", content: "Écris à Benjamin Macé." }],
      }),
    });

    expect(res.status).toBe(200);
    // 1) The upstream LLM NEVER saw the real PII — only a token.
    expect(upstreamBody).not.toContain("Benjamin Macé");
    expect(upstreamBody).toContain("[PERSON_1]");
    // 2) The agent gets the RESTORED response (real value back, no token).
    const agentSees = await res.text();
    expect(agentSees).toContain("Benjamin Macé");
    expect(agentSees).not.toContain("[PERSON_1]");
  });

  it("is a no-op on the response when no anonymizer is configured", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"choices":[{"message":{"content":"hi"}}]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const app = createApp(baseDeps(fetchFn)); // no anonymizer
    const res = await app.request("/llm/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Benjamin Macé" }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"choices":[{"message":{"content":"hi"}}]}');
  });
});
