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
 *   2. Every statically-analysable `t("…")` key resolves in some namespace.
 *
 * Deliberately conservative — keys built from template literals or a variable
 * cannot be resolved statically and are skipped rather than guessed at.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const LOCALES_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_SRC = dirname(LOCALES_DIR);

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

/** Every key of every namespace, plus the plural/context families they head. */
const allKeys = new Set<string>();
for (const keys of en.values()) for (const k of Object.keys(keys)) allKeys.add(k);

/**
 * i18next resolves `key` when the bundle holds it verbatim OR holds a
 * suffixed member of its family (`key_one`, `key_other`, `key_female`, …).
 */
function isDeclared(key: string): boolean {
  if (allKeys.has(key)) return true;
  for (const k of allKeys) if (k.startsWith(`${key}_`)) return true;
  return false;
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

/** `t("key"` / `t('key'` / `t(`key`` — the opening quote must follow `t(`. */
const T_CALL = /\bt\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

describe("t() keys", () => {
  it("all resolve to a declared locale key", () => {
    const missing: string[] = [];

    for (const file of sourceFiles(WEB_SRC)) {
      const src = readFileSync(file, "utf8");
      T_CALL.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = T_CALL.exec(src))) {
        const quote = match[1]!;
        const literal = match[2]!;
        // Template literal with an interpolation — not statically resolvable.
        if (quote === "`" && literal.includes("${")) continue;

        // A leading `namespace:` prefix is not part of the stored key.
        const prefixed = /^([\w-]+):(.+)$/.exec(literal);
        const key = prefixed && en.has(prefixed[1]!) ? prefixed[2]! : literal;

        if (isDeclared(key)) continue;
        const line = src.slice(0, match.index).split("\n").length;
        missing.push(`${relative(WEB_SRC, file)}:${line} → t("${literal}")`);
      }
    }

    expect(missing).toEqual([]);
  });
});
