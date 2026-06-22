// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `@appstrate/runner-claude` — the official Claude Agent SDK as an AFPS
 * {@link Runner}. Drives `claude-code` (Claude subscription) runs in-process
 * under Bun, with no fingerprint forging.
 */

export {
  ClaudeAgentRunner,
  type ClaudeAgentRunnerOptions,
  type ClaudeQueryFn,
  type ClaudeQueryInput,
} from "./claude-agent-runner.ts";
export {
  SdkRunEventMapper,
  type SdkRunMessage,
  type SdkTerminal,
  type SdkUsage,
} from "./sdk-event-mapper.ts";
