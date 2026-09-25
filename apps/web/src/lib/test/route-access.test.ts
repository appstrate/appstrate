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
import { routeOf } from "../route-match.ts";

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

  /** The shell: whatever renders on every page and links into the registry. */
  const SHELL = [
    "components/nav-org.tsx",
    "pages/org-settings/layout.tsx",
    "components/org-switcher.tsx",
    "components/notification-bell.tsx",
    "components/sidebar-billing.tsx",
    "components/nav-user.tsx",
    "components/app-sidebar.tsx",
  ].map((file) => ({ file, text: source(`../../${file}`) }));
  /** Routes outside `MainLayout`, which no declaration covers. */
  const OUTSIDE_MAIN_LAYOUT = new Set(["/onboarding/create"]);
  const links = (text: string) => [...text.matchAll(/\bto(?:=|: )"([^"]+)"/g)].map((m) => m[1]!);
  const reached = (text: string) => [...text.matchAll(/canReach\("([^"]+)"\)/g)].map((m) => m[1]!);

  it("points every shell link at a declared route", () => {
    const targets = SHELL.flatMap(({ text }) => [
      ...links(text),
      ...reached(text),
      ...[...text.matchAll(/(?:path|landsOn): "([^"]+)"/g)].map((m) => m[1]!),
    ]);
    expect(targets.length).toBeGreaterThan(40);
    expect(targets.filter((t) => !declared.has(t) && !OUTSIDE_MAIN_LAYOUT.has(t))).toEqual([]);
  });

  it("shows a shell link to a gated route only behind `canReach` of that route", () => {
    const allOn = new Proxy({}, { get: () => true });
    const unguarded = SHELL.flatMap(({ file, text }) =>
      links(text)
        .filter((t) => declared.has(t))
        .filter((t) => routeVerdict(t as RoutePath, () => false, allOn) !== "granted")
        .filter((t) => !reached(text).includes(t))
        .map((t) => `${file} → ${t}`),
    );
    expect(unguarded).toEqual([]);
  });

  it("leaves shell visibility to the declarations, never to a local permission or flag check", () => {
    const local = SHELL.flatMap(({ file, text }) =>
      (text.match(/\busePermissions\(|\bcan\(|\bfeatures\./g) ?? []).map((m) => `${file}: ${m}`),
    );
    expect(local).toEqual([]);
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

describe("routeOf", () => {
  it("returns a declared pattern as is", () => {
    expect(routeOf("/agents/:scope/:name/runs/:runId")).toBe("/agents/:scope/:name/runs/:runId");
  });

  it("ranks a concrete URL the way the router does: static segments first", () => {
    expect(routeOf("/agents/new")).toBe("/agents/new");
    expect(routeOf("/agents/@acme/triage")).toBe("/agents/:scope/:name");
    expect(routeOf("/agents/@acme/triage/edit")).toBe("/agents/:scope/:name/edit");
    expect(routeOf("/agents/@acme/triage/1.2.0")).toBe("/agents/:scope/:name/:version");
    expect(routeOf("/agents/@acme/triage/runs/run_1?tab=logs#x")).toBe(
      "/agents/:scope/:name/runs/:runId",
    );
    expect(routeOf("/integrations/@acme/gmail#configuration")).toBe("/integrations/:scope/:name");
  });

  it("covers no URL outside the declarations", () => {
    expect(routeOf("/onboarding/create")).toBeUndefined();
    expect(routeOf("/agents/@acme/triage/runs/run_1/logs")).toBeUndefined();
  });

  it("feeds routeVerdict, so a concrete link is judged by its route's gate", () => {
    const runsOnly = (p: string) => p === "runs:read";
    const verdict = (url: string) => routeVerdict(routeOf(url)!, runsOnly, {});
    expect(verdict("/agents/@acme/triage/runs/run_1")).toBe("granted");
    expect(verdict("/agents/@acme/triage")).toBe("denied");
  });
});
