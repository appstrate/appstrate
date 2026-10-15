// SPDX-License-Identifier: Apache-2.0

/**
 * A real modal has an address (DESIGN_SYSTEM.md, section 9).
 *
 * A modal opened by local `useState` cannot be linked, does not survive a
 * reload and is not closed by Back. `useModalParam` (`hooks/use-modal-param.ts`)
 * keeps the open state in the URL instead. This scan reads the sources, with no
 * DOM, and fails on a modal-like element whose `open` / `onClose` /
 * `onOpenChange`, or the `cond &&` / `cond ?` guarding it, reads a `useState` of
 * the same file — directly, or through a `const` derived from it in that file
 * (`const closure = closures[0]`) — unless the pair is listed in EXCEPTIONS. A
 * modal its `useModalParam` opens has its address even when a local condition
 * narrows when it may open (`{editing && editingFile.value !== null && …}`).
 *
 * Its sight stops at the file: a modal driven by a prop, a store or a custom
 * hook's state is not seen, and review holds those.
 *
 * What has no address is only what the design system names: the confirmation
 * of an act, the single display of a secret, the chat (whose message cards have
 * no stable address) and what is not a modal at all. `ConfirmModal`,
 * `UnsavedChangesModal` and `SecretRevealModal` are those by nature and need no
 * line below. Every other exception names its case, and an entry that matches
 * no code fails too: the list cannot rot.
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

/** The four cases DESIGN_SYSTEM.md section 9 allows without an address. */
type ExceptionCase = "confirmation" | "secret" | "chat" | "not-a-modal";
const CASES: ReadonlySet<string> = new Set<ExceptionCase>([
  "confirmation",
  "secret",
  "chat",
  "not-a-modal",
]);

interface Exception {
  /** Path from the repository root. */
  file: string;
  /** The element opened by local state. */
  tag: string;
  /** The `useState` variable that opens it, directly or through a derived `const`. */
  state: string;
  case: ExceptionCase;
  reason: string;
}

const EXCEPTIONS: Exception[] = [
  {
    file: "apps/web/src/components/notification-bell.tsx",
    tag: "Sheet",
    state: "open",
    case: "not-a-modal",
    reason: "A popover that becomes a bottom sheet on a phone: not a modal, a menu.",
  },
  {
    file: "apps/web/src/pages/preferences/security.tsx",
    tag: "ReauthModal",
    state: "pendingUnlink",
    case: "confirmation",
    reason: "Re-authentication confirming an act (unlinking an account): a confirmation of an act.",
  },
  {
    file: "packages/module-chat/src/ui/chat-run-progress-card.tsx",
    tag: "Modal",
    state: "open",
    case: "chat",
    reason: "Chat: the detail of a card inside a message, one of many, no stable address.",
  },
  {
    file: "packages/module-chat/src/ui/tool-uis.tsx",
    tag: "Modal",
    state: "open",
    case: "chat",
    reason: "Chat: the detail of a tool call inside a message, one of many, no stable address.",
  },
  {
    file: "packages/module-chat/src/ui/thread-list.tsx",
    tag: "Dialog",
    state: "confirmingDelete",
    case: "confirmation",
    reason: "Chat: the confirmation of deleting a conversation, a confirmation of an act.",
  },
  {
    file: "apps/web/src/components/org-catalogue-modal.tsx",
    tag: "ActivationClosureDialog",
    state: "closures",
    case: "confirmation",
    reason: "The activation closure: confirms activating what an agent's run needs.",
  },
];

function walk(dir: string, out: string[] = [], files = /\.tsx$/): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "test" || name === "lab" || name === "node_modules") continue;
      walk(path, out, files);
    } else if (files.test(path)) {
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

/**
 * Each name that carries a `useState` of `source`, mapped to that state variable: the
 * state, its setter, and every `const` whose initializer reads one of them (to a fixed
 * point, so a derivation of a derivation counts). A setter's derivations are left out:
 * a handler that also resets local state does not make the modal it closes local.
 */
function localStateNames(source: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of source.matchAll(/const \[(\w+), (set\w+)\] = (?:React\.)?useState\b/g)) {
    names.set(m[1]!, m[1]!);
    names.set(m[2]!, m[1]!);
  }
  const setters = new Set([...names.keys()].filter((name) => names.get(name) !== name));
  // A component body's own `const`s (prettier indents them by two): a callback's locals
  // are another scope, and a shared name (`id`, `user`) there would read as the state.
  const declarations = /^ {2}const (\w+)(?::[^=]+)? = ([\s\S]*?);\n/gm;
  const derived = [...source.matchAll(declarations)].map((m) => ({
    name: m[1]!,
    initializer: m[2]!,
  }));
  for (let grew = true; grew;) {
    grew = false;
    for (const { name, initializer } of derived) {
      if (names.has(name)) continue;
      const read = [...names.keys()].find(
        (state) => !setters.has(state) && reads(initializer, state),
      );
      if (read) {
        names.set(name, names.get(read)!);
        grew = true;
      }
    }
  }
  return names;
}

