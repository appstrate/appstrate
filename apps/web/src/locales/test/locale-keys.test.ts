// SPDX-License-Identifier: Apache-2.0

/**
 * Locale integrity guards.
 *
 * The locale JSONs are FLAT dotted-key maps: when `t()` is called with a key
 * that no bundle defines, i18next silently renders the key STRING itself
 * ("list.used_by_agents" showing up in a badge). Nothing — not tsc, not eslint
 * — catches that, so two such keys shipped to production unnoticed.
 *
 * These tests close the gap with a static scan of the SPA source:
 *   1. `en` and `fr` define exactly the same keys (a missing translation must
 *      be a visible failure, not a silent fallback).
 *   2. Every statically-analysable `t("…")` / `<Trans i18nKey="…">` key
 *      resolves in some namespace.
 *   3. The reverse: every declared key is still referenced by the source. A
 *      key nobody uses is dead weight that survives every refactor because
 *      deleting a component never fails a test.
 *
 * Deliberately conservative — keys built from template literals or a variable
 * cannot be resolved statically and are skipped (guard 2) or shielded by the
 * dynamic-prefix allow-list (guard 3) rather than guessed at.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const LOCALES_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_SRC = dirname(LOCALES_DIR);
const REPO_ROOT = dirname(dirname(dirname(WEB_SRC)));

/**
 * Every tree whose code resolves against these bundles. `module-chat`'s UI is
 * in the list because it renders inside the SPA and reads `chat.json` through
 * the host-injected `t` (see its `runtime-context.ts`) — its keys live here,
 * so both guards must see its call sites or they mis-report in both
 * directions (unresolvable keys missed, live keys reported dead).
 */
const SOURCE_ROOTS = [WEB_SRC, join(REPO_ROOT, "packages/module-chat/src/ui")];

function loadNamespaces(lang: string): Map<string, Record<string, string>> {
  const dir = join(LOCALES_DIR, lang);
  const out = new Map<string, Record<string, string>>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    out.set(
      file.replace(/\.json$/, ""),
      JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, string>,
    );
  }
  return out;
}

const en = loadNamespaces("en");
const fr = loadNamespaces("fr");

describe("locale bundles", () => {
  it("declares the same namespaces in en and fr", () => {
    expect([...fr.keys()].sort()).toEqual([...en.keys()].sort());
  });

  for (const [ns, enKeys] of en) {
    it(`declares the same keys in en and fr for the "${ns}" namespace`, () => {
      const frKeys = fr.get(ns) ?? {};
      expect(Object.keys(frKeys).sort()).toEqual(Object.keys(enKeys).sort());
    });
  }
});

/** Every key of every namespace. */
const allKeys = new Set<string>();
for (const keys of en.values()) for (const k of Object.keys(keys)) allKeys.add(k);

/**
 * The ONLY suffixes i18next appends to a lookup key on its own. Matching any
 * `key_*` member instead would make the guard blind by accident: the bundles
 * are full of snake_case leaves (`filter.agent_output`,
 * `integration.auth.type.api_key`, `run.connSource.member_pin`), so a typo'd
 * `t("filter.agent")` would resolve against `filter.agent_output` and ship a
 * raw key string to the UI. The `_context` form is not accepted either — no
 * bundle uses one, and speculating on it costs the same blindness.
 */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** Bases of the declared plural families, e.g. `connections.reusedByCount`. */
const pluralBases = new Set<string>();
for (const k of allKeys) if (PLURAL_SUFFIX.test(k)) pluralBases.add(k.replace(PLURAL_SUFFIX, ""));

/** i18next resolves `key` verbatim, or via its plural family. */
function isDeclared(key: string): boolean {
  return allKeys.has(key) || pluralBases.has(key);
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "locales") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, acc);
    else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) acc.push(path);
  }
  return acc;
}

const SOURCES = SOURCE_ROOTS.flatMap((root) => sourceFiles(root));

