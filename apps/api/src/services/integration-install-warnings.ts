// SPDX-License-Identifier: Apache-2.0

import { META_NAMESPACE_KEY_REGEX } from "@appstrate/core/validation";

/**
 * Install-time warnings for `integration` manifests whose `connect.login`
 * declarations exercise corners of AFPS §7.7 the Appstrate login engine
 * (`packages/connect/src/connect/login-engine.ts`) does NOT fully support.
 *
 * Spec-conformant manifests are still installable — the engine is a documented
 * subset (no XPath, jsonpath single-value, criterion-type subset). These
 * warnings surface the gap at install time so the publisher learns about it
 * BEFORE the first failed credential acquisition rather than chasing a
 * runtime `LoginError` after the fact.
 *
 * Categories produced:
 *   - `connect.login.outputs[<name>]` declared as an Arazzo Selector Object
 *     with `type === "xpath"` → engine throws at extraction time.
 *   - `connect.login.outputs[<name>]` declared as a `jsonpath` Selector
 *     whose query contains wildcards / filters / slices / recursive descent →
 *     the single-value RFC 9535 subset will throw.
 *   - `connect.login.success_criteria[*]` whose `type` is `xpath` (always
 *     unsupported) — the engine now handles `simple|jsonpath|regex`.
 *
 * Pure function. Reads the integration manifest only — does NOT need any
 * DB lookup. Returns an array of human-readable strings; the caller folds
 * them into the route response's `warnings` channel.
 */

/** A Selector Object as it lands in the manifest (subset for shape-checking only). */
interface MaybeSelectorObject {
  context?: unknown;
  selector?: unknown;
  type?: unknown;
}

interface MaybeCriterion {
  condition?: unknown;
  type?: unknown;
  context?: unknown;
}

const MULTI_VALUE_JSONPATH = /(\[\s*\*\s*\]|\[\s*\?|\.{2}|\[\s*-?\d+\s*:)/;

function isSelectorObject(value: unknown): value is MaybeSelectorObject {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as MaybeSelectorObject).selector === "string" &&
    typeof (value as MaybeSelectorObject).type === "string"
  );
}

/**
 * Walk an integration manifest's `auths.{key}.connect.login` blocks and
 * collect engine-subset warnings. Returns `[]` when the manifest is not
 * an integration or declares no `connect.login`.
 */
export function collectConnectLoginWarnings(manifest: unknown): string[] {
  const warnings: string[] = [];
  if (typeof manifest !== "object" || manifest === null) return warnings;
  const m = manifest as Record<string, unknown>;
  if (m.type !== "integration") return warnings;

  const auths = m.auths;
  if (typeof auths !== "object" || auths === null) return warnings;

  for (const [authKey, authValueRaw] of Object.entries(auths as Record<string, unknown>)) {
    if (typeof authValueRaw !== "object" || authValueRaw === null) continue;
    const authValue = authValueRaw as Record<string, unknown>;
    const connect = authValue.connect;
    if (typeof connect !== "object" || connect === null) continue;
    const login = (connect as Record<string, unknown>).login;
    if (typeof login !== "object" || login === null) continue;

    // --- outputs ---
    const outputs = (login as Record<string, unknown>).outputs;
    if (outputs && typeof outputs === "object") {
      for (const [outputName, outputValue] of Object.entries(outputs as Record<string, unknown>)) {
        if (!isSelectorObject(outputValue)) continue;
        const type = String(outputValue.type);
        const selector = String(outputValue.selector);
        if (type === "xpath") {
          warnings.push(
            `auths.${authKey}.connect.login.outputs.${outputName}: ` +
              `XPath selector not supported by Appstrate runtime; output \`${outputName}\` will fail at credential acquisition.`,
          );
        } else if (type === "jsonpath" && MULTI_VALUE_JSONPATH.test(selector)) {
          warnings.push(
            `auths.${authKey}.connect.login.outputs.${outputName}: ` +
              `JSONPath selector \`${selector}\` uses wildcards/filters/slices/recursive-descent — the Appstrate runtime only supports the single-value subset (\`$.a.b\` / \`$.a[0].b\`). Extraction will fail.`,
          );
        }
      }
    }

    // --- success_criteria ---
    const successCriteria = (login as Record<string, unknown>).success_criteria;
    if (Array.isArray(successCriteria)) {
      successCriteria.forEach((entry, index) => {
        if (typeof entry !== "object" || entry === null) return;
        const c = entry as MaybeCriterion;
        const type = typeof c.type === "string" ? c.type : "simple";
        if (type === "xpath") {
          warnings.push(
            `auths.${authKey}.connect.login.success_criteria[${index}]: ` +
              `criterion type \`xpath\` is not supported by the Appstrate runtime; this criterion will conservatively fail.`,
          );
        }
      });
    }
  }

  return warnings;
}

