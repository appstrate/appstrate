// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Pin built-in tool — Upsert a named pinned slot for the next run.
 *
 * Formerly the `@appstrate/pin` tool package; baked into the runtime
 * image. Pinned slots are rendered into the system prompt on every run;
 * last-write-wins per `(scope, key)`. Emits a `pinned.set` event on
 * stdout, persisted at run finalize.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { emit } from "./emit.ts";

export const pinTool: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "pin",
    label: "Pin",
    description:
      "Upsert a named slot pinned into the system prompt on every run. Last-write-wins per (scope, key). " +
      'Use key="checkpoint" for the carry-over checkpoint; other keys (e.g. "persona", "goals") create additional pinned blocks. ' +
      'Scope defaults to "actor" — scheduled runs, manual triggers, and different members each get their own copy. ' +
      'Pass scope="shared" when the slot tracks a resource shared across actors (synced repo, shared inbox, shared DB), ' +
      "otherwise the agent will desynchronise across triggers.",
    parameters: Type.Object({
      key: Type.String({
        minLength: 1,
        maxLength: 64,
        pattern: "^[a-z0-9_]+$",
        description:
          'Pinned slot identifier. Lowercase, digits and underscores only. "checkpoint" is the carry-over slot.',
      }),
      content: Type.Unsafe<unknown>({
        description: "Arbitrary JSON value stored under the pinned slot.",
      }),
      scope: Type.Optional(
        Type.Union([Type.Literal("actor"), Type.Literal("shared")], {
          description:
            'Persistence scope. "actor" (default) gives every actor their own private copy of the slot — scheduled runs, manual triggers, and different members do not share state. "shared" makes the slot app-wide; use when the slot tracks a resource shared across actors.',
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const { key, content, scope } = params as {
        key: string;
        content: unknown;
        scope?: "actor" | "shared";
      };
      const event: Record<string, unknown> = { type: "pinned.set", key, content };
      if (scope !== undefined) event.scope = scope;
      emit(event);
      return {
        content: [{ type: "text", text: `Pinned slot "${key}" updated` }],
        details: { key, content, ...(scope !== undefined ? { scope } : {}) },
      };
    },
  });
};
