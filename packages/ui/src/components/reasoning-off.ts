// SPDX-License-Identifier: Apache-2.0

/**
 * Whether reasoning level `off` puts nothing on the wire for a model, leaving
 * reasoning to the server: Pi's chat-completions request for a model it keeps
 * no record of sends no `reasoning_effort` at all. An alias names neither, so
 * it is never one. Parity with the payload Pi builds is pinned by
 * `packages/runner-pi/test/reasoning-off-parity.test.ts`.
 */
export function reasoningOffSendsNothing(model: {
  apiShape?: string | null;
  pi_dialect?: unknown;
}): boolean {
  return model.apiShape === "openai-completions" && model.pi_dialect == null;
}
