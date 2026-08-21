// SPDX-License-Identifier: Apache-2.0

/**
 * Pure transformation + assertion logic for the one-shot `config` → `input`
 * data migration (`scripts/migrate-config-to-input.ts`).
 *
 * Kept free of database, storage and env imports so every rule below is
 * unit-testable without a live database. The CLI owns all I/O.
 *
 * Background: an AFPS agent manifest used to declare two parameter schemas,
 * `input` (per run) and `config` (set once at setup). They are now one:
 * `input`. The platform no longer reads `manifest.config`, and the prompt
 * renderer is logic-less Mustache — an unknown key renders as the EMPTY
 * STRING. A stale `{{config.days}}` therefore produces a silently truncated
 * prompt with no error, which is exactly what this migration exists to
 * eliminate.
 */

import { getOrderedKeys, asJSONSchemaObject } from "@appstrate/core/form";

/** AFPS `schema_version` stamped on every manifest this migration rewrites. */
export const MIGRATED_SCHEMA_VERSION = "0.3";

/**
 * Wrapper members carried from `config` into `input`. Anything else present on
 * a `config` wrapper is reported as not carried — never dropped silently.
 * `required` is not listed here: per AFPS it lives inside `schema.required`,
 * and is merged with the schema below.
 */
const CARRIED_WRAPPER_KEYS = new Set(["schema", "file_constraints", "ui_hints", "property_order"]);

export type JsonObject = Record<string, unknown>;

/** Narrow an unknown JSONB value to a plain object, or `null`. */
export function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Whether a manifest still declares the retired top-level `config` section. */
export function hasConfigSection(manifest: unknown): boolean {
  const obj = asObject(manifest);
  return obj !== null && "config" in obj;
}

// ─────────────────────────────────────────────
// Manifest merge
// ─────────────────────────────────────────────

export interface MergeReport {
  /** `config` properties moved into `input.schema.properties`. */
  merged: string[];
  /** `config` properties dropped because `input` already declared them (input wins). */
  collisions: string[];
  /** Property names that became `required` on `input` because `config` required them. */
  requiredAdded: string[];
  /** Property names whose `ui_hints` entry was carried over. */
  uiHintsCarried: string[];
  /** Property names whose `file_constraints` entry was carried over. */
  fileConstraintsCarried: string[];
  /** `config` wrapper members with no `input` counterpart this migration carries. */
  notCarried: string[];
}

export interface MergeOutcome {
  manifest: JsonObject;
  report: MergeReport;
}