/** `t("key"` / `t('key'` / `t(`key`` — the opening quote must follow `t(`. */
const T_CALL = /\bt\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
/** `<Trans i18nKey="key">` — a second call site the `t(` regex cannot see. */
const TRANS_KEY =
  /\bi18nKey\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(["'`])((?:\\.|(?!\3)[^\\])*)\3\s*\})/g;

/** A leading `namespace:` prefix is not part of the stored key. */
function stripNamespace(literal: string): string {
  const prefixed = /^([\w-]+):(.+)$/.exec(literal);
  return prefixed && en.has(prefixed[1]!) ? prefixed[2]! : literal;
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

describe("t() keys", () => {
  it("all resolve to a declared locale key", () => {
    const missing: string[] = [];

    for (const file of SOURCES) {
      const src = readFileSync(file, "utf8");
      for (const [pattern, quoteAt, literalAt] of [
        [T_CALL, 1, 2],
        [TRANS_KEY, 3, -1],
      ] as const) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(src))) {
          const literal =
            literalAt >= 0 ? match[literalAt]! : (match[1] ?? match[2] ?? match[4] ?? "");
          const quote = match[quoteAt];
          // Template literal with an interpolation — not statically resolvable.
          if (quote === "`" && literal.includes("${")) continue;
          if (literal === "") continue;

          if (isDeclared(stripNamespace(literal))) continue;
          missing.push(`${relative(REPO_ROOT, file)}:${lineOf(src, match.index)} → "${literal}"`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});

/**
 * Keys assembled at runtime (`t(`status.${status}`)`) have no literal call
 * site, so the reverse guard cannot see them. Each entry below is a prefix
 * under which a REAL interpolation site exists — the comment names it. This
 * is the one list that must be justified per line: widening it to silence a
 * failure is how a dead-key guard becomes decorative.
 */
const DYNAMIC_KEY_PREFIXES = [
  "concept.", // modules/agent-map/map-nodes.tsx — t(`agent-map:concept.${concept}.{title,body}`)
  "filter.", // components/document-list-panel.tsx — t(`filter.${p}`)
  "purpose.", // components/document-columns.tsx — t(`purpose.${doc.purpose}`)
  "type.", // components/document-columns.tsx — t(`type.${mimeKind(doc.mime)}`)
  "generation.level.", // packages/module-chat/src/ui/model-select.tsx
  "generation.levelShort.", // packages/module-chat/src/ui/model-select.tsx
  "integration.auth.type.", // components/integration-connect/{inline-connect-button,integration-connection-picker}.tsx
  "integration.connect.fields.", // components/integration-connect/credential-fields.tsx
  "library.tab.", // pages/library-page.tsx — t(`library.tab.${tab}`)
  "log.level.", // components/log-viewer.tsx — t(`log.level.${value}`)
  "log.type.", // components/log-viewer.tsx — t(`log.type.${value}`)
  "oauthClients.scopeLabels.", // modules/oidc/components/oauth-client-form-modal.tsx
  "oauthClients.signupRoleOption.", // modules/oidc/components/oauth-client-form-modal.tsx
  "packages.type.", // components/package-detail/shared-header.tsx, pages/unified-package-detail.tsx
  "models.generation.levels.", // components/model-generation-fields.tsx
  "models.generation.levelsShort.", // components/model-generation-fields.tsx
  "run.artifacts.code.", // components/run-artifacts.ts — artifactFailureCodeKey()
  "run.connSource.", // components/run-info-tab.tsx — t(`run.connSource.${c.source}`)
  "run.status.", // packages/module-chat/src/ui/run-events.ts — runStatusLineKey()
  "status.", // components/status-badge.tsx — t(`status.${status}`)
  "switcher.role.", // components/org-switcher.tsx — t(`switcher.role.${org.role}`)
  "systemTool.", // modules/agent-map/map-nodes.tsx — t(`agent-map:systemTool.${item.id}`)
];

/**
 * A key counts as referenced when it appears in the source as the head of a
 * string literal, optionally namespace-prefixed. Scanning only `t("…")` would
 * be far too narrow: most keys reach `t()` indirectly — through a lookup map
 * (`billing.tsx` `past_due: "billing.statusPastDue"`), a `labelKey` prop, or a
 * helper's `return "invite.expired"` — and flagging those 100+ keys as dead
 * would make the guard useless on its first run.
 */
const SOURCE_BLOB = SOURCES.map((f) => readFileSync(f, "utf8")).join("\n");

function isReferenced(key: string): boolean {
  for (const quote of ['"', "'", "`"]) {
    if (SOURCE_BLOB.includes(quote + key)) return true;
    for (const ns of en.keys()) if (SOURCE_BLOB.includes(`${quote}${ns}:${key}`)) return true;
  }
  return false;
}

function isShielded(key: string): boolean {
  return DYNAMIC_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

describe("declared keys", () => {
  it("are all still referenced by the source", () => {
    // The guard the other direction lacks: deleting the last call site of a
    // key leaves the translation behind in both bundles, and nothing notices.
    const orphans = [...allKeys]
      .filter((key) => !isShielded(key))
      .filter((key) => !isReferenced(key) && !isReferenced(key.replace(PLURAL_SUFFIX, "")))
      .sort();

    expect(orphans).toEqual([]);
  });

  it("keep every dynamic-prefix exemption backed by a real interpolation site", () => {
    // An exemption is only legitimate while the code it excuses exists. This
    // is what stops the allow-list from being widened to silence a failure:
    // an invented prefix has no `` `prefix.${…}` `` anywhere and fails here.
    const unjustified = DYNAMIC_KEY_PREFIXES.filter((prefix) => {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Optional `namespace:` — some sites interpolate `settings:foo.${x}`.
      return !new RegExp("`(?:[\\w-]+:)?" + escaped + "\\$\\{").test(SOURCE_BLOB);
    });

    expect(unjustified).toEqual([]);
  });
});
