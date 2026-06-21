// SPDX-License-Identifier: Apache-2.0

/**
 * Sidecar RunAnonymizer (palier b2 — Option S).
 *
 * Le masquage passe par un faux endpoint `/internal/anonymize` injecté ; le
 * restore est LOCAL (assertion centrale : il n'appelle JAMAIS le réseau). On
 * vérifie aussi la continuité de la table entre deux appels et le fail-closed.
 */
import { describe, it, expect } from "bun:test";
import { createRunAnonymizer, wrapToolHandler } from "../anonymizer.ts";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

/** Faux endpoint qui masque une liste fixe de littéraux + fusionne la table,
 *  comme le vrai `/internal/anonymize`. Compte ses appels. */
function fakeEndpoint(terms: Record<string, string>) {
  const calls: Array<{ auth: string | null; body: string; mapping: Record<string, string> }> = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const parsed = JSON.parse(init.body as string) as {
      body: string;
      mapping: Record<string, string>;
    };
    calls.push({
      auth: new Headers(init.headers).get("authorization"),
      body: unb64(parsed.body),
      mapping: parsed.mapping,
    });
    const map = { ...parsed.mapping };
    const value2token: Record<string, string> = {};
    let counter = 0;
    for (const [tok, val] of Object.entries(map)) {
      value2token[val] = tok;
      const n = +tok.replace(/\D/g, "");
      if (n > counter) counter = n;
    }
    let out = unb64(parsed.body);
    for (const [literal, type] of Object.entries(terms)) {
      if (!out.includes(literal)) continue;
      let tok = value2token[literal];
      if (!tok) {
        tok = `[${type}_${++counter}]`;
        map[tok] = literal;
        value2token[literal] = tok;
      }
      out = out.split(literal).join(tok);
    }
    return new Response(JSON.stringify({ body: b64(out), mapping: map }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("sidecar RunAnonymizer", () => {
  it("masks a body via the endpoint (auth + base64) and returns the decoded result", async () => {
    const ep = fakeEndpoint({ "Benjamin Macé": "PERSON" });
    const anon = createRunAnonymizer({
      endpointUrl: "http://platform/internal/anonymize",
      runToken: "tok-123",
      fetchImpl: ep.impl,
    });
    const body = JSON.stringify({ messages: [{ role: "user", content: "Salut Benjamin Macé" }] });
    const masked = await anon.maskBody(body);
    expect(masked).toMatch(/\[PERSON_\d+\]/);
    expect(masked).not.toContain("Benjamin Macé");
    expect(ep.calls).toHaveLength(1);
    expect(ep.calls[0]!.auth).toBe("Bearer tok-123");
    expect(ep.calls[0]!.body).toContain("Benjamin Macé"); // envoyé en base64, décodé ici
  });

  it("restores LOCALLY — no network call", async () => {
    const ep = fakeEndpoint({ "Benjamin Macé": "PERSON" });
    const anon = createRunAnonymizer({
      endpointUrl: "http://platform/internal/anonymize",
      runToken: "tok",
      fetchImpl: ep.impl,
    });
    await anon.maskBody(JSON.stringify({ messages: [{ role: "user", content: "Benjamin Macé" }] }));
    const callsAfterMask = ep.calls.length;
    const restored = anon.restore("Le modèle a écrit [PERSON_1] dans sa réponse.");
    expect(restored).toContain("Benjamin Macé");
    expect(ep.calls.length).toBe(callsAfterMask); // RESTORE = zéro réseau
  });

  it("keeps run continuity: same value → same token across calls", async () => {
    const ep = fakeEndpoint({ "Benjamin Macé": "PERSON" });
    const anon = createRunAnonymizer({
      endpointUrl: "http://platform/internal/anonymize",
      runToken: "tok",
      fetchImpl: ep.impl,
    });
    const first = await anon.maskBody(
      JSON.stringify({ messages: [{ role: "user", content: "Benjamin Macé" }] }),
    );
    const token = first.match(/\[PERSON_\d+\]/)![0];
    // 2ᵉ appel : la table accumulée est renvoyée à l'endpoint → même jeton
    const second = await anon.maskBody(
      JSON.stringify({ messages: [{ role: "user", content: "Re Benjamin Macé" }] }),
    );
    expect(second).toContain(token);
    expect(ep.calls[1]!.mapping[token]).toBe("Benjamin Macé"); // table threadée
  });

  it("fails CLOSED when the endpoint errors (no PII leak)", async () => {
    const failing = (async () => new Response("boom", { status: 503 })) as unknown as typeof fetch;
    const anon = createRunAnonymizer({
      endpointUrl: "http://platform/internal/anonymize",
      runToken: "tok",
      fetchImpl: failing,
    });
    await expect(anon.maskBody(JSON.stringify({ messages: [] }))).rejects.toThrow(/503/);
  });

  it("restores an SSE stream locally, chunk by chunk", async () => {
    const ep = fakeEndpoint({ "Benjamin Macé": "PERSON" });
    const anon = createRunAnonymizer({
      endpointUrl: "http://platform/internal/anonymize",
      runToken: "tok",
      fetchImpl: ep.impl,
    });
    await anon.maskBody(JSON.stringify({ messages: [{ role: "user", content: "Benjamin Macé" }] }));
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"delta":"[PERSON_1]"}\n\n'));
        c.close();
      },
    });
    const out = source.pipeThrough(anon.restoreStream());
    const reader = out.getReader();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    expect(text).toContain("Benjamin Macé");
  });
});

