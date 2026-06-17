// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  analyzeComposeDefaults,
  extractComposeDefaults,
  rewriteStaleComposeDefaults,
  CODE_DEFAULTS,
  ALLOWLIST,
} from "../src/lib/compose-defaults.ts";

/**
 * Unit coverage for the shared compose-default knowledge (#515). Pure
 * string-in/findings-out — no filesystem. Mirrors the contract the CI
 * guard (`scripts/verify-compose-defaults.ts`) and the runtime checks
 * (`appstrate doctor` / `--upgrade-compose`) both rely on.
 */

// MODULES is a tracked, NON-allowlisted code default — the canonical
// #513 drift var. Its code default is the literal CSV below.
const MODULES_DEFAULT = CODE_DEFAULTS.MODULES!;

describe("extractComposeDefaults", () => {
  it("captures var name, default, line, and raw text per occurrence", () => {
    const content = [
      "services:",
      "  api:",
      "    environment:",
      "      - MODULES=${MODULES:-a,b}",
    ].join("\n");
    const matches = extractComposeDefaults(content);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      line: 4,
      varName: "MODULES",
      yamlDefault: "a,b",
      raw: "      - MODULES=${MODULES:-a,b}",
    });
  });

  it("finds multiple occurrences on the same line", () => {
    const content =
      "      - DATABASE_URL=postgres://${POSTGRES_USER:-appstrate}:${POSTGRES_PASSWORD:-x}@db";
    const matches = extractComposeDefaults(content);
    expect(matches.map((m) => m.varName)).toEqual(["POSTGRES_USER", "POSTGRES_PASSWORD"]);
  });

  it("does not leak regex state across calls (lastIndex reset)", () => {
    const content = "      - MODULES=${MODULES:-x}";
    expect(extractComposeDefaults(content)).toHaveLength(1);
    expect(extractComposeDefaults(content)).toHaveLength(1);
  });
});

describe("analyzeComposeDefaults", () => {
  it("flags a duplicated code default", () => {
    const content = `      - MODULES=\${MODULES:-${MODULES_DEFAULT}}`;
    const findings = analyzeComposeDefaults(content);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "duplicate",
      varName: "MODULES",
      yamlDefault: MODULES_DEFAULT,
      codeDefault: MODULES_DEFAULT,
      line: 1,
    });
  });

  it("ignores a YAML default that differs from the code default", () => {
    // An operator who genuinely wants a different default is not the
    // #513 bug — only an EXACT mirror is flagged.
    const content = "      - MODULES=${MODULES:-only,webhooks}";
    expect(analyzeComposeDefaults(content)).toEqual([]);
  });

  it("ignores untracked variables entirely", () => {
    const content = "      - SOME_RANDOM_VAR=${SOME_RANDOM_VAR:-whatever}";
    expect(analyzeComposeDefaults(content)).toEqual([]);
  });

  it("does not flag an allowlisted var at its sanctioned default", () => {
    // RUN_ADAPTER is allowlisted with yamlDefault "docker".
    const content = "      - RUN_ADAPTER=${RUN_ADAPTER:-docker}";
    expect(analyzeComposeDefaults(content)).toEqual([]);
  });

  it("flags allowlist drift when an override's default changed", () => {
    const content = "      - RUN_ADAPTER=${RUN_ADAPTER:-process}";
    const findings = analyzeComposeDefaults(content);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "allowlist-drift",
      varName: "RUN_ADAPTER",
      yamlDefault: "process",
      expectedYamlDefault: ALLOWLIST.RUN_ADAPTER!.yamlDefault,
    });
  });

  it("returns findings in line order for a mixed file", () => {
    const content = [
      "      - SOME_RANDOM_VAR=${SOME_RANDOM_VAR:-x}", // ignored
      `      - MODULES=\${MODULES:-${MODULES_DEFAULT}}`, // duplicate
      "      - RUN_ADAPTER=${RUN_ADAPTER:-process}", // allowlist-drift
    ].join("\n");
    const findings = analyzeComposeDefaults(content);
    expect(findings.map((f) => [f.line, f.kind])).toEqual([
      [2, "duplicate"],
      [3, "allowlist-drift"],
    ]);
  });
});

describe("rewriteStaleComposeDefaults", () => {
  it("returns unchanged for a clean file", () => {
    const content = ["      - MODULES", "      - APP_URL"].join("\n");
    const result = rewriteStaleComposeDefaults(content);
    expect(result.changed).toBe(false);
    expect(result.newContent).toBe(content);
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([]);
  });

  it("strips a stale sequence-entry default to a bare passthrough", () => {
    const content = [
      "    environment:",
      `      - MODULES=\${MODULES:-${MODULES_DEFAULT}}`,
      "      - APP_URL",
    ].join("\n");
    const result = rewriteStaleComposeDefaults(content);
    expect(result.changed).toBe(true);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({
      line: 2,
      varName: "MODULES",
      after: "      - MODULES",
    });
    expect(result.newContent.split("\n")[1]).toBe("      - MODULES");
    expect(result.refused).toEqual([]);
  });

  it("preserves operator-added lines verbatim", () => {
    const content = [
      "    environment:",
      `      - MODULES=\${MODULES:-${MODULES_DEFAULT}}`,
      "      - MY_CUSTOM_OPERATOR_VAR=hello",
      "    volumes:",
      "      - ./my-extra-mount:/data",
    ].join("\n");
    const result = rewriteStaleComposeDefaults(content);
    const lines = result.newContent.split("\n");
    expect(lines[1]).toBe("      - MODULES");
    expect(lines[2]).toBe("      - MY_CUSTOM_OPERATOR_VAR=hello");
    expect(lines[4]).toBe("      - ./my-extra-mount:/data");
  });

  it("is idempotent — a second pass changes nothing", () => {
    const content = `      - MODULES=\${MODULES:-${MODULES_DEFAULT}}`;
    const once = rewriteStaleComposeDefaults(content);
    const twice = rewriteStaleComposeDefaults(once.newContent);
    expect(twice.changed).toBe(false);
    expect(twice.newContent).toBe(once.newContent);
  });

  it("refuses (does not guess) a duplicated default in mapping form", () => {
    // Hand-written `VAR: ${VAR:-default}` cannot become a bare
    // passthrough without changing YAML structure → reported, not edited.
    const content = `      MODULES: \${MODULES:-${MODULES_DEFAULT}}`;
    const result = rewriteStaleComposeDefaults(content);
    expect(result.changed).toBe(false);
    expect(result.newContent).toBe(content);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toMatchObject({ line: 1, varName: "MODULES" });
  });

  it("leaves allowlist-drift lines untouched (not the #513 class)", () => {
    const content = "      - RUN_ADAPTER=${RUN_ADAPTER:-process}";
    const result = rewriteStaleComposeDefaults(content);
    expect(result.changed).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.refused).toEqual([]);
  });

  it("preserves indentation of the rewritten entry", () => {
    const content = `        - MODULES=\${MODULES:-${MODULES_DEFAULT}}`;
    const result = rewriteStaleComposeDefaults(content);
    expect(result.newContent).toBe("        - MODULES");
  });
});
