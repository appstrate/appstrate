// SPDX-License-Identifier: Apache-2.0

/** A run row in a list spanning spaces (the dashboard, the chat panel) names its run's space. */

import { describe, expect, it } from "bun:test";
import { memberSpaceClient, renderInSpace, testSpace } from "../../test/space-context.ts";
import { makeRun } from "../../test/run-fixture.ts";
import i18n, { i18nReady } from "../../i18n.ts";
import { RunRow } from "../run-row.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

function row(spanning: boolean): string {
  const queryClient = memberSpaceClient([testSpace("spc_studio", [], "Studio")]);
  return renderInSpace(
    <RunRow
      run={makeRun({ packageId: "@acme/reporter", spaceId: "spc_studio" })}
      agentName="Reporter"
      spanning={spanning}
    />,
    { overview: false, queryClient },
  );
}

describe("RunRow", () => {
  it("names the run's space in a list spanning spaces", () => {
    expect(row(true)).toContain("Studio");
  });

  it("names none in a list of the working space", () => {
    expect(row(false)).not.toContain("Studio");
  });
});

describe("RunRow — degraded badge", () => {
  function rowWith(metadata: unknown): string {
    return renderInSpace(
      <RunRow run={makeRun({ packageId: "@acme/reporter", metadata })} agentName="Reporter" />,
      { overview: false, queryClient: memberSpaceClient([]) },
    );
  }

  it("flags a run that lost an integration or a tool", () => {
    const label = i18n.t("agents:run.degraded.badge");
    expect(rowWith({ degraded_integrations: ["@acme/gmail"] })).toContain(label);
    expect(
      rowWith({
        unavailable_tools: [{ integration_id: "@acme/gmail", name: "x", reason: "hidden_tools" }],
      }),
    ).toContain(label);
  });

  it("flags a tool lost for a reason this build does not know", () => {
    const label = i18n.t("agents:run.degraded.badge");
    expect(
      rowWith({
        unavailable_tools: [
          { integration_id: "@acme/gmail", name: "x", reason: "from_the_future" },
        ],
      }),
    ).toContain(label);
  });

  it("flags nothing for a clean run", () => {
    const label = i18n.t("agents:run.degraded.badge");
    expect(rowWith({})).not.toContain(label);
    expect(rowWith(null)).not.toContain(label);
    expect(rowWith({ unavailable_tools: [] })).not.toContain(label);
  });
});
