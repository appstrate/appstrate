// SPDX-License-Identifier: Apache-2.0

// Seam LLM-proxy (palier b1) — preuve comportementale SANS GLiNER : un backend
// déterministe est injecté dans la session, ce qui isole la logique du seam
// (ciblage des champs masqués + restore + continuité des jetons) de la qualité
// du détecteur. Aucun onnxruntime, aucune table : test pur-logique.
import { describe, it, expect } from "bun:test";
import { AnonSession, type AnonBackend, type Mapping } from "../src/run-session.ts";
import { createLlmBodyTransformer, maskLlmRequestBody } from "../src/seam-llm.ts";

/** Backend déterministe : masque une liste fixe de littéraux, restore par table. */
function fakeBackend(terms: Record<string, string>): AnonBackend {
  return {
    async anonymize(text: string, mapping: Mapping = {}) {
      const map: Mapping = { ...mapping };
      const value2token: Record<string, string> = {};
      let counter = 0;
      for (const [tok, val] of Object.entries(map)) {
        value2token[val] = tok;
        const n = +tok.replace(/\D/g, "");
        if (n > counter) counter = n;
      }
      let out = text;
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
      return { text: out, mapping: map };
    },
    async restore(text: string, mapping: Mapping) {
      for (const [tok, val] of Object.entries(mapping)) text = text.split(tok).join(val);
      return text;
    },
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBytes = (o: unknown) => enc.encode(JSON.stringify(o));
const fromBytes = (u: Uint8Array) => JSON.parse(dec.decode(u));

describe("llm-proxy anonymization seam", () => {
  it("masks OpenAI message content but leaves model/role intact", async () => {
    const t = createLlmBodyTransformer(
      new AnonSession(fakeBackend({ "Benjamin Macé": "PERSON", Appstrate: "ORG" })),
    );
    const masked = fromBytes(
      await t.maskRequest(
        toBytes({
          model: "gpt-5.5",
          messages: [
            { role: "system", content: "Tu es utile." },
            { role: "user", content: "Écris à Benjamin Macé au sujet de Appstrate." },
          ],
        }),
      ),
    );
    expect(masked.model).toBe("gpt-5.5");
    expect(masked.messages[1].role).toBe("user");
    expect(JSON.stringify(masked)).not.toContain("Benjamin Macé");
    expect(masked.messages[1].content).toMatch(/\[PERSON_\d+\]/);
  });

  it("restores PII tokens the model echoes back in a JSON response", async () => {
    const t = createLlmBodyTransformer(
      new AnonSession(fakeBackend({ "Benjamin Macé": "PERSON", Appstrate: "ORG" })),
    );
    // build the mask table from a request first (same session)
    await t.maskRequest(
      toBytes({ messages: [{ role: "user", content: "Benjamin Macé / Appstrate" }] }),
    );
    const restored = await t.restoreResponse(
      JSON.stringify({ choices: [{ message: { content: "Fait pour [PERSON_1] chez [ORG_2]." } }] }),
    );
    expect(restored).toContain("Benjamin Macé");
    expect(restored).toContain("Appstrate");
  });

  it("masks Anthropic system + text parts, keeps the same token for the same value", async () => {
    const t = createLlmBodyTransformer(new AnonSession(fakeBackend({ "Benjamin Macé": "PERSON" })));
    const masked = fromBytes(
      await t.maskRequest(
        toBytes({
          model: "claude-opus-4-8",
          system: "Contexte sur Benjamin Macé.",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Relance Benjamin Macé." },
                { type: "image", source: { url: "x" } },
              ],
            },
          ],
        }),
      ),
    );
    expect(masked.system).not.toContain("Benjamin Macé");
    expect(masked.messages[0].content[0].text).not.toContain("Benjamin Macé");
    expect(masked.messages[0].content[1].source.url).toBe("x"); // non-text part untouched
    const tokenInSystem = masked.system.match(/\[PERSON_\d+\]/)?.[0];
    const tokenInPart = masked.messages[0].content[0].text.match(/\[PERSON_\d+\]/)?.[0];
    expect(tokenInSystem).toBeTruthy();
    expect(tokenInSystem).toBe(tokenInPart); // run-scoped continuity
  });

  it("forwards a non-JSON body untouched", async () => {
    const t = createLlmBodyTransformer(new AnonSession(fakeBackend({ Benjamin: "PERSON" })));
    const out = await t.maskRequest(enc.encode("pas du json Benjamin"));
    expect(dec.decode(out)).toBe("pas du json Benjamin");
  });

  it("masks Anthropic tool_result content fed back into the request (string and nested)", async () => {
    const t = createLlmBodyTransformer(new AnonSession(fakeBackend({ "Benjamin Macé": "PERSON" })));
    const masked = fromBytes(
      await t.maskRequest(
        toBytes({
          messages: [
            {
              role: "user",
              content: [
                { type: "tool_result", content: "Le client est Benjamin Macé" },
                { type: "tool_result", content: [{ type: "text", text: "aussi Benjamin Macé" }] },
              ],
            },
          ],
        }),
      ),
    );
    const parts = masked.messages[0].content;
    expect(parts[0].content).not.toContain("Benjamin Macé"); // string tool_result masked
    expect(parts[0].content).toMatch(/\[PERSON_\d+\]/);
    expect(parts[1].content[0].text).not.toContain("Benjamin Macé"); // nested tool_result masked
    expect(JSON.stringify(masked)).not.toContain("Benjamin Macé");
  });
});

describe("stateless maskLlmRequestBody (the /internal/anonymize endpoint seam)", () => {
  it("masks a body and returns the updated mapping (no session kept)", async () => {
    const { body, mapping } = await maskLlmRequestBody(
      fakeBackend({ "Benjamin Macé": "PERSON" }),
      toBytes({ messages: [{ role: "user", content: "Bonjour Benjamin Macé" }] }),
      {},
    );
    expect(fromBytes(body).messages[0].content).toMatch(/\[PERSON_\d+\]/);
    expect(Object.values(mapping)).toContain("Benjamin Macé");
  });

  it("reuses a seeded token across calls (run continuity — table lives in the caller)", async () => {
    const backend = fakeBackend({ "Benjamin Macé": "PERSON" });
    const first = await maskLlmRequestBody(
      backend,
      toBytes({ messages: [{ role: "user", content: "Benjamin Macé" }] }),
      {},
    );
    const seededToken = Object.keys(first.mapping)[0]!;
    // 2ᵉ appel SÉMÉ avec le mapping du 1er → même valeur ⇒ même jeton
    const second = await maskLlmRequestBody(
      backend,
      toBytes({ messages: [{ role: "user", content: "Encore Benjamin Macé" }] }),
      first.mapping,
    );
    expect(fromBytes(second.body).messages[0].content).toContain(seededToken);
    expect(Object.keys(second.mapping)).toHaveLength(1); // pas de doublon
  });
});
