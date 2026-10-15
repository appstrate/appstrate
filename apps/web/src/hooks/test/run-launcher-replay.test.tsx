// SPDX-License-Identifier: Apache-2.0

/**
 * `useRunLauncher` against a launch the server refuses twice. Each "Re-run" replays what the
 * refused request sent, without its own pick for the integrations THAT refusal names — so a
 * pick dropped by the first replay stays dropped in the second, and a pick no refusal named
 * rides along to the end.
 *
 * No DOM: a probe captures the launcher during a static render, the typed client's POST is
 * stubbed, and the launcher is driven by hand.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { client } = await import("../../api/client.ts");
const { ApiError } = await import("../../api/errors.ts");
const { render } = await import("../../test/render.tsx");
const { useRunLauncher } = await import("../use-mutations.ts");

const AGENT = "@acme/mailer";
const CRM = "@acme/crm";
const MAIL = "@acme/mail";
const DRIVE = "@acme/drive";

const refusal = (integrationId: string, code: string) =>
  new ApiError("missing_integration_connection", "refused", 409, [
    { field: `integrations.${integrationId}`, code, message: "refused" },
  ]);

function launcher() {
  const captured: ReturnType<typeof useRunLauncher>[] = [];
  function Probe() {
    captured.push(useRunLauncher(AGENT));
    return null;
  }
  render(<Probe />, { queryClient: new QueryClient() });
  return captured[0]!;
}

const settled = () => Bun.sleep(1);

let post: ReturnType<typeof spyOn>;
let stubs: { mockRestore: () => void }[];
beforeEach(() => {
  post = spyOn(client, "POST");
  // A launch leaves for the run page; outside an effect the router only warns about it.
  stubs = [post, spyOn(console, "warn").mockImplementation(() => {})];
});
afterEach(() => {
  for (const s of stubs) s.mockRestore();
});

type Sent = Array<[string, { body: { input?: unknown; connection_overrides?: unknown } }]>;

/** The body of each launch request, in order. */
const sentBodies = () => (post.mock.calls as unknown as Sent).map(([, init]) => init.body);
/** Their `connection_overrides` (`undefined`: none sent). */
const sentPicks = () => sentBodies().map((body) => body.connection_overrides);

describe("useRunLauncher — replaying a refused launch", () => {
  it("replays what each refused request sent, without the picks that refusal names", async () => {
    post
      .mockRejectedValueOnce(refusal(CRM, "override_outranked"))
      .mockRejectedValueOnce(refusal(DRIVE, "override_connection_unavailable"))
      .mockResolvedValue({ data: { id: "run_1", warnings: [] } });
    const launch = launcher();

    const picks = { [CRM]: ["c_out"], [MAIL]: ["c_m"], [DRIVE]: ["c_d"] };
    launch.launch({ input: { prompt: "bonjour" }, connectionOverrides: picks });
    await settled();
    launch.retry();
    await settled();
    launch.retry();
    await settled();

    expect(sentPicks()).toEqual([
      picks,
      // The first refusal names crm: its pick is dropped.
      { [MAIL]: ["c_m"], [DRIVE]: ["c_d"] },
      // The second names drive: its pick goes too, crm does not come back, mail still rides.
      { [MAIL]: ["c_m"] },
    ]);
    // The input typed in the run modal rides every replay.
    const input = { prompt: "bonjour" };
    expect(sentBodies().map((body) => body.input)).toEqual([input, input, input]);
  });

  it("drops every pick a refusal names, sending no empty map", async () => {
    post
      .mockRejectedValueOnce(refusal(CRM, "override_connection_unavailable"))
      .mockResolvedValue({ data: { id: "run_1", warnings: [] } });
    const launch = launcher();
    launch.launch({ connectionOverrides: { [CRM]: ["c_gone"] } });
    await settled();
    launch.retry();
    await settled();
    expect(sentPicks()).toEqual([{ [CRM]: ["c_gone"] }, undefined]);
  });
});