/**
 * Install-time warning for `source.kind: "remote"` integrations that declare
 * per-tool `tools_policy.{name}.url_patterns`.
 *
 * Why: the niveau-2 Phase-4 MITM URL envelope is enforced ONLY on the local
 * stdio-runner path. A remote HTTP MCP integration transits every tool call
 * through the single `/mcp/v1` endpoint, so the sidecar can't discriminate
 * per-tool upstream URLs — the `url_patterns` are silently UNENFORCEABLE (the
 * upstream MCP's own RBAC + OAuth scope are the only gates). An author who
 * declares them likely believes they have an enforcement layer they don't.
 *
 * Non-blocking (the manifest is still installable + functional) — we surface
 * the trade-off at the publish/install decision point rather than rejecting.
 *
 * Pure function. Returns `[]` for non-integration manifests, non-remote
 * sources, or when no tool declares `url_patterns`.
 */
export function collectRemoteUrlPatternWarnings(manifest: unknown): string[] {
  const warnings: string[] = [];
  if (typeof manifest !== "object" || manifest === null) return warnings;
  const m = manifest as Record<string, unknown>;
  if (m.type !== "integration") return warnings;

  const source = m.source;
  if (typeof source !== "object" || source === null) return warnings;
  if ((source as Record<string, unknown>).kind !== "remote") return warnings;

  const toolsPolicy = m.tools_policy;
  if (typeof toolsPolicy !== "object" || toolsPolicy === null) return warnings;

  for (const [toolName, policyRaw] of Object.entries(toolsPolicy as Record<string, unknown>)) {
    if (typeof policyRaw !== "object" || policyRaw === null) continue;
    const patterns = (policyRaw as Record<string, unknown>).url_patterns;
    if (Array.isArray(patterns) && patterns.length > 0) {
      warnings.push(
        `tools_policy.${toolName}.url_patterns: declared on a \`source.kind: "remote"\` integration, ` +
          `but per-tool URL-envelope enforcement (niveau 2 Phase 4) applies ONLY to local runners. ` +
          `For remote HTTP MCP every tool transits the same \`/mcp/v1\` endpoint, so these patterns are NOT enforced — ` +
          `the upstream MCP's own RBAC + OAuth scope are the only gates.`,
      );
    }
  }

  return warnings;
}

/**
 * Walk a package manifest's top-level `_meta` block and collect install-time
 * warnings for namespace keys that don't match the AFPS Appendix B
 * `META_NAMESPACE_KEY` regex (per re-audit 2A observation — surface the
 * soft-fail warnings the core validator emits to `console.warn` only).
 *
 * Reserved-prefix keys (`mcp/`, `modelcontextprotocol/`) are hard-rejected
 * upstream by the validator (§10), so they cannot reach this code path.
 * Applies to ALL package types — every type's manifest can carry `_meta`.
 *
 * Pure function. Returns `[]` when `_meta` is absent or well-formed.
 */
export function collectMetaWarnings(manifest: unknown): string[] {
  const warnings: string[] = [];
  if (typeof manifest !== "object" || manifest === null) return warnings;
  const meta = (manifest as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) return warnings;

  for (const key of Object.keys(meta as Record<string, unknown>)) {
    if (!META_NAMESPACE_KEY_REGEX.test(key)) {
      warnings.push(
        `_meta.${key}: key "${key}" does not match the AFPS Appendix B META_NAMESPACE_KEY pattern — accepted for forward compatibility per §10.1, but consumers may not recognise it.`,
      );
    }
  }

  return warnings;
}