// ---- Tool path (b2.3) ----

/** Fake endpoint that masks fixed literals in BOTH a base64 `body` and a deep
 *  `value`, threading the mapping (stand-in for /internal/anonymize). */
function fakeEndpoint2(terms: Record<string, string>): typeof fetch {
  const maskText = (
    text: string,
    map: Record<string, string>,
    v2t: Record<string, string>,
    ctr: { n: number },
  ): string => {
    let out = text;
    for (const [literal, type] of Object.entries(terms)) {
      if (!out.includes(literal)) continue;
      let tok = v2t[literal];
      if (!tok) {
        tok = `[${type}_${++ctr.n}]`;
        map[tok] = literal;
        v2t[literal] = tok;
      }
      out = out.split(literal).join(tok);
    }
    return out;
  };
  const maskDeep = (
    value: unknown,
    map: Record<string, string>,
    v2t: Record<string, string>,
    ctr: { n: number },
  ): unknown => {
    if (typeof value === "string") return maskText(value, map, v2t, ctr);
    if (Array.isArray(value)) return value.map((v) => maskDeep(v, map, v2t, ctr));
    if (value && typeof value === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) o[k] = maskDeep(v, map, v2t, ctr);
      return o;
    }
    return value;
  };
  return (async (_url: string, init: RequestInit) => {
    const p = JSON.parse(init.body as string) as {
      body?: string;
      value?: unknown;
      mapping: Record<string, string>;
    };
    const map = { ...p.mapping };
    const v2t: Record<string, string> = {};
    const ctr = { n: 0 };
    for (const [tok, val] of Object.entries(map)) {
      v2t[val] = tok;
      const n = +tok.replace(/\D/g, "");
      if (n > ctr.n) ctr.n = n;
    }
    const ok = (b: Record<string, unknown>) =>
      new Response(JSON.stringify(b), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (p.body !== undefined)
      return ok({ body: b64(maskText(unb64(p.body), map, v2t, ctr)), mapping: map });
    return ok({ value: maskDeep(p.value, map, v2t, ctr), mapping: map });
  }) as unknown as typeof fetch;
}

describe("sidecar RunAnonymizer — tool path (b2.3)", () => {
  const opts = (impl: typeof fetch) => ({
    endpointUrl: "http://platform/internal/anonymize",
    runToken: "tok",
    fetchImpl: impl,
  });

  it("maskDeep masks every string in a nested value via the endpoint", async () => {
    const anon = createRunAnonymizer(opts(fakeEndpoint2({ "Benjamin Macé": "PERSON" })));
    const out = (await anon.maskDeep({ note: "appelle Benjamin Macé", l: ["Benjamin Macé"] })) as {
      note: string;
      l: string[];
    };
    expect(out.note).toMatch(/\[PERSON_\d+\]/);
    expect(out.l[0]).toMatch(/\[PERSON_\d+\]/);
    expect(JSON.stringify(out)).not.toContain("Benjamin Macé");
  });

  it("restoreDeep restores nested strings LOCALLY", async () => {
    const anon = createRunAnonymizer(opts(fakeEndpoint2({ "Benjamin Macé": "PERSON" })));
    await anon.maskBody(JSON.stringify({ messages: [{ role: "user", content: "Benjamin Macé" }] }));
    const restored = anon.restoreDeep({ a: "[PERSON_1]", b: ["x [PERSON_1]"] }) as {
      a: string;
      b: string[];
    };
    expect(restored.a).toBe("Benjamin Macé");
    expect(restored.b[0]).toBe("x Benjamin Macé");
  });

  it("wrapToolHandler: the tool gets REAL args, the LLM gets a re-masked result", async () => {
    const anon = createRunAnonymizer(
      opts(fakeEndpoint2({ "Benjamin Macé": "PERSON", "ben@x.fr": "EMAIL" })),
    );
    // The LLM was shown tokens for these values (seed the run mapping).
    const masked = await anon.maskBody(
      JSON.stringify({ messages: [{ role: "user", content: "Benjamin Macé ben@x.fr" }] }),
    );
    const personTok = masked.match(/\[PERSON_\d+\]/)![0];
    const emailTok = masked.match(/\[EMAIL_\d+\]/)![0];

    let received: { to: string; name: string } | null = null;
    const tool = {
      name: "sendEmail",
      handler: async (a: { to: string; name: string }, _extra: unknown) => {
        received = a;
        return { content: [{ type: "text", text: `Envoyé à ${a.to} (${a.name})` }] };
      },
    };
    const wrapped = wrapToolHandler(tool, anon);
    // The LLM calls the tool with TOKENS in the args.
    const out = await wrapped.handler({ to: emailTok, name: personTok }, {});

    expect(received!.to).toBe("ben@x.fr"); // tool acted on the REAL value
    expect(received!.name).toBe("Benjamin Macé");
    const outStr = JSON.stringify(out);
    expect(outStr).toContain(emailTok); // result re-masked → the LLM only sees a token
    expect(outStr).not.toContain("ben@x.fr"); // no real PII flows back to the model
  });
});
