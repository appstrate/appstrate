// SPDX-License-Identifier: Apache-2.0

/**
 * Anonymizer module — reversible PII anonymization layer for Appstrate
 * (chat conversations + agent runs).
 *
 * ## Scope of THIS palier (a)
 *
 * The module is a pure, ISOLATED package. It ports four building blocks:
 *   - `InProcessDetector` — GLiNER2 (ONNX, in-Bun, no Python/torch) + regex +
 *     business deny-list + role-word stop-list, with reversible mask/restore.
 *   - `AnonSession` — the run-scoped correspondence table: the same real value
 *     keeps the same token end-to-end across one run, so restore-before-tool
 *     and restore-final stay consistent.
 *   - `createAnonymizerMiddleware` — AI-SDK middleware (mask prompts out,
 *     restore the human-facing answer).
 *   - `wrapTools…WithAnonymizer` — tool choke-point wrapper (restore args
 *     before execution, re-mask the result).
 *
 * It registers itself as a loadable module but wires NO platform seam yet.
 *
 * ## Why no seam yet (palier b)
 *
 * There is no module-level hook at the LLM proxy
 * (`apps/api/src/services/llm-proxy/core.ts` — a fetch gateway, not a
 * `wrapLanguageModel`) nor at the tool choke point
 * (`runtime-pi/sidecar/mcp-host.ts` `buildTools()`). Branching anonymization
 * there is NOT a wrapper drop-in — it requires DESIGNING a new core extension
 * point (e.g. `transformLlmRequest`/`transformLlmResponse` + a buildTools
 * transform) that this module implements. That is a deliberate architecture
 * decision, made at palier b.
 *
 * Until then the module loads, logs once, and stays a strict no-op: zero
 * footprint on every run, and the onnxruntime native binding is never loaded
 * at boot (the detector lazy-imports GLiNER on the first `anonymize()` call,
 * which cannot happen before the seam lands).
 *
 * Opt-in: append `@appstrate/module-anonymizer` to MODULES to enable.
 */

import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";
import { llmBodyTransformerFactory } from "./seam-llm.ts";

const anonymizerModule: AppstrateModule = {
  manifest: { id: "anonymizer", name: "Anonymizer (reversible PII)", version: "0.1.0" },

  async init(ctx: ModuleInitContext) {
    // The GLiNER detector loads lazily on the first masked request — boot
    // itself never pulls the onnxruntime native binding.
    ctx.services.logger.info("anonymizer module loaded — LLM-proxy masking seam active");
  },

  // The llm-proxy anonymization seam (palier b1): a stable factory whose
  // shared detector is reused across requests; each request gets a fresh
  // session. The buildTools / agent-run paths land in palier b2.
  llmBodyTransformer() {
    return llmBodyTransformerFactory;
  },
};

export default anonymizerModule;
