// SPDX-License-Identifier: Apache-2.0

/**
 * One projection of a non-string credential at the three doors a value passes: a login input
 * rendered into the request, a login output stored, and a stored credential read back. A string
 * passes through, any other JSON value is its JSON text, and `null` is an absent credential.
 */

import { describe, it, expect } from "bun:test";
import { runLogin, type LoginConfig } from "../../src/connect/index.ts";
import { toCredentialStringMap } from "../../src/integration-credentials.ts";

const VALUES = {
  text: "plain",
  port: 5432,
  tls: true,
  hosts: ["a,b", "c"],
  options: { retries: 3 },
};
const NAMES = Object.keys(VALUES);

/** A login echoing its inputs back, one per line, and extracting each as an output. */
const config: LoginConfig = {
  login: {
    request: {
      method: "POST",
      url: "https://idp.example.com/login",
      content_type: "text/plain",
      body: NAMES.map((name) => `{{${name}}}`).join("\n"),
    },
    outputs: Object.fromEntries(NAMES.map((name) => [name, `$response.body#/${name}`])),
  },
};

async function login(inputs: Record<string, unknown>, answer: unknown) {
  const sent: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sent.push(String(init?.body));
    return new Response(JSON.stringify(answer));
  }) as unknown as typeof fetch;
  const result = await runLogin(config, {
    inputs,
    authorizedUris: ["https://idp.example.com/**"],
    allowAllUris: false,
    fetchImpl,
    resolveHost: async () => ["93.184.216.34"],
  }).catch((err: unknown) => err);
  return { sent, result };
}

describe("non-string credentials — one projection at every door", () => {
  const read = toCredentialStringMap(VALUES);

  it("renders a login input, stores a login output and reads a credential as the same text", async () => {
    const { sent, result } = await login(VALUES, VALUES);

    expect(sent).toEqual([NAMES.map((name) => read[name]).join("\n")]);
    expect(result).toMatchObject({ outputs: read });
    expect(read).toEqual({
      text: "plain",
      port: "5432",
      tls: "true",
      hosts: '["a,b","c"]',
      options: '{"retries":3}',
    });
  });

  it("treats `null` as an absent credential at each: never the text `null`", async () => {
    expect(toCredentialStringMap({ ...VALUES, port: null })).not.toHaveProperty("port");

    const input = await login({ ...VALUES, port: null }, VALUES);
    expect(input.result).toMatchObject({ reason: "unresolved_placeholder" });
    expect(input.sent).toEqual([]);

    const output = await login(VALUES, { ...VALUES, port: null });
    expect(output.result).toMatchObject({ reason: "extract_failed" });
  });
});
