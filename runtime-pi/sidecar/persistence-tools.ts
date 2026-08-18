// SPDX-License-Identifier: Apache-2.0

/**
 * Command-backed memory tools — `note`, `pin` and `update_slot`.
 *
 * ## Why these are not event emitters
 *
 * The other runtime tools emit a canonical event and return a fixed string.
 * That works for `log` and `output`, where nothing can go wrong that the agent
 * could act on. It does not work for memory:
 *
 * - the archive can be full, in which case "Note saved" is a lie the agent has
 *   no way to detect;
 * - a conditional slot write can CONFLICT, and the conflict is only useful if
 *   the current value comes back so the agent can rebase its patch onto it.
 *
 * An emitted event cannot carry an answer. So these three call the platform
 * command routes and derive both their text result and their canonical event
 * from what actually happened. The event is still emitted — it is what feeds
 * the run log and the terminal aggregate — but it is now an OBSERVATION of a
 * committed fact rather than a promise of one.
 *
 * ## Idempotency
 *
 * Each invocation mints one `operationId` and reuses it across transport
 * retries. That is the whole guarantee: a committed write whose response was
 * lost is re-answered from its receipt instead of being applied twice. A fresh
 * tool call from the model is a genuinely new write and gets a fresh id.
 */

import type { RuntimeToolDef } from "@appstrate/core/runtime-tool-defs";
import { RUNTIME_TOOL_EVENTS_META_KEY } from "@appstrate/core/runtime-tool-defs";

/** Minimal fetch surface, injected so tests need no network. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface PersistenceToolDeps {
  platformApiUrl: string;
  runToken: string;
  fetchFn: FetchFn;
  /** Injected for tests; defaults to `crypto.randomUUID`. */
  newOperationId?: () => string;
}

type CommandOutcome = {
  outcome?: "committed" | "conflict" | "rejected";
  revision?: number;
  content?: unknown;
  current_content?: unknown;
  reason?: string;
  detail?: string;
};

/**
 * POST a command, retrying transport failures with the SAME operation id.
 *
 * Two attempts, because the failure this guards is a lost response rather than
 * a busy server: if the first attempt actually committed, the retry replays its
 * receipt and returns the original answer. Without the shared id that retry
 * would be a second write.
 */
async function postCommand(
  deps: PersistenceToolDeps,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: CommandOutcome } | { ok: false; detail: string }> {
  const url = `${deps.platformApiUrl}${path}`;
  let lastError = "upstream unreachable";

  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await deps.fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.runToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : "upstream unreachable";
      continue;
    }

    if (res.ok) {
      try {
        return { ok: true, data: (await res.json()) as CommandOutcome };
      } catch {
        return { ok: false, detail: "the platform returned a malformed response" };
      }
    }

    // 4xx is a verdict, not a glitch — retrying cannot change it.
    if (res.status < 500) {
      return { ok: false, detail: `the platform refused the write (HTTP ${res.status})` };
    }
    lastError = `the platform is unavailable (HTTP ${res.status})`;
  }

  return { ok: false, detail: lastError };
}

/** Tool result carrying the canonical event the journal will pick up. */
function withEvent(text: string, event: Record<string, unknown> | null, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
    _meta: event ? { [RUNTIME_TOOL_EVENTS_META_KEY]: [event] } : {},
  };
}

/**
 * Replace the emitter handlers of `note` / `pin` with command-backed ones, and
 * append `update_slot` when the agent selected it.
 *
 * Defs the agent did not select are left untouched, so this is safe to run over
 * the whole set.
 */
export function commandBackedRuntimeToolDefs(
  defs: RuntimeToolDef[],
  deps: PersistenceToolDeps,
  selected: readonly string[],
): RuntimeToolDef[] {
  const newId = deps.newOperationId ?? (() => crypto.randomUUID());

  const wrapped = defs.map((def) => {
    if (def.descriptor.name === "note") return noteDef(def, deps, newId);
    if (def.descriptor.name === "pin") return pinDef(def, deps, newId);
    return def;
  });

  if (selected.includes("update_slot")) wrapped.push(updateSlotDef(deps, newId));
  return wrapped;
}

function noteDef(
  def: RuntimeToolDef,
  deps: PersistenceToolDeps,
  newId: () => string,
): RuntimeToolDef {
  return {
    descriptor: def.descriptor,
    handler: async (rawArgs) => {
      const { content, scope } = (rawArgs ?? {}) as { content: string; scope?: "actor" | "shared" };
      const operationId = newId();
      const result = await postCommand(deps, "/internal/memory", {
        operation_id: operationId,
        content,
        ...(scope !== undefined ? { scope } : {}),
      });

      if (!result.ok) {
        // Deliberately NOT "saved": the agent must be able to tell a stored
        // memory from one that never landed.
        return withEvent(`Note was not saved — ${result.detail}.`, null, true);
      }
      if (result.data.outcome === "rejected") {
        return withEvent(
          `Note was not saved — ${result.data.detail ?? result.data.reason ?? "refused"}.`,
          null,
          true,
        );
      }

      return withEvent("Note saved", {
        type: "memory.added",
        content,
        ...(scope !== undefined ? { scope } : {}),
        operationId,
      });
    },
  };
}

