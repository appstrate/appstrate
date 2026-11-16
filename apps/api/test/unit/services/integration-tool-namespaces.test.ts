// SPDX-License-Identifier: Apache-2.0
/**
 * The names of the integration tools callable outside a run: distinct namespaces never yield the
 * same `{ns}__{body}` name, a namespace depends on the space's integrations alone, and a typed
 * tool's body on its upstream name alone.
 */
import { describe, it, expect } from "bun:test";
import { fnv1a64Hex, isValidMcpToolName } from "@appstrate/afps-shared/mcp-naming";
import {
  integrationNamespaces,
  remoteToolName,
} from "../../../src/services/credential-proxy/integration-tools.ts";

const hash = (id: string, length = 6) => fnv1a64Hex(id).slice(0, length);

/** Every tool name of `tools` (integration id → upstream names), as a listing names them. */
function toolNames(tools: Record<string, string[]>): string[] {
  const namespaces = integrationNamespaces(Object.keys(tools));
  return Object.entries(tools).flatMap(([id, upstream]) =>
    upstream.map((name) => remoteToolName(namespaces.get(id)!, name)),
  );
}

describe("remoteToolName", () => {
  it("keeps an upstream name that is already a valid body as it is", () => {
    expect(remoteToolName("acme_docs", "files_read")).toBe("acme_docs__files_read");
    expect(remoteToolName("acme_docs", "_tool")).toBe("acme_docs___tool");
    expect(remoteToolName("acme_docs", "Get-Item")).toBe("acme_docs__Get-Item");
  });

  it("always hashes a transformed name, so it never takes another's plain form", () => {
    expect(remoteToolName("acme_docs", "files.read")).toBe(
      `acme_docs__files_read_${hash("files.read", 8)}`,
    );
    expect(remoteToolName("acme_docs", "files.read")).not.toBe(
      remoteToolName("acme_docs", "files_read"),
    );
  });

  it("never names an upstream tool as the platform's own `api_call` / `api_upload` tools", () => {
    for (const upstream of ["api_call", "api_upload", "api_call__oauth", "api_upload__key"]) {
      const name = remoteToolName("acme_docs", upstream);
      const body = name.slice("acme_docs__".length);
      expect(body).not.toBe("api_call");
      expect(body).not.toBe("api_upload");
      expect(body.startsWith("api_call__")).toBe(false);
      expect(body.startsWith("api_upload__")).toBe(false);
      expect(body.endsWith(hash(upstream, 8))).toBe(true);
    }
  });

  it("bounds every name to the grammar and its length, the hash kept whole", () => {
    const namespace = `acme_abcdefghijklmno_${hash("x", 16)}`;
    for (const upstream of ["x".repeat(120), "a.b".repeat(40), "é".repeat(30), ""]) {
      const name = remoteToolName(namespace, upstream);
      expect(isValidMcpToolName(name)).toBe(true);
      expect(name.endsWith(hash(upstream, 8))).toBe(true);
    }
  });
});

/** The bodies of the platform's own tools: no typed tool's body is one or starts with one. */
const RESERVED = ["api_call", "api_upload"];
const isReserved = (body: string) =>
  RESERVED.some((name) => body === name || body.startsWith(`${name}__`));

/** A deterministic xorshift32 stream: the same names on every run. */
function* names(seed: number, count: number): Generator<string> {
  const alphabet = ["a", "Z", "0", "9", "f", "_", "-", ".", "?", "é", " ", "/", "__"];
  const stems = ["", "api_call", "api_upload", "api_call__", "api_upload__", "x", "_"];
  let state = seed;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let i = 0; i < count; i++) {
    let name = stems[next() % stems.length]!;
    const length = next() % 70;
    for (let j = 0; j < length; j++) name += alphabet[next() % alphabet.length]!;
    if (next() % 4 === 0) name += `_${fnv1a64Hex(name).slice(0, 8)}`;
    yield name;
  }
}

describe("remoteToolName, for every upstream name", () => {
  const explicit = [
    "api_call.",
    "api_uploadé",
    "api_call__",
    "api_call?",
    "a.b",
    "export_20240101",
  ];

  it("is valid, never reserved, and a hashed body holds no `__`, whatever the namespace length", () => {
    const upstream = [...explicit, ...names(0x2206, 3_000)];
    for (let length = 1; length <= 37; length++) {
      const namespace = "n".repeat(length);
      for (const raw of upstream) {
        const name = remoteToolName(namespace, raw);
        expect(isValidMcpToolName(name)).toBe(true);
        expect(name.length).toBeLessThanOrEqual(56);
        const body = name.slice(namespace.length + 2);
        expect(isReserved(body)).toBe(false);
        if (body !== raw) expect(body.includes("__")).toBe(false);
      }
    }
  });

  it("gives a reserved-looking name a hashed body that is no reserved form", () => {
    for (const raw of ["api_call.", "api_uploadé", "api_call__", "api_call?"]) {
      const body = remoteToolName("a", raw).slice("a__".length);
      expect(body).toMatch(new RegExp(`^api_(call|upload)_${hash(raw, 8)}$`));
    }
  });

  it("never exposes a raw name shaped like a hashed body under its plain form", () => {
    const shaped = `a_b_${hash("a.b", 8)}`;
    expect(remoteToolName("gh", "a.b")).toBe(`gh__${shaped}`);
    expect(remoteToolName("gh", shaped)).toBe(`gh__${shaped}_${hash(shaped, 8)}`);
    expect(remoteToolName("gh", "export_20240101")).toBe(
      `gh__export_20240101_${hash("export_20240101", 8)}`,
    );
    expect(remoteToolName("gh", "deadbeef")).toBe(`gh__deadbeef_${hash("deadbeef", 8)}`);
  });

  it("never gives a plain name and a hashed name the same exposed name", () => {
    const upstream = [...explicit, ...names(0x2209, 3_000)];
    for (const namespace of ["gh", "n".repeat(37)]) {
      const plain = new Set<string>();
      const hashed = new Set<string>();
      for (const raw of upstream) {
        const name = remoteToolName(namespace, raw);
        (name === `${namespace}__${raw}` && !/(?:^|_)[0-9a-f]{8}$/.test(raw) ? plain : hashed).add(
          name,
        );
      }
      for (const name of plain) expect(hashed.has(name)).toBe(false);
    }
  });
});

