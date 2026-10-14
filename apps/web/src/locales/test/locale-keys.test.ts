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
import type { ScheduleWireDto } from "@appstrate/shared-types";

/**
 * These three guards read every source file of three workspaces on each run.
 * Under the default 5 s that is comfortable on an idle machine and a coin
 * flip on a loaded one (a cold page cache, or a second `bun test` running
 * beside this one), which makes them fail for a reason that has nothing to do
 * with the locales. The budget is deliberately far above the measured cost.
 */
const SCAN_TIMEOUT_MS = 30_000;

const LOCALES_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_SRC = dirname(LOCALES_DIR);
const REPO_ROOT = dirname(dirname(dirname(WEB_SRC)));

/**
 * Every tree whose code resolves against these bundles. `module-chat`'s UI is
 * in the list because it renders inside the SPA and reads `chat.json` through
 * the host-injected `t` (see its `runtime-context.ts`) — its keys live here,
 * so both guards must see its call sites or they mis-report in both
 * directions (unresolvable keys missed, live keys reported dead). `packages/ui`
 * joined for the same reason: `buildGenerationLabels()` names the whole
 * `models.generation.*` family in `model-generation-labels.ts`, on behalf of
 * both surfaces that render `ModelGenerationControls`.
 */
const SOURCE_ROOTS = [
  WEB_SRC,
  join(REPO_ROOT, "packages/module-chat/src/ui"),
  join(REPO_ROOT, "packages/ui/src"),
];

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
  it(
    "all resolve to a declared locale key",
    () => {
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
    },
    SCAN_TIMEOUT_MS,
  );
});

/**
 * Keys assembled at runtime (`t(`status.${status}`)`) have no literal call
 * site, so the reverse guard cannot see them. Each entry below is a prefix
 * under which a REAL interpolation site exists — the comment names it. This
 * is the one list that must be justified per line: widening it to silence a
 * failure is how a dead-key guard becomes decorative. A generic head is
 * qualified with its namespace (`files:type.`) so it shields that namespace
 * alone. Kept alphabetical.
 */
const DYNAMIC_KEY_PREFIXES = [
  "apiError.", // lib/mutation-error.ts — refusalMessage(), one key per server refusal code
  "common:status.", // components/status-badge.tsx — t(`status.${status}`)
  "editor.appearanceColorName.", // components/agent-editor/agent-appearance-fields.tsx
  "editor.runtimeTool.", // components/agent-editor/runtime-tools-group.tsx: one per runtime tool id
  "files:type.", // components/document-columns.tsx, components/file-artifact.tsx — t(`type.${mimeKind(…)}`)
  "integration.admin.creation.", // components/integration-detail/access-rules-section.tsx
  "integration.admin.orgDefault.connection.", // components/integration-detail/org-default-section.tsx — forced / default
  "integration.admin.usage.", // components/integration-detail/org-default-section.tsx — t(`integration.admin.usage.${mode}Help`)
  "integration.auth.type.", // components/integration-connect/connection-picker-menu.tsx
  "integration.connect.fields.", // components/integration-connect/credential-fields.tsx
  "integration.connect.handoff.", // components/integration-connect/handoff-steps.tsx — stepLabel()/stepNote()
  "integration.inventory.basis.", // components/package-detail/package-tool-catalog.tsx
  "integration.inventory.exposure.", // components/package-detail/package-tool-catalog.tsx
  "integration.inventory.filter.", // components/package-detail/package-tool-catalog.tsx
  "integration.inventory.origin.", // components/package-detail/package-tool-catalog.tsx
  "integration.inventory.originDetail.", // components/package-detail/package-tool-catalog.tsx
  "integration.inventory.reason.", // components/package-detail/package-tool-catalog.tsx
  "integration.inventory.rules.", // components/package-detail/package-tool-catalog.tsx
  "integration.structure.concept.", // components/package-detail/integration-structure.tsx
  "integration.structure.empty.", // components/package-detail/integration-structure.tsx
  "integration.structure.type.", // components/package-detail/integration-structure.tsx
  "integrations.execution.", // pages/integrations-page.tsx, components/org-catalogue-modal.tsx — tabs
  "integrations.protocol.", // pages/integration-list-columns.tsx, components/catalogue-columns.tsx — integrationProtocol()
  "log.level.", // components/log-viewer.tsx — t(`log.level.${value}`)
  "log.type.", // components/log-viewer.tsx — t(`log.type.${value}`)
  "models.generation.levels.", // packages/ui — model-generation-labels.ts buildGenerationLabels()
  "models.generation.levelsShort.", // packages/ui — model-generation-labels.ts buildGenerationLabels()
  "oauthClients.scopeLabels.", // modules/oidc/components/oauth-client-form-modal.tsx
  "oauthClients.signupRoleOption.", // modules/oidc/components/oauth-client-form-modal.tsx
  "orgRolesGuide.access.", // pages/org-settings/org-roles.tsx — space reach per org role
  "orgRolesGuide.can.", // pages/org-settings/org-roles.tsx — one key per capability row
  "orgSettings.roleHint.", // components/org-invitation-form.tsx + OAuth signup form
  "packages.type.", // components/package-detail/shared-header.tsx, pages/unified-package-detail.tsx
  "permissions.label.", // lib/permission-labels.ts — permissionLabel()
  "permissions.resource.", // lib/permission-labels.ts — permissionResourceLabel()
  "purpose.", // components/document-columns.tsx — t(`purpose.${doc.purpose}`)
  "roles.preset.", // hooks/use-roles.ts spaceRoleLabel(), pages/org-settings/app/general.tsx
  "roles.presetDesc.", // hooks/use-roles.ts — spaceRoleDescription()
  "run.artifacts.code.", // components/run-artifacts.ts — artifactFailureCodeKey()
  "run.connSource.", // components/run-detail/run-snapshot-inspector.tsx
  "run.status.", // packages/module-chat/src/ui/run-events.ts — runStatusLineKey()
  "run.triggerType.", // components/run-trigger.tsx, components/run-detail/run-header-summary.tsx + run-snapshot-inspector.tsx
  "schedule.disabledReason.", // components/schedule-status-badge.tsx, pages/schedule-detail.tsx
  "spaceMembers.source.", // pages/org-settings/space/space-member-columns.tsx, pages/org-settings/user-space-columns.tsx
  "spaces.visibility.", // pages/org-settings/app/general.tsx — t(`spaces.visibility.${value}`)
  "spaces.visibilityDesc.", // pages/org-settings/app/general.tsx — t(`spaces.visibilityDesc.${value}`)
  "switcher.role.", // components/org-switcher.tsx — t(`switcher.role.${org.role}`)
  "validation.schema.", // hooks/use-schema-form-labels.ts — one key per JSON Schema keyword
  "viewAs.stopped.", // components/view-as-banner.tsx — t(`viewAs.stopped.${code}`)
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
    // The whole literal, closing quote included: `"detail.open` is no
    // reference to `detail.open` when it is the head of `"detail.openRuns"`.
    if (SOURCE_BLOB.includes(quote + key + quote)) return true;
    for (const ns of en.keys())
      if (SOURCE_BLOB.includes(`${quote}${ns}:${key}${quote}`)) return true;
  }
  return false;
}

