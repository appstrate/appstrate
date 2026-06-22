// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `@appstrate/runner-codex` — the official OpenAI Codex CLI as an AFPS
 * {@link Runner}. Drives `codex` (ChatGPT subscription) runs as a subprocess
 * under Bun, with no fingerprint forging. The real subscription token is vended
 * in-container once at run start (the CLI talks to the upstream directly), and
 * outbound egress is locked to the provider's hosts by the sidecar's per-run
 * allowlist.
 */

export {
  CodexAgentRunner,
  buildCodexRunPrompt,
  type CodexAgentRunnerOptions,
  type CodexChild,
  type CodexSpawnFn,
} from "./codex-agent-runner.ts";
export { CodexRunEventMapper, computeCodexCost, type CodexModelCost } from "./run-event-mapper.ts";
export type { CodexEvent, CodexUsage } from "./codex-binary.ts";
