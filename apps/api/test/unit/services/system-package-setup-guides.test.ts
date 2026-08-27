// SPDX-License-Identifier: Apache-2.0

/**
 * Setup-guide conformance for the shipped system packages.
 *
 * `setup_guide` is what tells an admin WHERE to create the OAuth app whose
 * client id and secret the form then asks for. Its failure mode is quiet: a
 * dead console URL, a missing guide on a new integration, or a
 * `callback_url_hint` that forgot its `{{callback_url}}` placeholder all
 * render as a plausible-looking page that sends the admin nowhere useful. None
 * of it throws, and none of it shows up in a type check.
 *
 * Reachability of the URLs themselves is NOT asserted here — that needs the
 * network and belongs to the conformance monitor. What is pinned is everything
 * checkable offline: that every OAuth integration an admin must register an
 * app for HAS a guide, that its steps are well-formed https links, and that a
 * declared hint carries the placeholder that makes it useful.
 */

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { loadSystemPackages } from "@appstrate/core/system-packages";

const ARCHIVE_DIR = join(import.meta.dir, "../../../../../system-packages");

interface Step {
  label?: unknown;
  url?: unknown;
}

interface Pkg {
  packageId: string;
  sourceKind: string | undefined;
  oauthAuthKeys: string[];
  steps: Step[] | undefined;
  hints: Array<{ authKey: string; hint: string }>;
}

/**
 * Remote MCP integrations provision their client through DCR/CIMD at connect
 * time, so there is no console to visit and no app to register — a setup guide
 * on those would be an instruction to do nothing.
 */
async function loadPackages(): Promise<Pkg[]> {
  const { packages, warnings } = await loadSystemPackages(ARCHIVE_DIR);
  expect(warnings).toEqual([]);
  // `loadSystemPackages` swallows a `readdir` failure and returns an empty
  // set, and ARCHIVE_DIR is a five-level relative climb — so a moved test
  // file or a renamed directory would leave every assertion below comparing
  // `[]` to `[]` and reporting success over zero packages. Anchor the whole
  // file on the archive actually having been read.
  expect(packages.length).toBeGreaterThan(0);
  return packages.map((entry) => {
    const manifest = entry.manifest as Record<string, unknown>;
    const auths = (manifest.auths ?? {}) as Record<string, Record<string, unknown>>;
    const oauthAuthKeys = Object.entries(auths)
      .filter(([, a]) => a.type === "oauth2")
      .map(([k]) => k);
    const guide = manifest.setup_guide as { steps?: unknown } | undefined;
    const source = manifest.source as { kind?: string } | undefined;
    return {
      packageId: entry.packageId,
      sourceKind: source?.kind,
      oauthAuthKeys,
      steps: Array.isArray(guide?.steps) ? (guide.steps as Step[]) : undefined,
      hints: Object.entries(auths)
        .filter(([, a]) => typeof a.callback_url_hint === "string")
        .map(([authKey, a]) => ({ authKey, hint: a.callback_url_hint as string })),
    };
  });
}

/** Integrations whose admin has to go register an OAuth app somewhere. */
function needsGuide(pkg: Pkg): boolean {
  return pkg.oauthAuthKeys.length > 0 && pkg.sourceKind !== "remote";
}

describe("system-package setup guides", () => {
  it("gives every BYO-OAuth integration somewhere to go", async () => {
    const missing = (await loadPackages())
      .filter(needsGuide)
      .filter((p) => !p.steps || p.steps.length === 0)
      .map((p) => p.packageId)
      .sort();
    expect(missing).toEqual([]);
  });

  it("leaves auto-provisioned remote MCP integrations without a guide", async () => {
    // DCR/CIMD registers the client during connect, so there is nothing for an
    // admin to create. A guide here would be an instruction to do nothing.
    const spurious = (await loadPackages())
      .filter((p) => p.sourceKind === "remote" && p.steps && p.steps.length > 0)
      .map((p) => p.packageId)
      .sort();
    expect(spurious).toEqual([]);
  });

  it("gives every step a non-empty label", async () => {
    const bad: string[] = [];
    for (const pkg of await loadPackages()) {
      (pkg.steps ?? []).forEach((step, i) => {
        if (typeof step.label !== "string" || step.label.trim() === "") {
          bad.push(`${pkg.packageId} step ${i}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  // A step's URL is publisher-controlled and rendered as an anchor. The UI
  // degrades a non-http(s) URL to plain text, so a bad scheme is not a
  // vulnerability — it is a step that silently stops being clickable.
  it("makes every step URL an absolute https URL", async () => {
    const bad: string[] = [];
    for (const pkg of await loadPackages()) {
      (pkg.steps ?? []).forEach((step, i) => {
        if (step.url === undefined) return;
        if (typeof step.url !== "string") {
          bad.push(`${pkg.packageId} step ${i}: not a string`);
          return;
        }
        let parsed: URL;
        try {
          parsed = new URL(step.url);
        } catch {
          bad.push(`${pkg.packageId} step ${i}: ${step.url} is not absolute`);
          return;
        }
        if (parsed.protocol !== "https:") {
          bad.push(`${pkg.packageId} step ${i}: ${step.url} is not https`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it("declares no duplicate step URL within one guide", async () => {
    const dupes: string[] = [];
    for (const pkg of await loadPackages()) {
      const urls = (pkg.steps ?? [])
        .map((s) => s.url)
        .filter((u): u is string => typeof u === "string");
      if (new Set(urls).size !== urls.length) dupes.push(pkg.packageId);
    }
    expect(dupes).toEqual([]);
  });

  // The placeholder is the whole point of the field: it is what lets a hint
  // name the exact string to paste, resolved against this deployment's
  // callback. A hint without it is a sentence the UI could have hard-coded.
  it("makes every declared callback_url_hint carry the {{callback_url}} placeholder", async () => {
    const bad: string[] = [];
    for (const pkg of await loadPackages()) {
      for (const { authKey, hint } of pkg.hints) {
        if (!hint.includes("{{callback_url}}")) bad.push(`${pkg.packageId} auth '${authKey}'`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("declares a callback_url_hint only on oauth2 auths", async () => {
    const bad: string[] = [];
    for (const pkg of await loadPackages()) {
      for (const { authKey } of pkg.hints) {
        if (!pkg.oauthAuthKeys.includes(authKey)) bad.push(`${pkg.packageId} auth '${authKey}'`);
      }
    }
    expect(bad).toEqual([]);
  });
});
