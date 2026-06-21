// SPDX-License-Identifier: Apache-2.0

// Middleware AI SDK : on enveloppe le modele UNE fois, tous les agents en heritent.
// Aller   : on masque le texte des messages avant l'envoi au LLM externe.
// Retour  : on restaure le texte de la reponse finale destinee a l'humain.
// (Les arguments d'outils, eux, sont restaures au niveau du wrapper d'outils.)
//
// Types laisses en `any` pour rester drop-in sans dependre d'une version precise
// du package `ai`. A l'integration : typer avec LanguageModelV2Middleware.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AnonSession } from "./run-session.ts";

export function createAnonymizerMiddleware(session: AnonSession) {
  return {
    // 1) Masquage des prompts sortants
    async transformParams({ params }: any) {
      if (Array.isArray(params.prompt)) {
        for (const message of params.prompt) {
          if (typeof message.content === "string") {
            message.content = await session.mask(message.content);
          } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
              if (part?.type === "text" && typeof part.text === "string") {
                part.text = await session.mask(part.text);
              }
            }
          }
        }
      }
      return params;
    },

    // 2) Restauration de la reponse non-streamee
    async wrapGenerate({ doGenerate }: any) {
      const result = await doGenerate();
      if (Array.isArray(result.content)) {
        for (const part of result.content) {
          if (part?.type === "text" && typeof part.text === "string") {
            part.text = await session.unmask(part.text);
          }
        }
      } else if (typeof result.text === "string") {
        result.text = await session.unmask(result.text);
      }
      return result;
    },

    // 3) Restauration de la reponse streamee (par chunk de texte)
    async wrapStream({ doStream }: any) {
      const { stream, ...rest } = await doStream();
      const transform = new TransformStream({
        async transform(chunk: any, controller: any) {
          if (chunk?.type === "text-delta" && typeof chunk.delta === "string") {
            // NB: le restore par delta est best-effort ; un jeton coupe en 2 deltas
            // ne sera pas restaure. Pour du streaming strict -> bufferiser par jeton.
            chunk.delta = await session.unmask(chunk.delta);
          }
          controller.enqueue(chunk);
        },
      });
      return { stream: stream.pipeThrough(transform), ...rest };
    },
  };
}
