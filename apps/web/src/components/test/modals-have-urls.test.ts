// SPDX-License-Identifier: Apache-2.0

/**
 * A modal that is a place has an address (DESIGN_SYSTEM.md, section 9).
 *
 * A modal opened by local `useState` cannot be linked, does not survive a
 * reload and is not closed by Back. `useModalParam` (`hooks/use-modal-param.ts`)
 * keeps the open state in the URL instead. This scan reads the sources, with no
 * DOM, and fails on a modal-like element whose `open` / `onClose` /
 * `onOpenChange` is driven by a `useState` of the same file, unless the pair is
 * listed in EXCEPTIONS with the reason it is not a place.
 *
 * An exception is one of three things: the confirmation of an act, the single
 * display of a secret, or a step inside a flow already at an address. The first
 * two are named by their component (`ConfirmModal`, `SecretRevealModal`) and
 * need no line below. Anything else is listed, with one line of reason, and an
 * entry that no longer matches code fails too: the list cannot rot.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const WEB_SRC = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO_ROOT = dirname(dirname(dirname(WEB_SRC)));
const SOURCE_ROOTS = [WEB_SRC, join(REPO_ROOT, "packages/module-chat/src/ui")];

/** Components that are exceptions by nature: an act to confirm, a secret shown once. */
const EXEMPT_TAGS = new Set(["ConfirmModal", "SecretRevealModal", "UnsavedChangesModal"]);

interface Exception {
  /** Path from the repository root. */
  file: string;
  /** The element opened by local state. */
  tag: string;
  /** The `useState` (state or setter) that opens it. */
  state: string;
  reason: string;
}

const EXCEPTIONS: Exception[] = [
  {
    file: "apps/web/src/components/notification-bell.tsx",
    tag: "Sheet",
    state: "open",
    reason: "A popover that becomes a bottom sheet on a phone: a menu, not a place.",
  },
  {
    file: "apps/web/src/components/onboarding-quick-connect.tsx",
    tag: "Modal",
    state: "dialogOpen",
    reason: "OAuth pairing in progress: its token lives in memory, a reload cannot resume it.",
  },
  {
    file: "apps/web/src/pages/preferences/security.tsx",
    tag: "ReauthModal",
    state: "pendingUnlink",
    reason: "Re-authentication confirming an act (unlinking an account): a confirmation.",
  },
  {
    file: "apps/web/src/components/org-catalogue-modal.tsx",
    tag: "ActivationClosureDialog",
    state: "closure",
    reason: "Confirms an activation and what it drags along: a confirmation of an act.",
  },
  {
    file: "apps/web/src/components/map-primitives.tsx",
    tag: "Modal",
    state: "open",
    reason: "A concept's explanation (help text of a card title): not a place.",
  },
  {
    file: "apps/web/src/components/map-primitives.tsx",
    tag: "Modal",
    state: "listOpen",
    reason: "The overflow of a card's rows, one of many cards on the map: no address of its own.",
  },
  {
    file: "apps/web/src/components/package-detail/integration-structure.tsx",
    tag: "Modal",
    state: "expanded",
    reason: "Full-screen view of the same map: a display mode, not a place.",
  },
  {
    file: "apps/web/src/components/package-detail/package-tool-catalog.tsx",
    tag: "Modal",
    state: "selected",
    reason: "Read-only inspection in a catalog embedded several times per page: no unique address.",
  },
  {
    file: "apps/web/src/modules/agent-map/map-panel-dialog.tsx",
    tag: "ModelFormModal",
    state: "adding",
    reason: "Adding a model from inside a map panel, which is itself at `?mapPanel=model`.",
  },
  {
    file: "packages/module-chat/src/ui/chat-run-progress-card.tsx",
    tag: "Modal",
    state: "open",
    reason: "Detail of a card inside a chat message: one of many, no stable address.",
  },
  {
    file: "packages/module-chat/src/ui/tool-uis.tsx",
    tag: "Modal",
    state: "open",
    reason: "Detail of a tool call inside a chat message: one of many, no stable address.",
  },
  {
    file: "packages/module-chat/src/ui/thread-list.tsx",
    tag: "Dialog",
    state: "confirmingDelete",
    reason: "Confirmation of deleting a conversation.",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "test" || name === "lab" || name === "node_modules") continue;
      walk(path, out);
    } else if (path.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out;
}