describe("integrationNamespaces", () => {
  it("hashes apart a namespace the length cut leaves equal to another, its trailing `_` dropped", () => {
    const cut = "@acme/abcdefghijklmn-op";
    const plain = "@acme/abcdefghijklmn";
    const namespaces = integrationNamespaces([cut, plain]);
    expect(namespaces.get(cut)).toBe(`acme_abcdefghijklmn_${hash(cut)}`);
    expect(namespaces.get(plain)).toBe(`acme_abcdefghijklmn_${hash(plain)}`);
    // `tool` of one and `_tool` of the other once both became `acme_abcdefghijklmn___tool`.
    const names = toolNames({ [cut]: ["tool"], [plain]: ["_tool"] });
    expect(new Set(names).size).toBe(2);
  });

  it("hashes apart a plain namespace equal to another's hashed one, until none is equal", () => {
    const ids = ["@acme/docs-x", "@acme-docs/x", `@acme/docs-x-${hash("@acme/docs-x")}`];
    const namespaces = integrationNamespaces(ids);
    expect(new Set(namespaces.values()).size).toBe(3);
    // The first two clash (`acme_docs_x`); the third then equals the first's hashed namespace.
    expect(namespaces.get("@acme-docs/x")).toBe(`acme_docs_x_${hash("@acme-docs/x")}`);
    expect(namespaces.get(ids[2]!)).toBe(`acme_docs_x_${hash("@acme/docs-x")}_${hash(ids[2]!)}`);
    expect(namespaces.get("@acme/docs-x")).toBe(`acme_docs_x_${hash("@acme/docs-x", 8)}`);
  });

  it("hashes apart three integrations whose ids normalise alike", () => {
    const ids = ["@acme/mail-x", "@acme-mail/x", "@acme/mail--x"];
    const namespaces = integrationNamespaces(ids);
    expect([...namespaces.values()].sort()).toEqual(
      ids.map((id) => `acme_mail_x_${hash(id)}`).sort(),
    );
    expect(new Set(toolNames(Object.fromEntries(ids.map((id) => [id, ["send"]])))).size).toBe(3);
  });

  it("keeps a namespace no other equals as it normalises", () => {
    const namespaces = integrationNamespaces(["@acme/gmail", "@acme/gmail-extra"]);
    expect(namespaces.get("@acme/gmail")).toBe("acme_gmail");
    expect(namespaces.get("@acme/gmail-extra")).toBe("acme_gmail_extra");
  });

  it("depends on the set of ids, never on their order", () => {
    const ids = [
      "@acme/abcdefghijklmn-op",
      "@acme/abcdefghijklmn",
      "@acme/docs-x",
      "@acme-docs/x",
      `@acme/docs-x-${hash("@acme/docs-x")}`,
      "@appstrate/microsoft-outlook",
      "@appstrate/microsoft-teams",
    ];
    const forward = integrationNamespaces(ids);
    const backward = integrationNamespaces([...ids].reverse());
    for (const id of ids) expect(backward.get(id)).toBe(forward.get(id)!);
  });

  it("gives no two integrations' tools the same name, whatever the ids and upstream names", () => {
    const ids = [
      "@acme/abcdefghijklmn-op",
      "@acme/abcdefghijklmn",
      "@acme/abcdefghijklmn-o",
      "@acme/docs-x",
      "@acme-docs/x",
      `@acme/docs-x-${hash("@acme/docs-x")}`,
      "@acme/docs-x-y",
      "@acme/docs--x",
      "@appstrate/microsoft-outlook",
      "@appstrate/microsoft-teams",
      "@appstrate/microsoft",
    ];
    const upstream = ["tool", "_tool", "__tool", "x__tool", "op__tool", "tool.x", "api_call"];
    const names = toolNames(Object.fromEntries(ids.map((id) => [id, upstream])));
    expect(new Set(names).size).toBe(names.length);
    // Structurally: no namespace holds `__` or ends with `_`, so none prefixes another's names.
    for (const namespace of integrationNamespaces(ids).values()) {
      expect(namespace.includes("__")).toBe(false);
      expect(namespace.endsWith("_")).toBe(false);
    }
  });
});
