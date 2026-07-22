// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { redactConnectLinks } from "../src/connect-offer.ts";
import { wrapToolModelOutputs } from "../src/platform-mcp.ts";

const PLACEHOLDER = "[connect link hidden — the chat renders the connect card]";

describe("redactConnectLinks", () => {
  it("redacts a nested connect_url in a content-type text JSON, keeping other fields", () => {
    const body = {
      ok: true,
      offer: { connect_url: "https://app/api/integrations/connect/start?token=t", label: "Gmail" },
    };
    const out = redactConnectLinks({
      type: "content",
      value: [{ type: "text", text: JSON.stringify(body) }],
    }) as { type: string; value: Array<{ type: string; text: string }> };

    const parsed = JSON.parse(out.value[0].text) as typeof body;
    expect(parsed.offer.connect_url).toBe(PLACEHOLDER);
    expect(parsed.ok).toBe(true);
    expect(parsed.offer.label).toBe("Gmail");
  });

  it("redacts the camelCase authUrl variant", () => {
    const out = redactConnectLinks({
      type: "content",
      value: [{ type: "text", text: JSON.stringify({ authUrl: "https://x/y", state: "s" }) }],
    }) as { value: Array<{ text: string }> };
    const parsed = JSON.parse(out.value[0].text) as { authUrl: string; state: string };
    expect(parsed.authUrl).toBe(PLACEHOLDER);
    expect(parsed.state).toBe("s");
  });

  it("passes a non-JSON text part through byte-identical (same reference)", () => {
    const part = { type: "text", text: "just some prose, not JSON" };
    const input = { type: "content", value: [part] };
    const out = redactConnectLinks(input);
    // Nothing changed → original output reference returned.
    expect(out).toBe(input);
    expect((out as typeof input).value[0]).toBe(part);
  });

  it("passes JSON text with no connect fields through byte-identical", () => {
    const input = {
      type: "content",
      value: [{ type: "text", text: JSON.stringify({ hello: "world", nested: { a: 1 } }) }],
    };
    const out = redactConnectLinks(input);
    expect(out).toBe(input);
  });

  it("deep-redacts a {type:'json'} variant", () => {
    const out = redactConnectLinks({
      type: "json",
      value: { items: [{ auth_url: "https://accounts.google.com/o/oauth2" }], count: 1 },
    }) as { type: string; value: { items: Array<{ auth_url: string }>; count: number } };
    expect(out.value.items[0].auth_url).toBe(PLACEHOLDER);
    expect(out.value.count).toBe(1);
  });

  it("leaves a {type:'json'} with no connect fields byte-identical", () => {
    const input = { type: "json", value: { a: 1, b: { c: [2, 3] } } };
    expect(redactConnectLinks(input)).toBe(input);
  });

  it("redacts a connect_url in a {type:'text'} JSON value (belt-and-braces variant)", () => {
    const out = redactConnectLinks({
      type: "text",
      value: JSON.stringify({ ok: true, connect_url: "https://app/connect/start" }),
    }) as { type: string; value: string };
    const parsed = JSON.parse(out.value) as { ok: boolean; connect_url: string };
    expect(parsed.connect_url).toBe(PLACEHOLDER);
    expect(parsed.ok).toBe(true);
  });

  it("passes a {type:'text'} non-JSON value through byte-identical", () => {
    const input = { type: "text", value: "just prose, not JSON" };
    expect(redactConnectLinks(input)).toBe(input);
  });
});

describe("wrapToolModelOutputs", () => {
  it("leaves a tool without toModelOutput untouched and applies redaction to one that has it", () => {
    const plain = { description: "no model output", execute: () => ({ x: 1 }) };
    const withOutput = {
      description: "has model output",
      execute: () => ({ irrelevant: true }),
      toModelOutput: () => ({
        type: "content",
        value: [{ type: "text", text: JSON.stringify({ connect_url: "https://x/c" }) }],
      }),
    };

    const wrapped = wrapToolModelOutputs({ plain, withOutput } as never) as unknown as Record<
      string,
      {
        toModelOutput?: (args: { output: unknown }) => {
          value: Array<{ text: string }>;
        };
      }
    >;

    // The tool without toModelOutput is passed through unchanged (same reference).
    expect(wrapped.plain).toBe(plain as never);

    // The wrapped tool redacts over the original's output.
    const result = wrapped.withOutput.toModelOutput!({ output: undefined });
    const parsed = JSON.parse(result.value[0].text) as { connect_url: string };
    expect(parsed.connect_url).toBe(PLACEHOLDER);
  });
});