function pinDef(
  def: RuntimeToolDef,
  deps: PersistenceToolDeps,
  newId: () => string,
): RuntimeToolDef {
  return {
    descriptor: def.descriptor,
    handler: async (rawArgs) => {
      const { key, content, scope } = (rawArgs ?? {}) as {
        key: string;
        content: unknown;
        scope?: "actor" | "shared";
      };
      const operationId = newId();
      const result = await postCommand(deps, "/internal/slots", {
        operation_id: operationId,
        key,
        content: content ?? null,
        ...(scope !== undefined ? { scope } : {}),
      });

      if (!result.ok) {
        return withEvent(`Slot "${key}" was not updated — ${result.detail}.`, null, true);
      }
      if (result.data.outcome === "rejected") {
        return withEvent(
          `Slot "${key}" was not updated — ${result.data.detail ?? result.data.reason ?? "refused"}.`,
          null,
          true,
        );
      }

      const revision = result.data.revision;
      return withEvent(
        `Pinned slot "${key}" updated${revision !== undefined ? ` (revision ${revision})` : ""}`,
        {
          type: "pinned.set",
          key,
          content: content ?? null,
          ...(scope !== undefined ? { scope } : {}),
          ...(revision !== undefined ? { revision } : {}),
          operationId,
        },
      );
    },
  };
}

/**
 * `update_slot` — the partial, conditional write.
 *
 * The description is the agent's only documentation for the tool (it is read
 * from `tools/list`), so it has to state the conflict protocol: on a mismatch
 * the agent gets the current value back and is expected to rebase, not retry
 * blindly.
 */
function updateSlotDef(deps: PersistenceToolDeps, newId: () => string): RuntimeToolDef {
  return {
    descriptor: {
      name: "update_slot",
      description:
        "Edit PART of a pinned slot without rewriting the whole value, safely when other runs may be editing it too. " +
        "Pass the `revision` shown next to the slot in your `## Pinned Slots` section as `expected_revision`. " +
        "If the slot changed since then you get `conflict` back together with its current value: re-apply your edit " +
        "on top of that value and call again with the new revision — do not repeat the same call unchanged. " +
        "Use `expected_revision: 0` to create a slot that does not exist yet. Patch by merging JSON members " +
        '(`{"type":"merge","value":{…}}`, where a null member deletes it) or by replacing an exact text fragment ' +
        '(`{"type":"replace","old":"…","new":"…"}`, which must match exactly once).',
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["key", "patch", "expected_revision"],
        properties: {
          key: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            pattern: "^[a-z0-9_]+$",
            description: "Slot to edit.",
          },
          expected_revision: {
            type: "integer",
            minimum: 0,
            description:
              "Revision you are editing, as shown in the prompt. 0 asserts the slot does not exist yet.",
          },
          patch: {
            description: "The partial edit to apply.",
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["type", "value"],
                properties: {
                  type: { type: "string", enum: ["merge"] },
                  value: {
                    type: "object",
                    description: "Members to set; a null member deletes it.",
                  },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["type", "old", "new"],
                properties: {
                  type: { type: "string", enum: ["replace"] },
                  old: { type: "string", minLength: 1, description: "Must match exactly once." },
                  new: { type: "string" },
                },
              },
            ],
          },
          scope: {
            type: "string",
            enum: ["actor", "shared"],
            description:
              'Which copy of the slot to edit. Defaults to your own ("actor"); "shared" is the app-wide copy.',
          },
        },
      },
    },
    handler: async (rawArgs) => {
      const { key, patch, expected_revision, scope } = (rawArgs ?? {}) as {
        key: string;
        patch: unknown;
        expected_revision: number;
        scope?: "actor" | "shared";
      };
      const operationId = newId();
      const result = await postCommand(deps, "/internal/slots/update", {
        operation_id: operationId,
        key,
        patch,
        expected_revision,
        ...(scope !== undefined ? { scope } : {}),
      });

      if (!result.ok) {
        return withEvent(`Slot "${key}" was not updated — ${result.detail}.`, null, true);
      }

      if (result.data.outcome === "conflict") {
        // Not an error: the agent is expected to act on this. Returning it as
        // `isError` would push the model toward retrying verbatim, which is
        // precisely what must not happen.
        return withEvent(
          `Slot "${key}" changed since revision ${expected_revision}. It is now at revision ` +
            `${result.data.revision}, with this value:\n\n${JSON.stringify(result.data.current_content, null, 2)}\n\n` +
            "Re-apply your edit on top of that value and call again with the new revision.",
          null,
        );
      }

      if (result.data.outcome === "rejected") {
        return withEvent(
          `Slot "${key}" was not updated — ${result.data.detail ?? result.data.reason ?? "refused"}.`,
          null,
          true,
        );
      }

      // The canonical event describes what was STORED, not the fragment that
      // was sent: the merge was resolved server-side, so the resulting value is
      // the only accurate payload for the terminal aggregate and the run log.
      return withEvent(`Slot "${key}" updated (revision ${result.data.revision})`, {
        type: "pinned.set",
        key,
        content: result.data.content ?? null,
        ...(scope !== undefined ? { scope } : {}),
        ...(result.data.revision !== undefined ? { revision: result.data.revision } : {}),
        operationId,
      });
    },
  };
}