/** The attribute text of each opening tag named `name`, up to its closing `>`. */
function openingTags(source: string): Array<{ tag: string; attributes: string; before: string }> {
  const tags: Array<{ tag: string; attributes: string; before: string }> = [];
  const start = /<([A-Z][A-Za-z0-9]*)(?=[\s>/])/g;
  for (let match = start.exec(source); match; match = start.exec(source)) {
    let depth = 0;
    let quote: string | null = null;
    let i = start.lastIndex;
    for (; i < source.length; i++) {
      const c = source[i]!;
      if (quote) {
        if (c === quote && source[i - 1] !== "\\") quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    tags.push({
      tag: match[1]!,
      attributes: source.slice(start.lastIndex, i),
      // What precedes the element: `{open && <Modal …>}` is opened by `open` too.
      before: source.slice(Math.max(0, match.index - 80), match.index),
    });
  }
  return tags;
}

/** The expression of one top-level attribute, `{...}` balanced, or "" when absent. */
function attribute(attributes: string, name: string): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < attributes.length; i++) {
    const c = attributes[i]!;
    if (quote) {
      if (c === quote && attributes[i - 1] !== "\\") quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (
      depth === 0 &&
      attributes.startsWith(`${name}={`, i) &&
      !/\w/.test(attributes[i - 1] ?? " ")
    ) {
      let inner = 0;
      const from = i + name.length + 1;
      for (let k = from; k < attributes.length; k++) {
        if (attributes[k] === "{") inner++;
        else if (attributes[k] === "}" && --inner === 0) return attributes.slice(from + 1, k);
      }
    }
  }
  return "";
}

const MODAL_LIKE = /(Modal|Dialog|Sheet)$|^FilePreview$/;

/** Every Modal-like element opened by a `useState` of its file. `state` is the state variable. */
function findings(): Array<{ file: string; tag: string; state: string }> {
  const found: Array<{ file: string; tag: string; state: string }> = [];
  for (const root of SOURCE_ROOTS) {
    for (const path of walk(root)) {
      const source = readFileSync(path, "utf8");
      const states = [
        ...source.matchAll(/const \[(\w+), (set\w+)\] = (?:React\.)?useState\b/g),
      ].map((m) => ({
        state: m[1]!,
        setter: m[2]!,
      }));
      if (states.length === 0) continue;
      for (const { tag, attributes, before } of openingTags(source)) {
        if (EXEMPT_TAGS.has(tag) || !MODAL_LIKE.test(tag)) continue;
        const driven = [
          attribute(attributes, "open"),
          attribute(attributes, "onClose"),
          attribute(attributes, "onOpenChange"),
        ].join(" ");
        const mentions = (name: string) => new RegExp(`(?<![.\\w])${name}\\b`).test(driven);
        const guarded = (name: string) =>
          new RegExp(`(?<![.\\w])${name}\\b[^{}]{0,40}(&&|\\?)\\s*\\(?\\s*$`).test(before);
        const hit = states.find((s) => mentions(s.state) || mentions(s.setter) || guarded(s.state));
        if (hit) found.push({ file: relative(REPO_ROOT, path), tag, state: hit.state });
      }
    }
  }
  return found;
}

describe("modals have URLs", () => {
  const found = findings();

  it("no modal is opened by local state outside the listed exceptions", () => {
    const listed = (f: { file: string; tag: string; state: string }) =>
      EXCEPTIONS.some((e) => e.file === f.file && e.tag === f.tag && e.state === f.state);
    const unlisted = found
      .filter((f) => !listed(f))
      .map((f) => `${f.file}: <${f.tag}> is opened by useState \`${f.state}\``);
    // Port it to `useModalParam` (a URL parameter named by the object and the act:
    // `?newWebhook=1`, `?editModel=<id>`), or, if it is not a place, list it above.
    expect(unlisted).toEqual([]);
  });

  it("every listed exception still matches code", () => {
    const stale = EXCEPTIONS.filter(
      (e) => !found.some((f) => f.file === e.file && f.tag === e.tag && f.state === e.state),
    ).map((e) => `${e.file}: <${e.tag}> \`${e.state}\``);
    expect(stale).toEqual([]);
  });

  it("every exception says why", () => {
    for (const e of EXCEPTIONS) expect(e.reason.length).toBeGreaterThan(20);
  });
});
