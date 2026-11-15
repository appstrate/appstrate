// SPDX-License-Identifier: Apache-2.0

/** A schedule list spanning spaces: each row names its space, and a row of another space enters it. */

import { describe, expect, it, spyOn } from "bun:test";
import type { EnrichedSchedule } from "@appstrate/shared-types";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { spaceStore } from "../../stores/space-store.ts";
import { SchedulesTable } from "../schedules-table.tsx";
import { useScheduleColumns } from "../schedule-columns.tsx";
import type { DataColumn } from "../data-table.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const schedule = (id: string, spaceId: string) =>
  ({ id, spaceId, name: `Planif ${id}` }) as EnrichedSchedule;
const nameOnly: DataColumn<EnrichedSchedule>[] = [
  { id: "name", header: "Nom", width: 120, cell: (s) => s.name },
];

describe("the schedules table", () => {
  it("links a schedule of another space naming that space, one of the current space as before", () => {
    const current = spyOn(spaceStore, "getInitialState").mockReturnValue({
      ...spaceStore.getInitialState(),
      id: "spc_1",
    });
    try {
      const html = render(
        <SchedulesTable
          schedules={[schedule("sch_1", "spc_1"), schedule("sch_2", "spc_2")]}
          columns={nameOnly}
        />,
      );
      expect(html).toContain('href="/schedules/sch_1"');
      expect(html).toContain('href="/schedules/sch_2?enterSpace=spc_2"');
    } finally {
      current.mockRestore();
    }
  });

  it("has an « Espace » column only when the list spans spaces", () => {
    const ids = (spanning: boolean) => {
      let columns: DataColumn<EnrichedSchedule>[] = [];
      function Probe() {
        columns = useScheduleColumns({ spanning });
        return null;
      }
      render(<Probe />);
      return columns.map((column) => column.id);
    };
    expect(ids(true)).toContain("space");
    expect(ids(false)).not.toContain("space");
  });
});
