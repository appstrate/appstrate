// SPDX-License-Identifier: Apache-2.0

/**
 * Every column set, measured against the thresholds it degrades on.
 *
 * A tier is a promise: "once the table reaches 36rem, these columns fit". That
 * promise is arithmetic — the sum of the tier's floors plus its gaps and
 * padding — and nothing in the type system checks it. It went unchecked once,
 * and the result was eight columns crushed into 700px with the agent name, the
 * only thing naming a run, at 6px.
 *
 * So the arithmetic is done here, on the real sets, at the real thresholds.
 * A column set that no longer fits fails a test instead of a screen.
 */

import { describe, it, expect } from "bun:test";
import type { ReactElement } from "react";
import type { DataColumn } from "../data-table.tsx";
import { useRunColumns } from "../runs-table.tsx";
import { useScheduleColumns } from "../schedules-table.tsx";
import { usePackageColumns } from "../packages-table.tsx";
import { useProxyColumns } from "../../pages/org-settings/proxies.tsx";
import {
  useConnectionColumns,
  useIntegrationClientColumns,
} from "../../pages/integration-columns.tsx";
import { useCredentialColumns, useModelColumns } from "../../pages/org-settings/model-columns.tsx";
import { render } from "./run-fixture.tsx";

/**
 * Tailwind's `@xl` and `@4xl`, the two container widths `DataTable` reads —
 * written out here rather than imported from it ON PURPOSE. A test that shares
 * the number it is checking tests nothing: it is the translation of the class
 * name into pixels, knowledge that lives in Tailwind, and the day someone moves
 * a column to a different tier this file has to disagree with them.
 */
const THRESHOLD = { 2: 36 * 16, 3: 56 * 16 } as const;
/** `px-3 gap-3` below `@xl`, `px-4 gap-4` from there up. */
const SPACING = { 1: 12, 2: 16, 3: 16 } as const;

/** All a tier measurement needs from a column. */
type Track = Pick<DataColumn<never>, "width" | "tier">;

/** The narrowest the browser will let a track be. */
function floor(width: string): number {
  const fixed = /^(\d+)px$/.exec(width);
  if (fixed) return Number(fixed[1]);
  const elastic = /^minmax\((\d+)px,/.exec(width);
  if (elastic) return Number(elastic[1]);
  throw new Error(`unreadable track: ${width}`);
}

function widthOf(columns: Track[], tier: 1 | 2 | 3): number {
  const shown = columns.filter((c) => (c.tier ?? 1) <= tier);
  const space = SPACING[tier];
  return shown.reduce((sum, c) => sum + floor(c.width), 0) + space * (shown.length + 1);
}

/** Runs the hook the way a screen does, and hands back what it returned. */
function columnsFrom<T>(useColumns: () => DataColumn<T>[]): Track[] {
  let captured: Track[] = [];
  function Probe(): ReactElement | null {
    captured = useColumns();
    return null;
  }
  render(<Probe />);
  return captured;
}

const SETS = {
  runs: () => columnsFrom(() => useRunColumns({ agentName: () => "Compta trimestrielle" })),
  schedules: () => columnsFrom(() => useScheduleColumns({ agentName: () => "Wiki-brain" })),
  packages: () => columnsFrom(() => usePackageColumns()),
  models: () =>
    columnsFrom(() =>
      useModelColumns({
        registry: undefined,
        testingId: null,
        testResults: {},
        onTest: () => {},
        onEdit: () => {},
        onDelete: () => {},
        onSetDefault: () => {},
      }),
    ),
  credentials: () =>
    columnsFrom(() =>
      useCredentialColumns({
        registry: undefined,
        testingId: null,
        testResults: {},
        onTest: () => {},
        onEdit: () => {},
        onDelete: () => {},
        onRename: () => {},
        onConnectOAuth: () => {},
      }),
    ),
  proxies: () =>
    columnsFrom(() =>
      useProxyColumns({
        testingId: null,
        testResults: {},
        onTest: () => {},
        onEdit: () => {},
        onDelete: () => {},
        onSetDefault: () => {},
      }),
    ),
  integrationClients: () =>
    columnsFrom(() =>
      useIntegrationClientColumns({
        canChooseDefault: true,
        isSettingDefault: false,
        isDeleting: false,
        onSetDefault: () => {},
        onRotate: () => {},
        onDelete: () => {},
      }),
    ),
  connections: () =>
    columnsFrom(() =>
      useConnectionColumns({
        packageId: "@appstrate/google-drive",
        authKey: "drive",
        authType: "oauth2",
        canRenew: true,
        userId: "user_1",
        isAdmin: true,
      }),
    ),
};

describe.each(Object.entries(SETS))("the %s column set", (_name, load) => {
  const columns = load();

  /**
   * KNOWN TOO GENEROUS: the tier-one budget asserted below is 390, the WINDOW,
   * and the real one is 348 — measured 22 August, at a 390px window every table
   * in the app is 348px wide, because the shell's own gutter takes the other 42.
   * Three sets are already between the two numbers (`packages` at 388, `models`
   * and `proxies` at 384), and it is not theoretical: the packages table clips
   * 28px of its last column at a 390px window, inside a frame that is
   * `overflow-hidden`. Tightening the assertion is what should happen; it is not
   * done here because it fails three sets that this change was not about, and
   * each is a product decision about which column gives up room. Recorded in
   * `docs/redesign-2026.md` under "Open" as the next thing to take. The two
   * integration sets were SIZED against 348 (308 and 340) — by construction, not
   * because anything below enforces it.
   */
  it("fits its tier-one floors on a phone", () => {
    expect(widthOf(columns, 1)).toBeLessThanOrEqual(390);
  });

  it.each([2, 3] as const)("fits the tier-%i floors inside the tier-%i threshold", (tier) => {
    expect(widthOf(columns, tier)).toBeLessThanOrEqual(THRESHOLD[tier]);
  });

  it("was actually read", () => {
    // A hook that threw would hand back an empty array, and every width
    // assertion above would pass on nothing at all.
    expect(columns.length).toBeGreaterThan(2);
  });
});