const reads = (expression: string, name: string) =>
  new RegExp(`(?<![.\\w])${name}\\b`).test(expression);

/** Every Modal-like element opened by local state. `state` is the `useState` variable. */
function findings(): Array<{ file: string; tag: string; state: string }> {
  const found: Array<{ file: string; tag: string; state: string }> = [];
  for (const root of SOURCE_ROOTS) {
    for (const path of walk(root)) {
      const source = readFileSync(path, "utf8");
      const names = localStateNames(source);
      if (names.size === 0) continue;
      const addressed = [...source.matchAll(/^ {2}const (\w+) = useModal(?:Param|Target)\b/gm)].map(
        (m) => m[1]!,
      );
      for (const { tag, attributes, before } of openingTags(source)) {
        if (EXEMPT_TAGS.has(tag) || !MODAL_LIKE.test(tag)) continue;
        const driven = [
          attribute(attributes, "open"),
          attribute(attributes, "onClose"),
          attribute(attributes, "onOpenChange"),
        ].join(" ");
        const guarded = (name: string) =>
          new RegExp(`(?<![.\\w])${name}\\b[^{}]{0,40}(&&|\\?)\\s*\\(?\\s*$`).test(before);
        // Mounted only while its URL parameter is set: a local condition in the same guard
        // narrows when it may open, it does not open it.
        if (addressed.some(guarded)) continue;
        const hit = [...names.keys()].find((name) => reads(driven, name) || guarded(name));
        if (hit) found.push({ file: relative(REPO_ROOT, path), tag, state: names.get(hit)! });
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
    // `?newWebhook=1`, `?editModel=<id>`). List it above only if it is a confirmation,
    // a secret shown once, the chat, or not a modal.
    expect(unlisted).toEqual([]);
  });

  it("every listed exception still matches code", () => {
    const stale = EXCEPTIONS.filter(
      (e) => !found.some((f) => f.file === e.file && f.tag === e.tag && f.state === e.state),
    ).map((e) => `${e.file}: <${e.tag}> \`${e.state}\``);
    expect(stale).toEqual([]);
  });

  it("every exception is one of the four cases, the chat's inside the chat", () => {
    const misfiled = EXCEPTIONS.filter(
      (e) =>
        !CASES.has(e.case) ||
        (e.case === "chat" && !e.file.startsWith("packages/module-chat/")) ||
        e.reason.trim() === "",
    ).map((e) => `${e.file}: <${e.tag}> filed as « ${e.case} »`);
    expect(misfiled).toEqual([]);
  });

  it("names every modal parameter in camelCase", () => {
    // DESIGN_SYSTEM.md section 9: `?newWebhook=1`, `?editModel=<id>`.
    const declared = /useModal(?:Param|Target)\(\s*"([^"]+)"|const [A-Z_]+_PARAM = "([^"]+)"/g;
    const misnamed: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const path of walk(root, [], /\.tsx?$/)) {
        for (const m of readFileSync(path, "utf8").matchAll(declared)) {
          const name = m[1] ?? m[2]!;
          if (!/^[a-z][A-Za-z0-9]*$/.test(name))
            misnamed.push(`${relative(REPO_ROOT, path)}: ${name}`);
        }
      }
    }
    expect(misnamed).toEqual([]);
  });

  it("sees a modal opened through state derived from a useState", () => {
    const names = localStateNames(
      [
        "  const [closures, setClosures] = useState([]);",
        "  const closure = closures[0];",
        "  const title = closure?.name;",
        "  const reset = () => setClosures([]);",
        "  const run = () => {",
        "    const first = closures[0];",
        "  };",
        "",
      ].join("\n"),
    );
    expect(names.get("closure")).toBe("closures");
    expect(names.get("title")).toBe("closures");
    expect(names.has("reset")).toBe(false);
    expect(names.has("first")).toBe(false);
  });
});