/** An entry's optional `namespace:` qualifier, and the key head it shields. */
function parsePrefix(entry: string): { ns: string | null; head: string } {
  const qualified = /^([\w-]+):(.+)$/.exec(entry);
  return qualified ? { ns: qualified[1]!, head: qualified[2]! } : { ns: null, head: entry };
}

function isShielded(ns: string, key: string): boolean {
  return DYNAMIC_KEY_PREFIXES.map(parsePrefix).some(
    (prefix) => (prefix.ns === null || prefix.ns === ns) && key.startsWith(prefix.head),
  );
}

describe("declared keys", () => {
  // Scans every key against the whole source blob, so it grows with the app;
  // past ~1000 keys it no longer fits the 5s default on a cold run.
  it(
    "are all still referenced by the source",
    () => {
      // The guard the other direction lacks: deleting the last call site of a
      // key leaves the translation behind in both bundles, and nothing notices.
      const orphans = [...en]
        .flatMap(([ns, keys]) => Object.keys(keys).map((key) => ({ ns, key })))
        .filter(({ ns, key }) => !isShielded(ns, key))
        .filter(({ key }) => !isReferenced(key) && !isReferenced(key.replace(PLURAL_SUFFIX, "")))
        .map(({ ns, key }) => `${ns}:${key}`)
        .sort();

      expect(orphans).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    "keep every dynamic-prefix exemption backed by a real interpolation site",
    () => {
      // An exemption is only legitimate while the code it excuses exists. This
      // is what stops the allow-list from being widened to silence a failure:
      // an invented prefix has no `` `prefix.${…}` `` anywhere and fails here.
      const unjustified = DYNAMIC_KEY_PREFIXES.filter((entry) => {
        const escaped = parsePrefix(entry).head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Optional `namespace:` — some sites interpolate `settings:foo.${x}`.
        return !new RegExp("`(?:[\\w-]+:)?" + escaped + "\\$\\{").test(SOURCE_BLOB);
      });

      expect(unjustified).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );
});

describe("schedule disabled reasons", () => {
  it("each have a sentence", () => {
    // A Record, so a reason added to the enum without an entry here fails the typecheck.
    const reasons = Object.keys({
      actor_invalid: true,
      actor_left_org: true,
      connection_deleted: true,
      connection_unshared: true,
      connection_set_unnamed: true,
      connection_choice_invalid: true,
    } satisfies Record<NonNullable<ScheduleWireDto["disabled_reason"]>, true>);

    expect(reasons.filter((reason) => !allKeys.has(`schedule.disabledReason.${reason}`))).toEqual(
      [],
    );
  });
});