/** Pick the entries of `map` whose key is in `keep`. Returns null when empty. */
function pickKeys(map: JsonObject | null, keep: Set<string>): JsonObject | null {
  if (!map) return null;
  const out: JsonObject = {};
  for (const key of Object.keys(map)) {
    if (keep.has(key)) out[key] = map[key];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Merge `manifest.config` into `manifest.input`, delete `config`, and stamp
 * `schema_version`.
 *
 * Collision rule: **`input` wins and the `config` entry is dropped whole** —
 * its property schema, its `required` membership, and its `ui_hints` /
 * `file_constraints` entries. A colliding name is already governed by `input`;
 * letting half of the dropped `config` entry survive would produce a field
 * whose schema and its metadata came from different authors.
 *
 * Idempotent on a manifest that carries no `config`: returns it untouched with
 * an empty report.
 */
export function mergeConfigIntoInput(manifest: JsonObject): MergeOutcome {
  const emptyReport: MergeReport = {
    merged: [],
    collisions: [],
    requiredAdded: [],
    uiHintsCarried: [],
    fileConstraintsCarried: [],
    notCarried: [],
  };
  if (!hasConfigSection(manifest)) return { manifest, report: emptyReport };

  const config = asObject(manifest["config"]) ?? {};
  const input = asObject(manifest["input"]) ?? {};

  const configSchema = asObject(config["schema"]) ?? {};
  const inputSchema = asObject(input["schema"]) ?? {};
  const configProps = asObject(configSchema["properties"]) ?? {};
  const inputProps = asObject(inputSchema["properties"]) ?? {};

  const merged: string[] = [];
  const collisions: string[] = [];
  const properties: JsonObject = { ...inputProps };
  for (const key of Object.keys(configProps)) {
    if (key in inputProps) {
      collisions.push(key);
      continue;
    }
    properties[key] = configProps[key];
    merged.push(key);
  }
  const mergedSet = new Set(merged);

  // `required` is a schema member, not a wrapper member. Carry it for the
  // properties that actually moved — a collided name keeps `input`'s own
  // requiredness, since its `config` entry was dropped whole.
  const inputRequired = asStringArray(inputSchema["required"]);
  const requiredAdded = asStringArray(configSchema["required"]).filter(
    (key) => mergedSet.has(key) && !inputRequired.includes(key),
  );
  const required = [...inputRequired, ...requiredAdded];

  const schema: JsonObject = { type: "object", ...inputSchema, properties };
  if (required.length > 0) schema["required"] = required;
  else delete schema["required"];

  const uiHints = {
    ...pickKeys(asObject(config["ui_hints"]), mergedSet),
    ...asObject(input["ui_hints"]),
  };
  const fileConstraints = {
    ...pickKeys(asObject(config["file_constraints"]), mergedSet),
    ...asObject(input["file_constraints"]),
  };

  const wrapper: JsonObject = { ...input, schema };
  if (Object.keys(uiHints).length > 0) wrapper["ui_hints"] = uiHints;
  if (Object.keys(fileConstraints).length > 0) wrapper["file_constraints"] = fileConstraints;

  // Presentation order: `input`'s own order first, then the migrated `config`
  // fields in their own order. Emitted only when at least one side declared
  // one — otherwise the natural key order already tells the truth, and
  // materialising an order here would freeze it for no reason.
  const inputOrder = asStringArray(input["property_order"]);
  const configOrder = asStringArray(config["property_order"]);
  if (inputOrder.length > 0 || configOrder.length > 0) {
    const inputKeys = getOrderedKeys(
      asJSONSchemaObject({ type: "object", properties: inputProps }),
      inputOrder,
    );
    const configKeys = getOrderedKeys(
      asJSONSchemaObject({ type: "object", properties: configProps }),
      configOrder,
    ).filter((key) => mergedSet.has(key));
    wrapper["property_order"] = [...inputKeys, ...configKeys];
  }

  const notCarried = Object.keys(config).filter((key) => !CARRIED_WRAPPER_KEYS.has(key));

  const out: JsonObject = { ...manifest, input: wrapper };
  delete out["config"];
  out["schema_version"] = MIGRATED_SCHEMA_VERSION;

  return {
    manifest: out,
    report: {
      merged,
      collisions,
      requiredAdded,
      uiHintsCarried: Object.keys(pickKeys(asObject(config["ui_hints"]), mergedSet) ?? {}),
      fileConstraintsCarried: Object.keys(
        pickKeys(asObject(config["file_constraints"]), mergedSet) ?? {},
      ),
      notCarried,
    },
  };
}

/** Top-level `input.schema.properties` names of a (migrated) manifest. */
export function inputPropertyNames(manifest: unknown): string[] {
  const input = asObject(asObject(manifest)?.["input"]);
  const props = asObject(asObject(input?.["schema"])?.["properties"]);
  return props ? Object.keys(props) : [];
}

// ─────────────────────────────────────────────
// Prompt template rewrite
// ─────────────────────────────────────────────

/**
 * One Mustache tag. Triple-stache first so `{{{x}}}` is not mis-split by the
 * double-stache alternative.
 */
const MUSTACHE_TAG = /\{\{\{[\s\S]*?\}\}\}|\{\{[\s\S]*?\}\}/g;

/**
 * Sigils this rewrite refuses to touch: comments (`!`), delimiter changes
 * (`=`) and partials (`>`) never address the view, so a `config` inside one is
 * not a data reference.
 */
const OPAQUE_SIGILS = new Set(["!", "=", ">"]);

/** Sigils that DO address the view: raw, section, inverted section, close. */
const VIEW_SIGILS = new Set(["&", "#", "^", "/"]);

/**
 * Rewrite every Mustache tag addressing the retired `config` namespace to
 * `input`. Handles the padded (`{{ config.x }}`), raw (`{{&config.x}}`),
 * triple (`{{{config.x}}}`) and section (`{{#config.x}}…{{/config.x}}`) forms,
 * plus the bare `{{config}}` / `{{#config}}` whole-object reference.
 *
 * Idempotent: a template with no `config` tag is returned unchanged with
 * `count: 0`.
 */
export function rewriteConfigReferences(template: string): { content: string; count: number } {
  let count = 0;
  const content = template.replace(MUSTACHE_TAG, (tag) => {
    const triple = tag.startsWith("{{{");
    const open = triple ? "{{{" : "{{";
    const close = triple ? "}}}" : "}}";
    const inner = tag.slice(open.length, tag.length - close.length).trim();
    const first = inner.slice(0, 1);
    if (OPAQUE_SIGILS.has(first)) return tag;
    const sigil = VIEW_SIGILS.has(first) ? first : "";
    const key = inner.slice(sigil.length).trim();
    if (key !== "config" && !key.startsWith("config.")) return tag;
    count++;
    return `${open}${sigil}input${key.slice("config".length)}${close}`;
  });
  return { content, count };
}

/** Whether a prompt template still addresses the retired `config` namespace. */
export function hasConfigReference(template: string | null | undefined): boolean {
  return template ? rewriteConfigReferences(template).count > 0 : false;
}

// ─────────────────────────────────────────────
// Final assertion
// ─────────────────────────────────────────────

export interface AssertionInput {
  /** Package ids whose `draft_manifest` was read. */
  draftsChecked: number;
  draftManifestsWithConfig: string[];
  /** Package ids whose `draft_content` was read (same population as drafts). */
  draftPromptsChecked: number;
  draftPromptsWithConfigRef: string[];
  /** `@scope/name@version` of every version this migration published. */
  republishedChecked: number;
  republishedManifestsWithConfig: string[];
  republishedPromptsWithConfigRef: string[];
  /** Schedules whose `version_override` was resolved. */
  schedulesChecked: number;
  schedulesPinnedToAffected: string[];
  /** `application_packages` rows read for the stored-values no-op check. */
  installsChecked: number;
  installsWithLockedFields: string[];
  /**
   * Pre-existing published versions that still carry `config`. Immutable by
   * construction — reported, never a failure on its own.
   */
  legacyAffectedVersions: string[];
  /**
   * Legacy affected versions still selected by default: the package's `latest`
   * dist-tag still points at one, so an unpinned run would execute it. This IS
   * a failure — it means the republish did not take.
   */
  legacyAffectedStillLatest: string[];
}

export interface AssertionResult {
  ok: boolean;
  lines: string[];
}

function residueLine(label: string, checked: number, offenders: string[]): string {
  const verdict = offenders.length === 0 ? "clean" : `${offenders.length} FOUND`;
  return `  ${label.padEnd(46)} checked ${String(checked).padStart(5)}   ${verdict}`;
}

/**
 * Render the final assertion. Fails when any residue the migration is
 * responsible for survives.
 *
 * `legacyAffectedVersions` is deliberately NOT a failure: a published version
 * is immutable (its `prompt.md` lives inside an integrity-pinned ZIP), so the
 * old rows keep their `config` for ever. What must hold is that none of them is
 * still *selected*: the `latest` dist-tag moved to the republished version and
 * no schedule pins one.
 */
export function renderAssertion(input: AssertionInput): AssertionResult {
  const offenders: [string, string[]][] = [
    ["`config` key in packages.draft_manifest", input.draftManifestsWithConfig],
    ["`{{config.` in packages.draft_content", input.draftPromptsWithConfigRef],
    ["`config` key in republished manifest", input.republishedManifestsWithConfig],
    ["`{{config.` in republished prompt.md", input.republishedPromptsWithConfigRef],
    ["schedule pinned to an affected version", input.schedulesPinnedToAffected],
    ["application_packages.locked_fields not empty", input.installsWithLockedFields],
    ["legacy affected version still tagged `latest`", input.legacyAffectedStillLatest],
  ];

  const lines = [
    "── Final assertion ───────────────────────────────────────────",
    residueLine(
      "`config` key in packages.draft_manifest",
      input.draftsChecked,
      input.draftManifestsWithConfig,
    ),
    residueLine(
      "`{{config.` in packages.draft_content",
      input.draftPromptsChecked,
      input.draftPromptsWithConfigRef,
    ),
    residueLine(
      "`config` key in republished manifest",
      input.republishedChecked,
      input.republishedManifestsWithConfig,
    ),
    residueLine(
      "`{{config.` in republished prompt.md",
      input.republishedChecked,
      input.republishedPromptsWithConfigRef,
    ),
    residueLine(
      "schedule pinned to an affected version",
      input.schedulesChecked,
      input.schedulesPinnedToAffected,
    ),
    residueLine(
      "application_packages.locked_fields not empty",
      input.installsChecked,
      input.installsWithLockedFields,
    ),
    residueLine(
      "legacy affected version still tagged `latest`",
      input.legacyAffectedVersions.length,
      input.legacyAffectedStillLatest,
    ),
  ];

  lines.push(
    `  legacy published versions still carrying \`config\`: ${input.legacyAffectedVersions.length}` +
      " (immutable — kept, but no longer selected by default)",
  );

  const failed = offenders.filter(([, list]) => list.length > 0);
  if (failed.length === 0) {
    lines.push("PASS — no reachable `config` residue.");
    return { ok: true, lines };
  }

  lines.push("");
  lines.push("FAIL — residue survived:");
  for (const [label, list] of failed) {
    lines.push(`  ${label}:`);
    for (const id of list) lines.push(`    ${id}`);
  }
  return { ok: false, lines };
}
