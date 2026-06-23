// SPDX-License-Identifier: Apache-2.0

/**
 * Anonymizer module — reversible PII anonymization layer for Appstrate
 * (chat conversations + agent runs).
 *
 * The module is a pure, ISOLATED package. It ports two building blocks:
 *   - `InProcessDetector` — GLiNER2 (ONNX, in-Bun, no Python/torch) + regex +
 *     business deny-list + role-word stop-list, with reversible mask/restore.
 *   - `AnonSession` — the run-scoped correspondence table: the same real value
 *     keeps the same token end-to-end across one run, so restore stays
 *     consistent for both the LLM answer and tool args.
 *
 * It wires the LLM-proxy masking seam. The proxy is a fetch gateway (not a
 * `wrapLanguageModel`), so the module implements `LlmBodyTransformer` — masking
 * the outgoing request body (system + messages) and restoring each response
 * branch (JSON, SSE, error). The agent-run path reuses the SAME detector via
 * the `/internal/anonymize` endpoint, while the sidecar keeps the per-run mask
 * table locally (Option S) so restore stays a free, network-less lookup.
 *
 * Zero footprint when off: without the module in MODULES it never loads; even
 * loaded, the onnxruntime native binding is never pulled at boot — the detector
 * lazy-imports GLiNER on the first masked request.
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
