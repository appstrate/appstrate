// SPDX-License-Identifier: Apache-2.0

/**
 * What the compiler cannot prove about the one-declaration-per-route rule
 * (`lib/route-access.ts`). Source-scanned: `app.tsx` pulls in the typed API
 * client, which the bun runner cannot evaluate. The `anyOf` ↔ API guard pin is
 * `apps/api/test/unit/spa-route-access.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ROUTE_ACCESS, routeVerdict, type RoutePath } from "../route-access.ts";

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("route declarations", () => {
  const declared = new Set(Object.keys(ROUTE_ACCESS));

  it("mounts every main-layout route from the PAGES table, never by hand", () => {
    // `PAGES: Record<RoutePath, …>` pairs each route with its declaration at
    // compile time; a hand-written `<Route path=…>` there would bypass it.
    const app = source("../../app.tsx");
    const mainLayout = app.slice(app.indexOf("<MainLayout />"));
    expect(mainLayout.match(/<Route\s+path=/g)).toEqual(["<Route path="]);
    expect(mainLayout).toContain('<Route path="*"');
    expect(app).toMatch(/const PAGES: Record<RoutePath, ReactNode> =/);
  });

  it("points every sidebar entry and settings tab at a declared route", () => {
    const targets = [
      ...source("../../components/nav-org.tsx").matchAll(/(?:path|landsOn): "([^"]+)"/g),
      ...source("../../components/nav-org.tsx").matchAll(/canReach\("([^"]+)"\)/g),
      ...source("../../pages/org-settings/layout.tsx").matchAll(/\bto: "([^"]+)"/g),
      ...source("../../pages/org-settings/layout.tsx").matchAll(/canReach\("([^"]+)"\)/g),
    ].map((m) => m[1]!);
    expect(targets.length).toBeGreaterThan(25);
    expect(targets.filter((t) => !declared.has(t))).toEqual([]);
  });

  it("leaves visibility to the declarations, never to a local permission or flag check", () => {
    for (const file of ["../../components/nav-org.tsx", "../../pages/org-settings/layout.tsx"]) {
      expect({ file, local: source(file).match(/\bcan\(|features\./g) ?? [] }).toEqual({
        file,
        local: [],
      });
    }
  });
});

describe("routeVerdict", () => {
  const none = () => false;

  it("opens a gated route on any one of its permissions", () => {
    expect(routeVerdict("/runs", (p) => p === "runs:read-all", {})).toBe("granted");
    expect(routeVerdict("/runs", none, {})).toBe("denied");
  });

  it("treats a route whose module is off as absent, whatever the grants", () => {
    const all = () => true;
    expect(routeVerdict("/chat", all, {})).toBe("absent");
    expect(routeVerdict("/chat", all, { chat: true })).toBe("granted");
    expect(routeVerdict("/chat", none, { chat: true })).toBe("denied");
  });

  it("opens an ungated route to a caller holding nothing", () => {
    const open: RoutePath[] = ["/", "/agents/:scope/:name/edit", "/preferences/general"];
    for (const path of open) expect(routeVerdict(path, none, {})).toBe("granted");
  });
});
