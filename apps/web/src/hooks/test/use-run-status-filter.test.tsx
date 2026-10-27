// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { runStatusValues } from "@appstrate/core/run-status";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { useRunStatusFilter } from "../use-run-status-filter.ts";

await i18nReady;
await i18n.changeLanguage("fr");

/** The hook's answer for a list whose state holds `stored` under `status`. */
function filterFor(stored: string[]) {
  const writes: Array<{ key: string; values: string[] }> = [];
  let result: ReturnType<typeof useRunStatusFilter> | undefined;
  function Probe() {
    result = useRunStatusFilter({
      values: <T extends string>(key: string, allowed: readonly T[]) =>
        key === "status" ? allowed.filter((value) => stored.includes(value)) : [],
      setValues: (key) => (values) => writes.push({ key, values }),
    });
    return null;
  }
  render(<Probe />);
  return { ...result!, writes };
}

describe("useRunStatusFilter", () => {
  it("offers every run status, each in the reader's language", () => {
    const { filter } = filterFor([]);
    expect(filter.id).toBe("status");
    expect(filter.options.map((o) => o.value)).toEqual([...runStatusValues]);
    for (const option of filter.options) {
      expect(option.label).toBe(i18n.t(`status.${option.value}`, { ns: "common" }));
    }
  });

  it("reads the chosen statuses from the list, and writes them back to it", () => {
    const { statuses, filter, writes } = filterFor(["failed", "bogus"]);
    expect(statuses).toEqual(["failed"]);
    expect(filter.values).toEqual(["failed"]);
    filter.onChange(["success"]);
    expect(writes).toEqual([{ key: "status", values: ["success"] }]);
  });
});
