// SPDX-License-Identifier: Apache-2.0

// Implémentation du seam LLM-proxy (palier b1).
//
// Le proxy (`apps/api/.../llm-proxy/core.ts`) construit UN transformer par
// appel via la factory, masque le corps sortant, et restaure chaque branche
// de réponse (JSON, SSE, erreur) à travers lui.
//
// - Masquage ALLER : ciblé sur les champs porteurs de texte utilisateur —
//   `system` + `messages[].content` (couvre OpenAI chat/completions et
//   Anthropic messages, content = string OU tableau de parts {type:"text"}).
//   On ne masque JAMAIS la structure JSON (model, role, noms d'outils) : GLiNER
//   voit du texte propre et le LLM garde un payload intact hors PII.
// - Restore RETOUR : remplacement de jetons EN AVEUGLE sur tout le corps. Les
//   jetons `[TYPE_N]` sont non ambigus → un simple split/join est sûr et
//   suffit, sans reparser le JSON.
//
// Détecteur GLiNER PARTAGÉ (le modèle se charge une fois, paresseusement) ;
// session FRAÎCHE par appel (table de correspondance propre à la requête).
/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  LlmBodyTransformer,
  LlmBodyTransformerFactory,
  LlmBodyTransformContext,
} from "@appstrate/core/module";
import { InProcessDetector } from "./detector.ts";
import { AnonSession, type AnonBackend, type Mapping } from "./run-session.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Masque les parts porteuses de texte d'un tableau de content :
 *   - `{type:"text", text}` (texte normal)
 *   - `{type:"tool_result", content}` (Anthropic) — RÉSULTAT d'outil renvoyé au
 *     LLM au tour suivant : il peut porter de la PII fraîche, on le masque pour
 *     que le modèle ne la revoie jamais. `content` = string OU tableau de parts.
 * (Mistral/OpenAI mettent les résultats d'outils dans un `content` string de
 * message → couverts par la branche string de `maskField`.)
 */
async function maskContentParts(session: AnonSession, parts: any[]): Promise<void> {
  for (const part of parts) {
    if (part?.type === "text" && typeof part.text === "string") {
      part.text = await session.mask(part.text);
    } else if (part?.type === "tool_result") {
      if (typeof part.content === "string") {
        part.content = await session.mask(part.content);
      } else if (Array.isArray(part.content)) {
        await maskContentParts(session, part.content);
      }
    }
  }
}

/** Masque `obj[key]` si c'est une string OU un tableau de parts de content. */
async function maskField(session: AnonSession, obj: any, key: string): Promise<void> {
  const value = obj?.[key];
  if (typeof value === "string") {
    obj[key] = await session.mask(value);
  } else if (Array.isArray(value)) {
    await maskContentParts(session, value);
  }
}

/** Parse → masque system + messages[].content → re-sérialise. Non-JSON = intact. */
async function maskRequestBody(session: AnonSession, body: Uint8Array): Promise<Uint8Array> {
  let payload: any;
  try {
    payload = JSON.parse(decoder.decode(body));
  } catch {
    return body; // pas du JSON (ex. multipart) → on ne touche pas
  }
  if (!payload || typeof payload !== "object") return body;
  await maskField(session, payload, "system");
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) await maskField(session, message, "content");
  }
  return encoder.encode(JSON.stringify(payload));
}

class AnonLlmBodyTransformer implements LlmBodyTransformer {
  constructor(private session: AnonSession) {}

  maskRequest(body: Uint8Array): Promise<Uint8Array> {
    return maskRequestBody(this.session, body);
  }

  restoreResponse(text: string): Promise<string> {
    return this.session.unmask(text);
  }

  restoreResponseStream(): TransformStream<Uint8Array, Uint8Array> {
    const session = this.session;
    // Décodeur à état pour ne pas couper un caractère multi-octets entre chunks.
    // NB best-effort : un jeton coupé entre deux chunks ne sera pas restauré.
    const streamDecoder = new TextDecoder();
    return new TransformStream({
      async transform(chunk, controller) {
        const restored = await session.unmask(streamDecoder.decode(chunk, { stream: true }));
        controller.enqueue(encoder.encode(restored));
      },
    });
  }
}

/** Lie un transformer à une session donnée (= unité testable du seam). */
export function createLlmBodyTransformer(session: AnonSession): LlmBodyTransformer {
  return new AnonLlmBodyTransformer(session);
}

/**
 * Masque UN corps de requête LLM de façon stateless : on sème une session
 * jetable avec `mapping`, on masque (system + messages content), on rend le
 * mapping mis à jour. `backend` injectable → testable sans GLiNER.
 */
export async function maskLlmRequestBody(
  backend: AnonBackend,
  body: Uint8Array,
  mapping: Mapping,
): Promise<{ body: Uint8Array; mapping: Mapping }> {
  const session = new AnonSession(backend, mapping);
  const masked = await maskRequestBody(session, body);
  return { body: masked, mapping: session.table() };
}

// Détecteur partagé sur tout le process : le modèle GLiNER ne se charge qu'une
// fois (paresseux), à la première vraie requête anonymisée.
const sharedDetector = new InProcessDetector();

export const llmBodyTransformerFactory: LlmBodyTransformerFactory = {
  create(_ctx: LlmBodyTransformContext): LlmBodyTransformer {
    return createLlmBodyTransformer(new AnonSession(sharedDetector));
  },

  // Stateless mask pour l'endpoint /internal/anonymize (sidecar, b2) : délègue
  // à maskLlmRequestBody avec le détecteur partagé. Aucune session conservée.
  maskLlmBody(body: Uint8Array, mapping: Mapping): Promise<{ body: Uint8Array; mapping: Mapping }> {
    return maskLlmRequestBody(sharedDetector, body, mapping);
  },
};
